import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { normalizeClipSpeed, parseClipSpeedPercent } from "./clip-timing.js";
import { parseVideoProjectFile } from "./migrations.js";
import {
  projectClipSchema,
  videoProjectSnapshotV2Schema,
  videoProjectStateV2Schema,
  type VideoProjectSnapshotV2,
} from "./project-v2.js";

function fixture(name = "valid-relative-source") {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/project-v2/${name}.svpvideo`, import.meta.url), "utf8"),
  ) as VideoProjectSnapshotV2;
}
function firstClip(snapshot: VideoProjectSnapshotV2) {
  const track = snapshot.state.sequences[0]!.tracks[0]!;
  if (track.kind === "caption") throw new Error("Expected video fixture");
  return track.clips[0]!;
}
// Fixture-only canonical JSON: these fixtures contain JSON values with integer numbers
// and ASCII keys. Production canonical hashing remains authoritative in Rust.
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, ordered(entry)]),
    );
  }
  return value;
}
function fixtureHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
const invalid: { name: string; speed: unknown }[] = JSON.parse(
  readFileSync(new URL("../fixtures/clip-speed-invalid.json", import.meta.url), "utf8"),
);

describe("clip speed serialization compatibility", () => {
  it("reads V1 without adding speed and rejects speed-bearing V1 input", () => {
    const original: unknown = JSON.parse(
      readFileSync(new URL("../fixtures/clip-speed-legacy-v1.json", import.meta.url), "utf8"),
    );
    const parsed = parseVideoProjectFile(original);
    expect(parsed).toEqual(original);
    expect(JSON.stringify(parsed)).not.toContain('"speed"');
    if (parsed.schemaVersion !== 1) throw new Error("Expected legacy project");
    const clip = parsed.revisions[0]!.state.sequence!.videoTracks[0].clips[0]!;
    Object.assign(clip, { speed: parseClipSpeedPercent("150") });
    expect(() => parseVideoProjectFile(parsed)).toThrow("strict V1 validation");
  });
  it.each(["valid-minimal", "valid-mixed-rate", "valid-relative-source"])(
    "preserves omitted fields and the legacy state hash: %s",
    (name) => {
      const original = fixture(name);
      const parsed = videoProjectSnapshotV2Schema.parse(original);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(original);
      expect(fixtureHash(parsed.state)).toBe(original.revision.stateHash);
      expect(parseVideoProjectFile(original)).toEqual(parsed);
      expect(JSON.stringify(parsed)).not.toContain('"speed"');
    },
  );

  it("normal-speed restoration returns to omission and the original state hash", () => {
    const original = fixture();
    const changed = structuredClone(original);
    firstClip(changed).speed = parseClipSpeedPercent("150");
    expect(fixtureHash(changed.state)).not.toBe(original.revision.stateHash);
    const normalized = normalizeClipSpeed(parseClipSpeedPercent("100"));
    expect(normalized).toBeUndefined();
    // This tests the edit normalization primitive, not a not-yet-implemented command.
    if (normalized === undefined) delete firstClip(changed).speed;
    else firstClip(changed).speed = normalized;
    const parsed = videoProjectSnapshotV2Schema.parse(changed);
    expect(Object.hasOwn(firstClip(parsed), "speed")).toBe(false);
    expect(fixtureHash(parsed.state)).toBe(original.revision.stateHash);
    expect(parsed).toEqual(original);
  });

  it("does not rewrite explicit normal speed merely by reading it", () => {
    const original = fixture();
    firstClip(original).speed = parseClipSpeedPercent("100");
    original.revision.stateHash = fixtureHash(original.state);
    const parsed = videoProjectSnapshotV2Schema.parse(original);
    expect(parsed).toEqual(original);
    expect(fixtureHash(parsed.state)).toBe(original.revision.stateHash);
  });

  it.each([50, 51, 150, 200])(
    "round trips %i%% clip bytes and admits only exact canonical timing",
    (percent) => {
      const snapshot = fixture();
      const clip = firstClip(snapshot);
      const before = structuredClone(clip);
      clip.speed = parseClipSpeedPercent(String(percent));
      const parsed = projectClipSchema.parse(JSON.parse(JSON.stringify(clip)));
      expect(parsed).toEqual(clip);
      expect(parsed.sourceIn).toEqual(before.sourceIn);
      expect(parsed.sourceOut).toEqual(before.sourceOut);
      expect(parsed.timelineStart).toEqual(before.timelineStart);
      const result = videoProjectStateV2Schema.safeParse(snapshot.state);
      expect(result.success).toBe(percent !== 51);
      if (percent === 51) {
        expect(() => parseVideoProjectFile(snapshot)).toThrow("strict V2 validation");
      } else {
        snapshot.revision.stateHash = fixtureHash(snapshot.state);
        expect(parseVideoProjectFile(snapshot)).toEqual(snapshot);
      }
    },
  );

  it("keeps dedicated audio and nested retiming unsupported in canonical state", () => {
    const audio = fixture();
    firstClip(audio).speed = parseClipSpeedPercent("200");
    Object.assign(audio.state.sequences[0]!.tracks[0]!, { kind: "audio" });
    expect(videoProjectStateV2Schema.safeParse(audio.state).success).toBe(false);
    const nested = fixture();
    firstClip(nested).speed = parseClipSpeedPercent("200");
    const parent = structuredClone(nested.state.sequences[0]!);
    parent.id = "10000000-0000-4000-8000-000000000030";
    const track = parent.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected video fixture");
    track.id = "10000000-0000-4000-8000-000000000031";
    const child = track.clips[0]!;
    delete child.speed;
    child.id = "10000000-0000-4000-8000-000000000032";
    child.source = { kind: "sequence", sequenceId: nested.state.sequences[0]!.id };
    nested.state.sequences.push(parent);
    const result = videoProjectStateV2Schema.safeParse(nested.state);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Nested retiming admitted");
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ message: "Speed in referenced child sequences is unsupported" }),
    );
  });

  it.each(invalid)("rejects invalid serialized speed: $name", ({ speed }) => {
    const snapshot = fixture();
    const value = { ...firstClip(snapshot), speed };
    expect(projectClipSchema.safeParse(value).success).toBe(false);
  });
});
