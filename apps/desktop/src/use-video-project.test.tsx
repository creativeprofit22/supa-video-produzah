// @vitest-environment jsdom

import { commandGroupRequestSchema, VideoDomainError } from "@supa-video/contracts";
import type {
  CommandGroupRequest,
  CommandResult,
  ProjectProjection,
  RenderPlan,
} from "@supa-video/contracts";
import { captionArtifactV1Schema, transcriptArtifactV1Schema } from "@supa-video/media";
import { createTranscriptEditProposal, projectTranscriptToTimeline } from "@supa-video/project";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useVideoProject } from "./use-video-project";
import type { VideoBackend, VideoRenderNotification } from "./video-ipc";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const timestamp = "2026-07-26T12:00:00.000Z";
const hash = "a".repeat(64);
const probe = {
  durationMicroseconds: 2_000_000,
  averageFrameRate: { numerator: 30, denominator: 1 },
  realFrameRate: { numerator: 30, denominator: 1 },
  variableFrameRate: false,
  width: 320,
  height: 180,
  videoCodecName: "h264",
  audio: null,
  fileSizeBytes: 1000,
} as const;
const sourceIdentity = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: probe.fileSizeBytes,
} as const;
const profileIdentity = {
  schemaVersion: 1,
  profileId: "preview-v1",
  profileDigest: "34".repeat(32),
} as const;
const identityBase = {
  schemaVersion: 1,
  sourceIdentity,
  toolchainId: "ffmpeg-test-v1",
  profileIdentity,
  recipeDigest: "56".repeat(32),
} as const;
const prepared = {
  sourceFingerprint: {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: "78".repeat(32),
    byteLength: probe.fileSizeBytes,
    modifiedUnixSeconds: 1_720_000_000,
    modifiedNanoseconds: 42,
  },
  sourceIdentity,
  sourceProbe: probe,
  sequenceRate: probe.averageFrameRate,
  profileIdentity,
  proxyIdentity: { ...identityBase, artifactKind: "proxy", key: "9a".repeat(32) },
  proxyPath: "C:\\Cache\\proxy.mp4",
  proxyProbe: probe,
  thumbnailIdentity: {
    ...identityBase,
    artifactKind: "thumbnail_tile",
    key: "bc".repeat(32),
  },
  thumbnailPath: "C:\\Cache\\thumb.jpg",
} as const;

function emptyProjection(revision = 0): ProjectProjection {
  return {
    projectId: id(1),
    name: "Canonical project",
    revision: {
      number: revision,
      id: id(100 + revision),
      parentId: revision === 0 ? null : id(99 + revision),
      committedAt: timestamp,
      operationId: id(200 + revision),
      stateHash: hash,
    },
    state: { assets: [], sequences: [], activeSequenceId: null },
    canUndo: false,
    canRedo: false,
    lastCommand: null,
    sources: [],
    journalHealth: "healthy",
    snapshotRevision: 0,
    recoveryStatus: "clean",
    replayedRecordCount: 0,
  };
}

function clipProjection(revision = 1, sourceIn = 0, sourceOut = 60): ProjectProjection {
  return {
    ...emptyProjection(revision),
    canUndo: true,
    state: {
      assets: [
        {
          id: id(2),
          displayName: "clip.mp4",
          locator: { absolutePath: "C:\\Media\\clip.mp4" },
          probe,
          contentIdentity: sourceIdentity,
        },
      ],
      sequences: [
        {
          id: id(3),
          name: "Sequence 1",
          rate: probe.averageFrameRate,
          width: 320,
          height: 180,
          audioSampleRate: 48_000,
          markers: [],
          tracks: [
            {
              id: id(4),
              name: "Video 1",
              kind: "video",
              clips: [
                {
                  id: id(5),
                  source: { kind: "asset", assetId: id(2) },
                  timelineStart: { value: 0, rateNumerator: 30, rateDenominator: 1 },
                  sourceIn: { value: sourceIn, rateNumerator: 30, rateDenominator: 1 },
                  sourceOut: { value: sourceOut, rateNumerator: 30, rateDenominator: 1 },
                  transform: {
                    positionXPermille: 0,
                    positionYPermille: 0,
                    scaleXPermille: 1000,
                    scaleYPermille: 1000,
                    rotationMilliDegrees: 0,
                    opacityPermille: 1000,
                  },
                  gainMilliDecibels: 0,
                },
              ],
            },
          ],
        },
      ],
      activeSequenceId: id(3),
    },
    sources: [{ assetId: id(2), status: "resolved", resolvedPath: "C:\\Media\\clip.mp4" }],
  };
}

const transcriptWord = {
  wordId: "chunk-0:0",
  chunkId: "chunk-0",
  chunkIndex: 0,
  wordIndex: 0,
  text: "remove",
  sourceStartUs: 0,
  sourceEndUs: probe.durationMicroseconds,
  recognitionConfidence: 0.99,
  speakerLabel: null,
  speakerConfidence: null,
  timingProvenance: "aligned",
} as const;

const transcriptArtifact = transcriptArtifactV1Schema.parse({
  schemaVersion: 1,
  identity: {
    schemaVersion: 1,
    key: "9a".repeat(32),
    sourceIdentity,
    sourceFingerprint: {
      schemaVersion: 1,
      algorithm: "sha256",
      digest: "bc".repeat(32),
      byteLength: probe.fileSizeBytes,
      modifiedUnixSeconds: 1_720_000_000,
      modifiedNanoseconds: 42,
    },
    configurationIdentity: {
      schemaVersion: 1,
      algorithm: "sha256",
      digest: "de".repeat(32),
    },
  },
  sourceDurationUs: probe.durationMicroseconds,
  configuration: {
    schemaVersion: 1,
    engineId: "test-asr",
    engineVersion: "1.0.0",
    modelId: "test-model",
    modelRevision: "test-revision",
    requestedLanguage: "en",
    task: "transcribe",
    wordTimingRequired: true,
    speakerDiarizationMode: "off",
    chunkDurationUs: probe.durationMicroseconds,
    chunkOverlapUs: 0,
    providerSettings: [],
  },
  chunks: [
    {
      schemaVersion: 1,
      chunkId: "chunk-0",
      chunkIndex: 0,
      sourceStartUs: 0,
      sourceEndUs: probe.durationMicroseconds,
      words: [transcriptWord],
    },
  ],
  words: [transcriptWord],
  uncertaintyCounts: {
    missingConfidenceWordCount: 0,
    missingSpeakerWordCount: 1,
    estimatedTimingWordCount: 0,
    clampedTimingWordCount: 0,
    retainedOverlapWordCount: 0,
    removedExactDuplicateWordCount: 0,
  },
});

function managedTranscriptLoader(...artifacts: readonly (typeof transcriptArtifact)[]) {
  const artifactsByKey = new Map(artifacts.map((artifact) => [artifact.identity.key, artifact]));
  return vi.fn<VideoBackend["loadManagedTranscriptArtifact"]>(async (key) => {
    const artifact = artifactsByKey.get(key);
    if (artifact === undefined)
      throw new VideoDomainError("invalid_project", "Managed transcript fixture is missing", {
        category: "cache_miss",
        path: "C:\\private\\transcripts",
      });
    return structuredClone(artifact);
  });
}

function captionedProjection(revision = 1): ProjectProjection {
  const projection = clipProjection(revision);
  const sequence = projection.state.sequences[0]!;
  sequence.tracks.push({
    id: id(6),
    name: "Captions",
    kind: "caption",
    captions: [],
    activeCaptionArtifact: captionArtifactV1Schema.parse({
      schemaVersion: 1,
      trackLink: {
        schemaVersion: 1,
        projectId: projection.projectId,
        projectRevision: emptyProjection(revision - 1).revision,
        sequenceId: sequence.id,
        captionTrackId: id(6),
      },
      sourceIdentity,
      transcriptArtifactIdentityKey: transcriptArtifact.identity.key,
      language: "en-US",
      timelineRate: probe.averageFrameRate,
      style: {
        schemaVersion: 1,
        typography: {
          fontFamily: "Inter",
          fontSizePx: 48,
          fontWeight: 600,
          fontStyle: "normal",
          lineHeightPermille: 1_200,
          foregroundColorRgba: "#ffffffff",
        },
        alignment: { horizontal: "center", vertical: "bottom" },
      },
      validationProfile: {
        schemaVersion: 1,
        maxLinesPerCue: 2,
        maxCharactersPerLine: 80,
        maxCharactersPerSecond: 100,
        minimumCueDuration: { value: 1, rateNumerator: 30, rateDenominator: 1 },
        maximumCueDuration: { value: 120, rateNumerator: 30, rateDenominator: 1 },
        safeArea: {
          topPermille: 50,
          rightPermille: 50,
          bottomPermille: 50,
          leftPermille: 50,
        },
      },
      cues: [
        {
          schemaVersion: 1,
          cueId: "cue-1",
          start: { value: 0, rateNumerator: 30, rateDenominator: 1 },
          end: { value: 60, rateNumerator: 30, rateDenominator: 1 },
          lines: ["remove"],
          anchor: { xPermille: 500, yPermille: 900 },
          sourceLinks: [
            {
              transcriptArtifactIdentityKey: transcriptArtifact.identity.key,
              sourceStartUs: 0,
              sourceEndUs: probe.durationMicroseconds,
              transcriptWordIds: [transcriptWord.wordId],
            },
          ],
        },
      ],
    }),
  });
  return projection;
}

async function transcriptEditProposal(projection: ProjectProjection) {
  const timeline = projectTranscriptToTimeline({
    artifact: transcriptArtifact,
    projection,
    sequenceId: id(3),
    trackId: id(4),
  });
  const occurrence = timeline.occurrences[0];
  if (occurrence === undefined) throw new Error("Expected transcript occurrence fixture");
  return createTranscriptEditProposal({
    artifact: transcriptArtifact,
    projection,
    sequenceId: id(3),
    trackId: id(4),
    deletedOccurrenceIds: [occurrence.occurrenceId],
  });
}

function cleanOpenResult(projection: ProjectProjection) {
  return {
    projection,
    recovery: {
      status: "clean" as const,
      recoveredRevision: projection.revision.number,
      replayedRecordCount: 0,
      discardedTailBytes: 0,
      message: "Clean",
      legacyHistoryReset: false,
    },
  };
}

function multitrackProjection(revision = 1): ProjectProjection {
  const projection = clipProjection(revision);
  projection.state.assets[0]!.probe = {
    ...projection.state.assets[0]!.probe,
    audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
  };
  const sequence = projection.state.sequences[0]!;
  const topTrack = sequence.tracks[0]!;
  if (topTrack.kind !== "video") throw new Error("Expected video track fixture");
  topTrack.muted = true;
  const secondaryAssetId = id(8);
  projection.state.assets.push({
    ...structuredClone(projection.state.assets[0]!),
    id: secondaryAssetId,
    displayName: "secondary.mp4",
  });
  projection.sources.push({
    assetId: secondaryAssetId,
    status: "resolved",
    resolvedPath: "C:\\Media\\secondary.mp4",
  });
  sequence.tracks.push({
    ...structuredClone(topTrack),
    id: id(6),
    name: "Video 2",
    hidden: true,
    muted: false,
    clips: [
      {
        ...structuredClone(topTrack.clips[0]!),
        id: id(7),
        source: { kind: "asset", assetId: secondaryAssetId },
      },
    ],
  });
  return projection;
}

