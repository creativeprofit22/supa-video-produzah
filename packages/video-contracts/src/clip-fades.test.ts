import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clipTimelineDuration } from "./clip-timing.js";
import { projectCommandSchemaV2 } from "./project-commands-v2.js";
import { videoProjectStateV2Schema } from "./project-v2.js";

const raw = JSON.parse(
  readFileSync(
    new URL("../fixtures/project-v2/valid-relative-source.svpvideo", import.meta.url),
    "utf8",
  ),
) as { state: unknown };
function fixture() {
  const state = videoProjectStateV2Schema.parse(raw.state);
  const sequence = state.sequences[0]!;
  const track = sequence.tracks[0]!;
  if (track.kind === "caption") throw new Error("Expected media fixture");
  return { state, sequence, track, clip: track.clips[0]! };
}
function command() {
  const { sequence, track, clip } = fixture();
  return {
    type: "SetClipFades",
    commandId: "70000000-0000-4000-8000-000000000001",
    sequenceId: sequence.id,
    trackId: track.id,
    clipId: clip.id,
    fades: { inFrames: 1, outFrames: 2 },
  };
}

describe("canonical audio fades", () => {
  it("does not rewrite legacy state or add default fade fields", () => {
    expect(fixture().state).toEqual(raw.state);
    expect(JSON.stringify(fixture().state)).not.toContain('"fades"');
  });
  it.each([
    null,
    {},
    { inFrames: -1, outFrames: 0 },
    { inFrames: 0.5, outFrames: 0 },
    { inFrames: Number.MAX_SAFE_INTEGER + 1, outFrames: 0 },
    { inFrames: 0, outFrames: 0, extra: true },
  ])("rejects malformed state and command fades: %j", (fades) => {
    const value = command();
    expect(projectCommandSchemaV2.safeParse({ ...value, fades }).success).toBe(false);
    const { state, clip } = fixture();
    Object.assign(clip, { fades });
    expect(videoProjectStateV2Schema.safeParse(state).success).toBe(false);
  });
  it("accepts zero and positive fades but enforces the exact output duration", () => {
    for (const fades of [
      { inFrames: 0, outFrames: 0 },
      { inFrames: 1, outFrames: 2 },
    ]) {
      expect(projectCommandSchemaV2.safeParse({ ...command(), fades }).success).toBe(true);
    }
    const { state, sequence, clip } = fixture();
    const duration = clipTimelineDuration(
      { in: clip.sourceIn, out: clip.sourceOut },
      sequence.rate,
    ).value;
    clip.fades = { inFrames: duration, outFrames: 0 };
    expect(videoProjectStateV2Schema.safeParse(state).success).toBe(true);
    clip.fades.outFrames = 1;
    expect(videoProjectStateV2Schema.safeParse(state).success).toBe(false);
  });
  it("rejects a timing edit that makes existing fades too long, not speed alone", () => {
    const { state, sequence, clip } = fixture();
    const frames = clip.sourceOut.value - clip.sourceIn.value;
    clip.sourceOut.value -= frames % 2;
    const duration = clipTimelineDuration(
      { in: clip.sourceIn, out: clip.sourceOut },
      sequence.rate,
    ).value;
    clip.speed = { numerator: 2, denominator: 1 };
    expect(videoProjectStateV2Schema.safeParse(state).success).toBe(true);
    clip.fades = { inFrames: duration, outFrames: 0 };
    expect(videoProjectStateV2Schema.safeParse(state).success).toBe(false);
  });
  it("requires an explicit private restoration value instead of treating omission as null", () => {
    const { commandId, sequenceId, trackId, clipId } = command();
    const inverse = { commandId, sequenceId, trackId, clipId, type: "RestoreClipFades" };
    expect(projectCommandSchemaV2.safeParse(inverse).success).toBe(false);
    expect(projectCommandSchemaV2.safeParse({ ...inverse, fades: null }).success).toBe(true);
    expect(
      projectCommandSchemaV2.safeParse({ ...inverse, fades: { inFrames: 0, outFrames: 0 } })
        .success,
    ).toBe(true);
  });
});
