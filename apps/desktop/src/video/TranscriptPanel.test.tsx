// @vitest-environment jsdom

import {
  createRationalTime,
  type MediaContentIdentityV1,
  type ProjectProjection,
} from "@supa-video/contracts";
import {
  createTranscriptArtifactV1,
  type AsrRuntimeStatus,
  type MediaJobRecord,
} from "@supa-video/media";
import {
  projectTranscriptToTimeline,
  type TranscriptTimelineOccurrence,
} from "@supa-video/project";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { TranscriptionBackend } from "../asr-ipc";
import { testMediaJob } from "../test-video-service";
import {
  TranscriptPanel,
  findActiveOccurrenceIndex,
  formatTimelineTime,
  runtimeProblemMessage,
  speakerDisplayName,
  type TranscriptTarget,
} from "./TranscriptPanel";

const manifestSha256 = "a".repeat(64);
const jobId = "40000000-0000-4000-8000-000000000001";

function status(overrides: Partial<AsrRuntimeStatus> = {}): AsrRuntimeStatus {
  return {
    runtimeFolder: null,
    runtime: { state: "notConfigured" },
    consent: "missing",
    manifestSha256,
    license: {
      modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
      modelRevision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d",
      modelLicenseSpdx: "OpenMDW-1.1",
      modelLicenseUrl: "https://openmdw.ai/license/1-1/",
      modelAttribution: "Nemotron by NVIDIA Corporation.",
      runtimeLicenseSpdx: "Apache-2.0",
      runtimeLicenseUrl: "https://github.com/NVIDIA/NeMo-Speech.cpp/blob/x/LICENSE",
      runtimeAttribution: "NeMo-Speech.cpp by NVIDIA Corporation.",
      commercialUse: true,
      device: "cuda:0",
    },
    ...overrides,
  };
}

const readyStatus = status({
  runtimeFolder: "E:\\nemo-runtime\\runtime",
  runtime: { state: "ready" },
  consent: "accepted",
});

const target: TranscriptTarget = {
  projectId: "40000000-0000-4000-8000-000000000010",
  assetId: "40000000-0000-4000-8000-000000000011",
  sourcePath: "C:\\media\\talk.mp4",
  sequenceId: "40000000-0000-4000-8000-000000000012",
  trackId: "40000000-0000-4000-8000-000000000013",
};

function backend(initial: AsrRuntimeStatus): TranscriptionBackend & {
  readonly calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    getAsrRuntimeStatus: vi.fn(async () => initial),
    chooseAsrRuntimeFolder: vi.fn(async () => readyStatus),
    setAsrConsent: vi.fn(async (accepted: boolean) =>
      status({ ...initial, consent: accepted ? "accepted" : "missing" }),
    ),
    startTranscription: vi.fn(async () => ({
      jobId,
      state: "queued" as const,
    })),
    getTranscriptionResult: vi.fn(async () => ({
      transcriptKey: "b".repeat(64),
      wordCount: 2,
      reused: false,
    })),
  };
  return { ...calls, calls } as unknown as TranscriptionBackend & {
    readonly calls: typeof calls;
  };
}

function props(fake: TranscriptionBackend, jobs: readonly MediaJobRecord[] = []) {
  return {
    backend: fake,
    loadTranscript: vi.fn(async () => {
      throw new Error("not used");
    }),
    projection: null,
    target,
    mediaJobs: jobs,
    disabled: false,
    onCancelJob: vi.fn(),
    onOpenJobCenter: vi.fn(),
    onApplyProposal: vi.fn(async () => true),
    onGenerateCaptions: vi.fn(async () => true),
  };
}

afterEach(cleanup);

