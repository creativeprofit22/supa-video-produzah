import { describe, expect, it } from "vitest";

import {
  MUSIC_BEAT_ANALYSIS_LIMITS,
  musicBeatAnalysisV1Schema,
  musicBeatDetectionResultSchema,
  musicBeatRuntimeStatusSchema,
  startMusicBeatDetectionRequestSchema,
  type MusicBeatAnalysisV1,
} from "./music-beats.js";

function analysis(
  overrides: Partial<Record<keyof MusicBeatAnalysisV1 | "narrativeBeats", unknown>> = {},
): unknown {
  return {
    schemaVersion: 1,
    detector: { kind: "tempo_fallback", version: "tempo-fallback-v1", checkpointSha256: null },
    durationUs: 4_000_000,
    tempoBpm: 120,
    beatsUs: [0, 500_000, 1_000_000, 1_500_000],
    downbeatsUs: [0],
    onsetsUs: [0, 500_000, 1_000_000],
    ...overrides,
  };
}

describe("music beat analysis schema", () => {
  it("accepts a sorted fallback analysis", () => {
    const parsed = musicBeatAnalysisV1Schema.parse(analysis());
    expect(parsed.beatsUs).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });

  it("accepts a Beat This! analysis with its checkpoint digest", () => {
    const parsed = musicBeatAnalysisV1Schema.safeParse(
      analysis({
        detector: { kind: "beat_this", version: "1.0.0", checkpointSha256: "a".repeat(64) },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["unsorted music beats", { beatsUs: [0, 1_000_000, 500_000] }],
    ["duplicate music beats", { beatsUs: [0, 0] }],
    ["negative times", { onsetsUs: [-1, 0] }],
    ["fractional times", { beatsUs: [0.5] }],
    ["times past the duration", { beatsUs: [0, 5_000_000] }],
    ["unknown detector", { detector: { kind: "madmom", version: "x", checkpointSha256: null } }],
    [
      "fallback with a checkpoint",
      {
        detector: { kind: "tempo_fallback", version: "x", checkpointSha256: "a".repeat(64) },
      },
    ],
    [
      "Beat This! without a checkpoint",
      { detector: { kind: "beat_this", version: "x", checkpointSha256: null } },
    ],
    ["tempo without music beats", { beatsUs: [], downbeatsUs: [], tempoBpm: 120 }],
    ["tempo out of range", { tempoBpm: 1_000 }],
    ["duration past one hour", { durationUs: 3_600_000_001 }],
    [
      "too many music beats",
      {
        durationUs: MUSIC_BEAT_ANALYSIS_LIMITS.maxDurationUs,
        beatsUs: Array.from({ length: MUSIC_BEAT_ANALYSIS_LIMITS.maxMusicBeats + 1 }, (_, i) => i),
      },
    ],
    ["unknown field", { narrativeBeats: [] }],
  ])("rejects %s", (_name, overrides) => {
    expect(musicBeatAnalysisV1Schema.safeParse(analysis(overrides)).success).toBe(false);
  });

  it("accepts an empty analysis of silence", () => {
    const parsed = musicBeatAnalysisV1Schema.safeParse(
      analysis({ beatsUs: [], downbeatsUs: [], onsetsUs: [], tempoBpm: null }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("music beat detection IPC schemas", () => {
  it("validates requests and results strictly", () => {
    expect(
      startMusicBeatDetectionRequestSchema.safeParse({
        projectId: "00000000-0000-4000-8000-000000000001",
        assetId: "00000000-0000-4000-8000-000000000002",
        sourcePath: "C:\\music.wav",
      }).success,
    ).toBe(true);
    expect(
      musicBeatDetectionResultSchema.safeParse({
        analysisKey: "b".repeat(64),
        detector: "tempo_fallback",
        musicBeatCount: 12,
        reused: false,
      }).success,
    ).toBe(true);
    expect(
      musicBeatDetectionResultSchema.safeParse({
        analysisKey: "B".repeat(64),
        detector: "tempo_fallback",
        musicBeatCount: 12,
        reused: false,
      }).success,
    ).toBe(false);
  });

  const status = (overrides: Record<string, unknown>): unknown => ({
    runtimeFolder: "C:\\beat-runtime",
    runtime: { state: "ready" },
    accelerator: { kind: "cuda" },
    manifestSha256: "c".repeat(64),
    beatThisVersion: "rs-1.1.0",
    checkpointSha256: "d".repeat(64),
    ...overrides,
  });

  it.each([
    ["ready on the GPU", {}],
    ["ready on the CPU", { accelerator: { kind: "cpu", reason: "cudaInitFailed" } }],
    [
      "a model problem",
      {
        runtime: { state: "unavailable", problem: { reason: "modelMismatch" } },
        accelerator: null,
      },
    ],
    [
      "a missing detector",
      {
        runtime: { state: "unavailable", problem: { reason: "detectorMissing" } },
        accelerator: null,
      },
    ],
  ])("accepts runtime status %s", (_name, overrides) => {
    expect(musicBeatRuntimeStatusSchema.safeParse(status(overrides)).success).toBe(true);
  });

  it.each([
    [
      "a retired Python problem",
      { runtime: { state: "unavailable", problem: { reason: "pythonMissing" } } },
    ],
    ["an unknown CPU reason", { accelerator: { kind: "cpu", reason: "tooHot" } }],
    ["a CPU accelerator without a reason", { accelerator: { kind: "cpu" } }],
    ["no accelerator field", { accelerator: undefined }],
  ])("rejects runtime status with %s", (_name, overrides) => {
    expect(musicBeatRuntimeStatusSchema.safeParse(status(overrides)).success).toBe(false);
  });
});
