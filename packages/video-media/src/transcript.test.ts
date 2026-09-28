import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  asrConfigurationV1Schema,
  createTranscriptArtifactV1,
  deriveAsrConfigurationIdentity,
  normalizeTranscriptChunks,
  transcriptArtifactV1Schema,
  type AsrConfigurationV1,
  type CreateTranscriptArtifactV1Input,
  type TranscriptArtifactV1,
  type TranscriptChunkInputV1,
} from "./transcript.js";

interface TranscriptFixture extends CreateTranscriptArtifactV1Input {
  schemaVersion: 1;
  configurationIdentity: unknown;
  artifact: TranscriptArtifactV1;
}

interface ProviderNumberVector {
  name: string;
  value: number;
}

interface AcceptedProviderNumberVector extends ProviderNumberVector {
  expectedDigest: string;
}

interface ProviderNumberFixture {
  schemaVersion: 1;
  baseConfiguration: AsrConfigurationV1;
  accepted: AcceptedProviderNumberVector[];
  rejected: ProviderNumberVector[];
}

async function readFixture(): Promise<TranscriptFixture> {
  return JSON.parse(
    await readFile(new URL("../fixtures/transcript-artifact-v1.json", import.meta.url), "utf8"),
  ) as TranscriptFixture;
}

async function readProviderNumberFixture(): Promise<ProviderNumberFixture> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/transcript-provider-number-v1.json", import.meta.url),
      "utf8",
    ),
  ) as ProviderNumberFixture;
}

function configurationWithProviderNumber(
  baseConfiguration: AsrConfigurationV1,
  value: number,
): AsrConfigurationV1 {
  return {
    ...baseConfiguration,
    providerSettings: [{ key: "numeric_value", value }],
  };
}

