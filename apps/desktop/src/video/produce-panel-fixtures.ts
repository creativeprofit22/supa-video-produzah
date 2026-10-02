import type { AcquisitionReceipt, ProjectProjection } from "@supa-video/contracts";
import { isMediaTrack } from "@supa-video/contracts";
import { createTranscriptArtifactV1, type TranscriptArtifactV1 } from "@supa-video/media";
import { firstCutFixtureSchema, type FirstCutFixture } from "@supa-video/produce";

import explainerFixture from "../../../../packages/video-produce/fixtures/v1/explainer.json";
import podcastFixture from "../../../../packages/video-produce/fixtures/v1/podcast.json";

/* Desktop test data built from the versioned first-cut package fixtures. */

export const explainer: FirstCutFixture = firstCutFixtureSchema.parse(explainerFixture);
export const podcast: FirstCutFixture = firstCutFixtureSchema.parse(podcastFixture);

export function projectionFor(fixture: FirstCutFixture): ProjectProjection {
  return {
    projectId: fixture.projectId,
    name: fixture.name,
    revision: {
      number: fixture.projectRevision,
      id: "0f000000-0000-4000-8000-000000000001",
      parentId: null,
      committedAt: "2026-09-29T09:00:00.000Z",
      operationId: "0f000000-0000-4000-8000-000000000002",
      stateHash: "0f".repeat(32),
    },
    state: fixture.state,
    canUndo: false,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: fixture.projectRevision,
    recoveryStatus: "clean",
    replayedRecordCount: 0,
  };
}

export function receiptsBackend(receipts: readonly AcquisitionReceipt[]) {
  const calls: (string | null)[] = [];
  return {
    calls,
    listRightsReceipts: async (
      projectId: string | null,
    ): Promise<readonly AcquisitionReceipt[]> => {
      calls.push(projectId);
      return receipts;
    },
  };
}

/** The podcast fixture's A-roll transcript as a real transcript artifact. */
export async function podcastArtifact(): Promise<TranscriptArtifactV1> {
  const transcript = podcast.transcripts[0];
  if (transcript === undefined) throw new Error("podcast fixture has no transcript");
  const endUs = Math.max(...transcript.words.map((word) => word.sourceEndUs));
  return createTranscriptArtifactV1({
    sourceIdentity: {
      schemaVersion: 1,
      algorithm: "sha256",
      digest: "11".repeat(32),
      byteLength: 1_000,
    },
    sourceFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256",
      digest: "12".repeat(32),
      byteLength: 1_000,
      modifiedUnixSeconds: 1,
      modifiedNanoseconds: 0,
    },
    sourceDurationUs: 60_000_000,
    configuration: {
      schemaVersion: 1,
      engineId: "fixture-asr",
      engineVersion: "1",
      modelId: "fixture-model",
      modelRevision: "1",
      requestedLanguage: transcript.language,
      task: "transcribe",
      wordTimingRequired: true,
      speakerDiarizationMode: "optional",
      chunkDurationUs: 60_000_000,
      chunkOverlapUs: 0,
      providerSettings: [],
    },
    chunks: [
      {
        schemaVersion: 1,
        chunkId: "chunk-0",
        chunkIndex: 0,
        sourceStartUs: 0,
        sourceEndUs: Math.max(endUs, 60_000_000),
        words: transcript.words.map((word) => ({
          text: word.text,
          relativeStartUs: word.sourceStartUs,
          relativeEndUs: word.sourceEndUs,
          recognitionConfidence: 1,
          speakerLabel: null,
          speakerConfidence: null,
          timingProvenance: "aligned" as const,
        })),
      },
    ],
  });
}

type ARoll = { readonly assetId: string; readonly clipIds: readonly string[] };

function podcastARollClip() {
  const source = podcast.source;
  if (source.workflow !== "podcast") throw new Error("podcast fixture");
  const clip = podcast.state.sequences
    .flatMap((sequence) => sequence.tracks)
    .flatMap((track) => (isMediaTrack(track) ? track.clips : []))
    .find((candidate) => candidate.id === source.aRollClipId);
  if (clip === undefined || clip.source.kind !== "asset") throw new Error("A-roll clip");
  return { clip, assetId: clip.source.assetId };
}

export function podcastARoll(): ARoll {
  const { clip, assetId } = podcastARollClip();
  return { assetId, clipIds: [clip.id] };
}

const SPLIT_CLIP_ID = "000000d1-0000-4000-8000-0000000000f2";

/** The podcast project after a transcript edit split the A-roll at `splitFrame`. */
export function splitPodcast(splitFrame: number): {
  readonly projection: ProjectProjection;
  readonly aRoll: ARoll;
} {
  const { clip, assetId } = podcastARollClip();
  const second = {
    ...clip,
    id: SPLIT_CLIP_ID,
    sourceIn: { ...clip.sourceIn, value: splitFrame },
    timelineStart: {
      ...clip.timelineStart,
      value: clip.timelineStart.value + splitFrame - clip.sourceIn.value,
    },
  };
  const first = { ...clip, sourceOut: { ...clip.sourceOut, value: splitFrame } };
  const base = projectionFor(podcast);
  return {
    projection: {
      ...base,
      state: {
        ...base.state,
        sequences: base.state.sequences.map((sequence) => ({
          ...sequence,
          tracks: sequence.tracks.map((track) =>
            !isMediaTrack(track)
              ? track
              : {
                  ...track,
                  clips: track.clips.flatMap((item) =>
                    item.id === clip.id ? [first, second] : [item],
                  ),
                },
          ),
        })),
      },
    },
    aRoll: { assetId, clipIds: [first.id, second.id] },
  };
}
