# Step 3: serial live-timing project, two full runs (HEAD 32b63ab + project split)
serial-run1.log: 107 passed / 13 failed (4.5m)
serial-run2.log: 107 passed / 13 failed (4.5m)
All 26 failures are in ProgramMonitorSharedParity / RawMediaParity:
- 10+10 "actual output-clock aligned transient within one sequence frame" (1.06-1.76 frames vs <=1)
- 1+1 RawMediaParity raw <video> "unchanged one-frame output-clock gate" (1.56, 1.45 frames)
- 2+2 "decoded visual frame 42 must be directly observed" (null)
Groups C (ProgramMonitorSpeed) and D (ProgramMonitorAudio): 0 failures in both runs.
browser0-interrupted.log and contaminated/ are voided runs (session cut / overlapping jobs).

# Step 4: group D root cause
`--project=live-timing --repeat-each=5 ProgramMonitorAudio`: 25 passed / 0 failed (audio-repeat5.log).
Raw audition ratios: 0.99992, 0.99929, 1.00045, 0.99999, 0.99915 (gate |r-1|<0.03).
The parallel baseline failures were playback starvation, not a gain defect:
- run1: baseline window starved (0.00241 vs steady 0.00353), result 0.00352 -> ratio 1.457
- run2: result window starved (measuredRate 0.925), baseline 0.00353 -> ratio 0.882
Hypothesis (b), a real gain defect, is ruled out. Hypothesis (a), different taps, is ruled out too: the baseline and result agree to 0.1% when they aren't starved.
The fix is the serial live-timing project (step 1). No app or test change.

# Step 5: group C
Serial full runs: 0 ProgramMonitorSpeed failures (2/2). `--repeat-each=3 ProgramMonitorSpeed`: 18 passed / 0 failed (speed-repeat3.log).
No pitch/clock-ratio failure remains in the serial run; root cause = parallel CPU/audio contention, fixed by step 1.

# Step 6: known-time gate (known1.json, serial project, SharedParity + RawMediaParity)
All measured app cases: |video| = 0.000, |audio| <= 0.583, |diff| <= 0.583 frames (gate <= 1).
Raw <video> control: video 0.000, audio 0.000, diff 0.000. PASSES the known-time gate.
Raw <video> control, run ALONE in the serial project: absolute output-clock gate 1.387 frames. STILL FAILS (step-13 trigger).
Note: the video channel uses rVFC metadata.mediaTime of the frame decoded as 42, so it checks the decoded identity/PTS pairing. The audio channel is the live measurement.

# Step 7: negative control (frame-45 burst)
30-1: audio error 2.960, diff 2.960 frames. Gate correctly FAILS the clip (test passes).
30000-1001: audio error 2.995, diff 2.995 frames. Gate correctly FAILS the clip (test passes).

# Step 8: group B root cause
The observer is already started before Play (evaluate registers rVFC, then clicks Play).
(1) 30000/1001 200% FINAL: exported speed-parity-30000-1001-2-1.mp4 contains only odd source frames (31,33,...,41,43). Frame 42 does not exist in the file.
    Cause: render.rs `setpts=PTS*d/n` quantizes the halved PTS to the 1/30000 stream timebase (500.5 ticks), so fps=30000/1001 keeps frame 2k+1 for slot k.
    ffmpeg proof: the same chain with `settb=1/60000` before the setpts, or with fps round=up, yields 30,32,34,... and frame 42 at index 6.
    30/1 is unaffected: its 1/15360 timebase is exact.
    This is a real export phase defect (half an output frame late) that slips through the Rust cadence tolerance (<= 1 frame).
(2) 30000/1001 150% PREVIEW: rVFC reports only ~30 presentations/s for ~45 fps content (presented/source 0.72), so a third of source frames are never presented and frame 42 is sometimes skipped. 30/1 150% shows the same ratio (0.71).

# Step 8 follow-up
FINAL 30000/1001 2x: fixed at the shared cause. `settb=expr=intb/n` before `setpts=PTS*d/n` in both the TS compiler
(packages/video-render/src/compile-render-plan.ts) and the Rust validator (render.rs). New strict Rust assertion in
speed_export_parity.rs (exact source frame 30+k*speed for speeds 1/2, 1/1, 2/1): RED before (30000/1001 2/1 gave 31,33,...), GREEN after.
Browser copies refreshed from the green run (/tmp/.tmpb27Yfb); stale copies kept in stale-browser-clips/.
PREVIEW >1x: plain <video> probe (no app code), 1.5s at 1.5x/2x, 2 repeats each:
- 1.5x: ~30 callbacks/s, and every media skip equals a presentedFrames jump of 2 (19-22 per run), with 0 dropped frames.
  Chromium presents frame 42, but rVFC can't observe every presentation. This happens with zero callback work too.
- 30000/1001 2x: Chromium's player drops 1-14 of ~125 frames (getVideoPlaybackQuality) with no app code.
Not an app preview frame drop.

# Step 8 close + step 13 decision
User decision (29 Sep 2026): the known-time gate is the acceptance gate. The absolute output-clock value is recorded as the `output-clock-frames` annotation and still attached in JSON; it is no longer asserted.
Preview frame-42 misses: headless Chromium caps rVFC at ~30/s (probe: callbacks 44 vs presented 64 at 1.5x; with
--disable-frame-rate-limit, callbacks 65 vs presented 64). Flag added to the live-timing project only.
known4.json: SharedParity live + Raw + negatives, --repeat-each=4: 76 passed / 0 failed, max known-time error 0.880 frames.
