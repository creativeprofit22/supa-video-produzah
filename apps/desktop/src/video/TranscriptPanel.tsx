import { VideoDomainError, type ProjectProjection } from "@supa-video/contracts";
import type { AsrRuntimeStatus, MediaJobRecord, TranscriptArtifactV1 } from "@supa-video/media";
import {
  createTranscriptEditProposal,
  projectTranscriptToTimeline,
  type TranscriptEditProposal,
  type TranscriptTimelineOccurrence,
} from "@supa-video/project";
import { Captions, FolderOpen, Mic, RotateCcw, Scissors, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TranscriptionBackend } from "../asr-ipc";
import { MediaJobStatus, isMediaJobActive, isMediaJobSettled } from "./MediaJobStatus";

export interface TranscriptTarget {
  readonly projectId: string;
  readonly assetId: string;
  readonly sourcePath: string;
  readonly sequenceId: string;
  readonly trackId: string;
}

interface TranscriptPanelProps {
  readonly backend: TranscriptionBackend;
  readonly loadTranscript: (key: string) => Promise<TranscriptArtifactV1>;
  readonly projection: ProjectProjection | null;
  readonly target: TranscriptTarget | null;
  readonly mediaJobs: readonly MediaJobRecord[];
  readonly disabled: boolean;
  readonly onCancelJob: (jobId: string) => void;
  readonly onOpenJobCenter: (jobId: string) => void;
  readonly onApplyProposal: (
    proposal: TranscriptEditProposal,
    artifact: TranscriptArtifactV1,
  ) => Promise<boolean>;
  readonly onGenerateCaptions: (artifact: TranscriptArtifactV1) => Promise<boolean>;
}

const problemMessages: Record<string, string> = {
  folderMissing: "That folder could not be found. Choose the runtime folder again.",
  linkedPath: "The runtime folder uses a link or shortcut. Choose the real folder.",
  tooManyEntries: "That folder has too many files. Choose the dedicated runtime folder.",
  missingFile: "A required runtime file is missing",
  sizeMismatch: "A runtime file is a different version than expected",
  unexpectedExecutable: "The folder contains an unexpected program",
  integrityFailed: "The runtime files did not pass the integrity check.",
};

export function runtimeProblemMessage(status: AsrRuntimeStatus): string | null {
  if (status.runtime.state !== "unavailable") return null;
  const problem = status.runtime.problem;
  const base = problemMessages[problem.reason] ?? "The runtime folder could not be verified.";
  return "name" in problem ? `${base}: ${problem.name}.` : base;
}

function safeError(error: unknown): string {
  if (error instanceof VideoDomainError) {
    if (error.details["category"] === "consent_required")
      return "Accept the model license before transcribing.";
    if (error.details["category"] === "runtime_in_use")
      return "Wait for the running transcription to finish before changing the runtime.";
    if (error.code === "path_not_granted")
      return "Access to the source expired. Reopen the project.";
    if (error.code === "tool_unavailable")
      return "The speech-recognition runtime is not ready. Check its folder.";
    if (error.code === "invalid_range" || error.code === "invalid_project")
      return "The transcript no longer matches this timeline. Transcribe again.";
  }
  return "Transcription could not be completed. Try again.";
}

type TranscriptLoad =
  | { readonly phase: "idle" }
  | { readonly phase: "loading"; readonly jobId: string }
  | { readonly phase: "loaded"; readonly jobId: string; readonly artifact: TranscriptArtifactV1 }
  | { readonly phase: "error"; readonly jobId: string; readonly message: string };

