import {
  type CommandGroupRequest,
  type VideoAsset,
  type VideoProjectStateV2,
  type VideoSequenceV2,
  createRationalTime,
  microsecondsToSourceFrames,
  videoProjectStateV2Schema,
} from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { buildAssetIndex } from "./asset-index.js";
import { compileFirstCut } from "./compile-first-cut.js";
import { type FirstCutProposal, planFirstCut } from "./first-cut-proposal.js";
import { planBeatsFromScript } from "./plan-beats.js";
import { DEFAULT_RANKING_CONFIG } from "./ranking-config.js";
import { TEST_NOW_MS, TEST_PROJECT_ID, testAsset, testUuid } from "./test-support.js";

const RATE = { numerator: 30, denominator: 1 };
const SCRIPT = [
  "# Rivers",
  "The river cuts the canyon.",
  "A kayak on the river. [show: kayak]",
  "The bridge at dusk.",
  "Chart: yearly flow",
].join("\n");

function assets(): VideoAsset[] {
  return [
    testAsset({ id: testUuid(0x70, 1), name: "river canyon.mp4", durationUs: 6_000_000 }),
    testAsset({ id: testUuid(0x70, 2), name: "kayak river.mp4", durationUs: 6_000_000 }),
    testAsset({ id: testUuid(0x70, 3), name: "bridge dusk.mp4", durationUs: 1_900_000 }),
    testAsset({ id: testUuid(0x70, 4), name: "river bridge.mp4", durationUs: 9_000_000 }),
  ];
}

function state(): VideoProjectStateV2 {
  const list = assets();
  const sequence: VideoSequenceV2 = {
    id: testUuid(0x71, 1),
    name: "Sequence 1",
    rate: RATE,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      {
        id: testUuid(0x71, 2),
        name: "Video 1",
        kind: "video",
        clips: [
          {
            id: testUuid(0x71, 3),
            source: { kind: "asset", assetId: testUuid(0x70, 1) },
            timelineStart: createRationalTime(0, RATE),
            sourceIn: createRationalTime(0, RATE),
            sourceOut: createRationalTime(30, RATE),
            transform: {
              positionXPermille: 0,
              positionYPermille: 0,
              scaleXPermille: 1_000,
              scaleYPermille: 1_000,
              rotationMilliDegrees: 0,
              opacityPermille: 1_000,
            },
            gainMilliDecibels: 0,
          },
        ],
      },
    ],
    markers: [{ id: testUuid(0x71, 4), time: createRationalTime(5, RATE), label: "Existing" }],
  };
  return videoProjectStateV2Schema.parse({
    assets: list,
    sequences: [sequence],
    activeSequenceId: sequence.id,
  });
}

