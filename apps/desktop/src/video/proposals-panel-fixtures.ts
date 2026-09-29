// Shared fixtures for ProposalsPanel unit and browser tests. Test-only.
import {
  createRationalTime,
  type CommandResult,
  type MediaContentIdentityV1,
  type ProjectProjection,
  type StoredProposal,
} from "@supa-video/contracts";
import { createTranscriptArtifactV1, type TranscriptArtifactV1 } from "@supa-video/media";
import type { TranscriptEditProposal } from "@supa-video/project";

import type { ProposalBackend } from "../proposal-ipc";

export const rate = { numerator: 10, denominator: 1 } as const;
export const id = (suffix: number): string =>
  `41000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
export const target = { sequenceId: id(12), trackId: id(13) };
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};

// "Hi um there uh again", one word every 0.5 s at 10 fps.
const texts = ["Hi", "um", "there", "uh", "again"] as const;

export async function artifact(): Promise<TranscriptArtifactV1> {
  return createTranscriptArtifactV1({
    sourceIdentity,
    sourceFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256",
      digest: "34".repeat(32),
      byteLength: 1_000,
      modifiedUnixSeconds: 1,
      modifiedNanoseconds: 0,
    },
    sourceDurationUs: 3_000_000,
    configuration: {
      schemaVersion: 1,
      engineId: "fixture-asr",
      engineVersion: "1",
      modelId: "fixture-model",
      modelRevision: "1",
      requestedLanguage: "en",
      task: "transcribe",
      wordTimingRequired: true,
      speakerDiarizationMode: "optional",
      chunkDurationUs: 3_000_000,
      chunkOverlapUs: 0,
      providerSettings: [],
    },
    chunks: [
      {
        schemaVersion: 1,
        chunkId: "chunk-0",
        chunkIndex: 0,
        sourceStartUs: 0,
        sourceEndUs: 3_000_000,
        words: texts.map((text, index) => ({
          text,
          relativeStartUs: index * 500_000,
          relativeEndUs: index * 500_000 + 400_000,
          recognitionConfidence: 1,
          speakerLabel: null,
          speakerConfidence: null,
          timingProvenance: "aligned" as const,
        })),
      },
    ],
  });
}

export const projection = {
  projectId: id(10),
  name: "Proposal fixture",
  revision: {
    number: 1,
    id: id(101),
    parentId: null,
    committedAt: "2026-09-28T12:00:00.000Z",
    operationId: id(102),
    stateHash: "03".repeat(32),
  },
  state: {
    assets: [
      {
        id: id(11),
        displayName: "talk.wav",
        locator: { absolutePath: "C:/media/talk.wav" },
        probe: {
          durationMicroseconds: 3_000_000,
          averageFrameRate: rate,
          realFrameRate: rate,
          variableFrameRate: false,
          width: 1_920,
          height: 1_080,
          videoCodecName: "h264",
          audio: { codecName: "aac", channels: 1, sampleRate: 16_000 },
          fileSizeBytes: sourceIdentity.byteLength,
        },
        contentIdentity: sourceIdentity,
      },
    ],
    sequences: [
      {
        id: target.sequenceId,
        name: "Main",
        rate,
        width: 1_920,
        height: 1_080,
        audioSampleRate: 48_000,
        tracks: [
          {
            id: target.trackId,
            name: "Video",
            kind: "video",
            clips: [
              {
                id: id(300),
                source: { kind: "asset", assetId: id(11) },
                timelineStart: createRationalTime(0, rate),
                sourceIn: createRationalTime(0, rate),
                sourceOut: createRationalTime(30, rate),
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
        markers: [],
      },
    ],
    activeSequenceId: target.sequenceId,
  },
  canUndo: false,
  canRedo: false,
  lastCommand: null,
  sources: [],
  journalHealth: "healthy",
  snapshotRevision: 1,
  recoveryStatus: "clean",
  replayedRecordCount: 1,
} as ProjectProjection;

export function stored(
  proposal: TranscriptEditProposal,
  status: StoredProposal["status"],
): StoredProposal {
  return {
    proposalId: proposal.proposalId,
    producer: proposal.producer,
    sequenceId: proposal.sequenceId,
    trackId: proposal.trackId,
    baseRevision: proposal.projectRevision,
    status,
    statusReason: null,
    createdAtMs: 1,
    expiresAtMs: 2,
    appliedGroupId: status === "applied" ? proposal.commandGroup.groupId : null,
    preApplyRevision: status === "applied" ? proposal.projectRevision : null,
    approvedRangeIds: [],
    restoreOperationId: null,
    restoreSteps: 0,
    proposal: JSON.parse(JSON.stringify(proposal)) as StoredProposal["proposal"],
  };
}

/** In-memory native side: keeps submitted proposals and records calls. */
type Tracked<F extends (...args: never[]) => unknown> = F & { readonly calls: Parameters<F>[] };

function track<F extends (...args: never[]) => unknown>(fn: F): Tracked<F> {
  const calls: Parameters<F>[] = [];
  const wrapped = ((...args: Parameters<F>) => {
    calls.push(args);
    return fn(...args);
  }) as F;
  return Object.assign(wrapped, { calls });
}

export function fakeBackend(
  enabled = true,
  options: { readonly applyFails?: boolean; readonly applyError?: Error } = {},
) {
  let proposals: StoredProposal[] = [];
  const result = { projectId: projection.projectId } as CommandResult;
  const backend = {
    getAgentProposalsEnabled: track(async () => enabled),
    listProposals: track(async () => ({ proposals, audit: [], storeDiscarded: false })),
    submitProposal: track(async (_projectId: string, proposal: TranscriptEditProposal) => {
      const entry = stored(proposal, "pending");
      proposals = [...proposals, entry];
      return entry;
    }),
    applyProposal: track(
      async (_p: string, proposalId: string, approved: TranscriptEditProposal) => {
        if (options.applyError !== undefined) throw options.applyError;
        if (options.applyFails === true) throw new Error("Native apply refused");
        if (approved.producer.id.length === 0)
          throw new Error("Approved proposal lacks a producer");
        proposals = proposals.map((entry) =>
          entry.proposalId === proposalId ? { ...entry, status: "applied" as const } : entry,
        );
        return result;
      },
    ),
    rejectProposal: track(async (_p: string, proposalId: string) => {
      proposals = proposals.map((entry) =>
        entry.proposalId === proposalId ? { ...entry, status: "rejected" as const } : entry,
      );
      return proposals[0] as StoredProposal;
    }),
    markProposalStale: track(async (_p: string, proposalId: string, reason: string) => {
      proposals = proposals.map((entry) =>
        entry.proposalId === proposalId
          ? { ...entry, status: "stale" as const, statusReason: reason }
          : entry,
      );
      return proposals[0] as StoredProposal;
    }),
    restoreBeforeProposal: track(async () => [result]),
  } satisfies ProposalBackend;
  return backend;
}
