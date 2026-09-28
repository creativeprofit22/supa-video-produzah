import {
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectProjection,
} from "@supa-video/contracts";
import {
  createTranscriptArtifactV1,
  type AsrRuntimeStatus,
  type MediaJobRecord,
  type CaptionArtifactV1,
  type TranscriptArtifactV1,
} from "@supa-video/media";
import { buildGenerateCaptionsCommandGroup } from "@supa-video/project";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import type { TranscriptionBackend } from "../src/asr-ipc";
import { CaptionsPanel } from "../src/video/CaptionsPanel";
import { TranscriptPanel } from "../src/video/TranscriptPanel";

const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const rate = { numerator: 10, denominator: 1 } as const;
const jobId = id(500);
const timestamp = "2026-09-28T12:00:00.000Z";
const sourceIdentity: MediaContentIdentityV1 = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "12".repeat(32),
  byteLength: 1_000,
};
const words = [
  "And",
  "so,",
  "my",
  "fellow",
  "Americans,",
  "ask",
  "not",
  "what",
  "your",
  "country",
  "can",
  "do",
  "for",
  "you,",
  "ask",
  "what",
  "you",
  "can",
  "do",
  "for",
  "your",
  "country.",
];

const projection: ProjectProjection = {
  projectId: id(900),
  name: "Transcript fixture",
  revision: {
    number: 3,
    id: id(103),
    parentId: id(102),
    committedAt: timestamp,
    operationId: id(203),
    stateHash: "03".repeat(32),
  },
  state: {
    assets: [
      {
        id: id(1),
        displayName: "jfk.wav",
        locator: { absolutePath: "C:/media/jfk.wav" },
        probe: {
          durationMicroseconds: 11_000_000,
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
        id: id(2),
        name: "Main",
        rate,
        width: 1_920,
        height: 1_080,
        audioSampleRate: 48_000,
        tracks: [
          {
            id: id(10),
            name: "Video",
            kind: "video",
            clips: [
              {
                id: id(300),
                source: { kind: "asset", assetId: id(1) },
                timelineStart: createRationalTime(0, rate),
                sourceIn: createRationalTime(0, rate),
                sourceOut: createRationalTime(110, rate),
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
    activeSequenceId: id(2),
  },
  canUndo: false,
  canRedo: false,
  lastCommand: null,
  sources: [],
  journalHealth: "healthy",
  snapshotRevision: 3,
  recoveryStatus: "clean",
  replayedRecordCount: 3,
};

const artifact: TranscriptArtifactV1 = await createTranscriptArtifactV1({
  sourceIdentity,
  sourceFingerprint: {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: "34".repeat(32),
    byteLength: 1_000,
    modifiedUnixSeconds: 1,
    modifiedNanoseconds: 0,
  },
  sourceDurationUs: 11_000_000,
  configuration: {
    schemaVersion: 1,
    engineId: "nemo-speech.cpp",
    engineVersion: "5be7bfb104802131e61fe679b3f1401b27270216",
    modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
    modelRevision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d",
    requestedLanguage: "en",
    task: "transcribe",
    wordTimingRequired: true,
    speakerDiarizationMode: "off",
    chunkDurationUs: 11_000_000,
    chunkOverlapUs: 0,
    providerSettings: [],
  },
  chunks: [
    {
      schemaVersion: 1,
      chunkId: "chunk-0",
      chunkIndex: 0,
      sourceStartUs: 0,
      sourceEndUs: 11_000_000,
      words: words.map((text, index) => ({
        text,
        relativeStartUs: index * 450_000,
        relativeEndUs: index * 450_000 + 400_000,
        recognitionConfidence: 1,
        speakerLabel: null,
        speakerConfidence: 0,
        timingProvenance: "aligned",
      })),
    },
  ],
});

const status: AsrRuntimeStatus = {
  runtimeFolder: null,
  runtime: { state: "notConfigured" },
  consent: "missing",
  manifestSha256: "ab".repeat(32),
  license: {
    modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
    modelRevision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d",
    modelLicenseSpdx: "OpenMDW-1.1",
    modelLicenseUrl: "https://openmdw.ai/license/1-1/",
    modelAttribution:
      "Nemotron 3.5 ASR Streaming 0.6B by NVIDIA Corporation, used under the OpenMDW-1.1 license.",
    runtimeLicenseSpdx: "Apache-2.0",
    runtimeLicenseUrl: "https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/LICENSE",
    runtimeAttribution: "NeMo-Speech.cpp by NVIDIA Corporation, built locally with CUDA 12.6.",
    commercialUse: true,
    device: "cuda:0",
  },
};

function job(state: "running" | "complete"): MediaJobRecord {
  const base = {
    schemaVersion: 1 as const,
    id: jobId,
    kind: "transcription" as const,
    parentId: null,
    projectId: projection.projectId,
    assetId: id(1),
    revisionId: null,
    priority: "interactive" as const,
    stage: state === "running" ? "transcribing" : "complete",
    progress: { completed: state === "running" ? 0 : 1, total: 1, unit: "stages" as const },
    attempt: 1,
    maxAttempts: 2,
    summary: "Transcribe source audio",
    error: null,
    retryAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    cancellationRequested: false,
  };
  return state === "running"
    ? ({ ...base, state, settledAt: null, resultAvailable: false } as MediaJobRecord)
    : ({ ...base, state, settledAt: timestamp, resultAvailable: true } as MediaJobRecord);
}

/** Mirrors what the native service does for InsertTrack + ApplyCaptionArtifact. */
function applyGroupLocally(
  base: ProjectProjection,
  transcript: TranscriptArtifactV1,
): ProjectProjection {
  const group = buildGenerateCaptionsCommandGroup({
    artifact: transcript,
    projection: base,
    sequenceId: id(2),
    trackId: id(10),
    language: "en",
    groupId: id(600),
    applyCommandId: id(601),
    insertTrackCommandId: id(602),
    newCaptionTrackId: id(603),
  });
  const apply = group.commandGroup.commands.at(-1);
  if (apply?.type !== "ApplyCaptionArtifact") throw new Error("Expected caption apply");
  const withTrack: ProjectProjection = {
    ...base,
    state: {
      ...base.state,
      sequences: base.state.sequences.map((sequence) => ({
        ...sequence,
        tracks: [
          ...sequence.tracks,
          { id: group.captionTrackId, name: "Captions", kind: "caption", captions: [] },
        ],
      })),
    },
  };
  return withCaptionArtifact(withTrack, group.captionTrackId, apply.artifact);
}

function withCaptionArtifact(
  base: ProjectProjection,
  trackId: string,
  artifact: CaptionArtifactV1,
): ProjectProjection {
  return {
    ...base,
    state: {
      ...base.state,
      sequences: base.state.sequences.map((sequence) => ({
        ...sequence,
        tracks: sequence.tracks.map((track) =>
          track.id === trackId && track.kind === "caption"
            ? { ...track, activeCaptionArtifact: artifact }
            : track,
        ),
      })),
    },
  };
}

function Fixture() {
  const [jobs, setJobs] = useState<readonly MediaJobRecord[]>([]);
  const [current, setCurrent] = useState(status);
  const [log, setLog] = useState<string>("");
  const [captioned, setCaptioned] = useState<ProjectProjection>(projection);
  const backend: TranscriptionBackend = {
    getAsrRuntimeStatus: async () => current,
    chooseAsrRuntimeFolder: async () => {
      const next = {
        ...current,
        runtimeFolder: "E:\\nemo-runtime\\runtime",
        runtime: { state: "ready" as const },
      };
      setCurrent(next);
      return next;
    },
    setAsrConsent: async (accepted) => {
      const next = { ...current, consent: accepted ? ("accepted" as const) : ("missing" as const) };
      setCurrent(next);
      return next;
    },
    startTranscription: async () => {
      setJobs([job("running")]);
      window.setTimeout(() => setJobs([job("complete")]), 300);
      return { jobId, state: "queued", transcriptKey: null };
    },
    getTranscriptionResult: async () => ({
      transcriptKey: artifact.identity.key,
      wordCount: words.length,
      reused: false,
    }),
  };
  return (
    <main style={{ padding: 12, maxWidth: 480 }}>
      <TranscriptPanel
        backend={backend}
        loadTranscript={async () => artifact}
        projection={projection}
        target={{
          projectId: projection.projectId,
          assetId: id(1),
          sourcePath: "C:\\media\\jfk.wav",
          sequenceId: id(2),
          trackId: id(10),
        }}
        mediaJobs={jobs}
        disabled={false}
        onCancelJob={() => setLog("cancel")}
        onOpenJobCenter={() => setLog("job-center")}
        onApplyProposal={async (proposal) => {
          setLog(`remove:${proposal.selectedOccurrenceIds.length}`);
          return true;
        }}
        onGenerateCaptions={async (transcript) => {
          setCaptioned(applyGroupLocally(projection, transcript));
          setLog("captions");
          return true;
        }}
      />
      <CaptionsPanel
        projection={captioned}
        sequenceId={id(2)}
        disabled={false}
        onApply={async (active, next) => {
          setCaptioned(withCaptionArtifact(captioned, active.trackId, next));
          setLog(`caption-edit:${next.style.typography.fontSizePx}`);
          return true;
        }}
        subtitleWriter={{
          pick: async (format) => `C:/exports/captions.${format}`,
          write: async (format, _path, contents) => {
            setLog(`subtitles:${format}:${contents.split("\n")[0] ?? ""}`);
          },
        }}
      />
      <output data-testid="fixture-log">{log}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
ReactDOM.createRoot(root).render(<Fixture />);