describe("TranscriptPanel", () => {
  it("fails closed until a runtime is chosen and the license is accepted", async () => {
    const fake = backend(status());
    render(<TranscriptPanel {...props(fake)} />);

    const transcribe = await screen.findByRole("button", { name: "Transcribe" });
    expect(transcribe).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Choose runtime folder" }));
    await waitFor(() => expect(fake.calls.chooseAsrRuntimeFolder).toHaveBeenCalledOnce());
  });

  it("shows attribution and binds acceptance to the displayed manifest", async () => {
    const fake = backend(status({ runtime: { state: "ready" } }));
    render(<TranscriptPanel {...props(fake)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review license" }));
    expect(screen.getByRole("link", { name: "OpenMDW-1.1" }).getAttribute("href")).toBe(
      "https://openmdw.ai/license/1-1/",
    );
    expect(screen.getByText("Both licenses allow commercial use of your videos.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept license" }));
    await waitFor(() =>
      expect(fake.calls.setAsrConsent).toHaveBeenCalledWith(true, manifestSha256),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Transcribe" })).toHaveProperty("disabled", false),
    );
  });

  it("warns in the license dialog when commercial use is not allowed", async () => {
    const base = status({ runtime: { state: "ready" } });
    const fake = backend({ ...base, license: { ...base.license, commercialUse: false } });
    render(<TranscriptPanel {...props(fake)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review license" }));
    expect(
      screen.getByText(
        "One of these licenses does not allow commercial use. Check the license terms before using transcripts commercially.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Both licenses allow commercial use of your videos.")).toBeNull();
  });

  it("starts a transcription for the authorized source and offers cancellation", async () => {
    const fake = backend(readyStatus);
    const running = {
      ...testMediaJob,
      id: jobId,
      kind: "transcription",
      state: "running",
    } as const satisfies MediaJobRecord;
    const panelProps = props(fake);
    const view = render(<TranscriptPanel {...panelProps} />);

    fireEvent.click(await screen.findByRole("button", { name: "Transcribe" }));
    await waitFor(() =>
      expect(fake.calls.startTranscription).toHaveBeenCalledWith({
        projectId: target.projectId,
        assetId: target.assetId,
        sourcePath: target.sourcePath,
      }),
    );
    view.rerender(<TranscriptPanel {...panelProps} mediaJobs={[running]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel transcription" }));
    expect(panelProps.onCancelJob).toHaveBeenCalledWith(jobId);
  });

  it("offers another attempt after a blocked job", async () => {
    const fake = backend(readyStatus);
    const panelProps = props(fake);
    const view = render(<TranscriptPanel {...panelProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Transcribe" }));
    await waitFor(() => expect(fake.calls.startTranscription).toHaveBeenCalledOnce());
    const blocked = {
      ...testMediaJob,
      id: jobId,
      kind: "transcription",
      state: "blocked",
      error: {
        code: "cuda_not_proven",
        category: "toolchain_unavailable",
        message: "The runtime did not prove CUDA execution.",
        retryable: false,
        action: "verify_toolchain",
      },
    } as const satisfies MediaJobRecord;
    view.rerender(<TranscriptPanel {...panelProps} mediaJobs={[blocked]} />);
    expect(await screen.findByRole("button", { name: "Transcribe again" })).toBeTruthy();
  });

  it("reads a completed job's transcript by key", async () => {
    const fake = backend(readyStatus);
    const panelProps = props(fake);
    const view = render(<TranscriptPanel {...panelProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Transcribe" }));
    await waitFor(() => expect(fake.calls.startTranscription).toHaveBeenCalledOnce());
    const complete = {
      ...testMediaJob,
      id: jobId,
      kind: "transcription",
      state: "complete",
      settledAt: testMediaJob.updatedAt,
      resultAvailable: true,
    } as const satisfies MediaJobRecord;
    view.rerender(<TranscriptPanel {...panelProps} mediaJobs={[complete]} />);
    await waitFor(() => expect(fake.calls.getTranscriptionResult).toHaveBeenCalledWith(jobId));
    await waitFor(() => expect(panelProps.loadTranscript).toHaveBeenCalledWith("b".repeat(64)));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("names the offending runtime file without exposing paths", () => {
    expect(
      runtimeProblemMessage(
        status({
          runtime: {
            state: "unavailable",
            problem: { reason: "unexpectedExecutable", name: "evil.dll" },
          },
        }),
      ),
    ).toBe("The folder contains an unexpected program: evil.dll.");
    expect(runtimeProblemMessage(readyStatus)).toBeNull();
  });
});

describe("TranscriptPanel word navigation", () => {
  const rate = { numerator: 10, denominator: 1 } as const;
  const sequenceId = target.sequenceId;
  const trackId = target.trackId;
  const texts = ["Hi", "there", "hello", "back", "again"] as const;
  const speakers = ["speaker_1", "speaker_1", "speaker_2", null, "speaker_2"] as const;
  const sourceIdentity: MediaContentIdentityV1 = {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: "12".repeat(32),
    byteLength: 1_000,
  };

  // Words start every 0.5 s: frames 0, 5, 10, 15, 20 of the source at 10 fps.
  const artifactPromise = createTranscriptArtifactV1({
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
      engineId: "nemo-speech.cpp",
      engineVersion: "5be7bfb104802131e61fe679b3f1401b27270216",
      modelId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
      modelRevision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d",
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
          speakerLabel: speakers[index] ?? null,
          speakerConfidence: null,
          timingProvenance: "aligned" as const,
        })),
      },
    ],
  });

  /** One clip of the source, trimmed to start at `sourceIn` and moved to `timelineStart`. */
  function projectionWith(sourceIn: number, timelineStart: number): ProjectProjection {
    return {
      projectId: target.projectId,
      name: "Navigation fixture",
      revision: {
        number: 1,
        id: "40000000-0000-4000-8000-000000000101",
        parentId: null,
        committedAt: "2026-09-28T12:00:00.000Z",
        operationId: "40000000-0000-4000-8000-000000000102",
        stateHash: "03".repeat(32),
      },
      state: {
        assets: [
          {
            id: target.assetId,
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
            id: sequenceId,
            name: "Main",
            rate,
            width: 1_920,
            height: 1_080,
            audioSampleRate: 48_000,
            tracks: [
              {
                id: trackId,
                name: "Video",
                kind: "video",
                clips: [
                  {
                    id: "40000000-0000-4000-8000-000000000300",
                    source: { kind: "asset", assetId: target.assetId },
                    timelineStart: createRationalTime(timelineStart, rate),
                    sourceIn: createRationalTime(sourceIn, rate),
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
        activeSequenceId: sequenceId,
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
  }

  async function renderLoaded(
    projection: ProjectProjection,
    extra: Partial<Parameters<typeof TranscriptPanel>[0]> = {},
  ) {
    const artifact = await artifactPromise;
    const fake = backend(readyStatus);
    const panelProps = {
      ...props(fake),
      loadTranscript: vi.fn(async () => artifact),
      projection,
      onSeekTimelineFrame: vi.fn(),
      ...extra,
    };
    const view = render(<TranscriptPanel {...panelProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Transcribe" }));
    await waitFor(() => expect(fake.calls.startTranscription).toHaveBeenCalledOnce());
    const complete = {
      ...testMediaJob,
      id: jobId,
      kind: "transcription",
      state: "complete",
      settledAt: testMediaJob.updatedAt,
      resultAvailable: true,
    } as const satisfies MediaJobRecord;
    const withJob = { ...panelProps, mediaJobs: [complete] };
    view.rerender(<TranscriptPanel {...withJob} />);
    return { view, panelProps: withJob, artifact };
  }

  it("shows speaker headings as text with an unknown-speaker fallback", async () => {
    await renderLoaded(projectionWith(0, 0));
    await screen.findByRole("button", { name: "Hi" });
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Speaker 1", "Speaker 2", "Unknown speaker", "Speaker 2"]);
    expect(screen.getByText(/may be wrong/u)).toBeTruthy();
  });

  it("seeks to the exact timeline frame of a word after a trim and move", async () => {
    const projection = projectionWith(10, 40);
    const { panelProps, artifact } = await renderLoaded(projection);
    const occurrences = projectTranscriptToTimeline({
      artifact,
      projection,
      sequenceId,
      trackId,
    }).occurrences;
    const back = occurrences.find((occurrence) => occurrence.text === "back");
    // Source frame 15, trimmed by 10 and moved to 40: timeline frame 45.
    expect(back?.timelineRange.start.value).toBe(45);

    fireEvent.click(await screen.findByRole("button", { name: "Seek to back at 0:04.50" }));
    expect(panelProps.onSeekTimelineFrame).toHaveBeenCalledWith(45);
    fireEvent.click(screen.getByRole("button", { name: "Seek to hello at 0:04.00" }));
    expect(panelProps.onSeekTimelineFrame).toHaveBeenLastCalledWith(40);
  });

  it("does not offer seeking for words cut from the timeline", async () => {
    await renderLoaded(projectionWith(10, 0));
    await screen.findByRole("button", { name: "hello" });
    expect(screen.queryByRole("button", { name: "Hi" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Seek to Hi /u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Seek to there /u })).toBeNull();
    expect(screen.getByText("2 words are not on the timeline")).toBeTruthy();
    expect(screen.getByText("Hi there")).toBeTruthy();
  });

  it("marks the word under the playhead as current", async () => {
    const projection = projectionWith(0, 0);
    const { view, panelProps } = await renderLoaded(projection, { playheadFrame: 16 });
    const back = await screen.findByRole("button", { name: "back" });
    expect(back.getAttribute("aria-current")).toBe("true");
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);

    view.rerender(<TranscriptPanel {...panelProps} playheadFrame={19} />);
    // Frame 19 falls in the gap between "back" (15 to 19) and "again" (20 to 24).
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
    view.rerender(<TranscriptPanel {...panelProps} playheadFrame={20} />);
    expect(screen.getByRole("button", { name: "again" }).getAttribute("aria-current")).toBe("true");
  });

  it("previews a cut before applying it, and applies nothing on Keep editing", async () => {
    const { panelProps } = await renderLoaded(projectionWith(0, 0));
    fireEvent.click(await screen.findByRole("button", { name: "hello" }));
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 selected words" }));

    const review = await screen.findByRole("dialog", { name: "Review cut" });
    // The fixture leaves a one-frame pause between the words; it lies inside the
    // deleted range, so it goes with them and the cut is one range.
    expect(review.textContent).toContain("Removes 2 words in 1 range.");
    expect(
      within(review)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("0:01.00 to 0:01.90 hello back")]);
    expect(panelProps.onApplyProposal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review cut" })).toBeNull());
    expect(panelProps.onApplyProposal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "hello" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 selected words" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply cut" }));
    await waitFor(() => expect(panelProps.onApplyProposal).toHaveBeenCalledOnce());
    const [proposal] = vi.mocked(panelProps.onApplyProposal).mock.calls[0] ?? [];
    expect(proposal?.selectedWords.map((word) => word.text)).toEqual(["hello", "back"]);
  });

  it("scrolls the current word into view only while paused", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const { view, panelProps } = await renderLoaded(projectionWith(0, 0), {
      playheadFrame: 0,
      playing: true,
    });
    await screen.findByRole("button", { name: "Hi" });
    view.rerender(<TranscriptPanel {...panelProps} playheadFrame={6} playing />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(<TranscriptPanel {...panelProps} playheadFrame={6} playing={false} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("findActiveOccurrenceIndex", () => {
  const occurrence = (start: number, end: number) =>
    ({
      timelineRange: {
        start: createRationalTime(start, { numerator: 10, denominator: 1 }),
        end: createRationalTime(end, { numerator: 10, denominator: 1 }),
      },
    }) as TranscriptTimelineOccurrence;
  const sorted = [occurrence(0, 4), occurrence(5, 9), occurrence(12, 15)];

  it.each([
    [null, -1],
    [0, 0],
    [3, 0],
    [4, -1],
    [5, 1],
    [10, -1],
    [14, 2],
    [15, -1],
    [99, -1],
  ])("frame %s resolves to index %s", (frame, index) => {
    expect(findActiveOccurrenceIndex(sorted, frame)).toBe(index);
  });

  it("formats timeline frames and speaker names", () => {
    expect(formatTimelineTime(45, { rateNumerator: 10, rateDenominator: 1 })).toBe("0:04.50");
    expect(formatTimelineTime(1_830, { rateNumerator: 30, rateDenominator: 1 })).toBe("1:01.00");
    expect(speakerDisplayName("speaker_3")).toBe("Speaker 3");
    expect(speakerDisplayName(null)).toBe("Unknown speaker");
  });
});
