import assert from "node:assert/strict";

// Functional media checks, not frame-presentation latency measurements.
export async function verifyMediaWindow(page, nativeData, trace, record) {
  const sequence = nativeData.projection.state.sequences[0];
  const mediaTracks = sequence.tracks.filter((t) => t.kind !== "caption");
  const checks = [];
  for (const track of mediaTracks) {
    const indices = [0, Math.floor(track.clips.length / 2), track.clips.length - 1, 0];
    for (const index of indices) {
      const clip = track.clips[index];
      const offset = Math.min(5, clip.sourceOut.value - clip.sourceIn.value - 1);
      assert.ok(offset >= 0);
      const target = clip.timelineStart.value + offset;
      const expectedSeconds =
        ((clip.sourceIn.value + offset) * clip.sourceIn.rateDenominator) /
        clip.sourceIn.rateNumerator;
      await trace(`window.seek.${track.kind}.${index}`, () =>
        page.evaluate((frame) => globalThis.__p2SeekTo(frame), target),
      );
      await trace(`window.ready.${track.kind}.${index}`, () =>
        page.waitForFunction(
          ({ id, seconds, tolerance }) => {
            const media = [...globalThis.document.querySelectorAll(".monitor-stage video")].find(
              (v) => v.dataset.clipId === id,
            );
            return (
              media &&
              media.readyState >= 2 &&
              !media.seeking &&
              Math.abs(media.currentTime - seconds) <= tolerance
            );
          },
          {
            id: clip.id,
            seconds: expectedSeconds,
            tolerance: clip.sourceIn.rateDenominator / clip.sourceIn.rateNumerator + 1e-6,
          },
          { timeout: 7000 },
        ),
      );
      const state = await trace("window.inspect", () =>
        page.evaluate((id) => {
          const nodes = [...globalThis.document.querySelectorAll(".monitor-stage video")];
          const media = nodes.find((v) => v.dataset.clipId === id);
          return {
            mounted: nodes.length,
            currentTime: media.currentTime,
            readyState: media.readyState,
            decodedFrames: media.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
            fatalError: !!globalThis.document.querySelector(".monitor-fallback[role=alert]"),
          };
        }, clip.id),
      );
      assert.ok(
        state.mounted <= mediaTracks.length * 3 + 1,
        "Fixture media must remain bounded after distant seeks",
      );
      assert.equal(state.fatalError, false);
      if (track.kind === "video")
        assert.ok(state.decodedFrames > 0, "Real video must decode after seeking");
      const result = {
        kind: track.kind,
        index,
        clipId: clip.id,
        target,
        expectedSeconds,
        ...state,
      };
      checks.push(result);
      record(result);
    }
  }
  return {
    scope:
      "actual media readiness/currentTime and decoded video; not presented-frame timing or audible-output proof",
    checks,
  };
}
