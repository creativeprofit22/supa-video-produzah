import { expect, test } from "@playwright/test";

import { audioMediaTime, knownTimeGate, loadClipEvents } from "./known-time";
import { captureRawPlayback } from "./raw-media-capture";
import { findVisualMarker } from "./visual-marker";

// Export source-in frame used by speed_export_parity.rs for the retimed artifacts.
const sourceInFrame = 30;

// Diagnostic control: no React, ProgramMonitor, seeks, or retiming. The exact native
// 1x encoded artifact passes sample/frame transient alignment in the Rust test.
test("raw HTML video with capture graph output-clock alignment", async ({
  page,
  request,
}, info) => {
  const events = await loadClipEvents(request, "speed-parity-30-1.mp4");
  const capture = await captureRawPlayback(page, "/browser-tests/speed-parity-30-1-1-1.mp4");
  const visual = findVisualMarker(capture.frames, 42);
  const eventFps = events.fpsNumerator / events.fpsDenominator;
  const audioMapped = audioMediaTime(capture.onsetTime, capture.anchors);
  const knownTime =
    visual && audioMapped
      ? knownTimeGate({
          expectedMediaSeconds: (events.eventFrame - sourceInFrame) / eventFps,
          videoMediaSeconds: visual.media,
          audioMediaSeconds: audioMapped.mediaTime,
          sequenceFramesPerMediaSecond: eventFps,
        })
      : null;
  const measurement = {
    ...capture,
    visual,
    deltaMs: visual ? capture.audio - visual.display : null,
    events,
    audioMapped,
    knownTime,
  };
  await info.attach("raw-control.json", {
    body: JSON.stringify(measurement, null, 2),
    contentType: "application/json",
  });
  expect(
    visual,
    "measurement validity: decoded visual frame 42 must be directly observed",
  ).not.toBeNull();
  expect(audioMapped, "known-time audio onset must map through a playing anchor").not.toBeNull();
  expect
    .soft(
      Math.abs(knownTime?.videoErrorFrames ?? Infinity),
      "known-time video frame 42 media time within one frame, raw browser baseline",
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      Math.abs(knownTime?.audioErrorFrames ?? Infinity),
      "known-time audio onset media time within one frame, raw browser baseline",
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      Math.abs(knownTime?.differenceFrames ?? Infinity),
      "known-time audio/video difference within one frame, raw browser baseline",
    )
    .toBeLessThanOrEqual(1);
  // Recorded, not asserted (user decision, 29 Sep 2026): this plain <video> baseline exceeds one
  // frame on the absolute output clock with no app code; the known-time gate above is the gate.
  info.annotations.push({
    type: "output-clock-frames",
    description:
      measurement.deltaMs === null
        ? "unmeasured"
        : ((Math.abs(measurement.deltaMs) / 1000) * 30).toFixed(3),
  });
});

// Negative control: same generator, audio burst 3 frames late (frame 45). The known-time gate must
// detect it, or a passing gate proves nothing.
for (const rate of ["30-1", "30000-1001"])
  test(`known-time gate rejects ${rate} clip with audio 3 frames late`, async ({
    page,
    request,
  }, info) => {
    const clip = `speed-parity-negative-${rate}.mp4`;
    const events = await loadClipEvents(request, clip);
    const capture = await captureRawPlayback(page, `/browser-tests/${clip}`);
    const visual = findVisualMarker(capture.frames, events.eventFrame);
    const eventFps = events.fpsNumerator / events.fpsDenominator;
    const audioMapped = audioMediaTime(capture.onsetTime, capture.anchors);
    const knownTime =
      visual && audioMapped
        ? knownTimeGate({
            expectedMediaSeconds: events.eventFrame / eventFps,
            videoMediaSeconds: visual.media,
            audioMediaSeconds: audioMapped.mediaTime,
            sequenceFramesPerMediaSecond: eventFps,
          })
        : null;
    await info.attach("negative-control.json", {
      body: JSON.stringify({ ...capture, visual, events, audioMapped, knownTime }, null, 2),
      contentType: "application/json",
    });
    expect(
      visual,
      "measurement validity: decoded visual frame 42 must be directly observed",
    ).not.toBeNull();
    expect(audioMapped, "known-time audio onset must map through a playing anchor").not.toBeNull();
    const lateFrames = events.audioEventFrame - events.eventFrame;
    expect(lateFrames, "negative control clip must carry a late audio burst").toBe(3);
    expect
      .soft(Math.abs(knownTime?.videoErrorFrames ?? Infinity), "video channel still on time")
      .toBeLessThanOrEqual(1);
    expect
      .soft(
        Math.abs((knownTime?.audioErrorFrames ?? Infinity) - lateFrames),
        "audio channel measures the injected lateness within one frame",
      )
      .toBeLessThanOrEqual(1);
    expect(
      Math.abs(knownTime?.differenceFrames ?? 0),
      "known-time audio/video gate must fail the late-audio clip",
    ).toBeGreaterThan(1);
  });
