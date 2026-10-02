import { compileTrack, type GraphicsKeyframe, type GraphicsLayer } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  applyPresetToLayer,
  graphicsLayerBounds,
  MOTION_PRESET_NAMES,
  type MotionPresetName,
  staggeredEntrance,
  textReveal,
} from "./motion-presets.js";
import { MOTION_PRESET_DATA } from "./motion-presets.data.js";

const hold = (value: number): GraphicsKeyframe[] => [{ timeMicroseconds: 0, value }];
const rect: GraphicsLayer = {
  kind: "rect",
  width: 400,
  height: 100,
  cornerRadius: 0,
  fill: "#FFFFFF",
  x: hold(200),
  y: hold(300),
  scale: hold(1),
  rotation: hold(0),
  opacity: hold(1),
};
const text: GraphicsLayer = {
  kind: "text",
  text: "Make it move",
  fontSize: 40,
  fill: "#FFFFFF",
  x: hold(100),
  y: hold(500),
  scale: hold(1),
  rotation: hold(0),
  opacity: hold(1),
};
const PROPERTIES = ["x", "y", "scale", "rotation", "opacity"] as const;

const sample = (track: readonly GraphicsKeyframe[], time: number): number => {
  const keys = track.map((key) => ({
    time: key.timeMicroseconds,
    value: key.value,
    easing: key.easing,
  }));
  const [first, ...rest] = keys;
  if (first === undefined) throw new Error("empty track");
  return compileTrack([first, ...rest])(time);
};

function expectTimesFit(track: readonly GraphicsKeyframe[], clipDuration: number): void {
  for (const [index, key] of track.entries()) {
    expect(Number.isSafeInteger(key.timeMicroseconds)).toBe(true);
    expect(key.timeMicroseconds).toBeGreaterThanOrEqual(0);
    expect(key.timeMicroseconds).toBeLessThanOrEqual(clipDuration);
    if (index > 0)
      expect(key.timeMicroseconds).toBeGreaterThan(track[index - 1]?.timeMicroseconds ?? -1);
  }
}

// preset × clip duration: shorter than, equal to and longer than the natural preset duration.
const fitCases = MOTION_PRESET_NAMES.flatMap((name) =>
  [33_333, MOTION_PRESET_DATA[name].durationMicroseconds, 3_000_000].map(
    (clipDuration) => [name, clipDuration] as const,
  ),
);

describe("named presets fit to the clip duration", () => {
  it.each(fitCases)(
    "%s in a %i µs clip ends inside the clip at the rest pose",
    (name, clipDuration) => {
      const result = applyPresetToLayer(rect, name, { clipDurationMicroseconds: clipDuration });

      if (!result.ok) throw new Error(result.error.message);
      const layer = result.value;
      for (const property of PROPERTIES) {
        expectTimesFit(layer[property], clipDuration);
        expect(sample(layer[property], clipDuration)).toBeCloseTo(
          rect[property][0]?.value ?? Number.NaN,
          4,
        );
      }
    },
  );

  it.each(MOTION_PRESET_NAMES)("%s plays at natural speed when the clip is longer", (name) => {
    const natural = MOTION_PRESET_DATA[name].durationMicroseconds;

    const result = applyPresetToLayer(rect, name, { clipDurationMicroseconds: 10 * natural });

    if (!result.ok) throw new Error(result.error.message);
    const lastKeyTime = Math.max(
      ...PROPERTIES.map((property) => result.value[property].at(-1)?.timeMicroseconds ?? 0),
    );
    expect(lastKeyTime).toBeLessThanOrEqual(natural);
    expect(lastKeyTime).toBeGreaterThan(natural * 0.8);
  });

  it.each<[MotionPresetName, string, number]>([
    // First keyframes = rest + preset offset × layer size (400 × 100), from the reference data.
    ["slam", "x", 200 - 0.169 * 400],
    ["pop", "scale", 0.5462],
    ["tiltIn", "rotation", -23.1718],
    ["cursorDrag", "x", 200 - 2.4779 * 400],
    ["rockSlide", "opacity", 0.7426],
  ])("%s starts %s at the reference pose", (name, property, expected) => {
    const result = applyPresetToLayer(rect, name, { clipDurationMicroseconds: 1_000_000 });

    if (!result.ok) throw new Error(result.error.message);
    const track = result.value[property as (typeof PROPERTIES)[number]];
    expect(track[0]?.value).toBeCloseTo(expected, 4);
  });

  it("keeps the reference easing on each segment and drops it from the last key", () => {
    const result = applyPresetToLayer(rect, "slam", { clipDurationMicroseconds: 1_000_000 });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.x[0]?.easing).toEqual({
      kind: "cubicBezier",
      x1: 0.2509,
      y1: 1.2201,
      x2: 0.5346,
      y2: 0.9369,
    });
    expect(result.value.x.at(-1)?.easing).toBeUndefined();
  });

  it("animates into a non-default rest pose", () => {
    const resting: GraphicsLayer = { ...rect, scale: hold(2), opacity: hold(0.5) };

    const result = applyPresetToLayer(resting, "pop", { clipDurationMicroseconds: 1_000_000 });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.scale[0]?.value).toBeCloseTo(2 * 0.5462, 6);
    expect(result.value.scale.at(-1)?.value).toBe(2);
    expect(result.value.opacity.at(-1)?.value).toBe(0.5);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects clip duration %d", (clipDuration) => {
    const result = applyPresetToLayer(rect, "pop", { clipDurationMicroseconds: clipDuration });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_option" } });
  });

  it("estimates text bounds at 0.55 em per character and one em tall", () => {
    expect(graphicsLayerBounds(text)).toEqual({ width: 12 * 0.55 * 40, height: 40 });
    expect(graphicsLayerBounds(rect)).toEqual({ width: 400, height: 100 });
  });
});

