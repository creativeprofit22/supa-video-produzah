import {
  applyGraphicsGroup,
  type GraphicsLayer,
  type VideoProjectStateV2,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { applyMotionPreset, type GraphicsPresetRequest } from "./apply-motion-preset.js";
import { fixtureGraphicsClip, fixtureGraphicsTrack } from "./graphics-test-fixtures.js";

const rate = { numerator: 30, denominator: 1 };
const ids = {
  sequence: "9b000000-0000-4000-8000-000000000001",
  track: "9b000000-0000-4000-8000-000000000002",
  clip: "9b000000-0000-4000-8000-000000000003",
  command: "9b000000-0000-4000-8000-000000000004",
};
const hold = (value: number) => [{ timeMicroseconds: 0, value }];
const rect: GraphicsLayer = {
  kind: "rect",
  width: 300,
  height: 80,
  cornerRadius: 0,
  fill: "#000000",
  x: hold(10),
  y: hold(10),
  scale: hold(1),
  rotation: hold(0),
  opacity: hold(1),
};

function state(options: { locked?: boolean; layers?: GraphicsLayer[] } = {}): VideoProjectStateV2 {
  const clip = fixtureGraphicsClip(ids.clip, rate, 0, 30, "Hello there world");
  return {
    assets: [],
    sequences: [
      {
        id: ids.sequence,
        name: "Main",
        rate,
        width: 1920,
        height: 1080,
        audioSampleRate: 48_000,
        tracks: [
          {
            ...fixtureGraphicsTrack(ids.track, [
              options.layers === undefined ? clip : { ...clip, layers: options.layers },
            ]),
            ...(options.locked === true ? { locked: true } : {}),
          },
        ],
        markers: [],
      },
    ],
    activeSequenceId: ids.sequence,
  };
}
const ref = { sequenceId: ids.sequence, trackId: ids.track, graphicsClipId: ids.clip };
const inverseId = (commandId: string, ordinal: number): string =>
  `${commandId.slice(0, 24)}${String(ordinal).padStart(12, "0")}`;

describe("applyMotionPreset", () => {
  it.each<[string, GraphicsPresetRequest]>([
    ["entrance on every layer", { kind: "entrance", name: "slam" }],
    ["entrance on one layer", { kind: "entrance", name: "pop", layerIndex: 0 }],
    [
      "staggered entrance",
      { kind: "staggeredEntrance", name: "tiltIn", staggerMicroseconds: 100_000 },
    ],
    ["word reveal", { kind: "textReveal", split: "word" }],
    ["letter reveal", { kind: "textReveal", split: "letter" }],
  ])(
    "%s yields exactly one SetGraphicsClipLayers command that applies cleanly",
    (_name, request) => {
      const base = state();

      const result = applyMotionPreset(base, ref, request, ids.command);

      if (!result.ok) throw new Error(result.error.message);
      expect(result.command).toMatchObject({
        type: "SetGraphicsClipLayers",
        commandId: ids.command,
        ...ref,
        fontKey: "segoe-ui-bold",
      });
      expect(applyGraphicsGroup(base, [result.command], inverseId).ok).toBe(true);
    },
  );

  it("does not mutate the input state", () => {
    const base = state();
    const before = structuredClone(base);

    applyMotionPreset(base, ref, { kind: "entrance", name: "pop" }, ids.command);

    expect(base).toEqual(before);
  });

  it.each<[string, VideoProjectStateV2, typeof ref, GraphicsPresetRequest, string]>([
    [
      "unknown clip",
      state(),
      { ...ref, graphicsClipId: ids.command },
      { kind: "entrance", name: "pop" },
      "unknown_graphics_clip",
    ],
    [
      "unknown track",
      state(),
      { ...ref, trackId: ids.command },
      { kind: "entrance", name: "pop" },
      "unknown_graphics_clip",
    ],
    [
      "locked track",
      state({ locked: true }),
      ref,
      { kind: "entrance", name: "pop" },
      "track_locked",
    ],
    [
      "text reveal without text",
      state({ layers: [rect] }),
      ref,
      { kind: "textReveal", split: "word" },
      "preset_does_not_fit",
    ],
    [
      "layer index out of range",
      state(),
      ref,
      { kind: "entrance", name: "pop", layerIndex: 3 },
      "preset_does_not_fit",
    ],
    [
      "no layers",
      state({ layers: [] }),
      ref,
      { kind: "entrance", name: "pop" },
      "preset_does_not_fit",
    ],
  ])("refuses %s with %s", (_name, input, clip, request, code) => {
    const result = applyMotionPreset(input, clip, request, ids.command);

    expect(result).toMatchObject({ ok: false, error: { code } });
  });
});