function rippleProjection(revision = 1): ProjectProjection {
  const projection = clipProjection(revision, 0, 20);
  const track = projection.state.sequences[0]!.tracks[0]!;
  if (track.kind === "caption") throw new Error("Expected clip track fixture");
  const successor = {
    ...structuredClone(track.clips[0]!),
    id: id(6),
    timelineStart: { value: 30, rateNumerator: 30, rateDenominator: 1 },
    sourceIn: { value: 20, rateNumerator: 30, rateDenominator: 1 },
    sourceOut: { value: 50, rateNumerator: 30, rateDenominator: 1 },
  };
  track.clips.push(successor);
  return projection;
}

function addRippleCaptionTrack(
  projection: ProjectProjection,
  trackId: string,
  artifactSourceIdentity = sourceIdentity,
  transcriptIdentityKey = transcriptArtifact.identity.key,
): void {
  const template = captionedProjection(projection.revision.number).state.sequences[0]!.tracks[1]!;
  if (template.kind !== "caption" || template.activeCaptionArtifact === undefined)
    throw new Error("Expected active caption fixture");
  const track = structuredClone(template);
  const artifact = track.activeCaptionArtifact;
  if (artifact === undefined) throw new Error("Expected cloned active caption fixture");
  track.id = trackId;
  artifact.trackLink.captionTrackId = trackId;
  artifact.sourceIdentity = artifactSourceIdentity;
  artifact.transcriptArtifactIdentityKey = transcriptIdentityKey;
  for (const cue of artifact.cues) {
    for (const link of cue.sourceLinks) link.transcriptArtifactIdentityKey = transcriptIdentityKey;
  }
  projection.state.sequences[0]!.tracks.push(track);
}

function rippleCaptionedProjection(revision = 1): ProjectProjection {
  const projection = rippleProjection(revision);
  addRippleCaptionTrack(projection, id(10));
  return projection;
}

const secondarySourceIdentity = {
  ...sourceIdentity,
  digest: "13".repeat(32),
} as const;
const secondaryTranscriptKey = "b".repeat(64);

function commandResult(
  prior: ProjectProjection,
  next: ProjectProjection,
  operationId: string,
  groupId = operationId,
): CommandResult {
  return {
    projectId: next.projectId,
    operationId,
    groupId,
    priorRevision: prior.revision,
    newRevision: next.revision,
    stateHash: next.revision.stateHash,
    projection: next,
    affectedRanges: [],
    cacheInvalidations: [],
    events: [],
  };
}

function withCheckpointWarning(
  result: CommandResult,
  source: "event" | "projection",
): CommandResult {
  return {
    ...result,
    projection:
      source === "projection"
        ? { ...result.projection, journalHealth: "snapshot_pending" }
        : result.projection,
    events:
      source === "event"
        ? [{ type: "snapshot_warning", message: "Periodic snapshot checkpoint failed" }]
        : [],
  };
}

function createBackend(overrides: Partial<VideoBackend> = {}): VideoBackend {
  return {
    getVideoToolStatus: vi.fn(async () => ({
      source: "bundled" as const,
      toolchainId: "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
      ffmpeg: { available: true, version: "8.1.2" },
      ffprobe: { available: true, version: "8.1.2" },
      ready: true,
    })),
    pickNewVideoProjectPath: vi.fn(async () => "C:\\Projects\\canonical.svpvideo"),
    createVideoProject: vi.fn(async () => emptyProjection()),
    openVideoProject: vi.fn(async () => null),
    executeVideoProjectGroup: vi.fn(async () => {
      throw new Error("unexpected execute");
    }),
    undoVideoProject: vi.fn(async () => {
      throw new Error("unexpected undo");
    }),
    redoVideoProject: vi.fn(async () => {
      throw new Error("unexpected redo");
    }),
    getVideoProjectInspector: vi.fn(async () => {
      throw new Error("unexpected inspector");
    }),
    closeVideoProject: vi.fn(async () => undefined),
    relinkVideoProjectAsset: vi.fn(async () => null),
    pickVideoSource: vi.fn(async () => null),
    probeVideoSource: vi.fn(async () => probe),
    prepareVideoAsset: vi.fn(async () => prepared),
    pickVideoExportPath: vi.fn(async () => null),
    startVideoRender: vi.fn(async () => ({ jobId: id(90), planId: id(91), revisionId: id(92) })),
    cancelVideoRender: vi.fn(async () => undefined),
    listenVideoRenderEvents: vi.fn(async () => () => undefined),
    listMediaJobs: vi.fn(async () => ({
      schemaVersion: 1 as const,
      jobs: [],
      unsettledParentCount: 0,
      nextBeforeUpdatedAt: null,
      nextBeforeJobId: null,
      latestEventId: 0,
      recovery: null,
    })),
    getMediaJobEvents: vi.fn(async () => ({
      schemaVersion: 1 as const,
      events: [],
      latestEventId: 0,
      hasMore: false,
    })),
    cancelMediaJob: vi.fn(async () => {
      throw new Error("unexpected media job cancellation");
    }),
    retryMediaJob: vi.fn(async () => {
      throw new Error("unexpected media job retry");
    }),
    reauthorizeMediaJobOutput: vi.fn(async () => {
      throw new Error("unexpected media job output reauthorization");
    }),
    getMediaCacheStatus: vi.fn(async () => ({
      schemaVersion: 1 as const,
      budgetBytes: 1_000_000,
      managedBytes: 0,
      leasedBytes: 0,
      reclaimableBytes: 0,
      artifactCount: 0,
      leasedArtifactCount: 0,
      pressure: "normal" as const,
      legacyBytes: 0,
      legacyEntryCount: 0,
      legacyUnsafeEntryCount: 0,
      legacyClearAvailable: false,
      recoveryWarning: null,
      refreshedAt: timestamp,
    })),
    clearLegacyMediaCache: vi.fn(async () => {
      throw new Error("unexpected legacy cache clear");
    }),
    loadManagedTranscriptArtifact: vi.fn(async () => {
      throw new Error("unexpected managed transcript load");
    }),
    listenMediaJobEvents: vi.fn(async () => () => undefined),
    convertFileSrc: vi.fn((path: string) => `asset:${path}`),
    ...overrides,
  };
}

