// @vitest-environment jsdom

import type { AsrRuntimeStatus, MediaJobRecord } from "@supa-video/media";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptionBackend } from "../asr-ipc";
import { testMediaJob } from "../test-video-service";
import { TranscriptPanel, runtimeProblemMessage, type TranscriptTarget } from "./TranscriptPanel";

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
      transcriptKey: null,
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
    fireEvent.click(screen.getByRole("button", { name: "Accept license" }));
    await waitFor(() =>
      expect(fake.calls.setAsrConsent).toHaveBeenCalledWith(true, manifestSha256),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Transcribe" })).toHaveProperty("disabled", false),
    );
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
