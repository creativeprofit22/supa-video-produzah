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
