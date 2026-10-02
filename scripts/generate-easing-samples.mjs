// Regenerates packages/video-contracts/fixtures/easing-samples.json.
//
// Usage: node scripts/generate-easing-samples.mjs <path to diffusion-studio-2/lib/motion.fixtures.json>
//
// `animejs` values come from the animejs 4.5.0 reference fixture; `expected` values are this repo's
// TypeScript easing output. Both the TS and Rust easing tests read the file (see ADR 0003).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import process from "node:process";

const easingModule = await import(
  new URL("../packages/video-contracts/src/easing.ts", import.meta.url).href
);
const { easeFunction, springSettlingSeconds, compileTrack } = easingModule;

const referencePath = process.argv[2];
if (referencePath === undefined) {
  console.error("usage: node scripts/generate-easing-samples.mjs <motion.fixtures.json>");
  process.exit(2);
}
const reference = JSON.parse(readFileSync(referencePath, "utf8"));

const presetNames = new Set([
  "easeIn",
  "easeOut",
  "easeInOut",
  "gentle",
  "snappy",
  "bouncy",
  "strong",
]);

function parseDescriptor(name, descriptor) {
  if (presetNames.has(name)) return { kind: "preset", name };
  const bezier = /^cubicBezier\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)$/.exec(descriptor);
  if (bezier !== null) {
    const [x1, y1, x2, y2] = bezier.slice(1, 5).map(Number);
    return { kind: "cubicBezier", x1, y1, x2, y2 };
  }
  const spring = /^spring\(([-\d.]+),(\d+)\)$/.exec(descriptor);
  if (spring !== null)
    return { kind: "spring", bounce: Number(spring[1]), durationMs: Number(spring[2]) };
  const steps = /^steps\((\d+),(true|false)\)$/.exec(descriptor);
  if (steps !== null)
    return { kind: "steps", count: Number(steps[1]), fromStart: steps[2] === "true" };
  throw new Error(`unknown descriptor ${descriptor}`);
}

const cases = reference.cases.map((entry) => {
  const easing = parseDescriptor(entry.name, entry.descriptor);
  const ease = easeFunction(easing);
  return {
    name: entry.name,
    easing,
    points: entry.points.map(([t, animejs]) => ({ t, animejs, expected: ease(t) })),
  };
});

const springSettling = [
  [0, 100],
  [0, 400],
  [0.3, 1000],
  [0.5, 628],
  [0.9, 2000],
  [-0.5, 400],
].map(([bounce, durationMs]) => ({
  bounce,
  durationMs,
  settlingSeconds: springSettlingSeconds(bounce, durationMs),
}));

const trackKeys = [
  { time: 0, value: 100, easing: { kind: "preset", name: "snappy" } },
  {
    time: 500_000,
    value: 400,
    easing: { kind: "cubicBezier", x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
  },
  { time: 1_000_000, value: 250, easing: { kind: "steps", count: 4 } },
  { time: 1_400_000, value: 0 },
];
const track = compileTrack(trackKeys);
const trackTimes = [
  -100_000, 0, 125_000, 250_000, 499_999, 500_000, 700_000, 999_000, 1_100_000, 1_399_999,
  1_400_000, 2_000_000,
];
const tracks = [
  {
    name: "mixed",
    keys: trackKeys,
    samples: trackTimes.map((time) => ({ time, value: track(time) })),
  },
];

const output = {
  source: reference.source,
  note: "animejs = animejs 4.5.0 reference (tolerance 1e-3); expected = repo easing output (TS and Rust within 1e-6). Regenerate with scripts/generate-easing-samples.mjs.",
  cases,
  springSettling,
  tracks,
};
const target = fileURLToPath(
  new URL("../packages/video-contracts/fixtures/easing-samples.json", import.meta.url),
);
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${cases.length} easing cases to ${target}`);
