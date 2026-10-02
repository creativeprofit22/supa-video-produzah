// Regenerates packages/video-contracts/fixtures/graphics-preset-commands.json: motion-preset
// output (one SetGraphicsClipLayers command per case) replayed by the Rust graphics contract
// tests. apps/desktop/src/graphics-preset-fixture.test.ts fails when the presets drift from it.
//
// Usage: pnpm --filter @supa-video/contracts --filter @supa-video/project build
//        node scripts/generate-graphics-preset-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";

const root = new URL("../", import.meta.url);
const { applyGraphicsGroup, videoProjectSnapshotV2Schema } = await import(
  new URL("packages/video-contracts/dist/index.js", root).href
);
const { applyMotionPreset } = await import(
  new URL("packages/video-project/dist/index.js", root).href
);

export const PRESET_FIXTURE_REQUESTS = [
  { name: "word text reveal", request: { kind: "textReveal", split: "word" }, number: 1 },
  {
    name: "staggered pop entrance",
    request: { kind: "staggeredEntrance", name: "pop", staggerMicroseconds: 80_000 },
    number: 2,
  },
  {
    name: "slam on the first layer",
    request: { kind: "entrance", name: "slam", layerIndex: 0 },
    number: 3,
  },
];

const fixtures = fileURLToPath(new URL("packages/video-contracts/fixtures/", root));
const base = videoProjectSnapshotV2Schema.parse(
  JSON.parse(readFileSync(`${fixtures}project-v2/valid-graphics.svpvideo`, "utf8")),
);
const sequence = base.state.sequences[0];
const track = sequence.tracks[1];
const clip = track.graphicsClips[0];
const ref = { sequenceId: sequence.id, trackId: track.id, graphicsClipId: clip.id };
const inverseId = (commandId, ordinal) =>
  `${commandId.slice(0, 24)}${String(ordinal).padStart(12, "0")}`;

const cases = PRESET_FIXTURE_REQUESTS.map(({ name, request, number }) => {
  const commandId = `9e000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
  const result = applyMotionPreset(base.state, ref, request, commandId);
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  const applied = applyGraphicsGroup(base.state, [result.command], inverseId);
  if (!applied.ok) throw new Error(`${name}: ${applied.category}`);
  return {
    name,
    request,
    commands: [result.command],
    expectedGraphicsClips: applied.state.sequences[0].tracks[1].graphicsClips,
  };
});

writeFileSync(
  `${fixtures}graphics-preset-commands.json`,
  `${JSON.stringify({ base: "project-v2/valid-graphics.svpvideo", sequenceIndex: 0, trackIndex: 1, ref, cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} preset cases`);