export function TranscriptPanel({
  backend,
  loadTranscript,
  projection,
  target,
  mediaJobs,
  disabled,
  onCancelJob,
  onOpenJobCenter,
  onApplyProposal,
  onGenerateCaptions,
}: TranscriptPanelProps) {
  const [status, setStatus] = useState<AsrRuntimeStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [load, setLoad] = useState<TranscriptLoad>({ phase: "idle" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const consentDialogRef = useRef<HTMLDialogElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const next = await backend.getAsrRuntimeStatus();
        if (current) setStatus(next);
      } catch (error) {
        if (current) setMessage(safeError(error));
      }
    })();
    return () => {
      current = false;
    };
  }, [backend]);

  const job = useMemo(
    () => (jobId === null ? null : (mediaJobs.find((candidate) => candidate.id === jobId) ?? null)),
    [jobId, mediaJobs],
  );

  // Load the finished transcript exactly once per completed job.
  useEffect(() => {
    if (job === null || job.state !== "complete" || load.phase !== "idle") return;
    const completedId = job.id;
    setLoad({ phase: "loading", jobId: completedId });
    void (async () => {
      try {
        const result = await backend.getTranscriptionResult(completedId);
        const artifact = await loadTranscript(result.transcriptKey);
        setLoad({ phase: "loaded", jobId: completedId, artifact });
        setSelected(new Set());
      } catch (error) {
        setLoad({ phase: "error", jobId: completedId, message: safeError(error) });
      }
    })();
  }, [backend, job, load.phase, loadTranscript]);

  const occurrences = useMemo((): readonly TranscriptTimelineOccurrence[] => {
    if (load.phase !== "loaded" || projection === null || target === null) return [];
    try {
      return projectTranscriptToTimeline({
        artifact: load.artifact,
        projection,
        sequenceId: target.sequenceId,
        trackId: target.trackId,
      }).occurrences;
    } catch {
      return [];
    }
  }, [load, projection, target]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setPending(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(safeError(error));
    } finally {
      setPending(false);
    }
  }, []);

  const chooseRuntime = () =>
    run(async () => {
      const next = await backend.chooseAsrRuntimeFolder();
      if (next !== null) setStatus(next);
    });

  const openConsent = () => {
    const dialog = consentDialogRef.current;
    if (dialog === null || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };
  const closeConsent = () => {
    const dialog = consentDialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    reviewButtonRef.current?.focus();
  };
  const setConsent = (accepted: boolean) =>
    run(async () => {
      if (status === null) return;
      setStatus(await backend.setAsrConsent(accepted, accepted ? status.manifestSha256 : ""));
      closeConsent();
    });

  const start = () =>
    run(async () => {
      if (target === null) return;
      const started = await backend.startTranscription({
        projectId: target.projectId,
        assetId: target.assetId,
        sourcePath: target.sourcePath,
      });
      setJobId(started.jobId);
      setLoad({ phase: "idle" });
    });

  const deleteSelected = () =>
    run(async () => {
      if (load.phase !== "loaded" || projection === null || target === null) return;
      const proposal = await createTranscriptEditProposal({
        artifact: load.artifact,
        projection,
        sequenceId: target.sequenceId,
        trackId: target.trackId,
        deletedOccurrenceIds: [...selected],
      });
      if (await onApplyProposal(proposal, load.artifact)) setSelected(new Set());
    });

  const generateCaptions = () =>
    run(async () => {
      if (load.phase !== "loaded") return;
      await onGenerateCaptions(load.artifact);
    });

  const toggle = (occurrenceId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(occurrenceId)) next.delete(occurrenceId);
      else next.add(occurrenceId);
      return next;
    });

  const ready = status?.runtime.state === "ready" && status.consent === "accepted";
  const active = job !== null && !isMediaJobSettled(job) && job.state !== "blocked";
  const canTryAgain =
    job !== null &&
    (job.state === "failed" || job.state === "blocked" || job.state === "cancelled");
  const problem = status === null ? null : runtimeProblemMessage(status);

  return (
    <section
      className="panel transcript-panel"
      aria-labelledby="transcript-title"
      aria-busy={pending || (job !== null && isMediaJobActive(job))}
    >
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Speech</p>
          <h2 id="transcript-title">Transcript</h2>
        </div>
      </div>

      {status === null ? (
        <p className="muted-copy">Checking the speech-recognition runtime…</p>
      ) : (
        <div className="transcript-setup">
          <p className="muted-copy">
            Runs locally on your NVIDIA GPU ({status.license.device}). Your source media is never
            changed or uploaded.
          </p>
          {status.runtime.state !== "ready" ? (
            <div>
              {problem !== null ? (
                <p role="alert" className="inline-error">
                  {problem}
                </p>
              ) : (
                <p className="muted-copy">Choose the folder with the pinned runtime and model.</p>
              )}
              <button
                className="secondary-button"
                type="button"
                disabled={pending || disabled}
                onClick={() => void chooseRuntime()}
              >
                <FolderOpen size={16} aria-hidden />
                Choose runtime folder
              </button>
            </div>
          ) : null}
          {status.consent !== "accepted" ? (
            <div>
              <p className="muted-copy">
                {status.consent === "stale"
                  ? "The model changed since you last accepted its license."
                  : "Review and accept the model license before the first transcription."}
              </p>
              <button
                ref={reviewButtonRef}
                className="secondary-button"
                type="button"
                disabled={pending}
                onClick={openConsent}
              >
                <ShieldCheck size={16} aria-hidden />
                Review license
              </button>
            </div>
          ) : null}
          <dialog
            ref={consentDialogRef}
            className="overwrite-dialog"
            aria-labelledby="asr-consent-title"
            onCancel={(event) => {
              event.preventDefault();
              closeConsent();
            }}
          >
            <h2 id="asr-consent-title">Speech model license</h2>
            <p>{status.license.modelAttribution}</p>
            <p>
              Model license:{" "}
              <a href={status.license.modelLicenseUrl} target="_blank" rel="noreferrer noopener">
                {status.license.modelLicenseSpdx}
              </a>
              . Runtime license:{" "}
              <a href={status.license.runtimeLicenseUrl} target="_blank" rel="noreferrer noopener">
                {status.license.runtimeLicenseSpdx}
              </a>
              .
            </p>
            <p>{status.license.runtimeAttribution}</p>
            <p>
              Audio is processed only on this computer. The app never downloads or updates the
              model.
            </p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={closeConsent}>
                Not now
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={pending}
                onClick={() => void setConsent(true)}
              >
                Accept license
              </button>
            </div>
          </dialog>
          {status.consent === "accepted" ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={pending || active}
              onClick={() => void setConsent(false)}
            >
              Withdraw license acceptance
            </button>
          ) : null}
        </div>
      )}

      <div className="transcript-actions">
        {active && job !== null ? (
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={job.cancellationRequested}
            onClick={() => onCancelJob(job.id)}
          >
            <X size={16} aria-hidden />
            {job.cancellationRequested ? "Cancelling" : "Cancel transcription"}
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            disabled={!ready || target === null || pending || disabled}
            onClick={() => void start()}
          >
            {canTryAgain ? <RotateCcw size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
            {canTryAgain ? "Transcribe again" : "Transcribe"}
          </button>
        )}
      </div>
      {target === null ? (
        <p className="muted-copy">Add a clip with audio to the timeline to transcribe it.</p>
      ) : null}

      {job !== null ? (
        <MediaJobStatus
          job={job}
          label="Transcription"
          subject="Transcription"
          onOpenJobCenter={onOpenJobCenter}
        />
      ) : null}

      {message !== null ? (
        <p role="alert" className="inline-error">
          {message}
        </p>
      ) : null}
      {load.phase === "error" ? (
        <p role="alert" className="inline-error">
          {load.message}
        </p>
      ) : null}
      {load.phase === "loading" ? <p className="muted-copy">Loading transcript…</p> : null}

      {load.phase === "loaded" ? (
        <div className="transcript-body">
          <p id="transcript-help" className="muted-copy">
            Select words to remove from the timeline. {occurrences.length} words on the timeline.
          </p>
          <ul className="transcript-words" aria-describedby="transcript-help">
            {occurrences.map((occurrence) => (
              <li key={occurrence.occurrenceId}>
                <button
                  className="transcript-word"
                  type="button"
                  aria-pressed={selected.has(occurrence.occurrenceId)}
                  onClick={() => toggle(occurrence.occurrenceId)}
                >
                  {occurrence.text}
                </button>
              </li>
            ))}
          </ul>
          <div className="transcript-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={selected.size === 0 || pending || disabled}
              onClick={() => void deleteSelected()}
            >
              <Scissors size={16} aria-hidden />
              Remove {selected.size} selected {selected.size === 1 ? "word" : "words"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={occurrences.length === 0 || pending || disabled}
              onClick={() => void generateCaptions()}
            >
              <Captions size={16} aria-hidden />
              Generate captions
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