describe("transcript V1 contract", () => {
  it("matches deterministic framed configuration and artifact identity vectors", async () => {
    const fixture = await readFixture();
    expect(await deriveAsrConfigurationIdentity(fixture.configuration)).toEqual(
      fixture.configurationIdentity,
    );
    expect(await createTranscriptArtifactV1(fixture)).toEqual(fixture.artifact);
    expect(transcriptArtifactV1Schema.parse(fixture.artifact)).toEqual(fixture.artifact);

    const changedContent = structuredClone(fixture);
    changedContent.chunks[0]!.words[2]!.text = "different recognition output";
    const changedArtifact = await createTranscriptArtifactV1(changedContent);
    expect(changedArtifact.identity.key).toBe(fixture.artifact.identity.key);
    expect(changedArtifact.words).not.toEqual(fixture.artifact.words);
  });

  it("enforces shared provider-number identity vectors", async () => {
    const fixture = await readProviderNumberFixture();

    for (const vector of fixture.accepted) {
      const configuration = configurationWithProviderNumber(
        fixture.baseConfiguration,
        vector.value,
      );
      expect(asrConfigurationV1Schema.safeParse(configuration).success, vector.name).toBe(true);
      expect((await deriveAsrConfigurationIdentity(configuration)).digest, vector.name).toBe(
        vector.expectedDigest,
      );
    }

    for (const vector of fixture.rejected) {
      const configuration = configurationWithProviderNumber(
        fixture.baseConfiguration,
        vector.value,
      );
      expect(asrConfigurationV1Schema.safeParse(configuration).success, vector.name).toBe(false);
      await expect(deriveAsrConfigurationIdentity(configuration), vector.name).rejects.toThrow();
    }

    const zero = fixture.accepted.find((vector) => vector.name === "zero")!;
    const negativeZero = fixture.accepted.find((vector) => vector.name === "negative-zero")!;
    expect(Object.is(negativeZero.value, -0)).toBe(true);
    await expect(
      deriveAsrConfigurationIdentity(
        configurationWithProviderNumber(fixture.baseConfiguration, negativeZero.value),
      ),
    ).resolves.toEqual(
      await deriveAsrConfigurationIdentity(
        configurationWithProviderNumber(fixture.baseConfiguration, zero.value),
      ),
    );
  });

  it("normalizes chunk-relative integer microseconds, clamps, merges, and deduplicates", async () => {
    const fixture = await readFixture();
    const normalized = normalizeTranscriptChunks(fixture.chunks, fixture.sourceDurationUs);

    expect(normalized.chunks.map((chunk) => [chunk.chunkIndex, chunk.sourceStartUs])).toEqual([
      [0, 0],
      [1, 500_000],
    ]);
    expect(normalized.words.map((word) => word.text)).toEqual([
      "early",
      "hello",
      "repaired",
      "overlap",
      "world",
      "late",
      "bounded",
    ]);
    expect(normalized.words.find((word) => word.text === "early")).toMatchObject({
      sourceStartUs: 0,
      sourceEndUs: 50_000,
      timingProvenance: "clamped",
    });
    expect(normalized.words.find((word) => word.text === "bounded")).toMatchObject({
      sourceStartUs: 1_050_000,
      sourceEndUs: 1_100_000,
      timingProvenance: "clamped",
    });
    expect(normalized.words.find((word) => word.text === "overlap")).toMatchObject({
      wordId: "chunk-b:0",
      recognitionConfidence: 0.95,
    });
    expect(normalized.uncertaintyCounts).toEqual({
      missingConfidenceWordCount: 2,
      missingSpeakerWordCount: 2,
      estimatedTimingWordCount: 1,
      clampedTimingWordCount: 2,
      retainedOverlapWordCount: 1,
      removedExactDuplicateWordCount: 1,
    });
  });

  it("accepts a zero-word chunk from a silent transcription piece", async () => {
    const fixture = await readFixture();
    const word = {
      recognitionConfidence: 0.9,
      speakerLabel: null,
      speakerConfidence: null,
      timingProvenance: "aligned",
    } as const;
    const chunks: TranscriptChunkInputV1[] = [
      {
        schemaVersion: 1,
        chunkId: "piece-0",
        chunkIndex: 0,
        sourceStartUs: 0,
        sourceEndUs: 400_000,
        words: [{ ...word, text: "hello", relativeStartUs: 0, relativeEndUs: 100_000 }],
      },
      {
        schemaVersion: 1,
        chunkId: "piece-1",
        chunkIndex: 1,
        sourceStartUs: 400_000,
        sourceEndUs: 800_000,
        words: [],
      },
      {
        schemaVersion: 1,
        chunkId: "piece-2",
        chunkIndex: 2,
        sourceStartUs: 800_000,
        sourceEndUs: 1_200_000,
        words: [{ ...word, text: "again", relativeStartUs: 50_000, relativeEndUs: 200_000 }],
      },
    ];

    const artifact = await createTranscriptArtifactV1({ ...fixture, chunks });
    const parsed = transcriptArtifactV1Schema.parse(artifact);

    expect(parsed.chunks.map((chunk) => chunk.words.length)).toEqual([1, 0, 1]);
    expect(parsed.chunks[1]).toMatchObject({ sourceStartUs: 400_000, sourceEndUs: 800_000 });
    expect(parsed.words.map((entry) => [entry.text, entry.sourceStartUs])).toEqual([
      ["hello", 0],
      ["again", 850_000],
    ]);
  });

  it("accepts a Rust-built multi-piece artifact with a silent piece and a clamped boundary word", async () => {
    // Written by the Rust test multichunk_artifact_matches_the_shared_fixture_bytes.
    const raw: unknown = JSON.parse(
      await readFile(
        new URL("../fixtures/transcript-artifact-multichunk-v1.json", import.meta.url),
        "utf8",
      ),
    );

    const result = transcriptArtifactV1Schema.safeParse(raw);

    expect(result.error?.issues).toBeUndefined();
    const artifact = result.data!;
    expect(artifact.chunks.map((chunk) => chunk.words.length)).toEqual([4, 0, 2]);
    expect(artifact.chunks[1]!.words).toEqual([]);
    expect(artifact.uncertaintyCounts.clampedTimingWordCount).toBe(1);
    expect(artifact.words.find((word) => word.text === "boundary")).toMatchObject({
      sourceEndUs: 240_000_000,
      timingProvenance: "clamped",
    });
    expect(artifact.words.find((word) => word.text === "resumed")?.sourceStartUs).toBe(480_000_000);
    expect(artifact.words.map((word) => word.speakerLabel)).toEqual([
      "speaker_1",
      null,
      "speaker_2",
      "speaker_1",
      "speaker_2",
      "speaker_1",
    ]);
  });

  it("accepts diarizer speaker labels and counts unlabelled words", async () => {
    const fixture = await readFixture();
    // Mirrors the native runner: Sortformer speaker N becomes "speaker_N";
    // untagged words keep null, and speaker confidence is never invented.
    const speakers = ["speaker_1", "speaker_2", null, "speaker_2"] as const;
    const words = speakers.map((speakerLabel, index) => ({
      text: `word${index}`,
      relativeStartUs: index * 200_000,
      relativeEndUs: index * 200_000 + 100_000,
      recognitionConfidence: 0.9,
      speakerLabel,
      speakerConfidence: null,
      timingProvenance: "aligned" as const,
    }));
    const chunk: TranscriptChunkInputV1 = {
      ...fixture.chunks[0]!,
      sourceStartUs: 0,
      words,
    };
    const artifact = await createTranscriptArtifactV1({
      ...fixture,
      configuration: { ...fixture.configuration, chunkDurationUs: 1_000_000, chunkOverlapUs: 0 },
      chunks: [chunk],
    });

    expect(artifact.words.map((word) => word.speakerLabel)).toEqual(speakers);
    expect(artifact.words.every((word) => word.speakerConfidence === null)).toBe(true);
    expect(artifact.uncertaintyCounts.missingSpeakerWordCount).toBe(1);
    expect(transcriptArtifactV1Schema.parse(artifact)).toEqual(artifact);

    const blankLabel = structuredClone(artifact);
    blankLabel.words[0]!.speakerLabel = "  ";
    expect(transcriptArtifactV1Schema.safeParse(blankLabel).success).toBe(false);
  });

  it("changes configuration identity with the diarization mode and diarizer hash", async () => {
    const fixture = await readFixture();
    const off: AsrConfigurationV1 = {
      ...fixture.configuration,
      speakerDiarizationMode: "off",
      providerSettings: [{ key: "device", value: "cuda:0" }],
    };
    const optional: AsrConfigurationV1 = {
      ...off,
      speakerDiarizationMode: "optional",
      providerSettings: [
        { key: "device", value: "cuda:0" },
        { key: "diarizer_sha256", value: "1".repeat(64) },
      ],
    };
    const otherDiarizer: AsrConfigurationV1 = {
      ...optional,
      providerSettings: [
        { key: "device", value: "cuda:0" },
        { key: "diarizer_sha256", value: "2".repeat(64) },
      ],
    };
    const digests = await Promise.all(
      [
        off,
        optional,
        otherDiarizer,
        { ...optional, speakerDiarizationMode: "required" as const },
      ].map(async (configuration) => (await deriveAsrConfigurationIdentity(configuration)).digest),
    );
    expect(new Set(digests).size).toBe(4);
  });

  it("invalidates identities for ASR or source changes but not transcript content", async () => {
    const fixture = await readFixture();
    const baseline = await createTranscriptArtifactV1(fixture);
    const changedConfiguration: AsrConfigurationV1 = {
      ...fixture.configuration,
      engineVersion: "1.7.6",
    };
    const changedConfigArtifact = await createTranscriptArtifactV1({
      ...fixture,
      configuration: changedConfiguration,
    });
    expect(changedConfigArtifact.identity.key).not.toBe(baseline.identity.key);

    const changedFingerprintArtifact = await createTranscriptArtifactV1({
      ...fixture,
      sourceFingerprint: {
        ...fixture.sourceFingerprint,
        modifiedNanoseconds: fixture.sourceFingerprint.modifiedNanoseconds + 1,
      },
    });
    expect(changedFingerprintArtifact.identity.key).not.toBe(baseline.identity.key);

    const changedContentIdentityArtifact = await createTranscriptArtifactV1({
      ...fixture,
      sourceIdentity: {
        ...fixture.sourceIdentity,
        digest: "3".repeat(64),
      },
    });
    expect(changedContentIdentityArtifact.identity.key).not.toBe(baseline.identity.key);
  });

  it("enforces strict sorted configuration and positive source intersections", async () => {
    const fixture = await readFixture();
    expect(
      asrConfigurationV1Schema.safeParse({ ...fixture.configuration, unframedOption: true })
        .success,
    ).toBe(false);
    expect(
      asrConfigurationV1Schema.safeParse({
        ...fixture.configuration,
        providerSettings: [...fixture.configuration.providerSettings].reverse(),
      }).success,
    ).toBe(false);

    const outsideChunk: TranscriptChunkInputV1 = {
      ...fixture.chunks[0]!,
      chunkId: "outside",
      chunkIndex: 99,
      sourceStartUs: 1_300_000,
      sourceEndUs: 1_400_000,
    };
    expect(() => normalizeTranscriptChunks([outsideChunk], fixture.sourceDurationUs)).toThrow(
      /does not intersect/,
    );

    const noWordIntersection: TranscriptChunkInputV1 = {
      ...fixture.chunks[0]!,
      words: [
        {
          ...fixture.chunks[0]!.words[0]!,
          relativeStartUs: 700_000,
          relativeEndUs: 800_000,
        },
      ],
    };
    expect(() => normalizeTranscriptChunks([noWordIntersection], fixture.sourceDurationUs)).toThrow(
      /no positive source intersection/,
    );
  });
});