describe("canonical project controller", () => {
  it("creates through Rust and never saves arbitrary project JSON", async () => {
    const backend = createBackend();
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());
    expect(backend.createVideoProject).toHaveBeenCalledWith(
      "C:\\Projects\\canonical.svpvideo",
      "canonical",
    );
    expect(result.current.projection?.revision.number).toBe(0);
  });

  it("consumes snapshot warning events from grouped import command results", async () => {
    const empty = emptyProjection();
    const imported = clipProjection(1);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const commandResultValue = withCheckpointWarning(
        commandResult(empty, imported, request.groupId),
        "event",
      );
      const importedAsset = request.commands.find((command) => command.type === "ImportAsset");
      const createdSequence = request.commands.find((command) => command.type === "CreateSequence");
      const insertedClip = request.commands.find((command) => command.type === "InsertClip");
      if (
        importedAsset?.type === "ImportAsset" &&
        createdSequence?.type === "CreateSequence" &&
        insertedClip?.type === "InsertClip"
      ) {
        commandResultValue.projection.state.assets = [importedAsset.asset];
        const sequence = structuredClone(createdSequence.sequence);
        const track = sequence.tracks.find((item) => item.id === insertedClip.trackId);
        if (track !== undefined && track.kind !== "caption") track.clips.push(insertedClip.clip);
        commandResultValue.projection.state.sequences = [sequence];
        commandResultValue.projection.state.activeSequenceId = sequence.id;
        commandResultValue.projection.sources = [
          {
            assetId: importedAsset.asset.id,
            status: "resolved",
            resolvedPath: importedAsset.asset.locator.absolutePath ?? "C:\\Media\\clip.mp4",
          },
        ];
      }
      return commandResultValue;
    });
    const backend = createBackend({
      createVideoProject: vi.fn(async () => empty),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());
    await act(() => result.current.prepareImportedSource("C:\\Media\\clip.mp4"));
    const request = execute.mock.calls[0]![0];
    expect(request.commands.map((command) => command.type)).toEqual([
      "ImportAsset",
      "CreateSequence",
      "InsertClip",
    ]);
    expect(request).not.toHaveProperty("committedAt");
    expect(result.current.projection?.revision.number).toBe(1);
    expect(result.current.preparedAsset).toEqual(prepared);
    expect(result.current.checkpointWarning).toEqual({
      type: "snapshot_pending",
      revision: 1,
    });
  });

  it("derives first-import timing from the canonical prepared source", async () => {
    const empty = emptyProjection();
    const preliminaryProbe = {
      ...probe,
      averageFrameRate: { numerator: 24, denominator: 1 },
      realFrameRate: { numerator: 24, denominator: 1 },
    } as const;
    const canonicalRate = { numerator: 60, denominator: 1 } as const;
    const canonicalProbe = {
      ...probe,
      durationMicroseconds: 2_500_000,
      averageFrameRate: canonicalRate,
      realFrameRate: canonicalRate,
    } as const;
    const canonicalPrepared = {
      ...prepared,
      sourceProbe: canonicalProbe,
      sequenceRate: canonicalRate,
      proxyProbe: {
        ...prepared.proxyProbe,
        durationMicroseconds: canonicalProbe.durationMicroseconds,
        averageFrameRate: canonicalRate,
        realFrameRate: canonicalRate,
      },
    } as const;
    const prepareRequests: Parameters<VideoBackend["prepareVideoAsset"]>[0][] = [];
    const prepareVideoAsset = vi.fn(
      async (request: Parameters<VideoBackend["prepareVideoAsset"]>[0]) => {
        prepareRequests.push(request);
        return canonicalPrepared;
      },
    );
    const probeVideoSource = vi.fn(async () => preliminaryProbe);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const importedAsset = request.commands.find((command) => command.type === "ImportAsset");
      const createdSequence = request.commands.find((command) => command.type === "CreateSequence");
      const insertedClip = request.commands.find((command) => command.type === "InsertClip");
      if (
        importedAsset?.type !== "ImportAsset" ||
        createdSequence?.type !== "CreateSequence" ||
        insertedClip?.type !== "InsertClip"
      )
        throw new Error("Expected a grouped first import");
      const imported = clipProjection(1);
      imported.state.assets = [importedAsset.asset];
      const sequence = structuredClone(createdSequence.sequence);
      const track = sequence.tracks.find((item) => item.id === insertedClip.trackId);
      if (track === undefined || track.kind === "caption")
        throw new Error("Expected the imported media track");
      track.clips.push(insertedClip.clip);
      imported.state.sequences = [sequence];
      imported.state.activeSequenceId = sequence.id;
      imported.sources = [
        {
          assetId: importedAsset.asset.id,
          status: "resolved",
          resolvedPath: importedAsset.asset.locator.absolutePath ?? "C:\\Media\\clip.mp4",
        },
      ];
      return commandResult(empty, imported, request.groupId);
    });
    const backend = createBackend({
      createVideoProject: vi.fn(async () => empty),
      pickVideoSource: vi.fn(async () => "C:\\Media\\clip.mp4"),
      probeVideoSource,
      prepareVideoAsset,
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());

    await act(() => result.current.chooseSource());

    expect(probeVideoSource).not.toHaveBeenCalled();
    const prepareRequest = prepareRequests[0]!;
    expect(prepareRequest).toEqual(
      expect.objectContaining({ projectId: empty.projectId, path: "C:\\Media\\clip.mp4" }),
    );
    expect(prepareRequest).not.toHaveProperty("sequenceRate");
    const request = execute.mock.calls[0]![0];
    const importedAsset = request.commands.find((command) => command.type === "ImportAsset");
    const createdSequence = request.commands.find((command) => command.type === "CreateSequence");
    const insertedClip = request.commands.find((command) => command.type === "InsertClip");
    expect(importedAsset?.type === "ImportAsset" ? importedAsset.asset.probe : null).toEqual(
      canonicalProbe,
    );
    expect(
      createdSequence?.type === "CreateSequence" ? createdSequence.sequence.rate : null,
    ).toEqual(canonicalRate);
    expect(insertedClip?.type === "InsertClip" ? insertedClip.clip.timelineStart : null).toEqual({
      value: 0,
      rateNumerator: 60,
      rateDenominator: 1,
    });
    expect(insertedClip?.type === "InsertClip" ? insertedClip.clip.sourceIn : null).toEqual({
      value: 0,
      rateNumerator: 60,
      rateDenominator: 1,
    });
    expect(insertedClip?.type === "InsertClip" ? insertedClip.clip.sourceOut : null).toEqual({
      value: 150,
      rateNumerator: 60,
      rateDenominator: 1,
    });
    expect(result.current.projection?.state.assets[0]?.probe).toEqual(canonicalProbe);
    expect(result.current.projection?.state.sequences[0]?.rate).toEqual(canonicalRate);
  });

  it("uses bare trim and trim-plus-move fallback groups when no captions are active", async () => {
    let active = clipProjection(1);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const next = structuredClone(active);
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(active, next, request.groupId);
      active = next;
      return response;
    });
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.splitTimelineClip({ clipId: id(5), sourceFrame: 20 }));
    await act(() => result.current.moveTimelineClip({ clipId: id(5), timelineStartFrame: 4 }));
    await act(() =>
      result.current.trimTimelineClip({
        clipId: id(5),
        sourceInFrame: 0,
        sourceOutFrame: 55,
        timelineStartFrame: 0,
      }),
    );
    await act(() =>
      result.current.trimTimelineClip({
        clipId: id(5),
        sourceInFrame: 10,
        sourceOutFrame: 55,
        timelineStartFrame: 10,
      }),
    );

    const requests = execute.mock.calls.map(([request]) => request);
    expect(loadManagedTranscriptArtifact).not.toHaveBeenCalled();
    expect(requests.map(({ baseRevision }) => baseRevision)).toEqual([1, 2, 3, 4]);
    expect(new Set(requests.map(({ groupId }) => groupId))).toHaveLength(4);
    expect(requests[0]!.commands).toEqual([
      expect.objectContaining({
        type: "SplitClip",
        clipId: id(5),
        splitAt: { value: 20, rateNumerator: 30, rateDenominator: 1 },
      }),
    ]);
    expect(requests[0]!.commands[0]).toEqual(
      expect.objectContaining({ rightClipId: expect.any(String) }),
    );
    expect(requests[1]!.commands).toEqual([
      expect.objectContaining({
        type: "MoveClip",
        clipId: id(5),
        timelineStart: { value: 4, rateNumerator: 30, rateDenominator: 1 },
      }),
    ]);
    expect(requests[2]!.commands.map(({ type }) => type)).toEqual(["TrimClip"]);
    expect(requests[3]!.commands.map(({ type }) => type)).toEqual(["TrimClip", "MoveClip"]);
    expect(requests[3]!.commands[1]).toEqual(
      expect.objectContaining({
        timelineStart: { value: 10, rateNumerator: 30, rateDenominator: 1 },
      }),
    );
    expect(result.current.projection?.revision.number).toBe(5);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("loads a captioned split transcript automatically and submits only SplitClip", async () => {
    const opened = captionedProjection(1);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const next = structuredClone(opened);
      next.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
      return commandResult(opened, next, request.groupId);
    });
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() =>
      result.current.splitTimelineClip({
        clipId: id(5),
        sourceFrame: 20,
      }),
    );

    expect(loadManagedTranscriptArtifact).toHaveBeenCalledOnce();
    expect(loadManagedTranscriptArtifact).toHaveBeenCalledWith(transcriptArtifact.identity.key);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].commands.map(({ type }) => type)).toEqual(["SplitClip"]);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("fails captioned splits before submission for missing, stale, or mismatched artifacts", async () => {
    const opened = captionedProjection(1);
    const execute = vi.fn(async () => {
      throw new Error("unexpected split submission");
    });
    const loadManagedTranscriptArtifact = managedTranscriptLoader();
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.splitTimelineClip({ clipId: id(5), sourceFrame: 20 }));
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "split",
      error: { details: { reason: "managed_transcript_artifact_missing" } },
    });

    const staleTranscript = structuredClone(transcriptArtifact);
    staleTranscript.identity.sourceIdentity = secondarySourceIdentity;
    loadManagedTranscriptArtifact.mockResolvedValue(staleTranscript);
    await act(() =>
      result.current.splitTimelineClip({
        clipId: id(5),
        sourceFrame: 20,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "split",
      error: { details: { reason: "caption_lifecycle_transcript_lineage_mismatch" } },
    });

    const mismatchedTranscript = structuredClone(transcriptArtifact);
    mismatchedTranscript.identity.key = secondaryTranscriptKey;
    loadManagedTranscriptArtifact.mockResolvedValue(mismatchedTranscript);
    await act(() => result.current.splitTimelineClip({ clipId: id(5), sourceFrame: 20 }));
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "split",
      error: { details: { reason: "managed_transcript_artifact_key_mismatch" } },
    });
    expect(result.current.projection).toBe(opened);
  });

  it("owns pending state across managed loading and abandons a stale continuation", async () => {
    const opened = captionedProjection(1);
    const newer = captionedProjection(2);
    let resolveLoad!: (artifact: typeof transcriptArtifact) => void;
    const loadManagedTranscriptArtifact = vi.fn<VideoBackend["loadManagedTranscriptArtifact"]>(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const execute = vi.fn();
    const openVideoProject = vi
      .fn<VideoBackend["openVideoProject"]>()
      .mockResolvedValueOnce(cleanOpenResult(opened))
      .mockResolvedValueOnce(cleanOpenResult(newer));
    const backend = createBackend({
      openVideoProject,
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let pendingEdit!: Promise<boolean>;
    act(() => {
      pendingEdit = result.current.splitTimelineClip({ clipId: id(5), sourceFrame: 20 });
    });
    await waitFor(() =>
      expect(result.current.editOperation).toEqual({ phase: "saving", operation: "split" }),
    );

    let secondOutcome: boolean | undefined;
    await act(async () => {
      secondOutcome = await result.current.moveTimelineClip({
        clipId: id(5),
        timelineStartFrame: 5,
      });
    });
    expect(secondOutcome).toBe(false);
    expect(loadManagedTranscriptArtifact).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();

    await act(() => result.current.openProject());
    expect(result.current.projection).toBe(newer);
    await act(async () => {
      resolveLoad(transcriptArtifact);
      expect(await pendingEdit).toBe(false);
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.projection).toBe(newer);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("loads a standalone move transcript before its caption correction in one atomic group", async () => {
    const opened = captionedProjection(1);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const next = structuredClone(opened);
      next.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
      return commandResult(opened, next, request.groupId);
    });
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() =>
      result.current.moveTimelineClip({
        clipId: id(5),
        timelineStartFrame: 5,
      }),
    );

    expect(loadManagedTranscriptArtifact).toHaveBeenCalledWith(transcriptArtifact.identity.key);
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0]![0];
    expect(request.commands.map(({ type }) => type)).toEqual(["MoveClip", "ApplyCaptionArtifact"]);
    expect(new Set(request.commands.map(({ commandId }) => commandId))).toHaveLength(2);
    expect(request.commands[0]).toMatchObject({
      type: "MoveClip",
      timelineStart: { value: 5, rateNumerator: 30, rateDenominator: 1 },
    });
    expect(request.commands[1]).toMatchObject({
      type: "ApplyCaptionArtifact",
      trackId: id(6),
      artifact: {
        trackLink: { projectRevision: opened.revision },
        cues: [{ start: { value: 5 }, end: { value: 65 } }],
      },
    });
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("rejects captioned standalone moves for a missing artifact or stale lineage", async () => {
    const opened = captionedProjection(1);
    const execute = vi.fn();
    const loadManagedTranscriptArtifact = managedTranscriptLoader();
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.moveTimelineClip({ clipId: id(5), timelineStartFrame: 5 }));
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "move",
      error: { details: { reason: "managed_transcript_artifact_missing" } },
    });

    const staleTranscript = structuredClone(transcriptArtifact);
    staleTranscript.identity.sourceIdentity = secondarySourceIdentity;
    loadManagedTranscriptArtifact.mockResolvedValue(staleTranscript);
    await act(() =>
      result.current.moveTimelineClip({
        clipId: id(5),
        timelineStartFrame: 5,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "move",
      error: { details: { reason: "caption_lifecycle_transcript_lineage_mismatch" } },
    });
    expect(result.current.projection).toEqual(opened);
  });

  it("submits trim, move, and caption correction atomically and undoes them together", async () => {
    const opened = captionedProjection(1);
    const originalCaption = structuredClone(
      opened.state.sequences[0]!.tracks.find((track) => track.kind === "caption")!
        .activeCaptionArtifact,
    );
    let applied: ProjectProjection | null = null;
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const next = structuredClone(opened);
      const sequence = next.state.sequences[0]!;
      const sourceTrack = sequence.tracks.find((track) => track.id === id(4));
      const captionTrack = sequence.tracks.find((track) => track.id === id(6));
      if (sourceTrack?.kind !== "video" || captionTrack?.kind !== "caption")
        throw new Error("Expected caption lifecycle fixture tracks");
      sourceTrack.clips[0]!.sourceIn.value = 10;
      sourceTrack.clips[0]!.sourceOut.value = 50;
      sourceTrack.clips[0]!.timelineStart.value = 5;
      const applyCommand = request.commands[2];
      if (applyCommand?.type !== "ApplyCaptionArtifact")
        throw new Error("Expected caption application command");
      captionTrack.activeCaptionArtifact = applyCommand.artifact;
      next.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
      next.canUndo = true;
      applied = next;
      return commandResult(opened, next, request.groupId);
    });
    const undo = vi.fn(async (_projectId: string, _base: number, operationId: string) => {
      if (applied === null) throw new Error("Trim was not applied");
      const undone = structuredClone(opened);
      undone.revision = { ...emptyProjection(3).revision, parentId: applied.revision.id };
      undone.canUndo = false;
      undone.canRedo = true;
      return commandResult(applied, undone, operationId);
    });
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      undoVideoProject: undo,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() =>
      result.current.trimTimelineClip({
        clipId: id(5),
        sourceInFrame: 10,
        sourceOutFrame: 50,
        timelineStartFrame: 5,
      }),
    );

    expect(loadManagedTranscriptArtifact).toHaveBeenCalledWith(transcriptArtifact.identity.key);
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0]![0];
    expect(request.commands.map(({ type }) => type)).toEqual([
      "TrimClip",
      "MoveClip",
      "ApplyCaptionArtifact",
    ]);
    expect(new Set(request.commands.map(({ commandId }) => commandId))).toHaveLength(3);
    expect(request.commands[2]).toMatchObject({
      type: "ApplyCaptionArtifact",
      trackId: id(6),
      artifact: { trackLink: { projectRevision: opened.revision } },
    });
    expect(result.current.projection?.revision.number).toBe(2);

    await act(() => result.current.undoEdit());

    expect(undo).toHaveBeenCalledOnce();
    expect(result.current.projection?.revision.number).toBe(3);
    const undoneSequence = result.current.projection?.state.sequences[0];
    const undoneSource = undoneSequence?.tracks.find((track) => track.id === id(4));
    const undoneCaption = undoneSequence?.tracks.find((track) => track.id === id(6));
    expect(undoneSource?.kind === "video" ? undoneSource.clips[0] : null).toMatchObject({
      sourceIn: { value: 0 },
      sourceOut: { value: 60 },
      timelineStart: { value: 0 },
    });
    expect(undoneCaption?.kind === "caption" ? undoneCaption.activeCaptionArtifact : null).toEqual(
      originalCaption,
    );
  });

  it("rejects stale transcript lineage without submitting a trim", async () => {
    const opened = captionedProjection(1);
    const execute = vi.fn();
    const staleTranscript = structuredClone(transcriptArtifact);
    staleTranscript.identity.sourceIdentity = secondarySourceIdentity;
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact: managedTranscriptLoader(staleTranscript),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() =>
      result.current.trimTimelineClip({
        clipId: id(5),
        sourceInFrame: 10,
        sourceOutFrame: 50,
        timelineStartFrame: 0,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "trim",
      error: {
        name: "VideoDomainError",
        details: { reason: "caption_transcript_lineage_mismatch" },
      },
    });
    expect(result.current.projection).toEqual(opened);
  });

  it("fails closed when an active caption managed transcript is missing", async () => {
    const opened = captionedProjection(1);
    const execute = vi.fn();
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() =>
      result.current.trimTimelineClip({
        clipId: id(5),
        sourceInFrame: 10,
        sourceOutFrame: 50,
        timelineStartFrame: 0,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "trim",
      error: { details: { reason: "managed_transcript_artifact_missing" } },
    });
    expect(result.current.projection).toEqual(opened);
  });

  it("preserves the ambiguous multi-caption trim failure without reading a transcript", async () => {
    const opened = captionedProjection(1);
    const sequence = opened.state.sequences[0]!;
    const firstCaptionTrack = sequence.tracks.find((track) => track.kind === "caption");
    if (firstCaptionTrack?.kind !== "caption") throw new Error("Expected caption track fixture");
    const secondCaptionTrack = structuredClone(firstCaptionTrack);
    secondCaptionTrack.id = id(7);
    if (secondCaptionTrack.activeCaptionArtifact === undefined)
      throw new Error("Expected active caption artifact fixture");
    secondCaptionTrack.activeCaptionArtifact.trackLink.captionTrackId = id(7);
    sequence.tracks.push(secondCaptionTrack);
    const execute = vi.fn();
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() =>
      result.current.trimTimelineClip({
        clipId: id(5),
        sourceInFrame: 10,
        sourceOutFrame: 50,
        timelineStartFrame: 0,
      }),
    );

    expect(loadManagedTranscriptArtifact).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "trim",
      error: { details: { reason: "trim_caption_context_ambiguous" } },
    });
    expect(result.current.projection).toBe(opened);
  });

  it("sets clip opacity against each latest canonical revision and keeps transformed render readiness", async () => {
    let active: ProjectProjection = clipProjection(1);
    const returnedProjections: ProjectProjection[] = [];
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const command = request.commands[0];
      if (command?.type !== "SetClipOpacity") throw new Error("Expected clip opacity command");
      const next = structuredClone(active);
      const track = next.state.sequences[0]?.tracks.find(
        ({ id: candidateTrackId }) => candidateTrackId === command.trackId,
      );
      if (track?.kind !== "video") throw new Error("Expected video track fixture");
      const clip = track.clips.find(
        ({ id: candidateClipId }) => candidateClipId === command.clipId,
      );
      if (clip === undefined) throw new Error("Expected clip fixture");
      clip.transform.opacityPermille = command.opacityPermille;
      if (active.revision.number === 1) clip.transform.positionXPermille = 1;
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(active, next, request.groupId);
      active = next;
      returnedProjections.push(next);
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    expect(result.current.renderReady).toBe(true);

    let firstResult: boolean | undefined;
    let secondResult: boolean | undefined;
    await act(async () => {
      firstResult = await result.current.setTimelineClipOpacity({
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        opacityPermille: 425,
      });
    });
    expect(firstResult).toBe(true);
    expect(result.current.projection).toBe(returnedProjections[0]);
    const refreshedTrack = result.current.projection?.state.sequences[0]?.tracks[0];
    expect(
      refreshedTrack?.kind === "video"
        ? refreshedTrack.clips[0]?.transform.positionXPermille
        : null,
    ).toBe(1);
    expect(result.current.renderReady).toBe(true);
    await act(async () => {
      secondResult = await result.current.setTimelineClipOpacity({
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        opacityPermille: 250,
      });
    });

    expect([firstResult, secondResult]).toEqual([true, true]);
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      {
        groupId: expect.any(String),
        projectId: id(1),
        baseRevision: 1,
        commands: [
          {
            type: "SetClipOpacity",
            commandId: expect.any(String),
            sequenceId: id(3),
            trackId: id(4),
            clipId: id(5),
            opacityPermille: 425,
          },
        ],
      },
      {
        groupId: expect.any(String),
        projectId: id(1),
        baseRevision: 2,
        commands: [
          {
            type: "SetClipOpacity",
            commandId: expect.any(String),
            sequenceId: id(3),
            trackId: id(4),
            clipId: id(5),
            opacityPermille: 250,
          },
        ],
      },
    ]);
    expect(returnedProjections.map(({ revision }) => revision)).toEqual([
      expect.objectContaining({ number: 2, id: id(102), parentId: id(101) }),
      expect.objectContaining({ number: 3, id: id(103), parentId: id(102) }),
    ]);
    expect(result.current.projection).toBe(returnedProjections[1]);
    expect(
      result.current.projection?.state.sequences[0]?.tracks[0]?.kind === "video"
        ? result.current.projection.state.sequences[0].tracks[0].clips[0]?.transform.opacityPermille
        : null,
    ).toBe(250);
    expect(result.current.renderReady).toBe(true);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("dispatches one complete clip transform and adopts the canonical projection", async () => {
    const opened = clipProjection(1);
    let canonicalProjection = opened;
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const command = request.commands[0];
      if (command?.type !== "SetClipTransform") throw new Error("Expected clip transform command");
      const next = structuredClone(canonicalProjection);
      const track = next.state.sequences[0]?.tracks[0];
      if (track?.kind !== "video" || track.clips[0] === undefined)
        throw new Error("Expected video clip fixture");
      track.clips[0].transform = command.transform;
      next.revision = {
        ...emptyProjection(2).revision,
        parentId: canonicalProjection.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(canonicalProjection, next, request.groupId);
      canonicalProjection = next;
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    const transform = {
      positionXPermille: 125,
      positionYPermille: -250,
      scaleXPermille: 1_500,
      scaleYPermille: 750,
      rotationMilliDegrees: 45_000,
      opacityPermille: 425,
    };

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.setTimelineClipTransform({
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        transform,
      });
    });

    expect(outcome).toBe(true);
    expect(execute).toHaveBeenCalledWith({
      groupId: expect.any(String),
      projectId: id(1),
      baseRevision: 1,
      commands: [
        {
          type: "SetClipTransform",
          commandId: expect.any(String),
          sequenceId: id(3),
          trackId: id(4),
          clipId: id(5),
          transform,
        },
      ],
    });
    expect(result.current.projection).toBe(canonicalProjection);
    expect(result.current.renderReady).toBe(true);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("rejects unchanged, out-of-bounds, non-video, unresolved, and locked clip opacity edits", async () => {
    const opened = clipProjection(1);
    const sequence = opened.state.sequences[0]!;
    const videoTrack = sequence.tracks[0]!;
    if (videoTrack.kind !== "video") throw new Error("Expected video track fixture");
    sequence.tracks.push({
      ...structuredClone(videoTrack),
      id: id(6),
      name: "Audio 1",
      kind: "audio",
      clips: [{ ...structuredClone(videoTrack.clips[0]!), id: id(7) }],
    });
    sequence.tracks.push({
      ...structuredClone(videoTrack),
      id: id(8),
      name: "Locked video",
      locked: true,
      clips: [{ ...structuredClone(videoTrack.clips[0]!), id: id(9) }],
    });
    const execute = vi.fn();
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    const inputs = [
      { sequenceId: id(3), trackId: id(4), clipId: id(5), opacityPermille: 1_000 },
      { sequenceId: id(3), trackId: id(4), clipId: id(5), opacityPermille: -1 },
      { sequenceId: id(3), trackId: id(4), clipId: id(5), opacityPermille: 1_001 },
      { sequenceId: id(3), trackId: id(4), clipId: id(5), opacityPermille: 1.5 },
      { sequenceId: id(3), trackId: id(4), clipId: id(5), opacityPermille: Number.NaN },
      {
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        opacityPermille: Number.POSITIVE_INFINITY,
      },
      { sequenceId: id(30), trackId: id(4), clipId: id(5), opacityPermille: 500 },
      { sequenceId: id(3), trackId: id(40), clipId: id(5), opacityPermille: 500 },
      { sequenceId: id(3), trackId: id(4), clipId: id(50), opacityPermille: 500 },
      { sequenceId: id(3), trackId: id(6), clipId: id(7), opacityPermille: 500 },
      { sequenceId: id(3), trackId: id(8), clipId: id(9), opacityPermille: 500 },
    ] as const;
    const outcomes: boolean[] = [];
    await act(async () => {
      for (const input of inputs) outcomes.push(await result.current.setTimelineClipOpacity(input));
    });

    expect(outcomes).toEqual(inputs.map(() => false));
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.projection).toBe(opened);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("rejects duplicate clip opacity work while the canonical edit is pending", async () => {
    const opened = clipProjection(1);
    let releaseExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      await executionGate;
      const command = request.commands[0];
      if (command?.type !== "SetClipOpacity") throw new Error("Expected clip opacity command");
      const next = structuredClone(opened);
      const track = next.state.sequences[0]?.tracks[0];
      if (track?.kind !== "video") throw new Error("Expected video track fixture");
      track.clips[0]!.transform.opacityPermille = command.opacityPermille;
      next.revision = {
        ...emptyProjection(2).revision,
        parentId: opened.revision.id,
        operationId: request.groupId,
      };
      return commandResult(opened, next, request.groupId);
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let acceptedRequest: Promise<boolean> | undefined;
    act(() => {
      acceptedRequest = result.current.setTimelineClipOpacity({
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        opacityPermille: 425,
      });
    });
    await waitFor(() =>
      expect(result.current.editOperation).toEqual({ phase: "saving", operation: "clip-opacity" }),
    );
    expect(result.current.projection).toBe(opened);
    expect(
      result.current.projection?.state.sequences[0]?.tracks[0]?.kind === "video"
        ? result.current.projection.state.sequences[0].tracks[0].clips[0]?.transform.opacityPermille
        : null,
    ).toBe(1_000);
    let pendingResult: boolean | undefined;
    await act(async () => {
      pendingResult = await result.current.setTimelineClipOpacity({
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        opacityPermille: 250,
      });
    });
    let acceptedResult: boolean | undefined;
    await act(async () => {
      releaseExecution?.();
      acceptedResult = await acceptedRequest;
    });

    expect(pendingResult).toBe(false);
    expect(acceptedResult).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("rolls a failed clip opacity edit back to the canonical projection and exposes the error", async () => {
    const opened = clipProjection(1);
    const failure = new Error("Opacity save failed");
    const execute = vi.fn(async () => {
      throw failure;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    const canonicalProjection = result.current.projection;

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.setTimelineClipOpacity({
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
        opacityPermille: 425,
      });
    });

    expect(outcome).toBe(false);
    expect(result.current.projection).toBe(canonicalProjection);
    expect(result.current.projection?.revision).toBe(opened.revision);
    expect(
      result.current.projection?.state.sequences[0]?.tracks[0]?.kind === "video"
        ? result.current.projection.state.sequences[0].tracks[0].clips[0]?.transform.opacityPermille
        : null,
    ).toBe(1_000);
    expect(result.current.renderReady).toBe(true);
    expect(result.current.editOperation).toEqual({
      phase: "error",
      operation: "clip-opacity",
      error: failure,
    });
  });

  it("locks and unlocks a timeline track through one revision per toggle", async () => {
    let active = clipProjection(1);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const command = request.commands[0];
      if (command?.type !== "SetTrackLocked") throw new Error("Expected track lock command");
      const next = structuredClone(active);
      const track = next.state.sequences[0]?.tracks.find(
        ({ id: trackId }) => trackId === command.trackId,
      );
      if (track === undefined) throw new Error("Expected track fixture");
      track.locked = command.locked;
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(active, next, request.groupId);
      active = next;
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.setTimelineTrackLocked({ trackId: id(4), locked: true }));
    await act(() => result.current.setTimelineTrackLocked({ trackId: id(4), locked: true }));
    await act(() => result.current.setTimelineTrackLocked({ trackId: id(4), locked: false }));

    const requests = execute.mock.calls.map(([request]) => request);
    expect(requests.map(({ baseRevision }) => baseRevision)).toEqual([1, 2]);
    expect(requests.map(({ commands }) => commands)).toEqual([
      [expect.objectContaining({ type: "SetTrackLocked", trackId: id(4), locked: true })],
      [expect.objectContaining({ type: "SetTrackLocked", trackId: id(4), locked: false })],
    ]);
    expect(result.current.projection?.revision.number).toBe(3);
    expect(result.current.projection?.state.sequences[0]?.tracks[0]?.locked).toBe(false);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("mutes timeline tracks with strict one-command revisions, deduplication, and returned projection adoption", async () => {
    let active = clipProjection(1);
    const returnedProjections: ProjectProjection[] = [];
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const command = request.commands[0];
      if (command?.type !== "SetTrackMuted") throw new Error("Expected track mute command");
      const next = structuredClone(active);
      const track = next.state.sequences[0]?.tracks.find(
        ({ id: trackId }) => trackId === command.trackId,
      );
      if (track === undefined || track.kind === "caption")
        throw new Error("Expected mutable track fixture");
      track.muted = command.muted;
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(active, next, request.groupId);
      active = next;
      returnedProjections.push(next);
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.setTimelineTrackMuted({ trackId: id(4), muted: true }));
    await act(() => result.current.setTimelineTrackMuted({ trackId: id(4), muted: true }));
    await act(() => result.current.setTimelineTrackMuted({ trackId: id(4), muted: false }));

    const requests = execute.mock.calls.map(([request]) => request);
    expect(requests.map(({ baseRevision }) => baseRevision)).toEqual([1, 2]);
    expect(requests.map(({ commands }) => commands)).toEqual([
      [
        {
          type: "SetTrackMuted",
          commandId: expect.any(String),
          sequenceId: id(3),
          trackId: id(4),
          muted: true,
        },
      ],
      [
        {
          type: "SetTrackMuted",
          commandId: expect.any(String),
          sequenceId: id(3),
          trackId: id(4),
          muted: false,
        },
      ],
    ]);
    expect(result.current.projection).toBe(returnedProjections[1]);
    expect(result.current.projection?.revision.number).toBe(3);
    expect(result.current.projection?.state.sequences[0]?.tracks[0]).toMatchObject({
      kind: "video",
      muted: false,
    });
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("deduplicates strict visual-track visibility edits and invalidates an active render", async () => {
    let active = clipProjection(1);
    active.state.sequences[0]!.tracks[0]!.locked = true;
    let releaseExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const cancelVideoRender = vi.fn(async () => undefined);
    const unlisten = vi.fn();
    let renderHandler: ((event: VideoRenderNotification) => void) | null = null;
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      await executionGate;
      const command = request.commands[0];
      if (command?.type !== "SetTrackHidden") throw new Error("Expected track visibility command");
      const next = structuredClone(active);
      const track = next.state.sequences[0]?.tracks.find(
        ({ id: trackId }) => trackId === command.trackId,
      );
      if (track === undefined || track.kind === "audio")
        throw new Error("Expected visual track fixture");
      track.hidden = command.hidden;
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response: CommandResult = {
        ...commandResult(active, next, request.groupId),
        cacheInvalidations: ["timeline", "preview", "captions", "render_plan"],
      };
      active = next;
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
      pickVideoExportPath: vi.fn(async () => "C:\\Exports\\clip.mp4"),
      startVideoRender: vi.fn(async (plan) => ({
        jobId: id(90),
        planId: plan.planId,
        revisionId: plan.revisionId,
      })),
      cancelVideoRender,
      listenVideoRenderEvents: vi.fn(async (handler) => {
        renderHandler = handler;
        return unlisten;
      }),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    await act(() => result.current.exportVideo());
    expect(result.current.render.phase).toBe("running");
    if (result.current.render.phase !== "running") throw new Error("Render did not start");
    const staleRenderIdentity = {
      jobId: result.current.render.jobId,
      planId: result.current.render.planId,
      revisionId: result.current.render.revisionId,
    };

    let acceptedRequest: Promise<boolean> | undefined;
    act(() => {
      acceptedRequest = result.current.setTimelineTrackHidden({ trackId: id(4), hidden: true });
    });
    let pendingResult: boolean | undefined;
    await act(async () => {
      pendingResult = await result.current.setTimelineTrackHidden({
        trackId: id(4),
        hidden: false,
      });
    });
    expect(pendingResult).toBe(false);
    expect(execute).toHaveBeenCalledOnce();

    let acceptedResult: boolean | undefined;
    await act(async () => {
      releaseExecution?.();
      acceptedResult = await acceptedRequest;
    });
    let unchangedResult: boolean | undefined;
    await act(async () => {
      unchangedResult = await result.current.setTimelineTrackHidden({
        trackId: id(4),
        hidden: true,
      });
    });

    expect(acceptedResult).toBe(true);
    expect(unchangedResult).toBe(false);
    const request = execute.mock.calls[0]![0];
    expect(request).toEqual({
      groupId: expect.any(String),
      projectId: id(1),
      baseRevision: 1,
      commands: [
        {
          type: "SetTrackHidden",
          commandId: expect.any(String),
          sequenceId: id(3),
          trackId: id(4),
          hidden: true,
        },
      ],
    });
    await expect(execute.mock.results[0]!.value).resolves.toMatchObject({
      cacheInvalidations: ["timeline", "preview", "captions", "render_plan"],
    });
    expect(cancelVideoRender).toHaveBeenCalledOnce();
    expect(cancelVideoRender).toHaveBeenCalledWith(id(90));
    expect(unlisten).toHaveBeenCalledOnce();
    expect(result.current.render).toEqual({ phase: "idle" });
    act(() => {
      renderHandler?.({
        type: "started",
        ...staleRenderIdentity,
      });
    });
    expect(result.current.render).toEqual({ phase: "idle" });
    act(() => {
      renderHandler?.({
        type: "progress",
        ...staleRenderIdentity,
        completedMicroseconds: 1_000_000,
        durationMicroseconds: 2_000_000,
      });
    });
    expect(result.current.render).toEqual({ phase: "idle" });
    act(() => {
      renderHandler?.({
        type: "completed",
        ...staleRenderIdentity,
        output: {
          outputPath: "C:\\Exports\\clip.mp4",
          previewPath: "C:\\Cache\\stale-preview.mp4",
          probe,
        },
      });
    });
    expect(result.current.render).toEqual({ phase: "idle" });
    expect(result.current.projection?.state.sequences[0]?.tracks[0]).toMatchObject({
      kind: "video",
      locked: true,
      hidden: true,
    });
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("keeps a late-started render cancellable when project-switch cancellation fails", async () => {
    const first = clipProjection(1);
    const second = { ...clipProjection(1), projectId: id(9), name: "Second" };
    const recovery = {
      status: "clean" as const,
      recoveredRevision: 1,
      replayedRecordCount: 0,
      discardedTailBytes: 0,
      message: "Clean",
      legacyHistoryReset: false,
    };
    let resolveStart!: (started: Awaited<ReturnType<VideoBackend["startVideoRender"]>>) => void;
    const pendingStart = new Promise<Awaited<ReturnType<VideoBackend["startVideoRender"]>>>(
      (resolve) => {
        resolveStart = resolve;
      },
    );
    const cancellationError = new Error("late render cancellation failed");
    const cancelVideoRender = vi
      .fn()
      .mockRejectedValueOnce(cancellationError)
      .mockResolvedValueOnce(undefined);
    const openVideoProject = vi
      .fn()
      .mockResolvedValueOnce({ projection: first, recovery })
      .mockResolvedValueOnce({ projection: second, recovery });
    const startVideoRender = vi.fn<VideoBackend["startVideoRender"]>(() => pendingStart);
    const backend = createBackend({
      openVideoProject,
      pickVideoExportPath: vi.fn(async () => "C:\\Exports\\clip.mp4"),
      startVideoRender,
      cancelVideoRender,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    let exportPromise!: Promise<void>;
    act(() => {
      exportPromise = result.current.exportVideo();
    });
    await waitFor(() => expect(result.current.render.phase).toBe("starting"));
    const plan = startVideoRender.mock.calls[0]?.[0];
    if (plan === undefined) throw new Error("Render plan was not submitted");
    const lateIdentity = {
      jobId: id(90),
      planId: plan.planId,
      revisionId: plan.revisionId,
    };

    await act(() => result.current.openProject());
    expect(result.current.projection?.projectId).toBe(second.projectId);
    expect(result.current.render).toMatchObject({
      phase: "starting",
      planId: lateIdentity.planId,
      revisionId: lateIdentity.revisionId,
    });
    await act(async () => {
      resolveStart(lateIdentity);
      await exportPromise;
      await Promise.resolve();
    });

    expect(cancelVideoRender).toHaveBeenCalledOnce();
    expect(cancelVideoRender).toHaveBeenCalledWith(lateIdentity.jobId);
    expect(result.current.render).toMatchObject({
      phase: "running",
      ...lateIdentity,
      cancellationPending: false,
      cancellationError,
    });
    await act(() => result.current.cancelRender());
    expect(cancelVideoRender).toHaveBeenCalledTimes(2);
    expect(result.current.render).toEqual({ phase: "idle" });
  });

  it("retains a stale render when visibility invalidation fails and permits retry", async () => {
    let active = clipProjection(1);
    const cancellationError = new Error("cancel service unavailable");
    let rejectCancellation!: (reason: unknown) => void;
    const pendingCancellation = new Promise<void>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancelVideoRender = vi
      .fn()
      .mockImplementationOnce(() => pendingCancellation)
      .mockResolvedValueOnce(undefined);
    const unlisten = vi.fn();
    let renderHandler: ((event: VideoRenderNotification) => void) | null = null;
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const command = request.commands[0];
      if (command?.type !== "SetTrackHidden") throw new Error("Expected visibility command");
      const next = structuredClone(active);
      const track = next.state.sequences[0]?.tracks.find(
        ({ id: trackId }) => trackId === command.trackId,
      );
      if (track === undefined || track.kind === "audio")
        throw new Error("Expected visual track fixture");
      track.hidden = command.hidden;
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(active, next, request.groupId);
      response.cacheInvalidations = ["timeline", "preview", "captions", "render_plan"];
      active = next;
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
      pickVideoExportPath: vi.fn(async () => "C:\\Exports\\clip.mp4"),
      startVideoRender: vi.fn(async (plan) => ({
        jobId: id(90),
        planId: plan.planId,
        revisionId: plan.revisionId,
      })),
      cancelVideoRender,
      listenVideoRenderEvents: vi.fn(async (handler) => {
        renderHandler = handler;
        return unlisten;
      }),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    await act(() => result.current.exportVideo());
    if (result.current.render.phase !== "running") throw new Error("Render did not start");
    const staleRenderIdentity = {
      jobId: result.current.render.jobId,
      planId: result.current.render.planId,
      revisionId: result.current.render.revisionId,
    };

    await act(() => result.current.setTimelineTrackHidden({ trackId: id(4), hidden: true }));

    expect(cancelVideoRender).toHaveBeenCalledOnce();
    expect(result.current.render).toMatchObject({
      phase: "running",
      ...staleRenderIdentity,
      cancellationPending: true,
      cancellationError: null,
    });
    expect(unlisten).not.toHaveBeenCalled();
    await act(async () => {
      rejectCancellation(cancellationError);
      await pendingCancellation.catch(() => undefined);
    });
    expect(result.current.render).toMatchObject({
      phase: "running",
      ...staleRenderIdentity,
      cancellationPending: false,
      cancellationError,
    });
    act(() => {
      renderHandler?.({
        type: "completed",
        ...staleRenderIdentity,
        output: {
          outputPath: "C:\\Exports\\clip.mp4",
          previewPath: "C:\\Cache\\stale-preview.mp4",
          probe,
        },
      });
    });
    expect(result.current.render).toMatchObject({
      phase: "running",
      cancellationError,
    });

    await act(() => result.current.cancelRender());

    expect(cancelVideoRender).toHaveBeenCalledTimes(2);
    expect(cancelVideoRender).toHaveBeenLastCalledWith(id(90));
    expect(unlisten).toHaveBeenCalledOnce();
    expect(result.current.render).toEqual({ phase: "idle" });
  });

  it("rejects audio track visibility without submitting or changing controller state", async () => {
    const opened = clipProjection(1);
    opened.state.sequences[0]!.tracks.push({
      id: id(7),
      name: "Audio 1",
      kind: "audio",
      clips: [],
    });
    const execute = vi.fn(async () => {
      throw new Error("unexpected audio visibility submission");
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let visibilityResult: boolean | undefined;
    await act(async () => {
      visibilityResult = await result.current.setTimelineTrackHidden({
        trackId: id(7),
        hidden: true,
      });
    });

    expect(visibilityResult).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.projection).toBe(opened);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("cancels an active render when track mute changes output", async () => {
    let active = clipProjection(1);
    const cancelVideoRender = vi.fn(async () => undefined);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      const command = request.commands[0];
      if (command?.type !== "SetTrackMuted") throw new Error("Expected track mute command");
      const next = structuredClone(active);
      const track = next.state.sequences[0]?.tracks.find(
        ({ id: trackId }) => trackId === command.trackId,
      );
      if (track === undefined || track.kind === "caption")
        throw new Error("Expected mutable track fixture");
      track.muted = command.muted;
      next.revision = {
        ...emptyProjection(active.revision.number + 1).revision,
        parentId: active.revision.id,
        operationId: request.groupId,
      };
      const response = commandResult(active, next, request.groupId);
      response.cacheInvalidations = ["timeline", "preview", "audio_mix", "render_plan"];
      active = next;
      return response;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: active,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
      pickVideoExportPath: vi.fn(async () => "C:\\Exports\\clip.mp4"),
      startVideoRender: vi.fn(async (plan) => ({
        jobId: id(90),
        planId: plan.planId,
        revisionId: plan.revisionId,
      })),
      cancelVideoRender,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    await act(() => result.current.exportVideo());
    expect(result.current.render.phase).toBe("running");

    await act(() => result.current.setTimelineTrackMuted({ trackId: id(4), muted: true }));

    expect(cancelVideoRender).toHaveBeenCalledOnce();
    expect(cancelVideoRender).toHaveBeenCalledWith(id(90));
    expect(result.current.render).toEqual({ phase: "idle" });
    expect(result.current.projection?.state.sequences[0]?.tracks[0]).toMatchObject({
      kind: "video",
      muted: true,
    });
  });

  it("rejects caption track mute requests without submitting or changing controller state", async () => {
    const opened = clipProjection(1);
    opened.state.sequences[0]!.tracks.push({
      id: id(7),
      name: "Captions",
      kind: "caption",
      captions: [],
    });
    const execute = vi.fn(async () => {
      throw new Error("unexpected caption mute submission");
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.setTimelineTrackMuted({ trackId: id(7), muted: true }));

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.projection).toBe(opened);
    expect(result.current.projection?.revision.number).toBe(1);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("submits captioned transcript geometry and ApplyCaptionArtifact in one request", async () => {
    const opened = captionedProjection(1);
    const proposal = await transcriptEditProposal(opened);
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      const next = structuredClone(opened);
      next.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
      return commandResult(opened, next, request.groupId);
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.applyTranscriptEditProposal(proposal, transcriptArtifact));

    expect(execute).toHaveBeenCalledOnce();
    const submittedTypes = execute.mock.calls[0]![0].commands.map(({ type }) => type);
    expect(submittedTypes.at(-1)).toBe("ApplyCaptionArtifact");
    expect(submittedTypes.slice(0, -1).every((type) => type !== "ApplyCaptionArtifact")).toBe(true);
  });

  it("submits the generated transcript command group at its base revision and installs the backend projection", async () => {
    const opened = clipProjection(1);
    const proposal = await transcriptEditProposal(opened);
    const committed = structuredClone(opened);
    const track = committed.state.sequences[0]!.tracks[0]!;
    if (track.kind === "caption") throw new Error("Expected media track fixture");
    track.clips = [];
    committed.revision = {
      ...emptyProjection(2).revision,
      parentId: opened.revision.id,
      operationId: proposal.commandGroup.groupId,
    };
    committed.canUndo = true;
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      return commandResult(opened, committed, request.groupId);
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.applyTranscriptEditProposal(proposal, transcriptArtifact));

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toBe(proposal.commandGroup);
    expect(execute.mock.calls[0]![0].baseRevision).toBe(proposal.projectRevision.number);
    expect(result.current.projection).toBe(committed);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("uses existing undo to recover the projection changed by a generated transcript edit", async () => {
    const opened = clipProjection(1);
    const proposal = await transcriptEditProposal(opened);
    const committed = structuredClone(opened);
    const committedTrack = committed.state.sequences[0]!.tracks[0]!;
    if (committedTrack.kind === "caption") throw new Error("Expected media track fixture");
    committedTrack.clips = [];
    committed.revision = {
      ...emptyProjection(2).revision,
      parentId: opened.revision.id,
      operationId: proposal.commandGroup.groupId,
    };
    committed.canUndo = true;
    const recovered = structuredClone(opened);
    recovered.revision = { ...emptyProjection(3).revision, parentId: committed.revision.id };
    recovered.canUndo = false;
    recovered.canRedo = true;
    const undo = vi.fn(async (_projectId: string, _baseRevision: number, operationId: string) =>
      commandResult(committed, recovered, operationId),
    );
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: vi.fn(async (request: CommandGroupRequest) =>
        commandResult(opened, committed, request.groupId),
      ),
      undoVideoProject: undo,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    await act(() => result.current.applyTranscriptEditProposal(proposal, transcriptArtifact));
    expect(result.current.projection).toBe(committed);

    await act(() => result.current.undoEdit());

    expect(undo).toHaveBeenCalledOnce();
    expect(undo).toHaveBeenCalledWith(opened.projectId, 2, expect.any(String));
    expect(result.current.projection).toBe(recovered);
    expect(result.current.projection?.state).toEqual(opened.state);
    expect(result.current.projection?.sources).toEqual(opened.sources);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("rejects a renderer-stale generated transcript proposal without calling the backend", async () => {
    const proposal = await transcriptEditProposal(clipProjection(1));
    const opened = clipProjection(2);
    const execute = vi.fn(async () => {
      throw new Error("unexpected stale transcript submission");
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.applyTranscriptEditProposal(proposal, transcriptArtifact));

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.projection).toBe(opened);
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "transcript-edit",
      error: {
        name: "VideoDomainError",
        code: "invalid_project",
        details: { reason: "stale_revision" },
      },
    });
  });

  it("keeps the active projection when the backend rejects a generated transcript proposal as stale", async () => {
    const opened = clipProjection(1);
    const proposal = await transcriptEditProposal(opened);
    const staleError = new VideoDomainError("stale_revision", "Command base revision is stale", {
      expected: 2,
      received: proposal.commandGroup.baseRevision,
    });
    const execute = vi.fn(async () => {
      throw staleError;
    });
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.applyTranscriptEditProposal(proposal, transcriptArtifact));

    expect(execute).toHaveBeenCalledOnce();
    expect(result.current.projection).toBe(opened);
    expect(result.current.editOperation).toEqual({
      phase: "error",
      operation: "transcript-edit",
      error: staleError,
    });
  });

  it("ripple deletes without captions through exactly one command and activates undo/redo projections", async () => {
    const opened = rippleProjection(1);
    const deleted = structuredClone(opened);
    const deletedTrack = deleted.state.sequences[0]!.tracks[0]!;
    if (deletedTrack.kind === "caption") throw new Error("Expected clip track fixture");
    deletedTrack.clips.splice(0, 1);
    deletedTrack.clips[0]!.timelineStart.value = 10;
    deleted.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
    deleted.canUndo = true;
    deleted.canRedo = false;
    deleted.lastCommand = {
      operationId: id(202),
      groupId: id(202),
      summary: "Ripple deleted clip",
    };
    const undone = structuredClone(opened);
    undone.revision = { ...emptyProjection(3).revision, parentId: deleted.revision.id };
    undone.canUndo = false;
    undone.canRedo = true;
    const redone = structuredClone(deleted);
    redone.revision = { ...emptyProjection(4).revision, parentId: undone.revision.id };
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      return commandResult(opened, deleted, request.groupId);
    });
    const undo = vi.fn(async (_projectId: string, _base: number, operationId: string) =>
      commandResult(deleted, undone, operationId),
    );
    const redo = vi.fn(async (_projectId: string, _base: number, operationId: string) =>
      commandResult(undone, redone, operationId),
    );
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      undoVideoProject: undo,
      redoVideoProject: redo,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.rippleDeleteTimelineClip({ clipId: id(5) });
    });

    expect(outcome).toBe(true);
    expect(loadManagedTranscriptArtifact).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0]![0];
    expect(request.baseRevision).toBe(1);
    expect(request.commands).toEqual([
      expect.objectContaining({
        type: "RippleDeleteClip",
        sequenceId: id(3),
        trackId: id(4),
        clipId: id(5),
      }),
    ]);
    expect(result.current.projection).toBe(deleted);

    await act(() => result.current.undoEdit());
    expect(result.current.projection).toBe(undone);
    expect(
      result.current.projection?.state.sequences[0]?.tracks[0]?.kind === "video"
        ? result.current.projection.state.sequences[0].tracks[0].clips.map(
            (clip) => clip.timelineStart.value,
          )
        : null,
    ).toEqual([0, 30]);

    await act(() => result.current.redoEdit());
    expect(result.current.projection).toBe(redone);
    expect(
      result.current.projection?.state.sequences[0]?.tracks[0]?.kind === "video"
        ? result.current.projection.state.sequences[0].tracks[0].clips.map((clip) => [
            clip.id,
            clip.timelineStart.value,
          ])
        : null,
    ).toEqual([[id(6), 10]]);
    expect(execute).toHaveBeenCalledOnce();
    expect(undo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledOnce();
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("atomically submits ripple delete before affected active-caption artifacts", async () => {
    const opened = rippleCaptionedProjection(1);
    const committed = structuredClone(opened);
    committed.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
    const execute = vi.fn(async (request: CommandGroupRequest) => {
      commandGroupRequestSchema.parse(request);
      return commandResult(opened, committed, request.groupId);
    });
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.rippleDeleteTimelineClip({ clipId: id(5) });
    });

    expect(outcome).toBe(true);
    expect(loadManagedTranscriptArtifact).toHaveBeenCalledOnce();
    expect(loadManagedTranscriptArtifact).toHaveBeenCalledWith(transcriptArtifact.identity.key);
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0]![0];
    expect(request.commands.map(({ type }) => type)).toEqual([
      "RippleDeleteClip",
      "ApplyCaptionArtifact",
    ]);
    expect(request.commands[0]).toMatchObject({ clipId: id(5), trackId: id(4) });
    expect(request.commands[1]).toMatchObject({
      type: "ApplyCaptionArtifact",
      trackId: id(10),
      artifact: {
        transcriptArtifactIdentityKey: transcriptArtifact.identity.key,
        trackLink: { captionTrackId: id(10), projectRevision: opened.revision },
      },
    });
    expect(new Set(request.commands.map(({ commandId }) => commandId))).toHaveLength(2);
    expect(result.current.projection).toBe(committed);
  });

  it("reuses one transcript for matching caption tracks in sequence order", async () => {
    const opened = rippleProjection(1);
    addRippleCaptionTrack(opened, id(11));
    addRippleCaptionTrack(opened, id(10));
    const committed = structuredClone(opened);
    committed.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
    const execute = vi.fn(async (request: CommandGroupRequest) =>
      commandResult(opened, committed, request.groupId),
    );
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.rippleDeleteTimelineClip({ clipId: id(5) });
    });

    expect(outcome).toBe(true);
    expect(loadManagedTranscriptArtifact).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    const commands = execute.mock.calls[0]![0].commands;
    expect(commands.map(({ type }) => type)).toEqual([
      "RippleDeleteClip",
      "ApplyCaptionArtifact",
      "ApplyCaptionArtifact",
    ]);
    expect(
      commands
        .slice(1)
        .map((command) =>
          command.type === "ApplyCaptionArtifact"
            ? [command.trackId, command.artifact.transcriptArtifactIdentityKey]
            : null,
        ),
    ).toEqual([
      [id(11), transcriptArtifact.identity.key],
      [id(10), transcriptArtifact.identity.key],
    ]);
  });

  it("loads each mixed-source ripple transcript once and applies every affected caption", async () => {
    const opened = rippleCaptionedProjection(1);
    const sequence = opened.state.sequences[0]!;
    const sourceTrack = sequence.tracks[0]!;
    if (sourceTrack.kind === "caption") throw new Error("Expected clip track fixture");
    const secondaryAssetId = id(20);
    opened.state.assets.push({
      ...structuredClone(opened.state.assets[0]!),
      id: secondaryAssetId,
      displayName: "secondary.mp4",
      contentIdentity: secondarySourceIdentity,
    });
    opened.sources.push({
      assetId: secondaryAssetId,
      status: "resolved",
      resolvedPath: "C:\\Media\\secondary.mp4",
    });
    sourceTrack.clips[1]!.source = { kind: "asset", assetId: secondaryAssetId };
    addRippleCaptionTrack(opened, id(12), secondarySourceIdentity, secondaryTranscriptKey);
    const secondaryTranscript = structuredClone(transcriptArtifact);
    secondaryTranscript.identity.key = secondaryTranscriptKey;
    secondaryTranscript.identity.sourceIdentity = secondarySourceIdentity;
    const committed = structuredClone(opened);
    committed.revision = { ...emptyProjection(2).revision, parentId: opened.revision.id };
    const execute = vi.fn(async (request: CommandGroupRequest) =>
      commandResult(opened, committed, request.groupId),
    );
    const loadManagedTranscriptArtifact = managedTranscriptLoader(
      transcriptArtifact,
      secondaryTranscript,
    );
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.rippleDeleteTimelineClip({ clipId: id(5) }));

    expect(loadManagedTranscriptArtifact.mock.calls.map(([key]) => key)).toEqual([
      transcriptArtifact.identity.key,
      secondaryTranscriptKey,
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(
      execute.mock.calls[0]![0].commands.map((command) =>
        command.type === "ApplyCaptionArtifact" ? command.trackId : command.type,
      ),
    ).toEqual(["RippleDeleteClip", id(10), id(12)]);
  });

  it("fails closed when one mixed-source caption transcript is missing", async () => {
    const opened = rippleCaptionedProjection(1);
    const sequence = opened.state.sequences[0]!;
    const sourceTrack = sequence.tracks[0]!;
    if (sourceTrack.kind === "caption") throw new Error("Expected clip track fixture");
    const secondaryAssetId = id(20);
    opened.state.assets.push({
      ...structuredClone(opened.state.assets[0]!),
      id: secondaryAssetId,
      displayName: "secondary.mp4",
      contentIdentity: secondarySourceIdentity,
    });
    opened.sources.push({
      assetId: secondaryAssetId,
      status: "resolved",
      resolvedPath: "C:\\Media\\secondary.mp4",
    });
    sourceTrack.clips[1]!.source = { kind: "asset", assetId: secondaryAssetId };
    addRippleCaptionTrack(opened, id(12), secondarySourceIdentity, secondaryTranscriptKey);
    const execute = vi.fn();
    const loadManagedTranscriptArtifact = managedTranscriptLoader(transcriptArtifact);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
      loadManagedTranscriptArtifact,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.rippleDeleteTimelineClip({ clipId: id(5) });
    });

    expect(outcome).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.editOperation).toMatchObject({
      phase: "error",
      operation: "ripple-delete",
      error: { details: { reason: "managed_transcript_artifact_missing" } },
    });
    expect(result.current.projection).toBe(opened);
  });

  it("rejects an invalid ripple-delete target without calling the backend", async () => {
    const opened = rippleCaptionedProjection(1);
    const execute = vi.fn();
    const backend = createBackend({
      openVideoProject: vi.fn(async () => cleanOpenResult(opened)),
      executeVideoProjectGroup: execute,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.rippleDeleteTimelineClip({ clipId: id(999) });
    });

    expect(outcome).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.projection).toBe(opened);
    expect(result.current.editOperation).toEqual({ phase: "idle" });
  });

  it("sets and clears checkpoint warnings across trim, undo, and redo results", async () => {
    const opened = clipProjection(1);
    const trimmed = clipProjection(2, 10, 50);
    const undone = { ...clipProjection(3), canRedo: true };
    const redone = clipProjection(4, 10, 50);
    const execute = vi.fn(async (request: CommandGroupRequest) =>
      withCheckpointWarning(commandResult(opened, trimmed, request.groupId), "projection"),
    );
    const undo = vi.fn(async (_projectId: string, _base: number, operationId: string) =>
      commandResult(trimmed, undone, operationId),
    );
    const redo = vi.fn(async (_projectId: string, _base: number, operationId: string) =>
      withCheckpointWarning(commandResult(undone, redone, operationId), "event"),
    );
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      executeVideoProjectGroup: execute,
      undoVideoProject: undo,
      redoVideoProject: redo,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    act(() => result.current.updateTrimDraft({ inFrame: 10, outFrame: 50 }));
    await act(() => result.current.applyTrim());
    expect(result.current.checkpointWarning).toEqual({
      type: "snapshot_pending",
      revision: 2,
    });
    await act(() => result.current.undoEdit());
    expect(result.current.checkpointWarning).toBeNull();
    await act(() => result.current.redoEdit());
    expect(result.current.checkpointWarning).toEqual({
      type: "snapshot_pending",
      revision: 4,
    });
  });

  it("uses the active video clip asset and normalizes the legacy audio-rate view", async () => {
    const base = clipProjection(1);
    const actualAsset = base.state.assets[0]!;
    const sequence = base.state.sequences[0]!;
    const videoTrack = sequence.tracks[0]!;
    if (videoTrack.kind !== "video") throw new Error("Expected video track fixture");
    const decoyAsset = {
      ...actualAsset,
      id: id(6),
      displayName: "audio.mp4",
      locator: { absolutePath: "C:\\Media\\audio.mp4" },
    };
    const opened = {
      ...base,
      state: {
        ...base.state,
        assets: [decoyAsset, actualAsset],
        sequences: [
          {
            ...sequence,
            audioSampleRate: 44_100,
            tracks: [
              {
                id: id(7),
                name: "Audio 1",
                kind: "audio" as const,
                clips: [
                  {
                    ...videoTrack.clips[0]!,
                    id: id(8),
                    source: { kind: "asset" as const, assetId: decoyAsset.id },
                  },
                ],
              },
              videoTrack,
            ],
          },
        ],
      },
      sources: [
        {
          assetId: decoyAsset.id,
          status: "resolved" as const,
          resolvedPath: "C:\\Media\\audio.mp4",
        },
        {
          assetId: actualAsset.id,
          status: "resolved" as const,
          resolvedPath: "C:\\Media\\clip.mp4",
        },
      ],
    } satisfies ProjectProjection;
    const prepareVideoAsset = vi.fn(async () => prepared);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      prepareVideoAsset,
    });
    const { result } = renderHook(() => useVideoProject(backend));

    await act(() => result.current.openProject());

    expect(prepareVideoAsset).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: actualAsset.id, path: "C:\\Media\\clip.mp4" }),
    );
    expect(result.current.project?.revisions[0]?.state.asset?.id).toBe(actualAsset.id);
    expect(result.current.project?.revisions[0]?.state.sequence?.audioSampleRate).toBe(48_000);
    expect(result.current.project?.revisions[0]?.state.sequence?.videoTracks[0].clips[0]?.id).toBe(
      videoTrack.clips[0]!.id,
    );
  });

  it("regenerates prepared media when undo invalidates the asset source", async () => {
    const opened = clipProjection(1);
    const undone = clipProjection(2);
    undone.sources = [
      { assetId: id(2), status: "resolved", resolvedPath: "C:\\Media\\replacement.mp4" },
    ];
    undone.state.assets[0]!.locator = { absolutePath: "C:\\Media\\replacement.mp4" };
    const refreshed = {
      ...prepared,
      proxyPath: "C:\\Cache\\replacement-proxy.mp4",
      thumbnailPath: "C:\\Cache\\replacement-thumb.jpg",
    };
    const prepareVideoAsset = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(refreshed);
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      prepareVideoAsset,
      undoVideoProject: vi.fn(async (_projectId, _baseRevision, operationId) => {
        const invalidated = commandResult(opened, undone, operationId);
        invalidated.cacheInvalidations = ["asset_source"];
        return invalidated;
      }),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.undoEdit());

    expect(prepareVideoAsset).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "C:\\Media\\replacement.mp4" }),
    );
    expect(result.current.preparedAsset).toEqual(refreshed);
  });

  it("preserves the missing projection when relink selection is cancelled", async () => {
    const opened = clipProjection(1);
    opened.sources = [{ assetId: id(2), status: "missing", resolvedPath: null }];
    const openVideoProject = vi.fn(async () => ({
      projection: opened,
      recovery: {
        status: "clean" as const,
        recoveredRevision: 1,
        replayedRecordCount: 0,
        discardedTailBytes: 0,
        message: "Clean",
        legacyHistoryReset: false,
      },
    }));
    const relinkVideoProjectAsset = vi.fn(async () => null);
    const prepareVideoAsset = vi.fn(async () => prepared);
    const backend = createBackend({
      openVideoProject,
      relinkVideoProjectAsset,
      prepareVideoAsset,
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());

    await act(() => result.current.regrantSourceAccess());

    expect(relinkVideoProjectAsset).toHaveBeenCalledWith(opened.projectId, id(2));
    expect(openVideoProject).toHaveBeenCalledOnce();
    expect(prepareVideoAsset).not.toHaveBeenCalled();
    expect(result.current.projection).toEqual(opened);
    expect(result.current.source?.status).toBe("missing");
    expect(result.current.projectOperation).toEqual({ phase: "idle" });
  });
  it("rejects an unsupported multi-clip composition before destination picking", async () => {
    const opened = clipProjection(1);
    const track = opened.state.sequences[0]!.tracks[0]!;
    if (track.kind !== "video") throw new Error("expected video track fixture");
    track.clips.push({ ...structuredClone(track.clips[0]!), id: id(7) });
    const pickVideoExportPath = vi.fn(async () => "C:\\Exports\\clip.mp4");
    const startVideoRender = vi.fn();
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      pickVideoExportPath,
      startVideoRender,
    });
    const { result } = renderHook(() => useVideoProject(backend));

    await act(() => result.current.openProject());
    expect(result.current.renderIneligibilityReason).toBe(
      "Each video track must contain exactly one direct-asset clip to export",
    );
    expect(result.current.renderReady).toBe(false);
    await act(() => result.current.exportVideo());

    expect(pickVideoExportPath).not.toHaveBeenCalled();
    expect(startVideoRender).not.toHaveBeenCalled();
    expect(result.current.destinationError?.message).toBe(
      "Each video track must contain exactly one direct-asset clip to export",
    );
  });

  it("exports all canonical video tracks while preserving hidden-layer audio and editability", async () => {
    const opened = multitrackProjection(1);
    const startVideoRender = vi.fn(async (plan: RenderPlan) => ({
      jobId: id(90),
      planId: plan.planId,
      revisionId: plan.revisionId,
    }));
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      pickVideoExportPath: vi.fn(async () => "C:\\Exports\\multitrack.mp4"),
      startVideoRender,
    });
    const { result } = renderHook(() => useVideoProject(backend));

    await act(() => result.current.openProject());
    expect(backend.prepareVideoAsset).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.current.preparedAssetsById)).toEqual([id(2), id(8)]);
    await act(() => result.current.exportVideo());

    expect(startVideoRender).toHaveBeenCalledOnce();
    expect(startVideoRender.mock.calls[0]?.[0]).toMatchObject({
      schemaVersion: 2,
      videoInputs: [
        { hidden: false, muted: true, hasAudio: true },
        { hidden: true, muted: false, hasAudio: true },
      ],
      expected: { audio: true },
    });
    const secondaryTrack = result.current.projection?.state.sequences[0]?.tracks[1];
    expect(secondaryTrack?.kind).toBe("video");
    expect(secondaryTrack?.kind === "video" ? secondaryTrack.clips : []).toHaveLength(1);
  });

  it("stays running through a durable retry and accepts the sole completion terminal", async () => {
    const opened = clipProjection(1);
    const outputPath = "C:\\Exports\\clip.mp4";
    const unlisten = vi.fn();
    let renderHandler: ((event: VideoRenderNotification) => void) | null = null;
    const emitRenderEvent = (event: VideoRenderNotification) => {
      if (renderHandler === null) throw new Error("Render listener was not registered");
      renderHandler(event);
    };
    const backend = createBackend({
      openVideoProject: vi.fn(async () => ({
        projection: opened,
        recovery: {
          status: "clean" as const,
          recoveredRevision: 1,
          replayedRecordCount: 0,
          discardedTailBytes: 0,
          message: "Clean",
          legacyHistoryReset: false,
        },
      })),
      pickVideoExportPath: vi.fn(async () => outputPath),
      listenVideoRenderEvents: vi.fn(async (handler) => {
        renderHandler = handler;
        return unlisten;
      }),
      startVideoRender: vi.fn(async (plan) => ({
        jobId: id(90),
        planId: plan.planId,
        revisionId: plan.revisionId,
      })),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.openProject());
    await act(() => result.current.exportVideo());

    expect(result.current.render.phase).toBe("running");
    if (result.current.render.phase !== "running") throw new Error("Render did not start");
    const identity = {
      jobId: result.current.render.jobId,
      planId: result.current.render.planId,
      revisionId: result.current.render.revisionId,
    };
    const observedPhases = [result.current.render.phase];

    act(() =>
      emitRenderEvent({
        type: "progress",
        ...identity,
        completedMicroseconds: 250_000,
        durationMicroseconds: 2_000_000,
      }),
    );
    observedPhases.push(result.current.render.phase);
    expect(result.current.render).toMatchObject({ phase: "running", progress: 12 });
    expect(unlisten).not.toHaveBeenCalled();

    act(() =>
      emitRenderEvent({
        type: "completed",
        ...identity,
        output: {
          outputPath,
          previewPath: "C:\\Cache\\clip-preview.mp4",
          probe,
        },
      }),
    );
    observedPhases.push(result.current.render.phase);

    expect(observedPhases).toEqual(["running", "running", "completed"]);
    expect(observedPhases).not.toContain("failed");
    expect(result.current.render).toMatchObject({ phase: "completed", jobId: identity.jobId });
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("ignores a stale import result after a project switch", async () => {
    let resolveExecute!: (value: CommandResult) => void;
    const pending = new Promise<CommandResult>((resolve) => {
      resolveExecute = resolve;
    });
    const first = emptyProjection();
    const second = { ...emptyProjection(), projectId: id(9), name: "Second" };
    const backend = createBackend({
      createVideoProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      executeVideoProjectGroup: vi.fn(() => pending),
    });
    const { result } = renderHook(() => useVideoProject(backend));
    await act(() => result.current.newProject());
    let importPromise!: Promise<void>;
    act(() => {
      importPromise = result.current.prepareImportedSource("C:\\Media\\clip.mp4");
    });
    await waitFor(() => expect(backend.executeVideoProjectGroup).toHaveBeenCalled());
    await act(() => result.current.newProject());
    resolveExecute(commandResult(first, clipProjection(1), id(70)));
    await act(() => importPromise);
    expect(result.current.projection?.projectId).toBe(second.projectId);
  });
});