describe("staggered entrance", () => {
  const layers = [rect, { ...rect, y: hold(450) }, text];

  it.each([
    // [clip µs, stagger µs, expected start offsets]
    [3_000_000, 100_000, [0, 100_000, 200_000]],
    [2_000_000, 0, [0, 0, 0]],
  ])("in a %i µs clip with %i µs stagger starts layers at %j", (clipDuration, stagger, starts) => {
    const result = staggeredEntrance(layers, "pop", {
      clipDurationMicroseconds: clipDuration,
      staggerMicroseconds: stagger,
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map((layer) => layer.x[0]?.timeMicroseconds)).toEqual(starts);
  });

  it.each([100_000, 250_000, 33_333])(
    "compresses stagger and motion together to end inside a %i µs clip",
    (clipDuration) => {
      const result = staggeredEntrance(layers, "pop", {
        clipDurationMicroseconds: clipDuration,
        staggerMicroseconds: 100_000,
      });

      if (!result.ok) throw new Error(result.error.message);
      const starts = result.value.map((layer) => layer.x[0]?.timeMicroseconds ?? -1);
      expect(starts[0]).toBe(0);
      expect(starts[1]).toBeGreaterThan(0);
      expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBe(starts[1]);
      for (const layer of result.value)
        for (const property of PROPERTIES) expectTimesFit(layer[property], clipDuration);
    },
  );

  it("needs at least one layer", () => {
    expect(
      staggeredEntrance([], "pop", { clipDurationMicroseconds: 1_000_000, staggerMicroseconds: 0 }),
    ).toMatchObject({ ok: false, error: { code: "no_layers" } });
  });
});

describe("text reveal", () => {
  it.each([
    // [split, expected unit count]
    ["word", 3],
    ["letter", 10],
  ] as const)("splits by %s into %i units", (split, count) => {
    const result = textReveal(text, { split, clipDurationMicroseconds: 3_000_000 });

    if (!result.ok || result.value.kind !== "text") throw new Error("reveal failed");
    expect(result.value.units?.opacity).toHaveLength(count);
    expect(result.value.units?.offsetY).toHaveLength(count);
  });

  it.each([
    // [clip µs, expected unit starts]
    [3_000_000, [0, 120_000, 240_000]],
    [270_000, [0, 60_000, 120_000]],
  ])("in a %i µs clip starts word units at %j and ends inside the clip", (clipDuration, starts) => {
    const result = textReveal(text, { split: "word", clipDurationMicroseconds: clipDuration });

    if (!result.ok || result.value.kind !== "text") throw new Error("reveal failed");
    const units = result.value.units;
    expect(units?.opacity.map((track) => track[0]?.timeMicroseconds)).toEqual(starts);
    for (const track of [...(units?.opacity ?? []), ...(units?.offsetY ?? [])])
      expectTimesFit(track, clipDuration);
    for (const track of units?.opacity ?? []) {
      expect(track[0]?.value).toBe(0);
      expect(sample(track, clipDuration)).toBe(1);
    }
    for (const track of units?.offsetY ?? []) {
      expect(track[0]?.value).toBe(20);
      expect(sample(track, clipDuration)).toBe(0);
    }
  });

  it("fits hundreds of letters into one frame", () => {
    const long: GraphicsLayer = { ...text, text: "x".repeat(400) };

    const result = textReveal(long, { split: "letter", clipDurationMicroseconds: 33_333 });

    if (!result.ok || result.value.kind !== "text") throw new Error("reveal failed");
    for (const track of result.value.units?.opacity ?? []) expectTimesFit(track, 33_333);
  });

  it("refuses non-text layers", () => {
    expect(textReveal(rect, { split: "word", clipDurationMicroseconds: 1_000_000 })).toMatchObject({
      ok: false,
      error: { code: "no_text_layer" },
    });
  });
});