async function proposal(): Promise<FirstCutProposal> {
  const beats = planBeatsFromScript(SCRIPT, { language: "en" });
  if (!beats.ok) throw new Error(beats.error.code);
  const result = await planFirstCut({
    projectId: TEST_PROJECT_ID,
    projectRevision: 7,
    workflow: "explainer",
    beats: beats.value,
    index: buildAssetIndex({ assets: assets(), receipts: [] }),
    receipts: [],
    intendedUse: "private-preview",
    nowMs: TEST_NOW_MS,
    config: DEFAULT_RANKING_CONFIG,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function compile(overrides = {}, revision = 7) {
  const base = state();
  const sequence = base.sequences[0];
  if (sequence === undefined) throw new Error("sequence");
  return compileFirstCut({
    proposal: await proposal(),
    overrides,
    projectId: TEST_PROJECT_ID,
    revision,
    sequence,
    assets: base.assets,
  });
}

/** Mirrors the native InsertTrack/AddMarker semantics for invariant checks. */
function applyAdditive(
  base: VideoProjectStateV2,
  request: CommandGroupRequest,
): VideoProjectStateV2 {
  const next = structuredClone(base);
  for (const command of request.commands) {
    if (command.type !== "InsertTrack" && command.type !== "AddMarker") {
      throw new Error(`unexpected ${command.type}`);
    }
    const sequence = next.sequences.find((item) => item.id === command.sequenceId);
    if (sequence === undefined) throw new Error("unknown sequence");
    if (command.type === "InsertTrack") sequence.tracks.splice(command.index, 0, command.track);
    else sequence.markers.splice(command.index ?? sequence.markers.length, 0, command.marker);
  }
  return videoProjectStateV2Schema.parse(next);
}

describe("compileFirstCut", () => {
  it("adds only new tracks and markers, leaving existing timeline content untouched", async () => {
    const compiled = await compile();
    if (!compiled.ok) throw new Error(compiled.error.code);
    const { request } = compiled.value;
    expect(request.baseRevision).toBe(7);
    expect(request.commands.map((command) => command.type)).toEqual([
      "InsertTrack",
      "InsertTrack",
      "AddMarker",
    ]);
    const before = state();
    const after = applyAdditive(before, request);
    expect(after.sequences[0]?.tracks.slice(0, 1)).toEqual(before.sequences[0]?.tracks);
    expect(after.sequences[0]?.markers[0]).toEqual(before.sequences[0]?.markers[0]);
    expect(after.sequences[0]?.tracks.map((track) => track.name)).toEqual([
      "Video 1",
      "First cut",
      "First cut titles",
    ]);
  });

  it("places non-overlapping clips inside their beats and inside the source media", async () => {
    const plan = await proposal();
    const compiled = await compile();
    if (!compiled.ok) throw new Error(compiled.error.code);
    const track = compiled.value.request.commands[0];
    if (track?.type !== "InsertTrack" || track.track.kind !== "video")
      throw new Error("video track");
    const durations = new Map(
      assets().map((asset) => [asset.id, asset.probe.durationMicroseconds]),
    );
    let previousEnd = 0;
    for (const clip of track.track.clips) {
      const start = clip.timelineStart.value;
      const end = start + (clip.sourceOut.value - clip.sourceIn.value);
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = end;
      const beat = plan.beats.find(
        (item) => microsecondsToSourceFrames(item.beat.startUs, RATE).value === start,
      );
      expect(beat).toBeDefined();
      expect(end).toBe(microsecondsToSourceFrames(beat?.beat.endUs ?? 0, RATE).value);
      if (clip.source.kind !== "asset") throw new Error("asset clip");
      expect(clip.sourceOut.value).toBeLessThanOrEqual(
        microsecondsToSourceFrames(durations.get(clip.source.assetId) ?? 0, RATE).value,
      );
    }
    expect(compiled.value.clipCount).toBe(3);
    expect(compiled.value.captionCount).toBe(2);
    expect(compiled.value.markerCount).toBe(1);
  });

  it("is deterministic and changes ids when the reviewer overrides a beat", async () => {
    const first = await compile();
    const second = await compile();
    expect(second).toEqual(first);
    const plan = await proposal();
    const beat = plan.beats[3];
    const alternative = beat?.alternatives[0]?.candidate.assetId;
    if (beat === undefined || alternative === undefined) throw new Error("alternative");
    const swapped = await compile({
      [beat.beat.id]: { kind: "alternative", assetId: alternative },
    });
    if (!first.ok || !swapped.ok) throw new Error("compile");
    expect(swapped.value.request.groupId).not.toBe(first.value.request.groupId);
    const marked = await compile({ [beat.beat.id]: { kind: "unresolved" } });
    if (!marked.ok) throw new Error("compile");
    expect(marked.value.markerCount).toBe(2);
    expect(marked.value.clipCount).toBe(2);
  });

  it("keeps the unresolved marker label within limits for a very long unspaced beat", async () => {
    const plan = await proposal();
    const target = plan.beats[1];
    if (target === undefined) throw new Error("beat");
    const longWord = "x".repeat(600);
    const edited: FirstCutProposal = {
      ...plan,
      beats: plan.beats.map((item) =>
        item === target ? { ...item, beat: { ...item.beat, text: longWord } } : item,
      ),
    };
    const base = state();
    const sequence = base.sequences[0];
    if (sequence === undefined) throw new Error("sequence");

    const compiled = await compileFirstCut({
      proposal: edited,
      overrides: { [target.beat.id]: { kind: "unresolved" } },
      projectId: TEST_PROJECT_ID,
      revision: 7,
      sequence,
      assets: base.assets,
    });

    if (!compiled.ok) throw new Error(compiled.error.code);
    const labels = compiled.value.request.commands.flatMap((command) =>
      command.type === "AddMarker" ? [command.marker.label] : [],
    );
    const label = labels.find((item) => item.includes("xxx"));
    expect(label).toBeDefined();
    expect(label?.length).toBeLessThanOrEqual(512);
    expect(label?.endsWith("…")).toBe(true);
  });

  it.each([
    ["stale revision", {}, 8, "stale-proposal"],
    ["unknown alternative", "unknown", 7, "unknown-alternative"],
  ] as const)("rejects %s", async (_name, overrides, revision, code) => {
    const plan = await proposal();
    const beatId = plan.beats[1]?.beat.id ?? "";
    const result = await compile(
      overrides === "unknown"
        ? { [beatId]: { kind: "alternative", assetId: testUuid(0x7f, 1) } }
        : overrides,
      revision,
    );
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});
