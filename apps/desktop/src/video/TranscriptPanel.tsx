import { VideoDomainError, type ProjectProjection } from "@supa-video/contracts";
import type { AsrRuntimeStatus, MediaJobRecord, TranscriptArtifactV1 } from "@supa-video/media";
import {
  createTranscriptEditProposal,
  projectTranscriptToTimeline,
  type TranscriptEditProposal,
  type TranscriptTimelineOccurrence,
} from "@supa-video/project";
import {
  Captions,
  FolderOpen,
  LocateFixed,
  Mic,
  RotateCcw,
  Scissors,
  ShieldCheck,
  X,
} from "lucide-react";
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
  /** Shares the loaded transcript (or null when none) with sibling panels. */
  readonly onArtifactChange?: (artifact: TranscriptArtifactV1 | null) => void;
  /** Moves the monitor and timeline playhead to a timeline frame. */
  readonly onSeekTimelineFrame?: (frame: number) => void;
  /** The current timeline playhead frame, used to mark the spoken word. */
  readonly playheadFrame?: number | null;
  /** While playing, the active word is marked but never scrolled into view. */
  readonly playing?: boolean;
}

/** "speaker_2" becomes "Speaker 2"; any other label is shown as-is. */
export function speakerDisplayName(label: string | null): string {
  if (label === null) return "Unknown speaker";
  const match = /^speaker_(\d+)$/u.exec(label);
  return match === null ? label : `Speaker ${match[1]}`;
}

/** Minutes, seconds and hundredths of a timeline frame. */
export function formatTimelineTime(
  frame: number,
  rate: { readonly rateNumerator: number; readonly rateDenominator: number },
): string {
  const seconds = (frame * rate.rateDenominator) / rate.rateNumerator;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

/**
 * Index of the occurrence whose timeline range contains `frame`, or -1.
 * Occurrences are sorted by timeline start and do not overlap on one track,
 * so a binary search finds the last start at or before the frame.
 */
export function findActiveOccurrenceIndex(
  occurrences: readonly TranscriptTimelineOccurrence[],
  frame: number | null,
): number {
  if (frame === null) return -1;
  let low = 0;
  let high = occurrences.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = occurrences[middle];
    if (candidate === undefined) break;
    if (candidate.timelineRange.start.value <= frame) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const active = occurrences[found];
  return active !== undefined && frame < active.timelineRange.end.value ? found : -1;
}

function rangeFrames(range: {
  readonly start: { readonly value: number };
  readonly end: { readonly value: number };
}): number {
  return range.end.value - range.start.value;
}

/** What the reviewed cut removes and how long the timeline becomes. */
function CutPreview({ proposal }: { readonly proposal: TranscriptEditProposal }) {
  const first = proposal.keptRanges[0] ?? proposal.deletedRanges[0];
  if (first === undefined) return null;
  const rate = first.originalTimelineRange.start;
  const removedFrames = proposal.deletedRanges.reduce(
    (total, range) => total + rangeFrames(range.originalTimelineRange),
    0,
  );
  const wordCount = proposal.deletedRanges.reduce(
    (total, range) => total + range.selectedWords.length,
    0,
  );
  return (
    <>
      <h2 id="transcript-cut-title">Review cut</h2>
      <p>
        Removes {wordCount} {wordCount === 1 ? "word" : "words"} in {proposal.deletedRanges.length}{" "}
        {proposal.deletedRanges.length === 1 ? "range" : "ranges"}. Later material moves earlier to
        close each gap, so the track gets {formatTimelineTime(removedFrames, rate)} shorter. You can
        undo this.
      </p>
      <ol className="transcript-cut-ranges">
        {proposal.deletedRanges.map((range) => (
          <li key={`${range.clipId}-${range.originalTimelineRange.start.value}`}>
            <span className="transcript-cut-time">
              {formatTimelineTime(range.originalTimelineRange.start.value, rate)} to{" "}
              {formatTimelineTime(range.originalTimelineRange.end.value, rate)}
            </span>{" "}
            <q>{range.selectedWords.map((word) => word.text).join(" ")}</q>{" "}
            <span className="muted-copy">
              (the cut point lands at{" "}
              {formatTimelineTime(range.previewTimelineRange.start.value, rate)})
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

interface SpeakerSegment {
  readonly key: string;
  readonly speakerLabel: string | null;
  readonly entries: readonly {
    readonly occurrence: TranscriptTimelineOccurrence;
    readonly index: number;
  }[];
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
  onSeekTimelineFrame,
  onArtifactChange,
  playheadFrame = null,
  playing = false,
}: TranscriptPanelProps) {
  const [status, setStatus] = useState<AsrRuntimeStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [load, setLoad] = useState<TranscriptLoad>({ phase: "idle" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const consentDialogRef = useRef<HTMLDialogElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const cutDialogRef = useRef<HTMLDialogElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  // The proposed cut under review. Nothing changes until it is applied.
  const [proposal, setProposal] = useState<TranscriptEditProposal | null>(null);
  const wordListRef = useRef<HTMLDivElement>(null);
  // A stable seek handler, so a new parent callback each render does not
  // rebuild the whole word list.
  const seekRef = useRef(onSeekTimelineFrame);
  useEffect(() => {
    seekRef.current = onSeekTimelineFrame;
  }, [onSeekTimelineFrame]);
  const canSeek = onSeekTimelineFrame !== undefined;
  const seek = useCallback((frame: number) => seekRef.current?.(frame), []);

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

  const loadedArtifact = load.phase === "loaded" ? load.artifact : null;
  useEffect(() => {
    onArtifactChange?.(loadedArtifact);
  }, [loadedArtifact, onArtifactChange]);

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

  // Speaker for each word, and the words cut from (or never on) the timeline.
  const { speakerByWordId, offTimelineWords, hasSpeakerLabels } = useMemo(() => {
    const speakers = new Map<string, string | null>();
    if (load.phase !== "loaded") {
      return { speakerByWordId: speakers, offTimelineWords: [], hasSpeakerLabels: false };
    }
    const onTimeline = new Set(occurrences.map((occurrence) => occurrence.wordId));
    for (const word of load.artifact.words) speakers.set(word.wordId, word.speakerLabel);
    return {
      speakerByWordId: speakers,
      offTimelineWords: load.artifact.words.filter((word) => !onTimeline.has(word.wordId)),
      hasSpeakerLabels: load.artifact.words.some((word) => word.speakerLabel !== null),
    };
  }, [load, occurrences]);

  // Consecutive words by the same speaker share one heading.
  const segments = useMemo((): readonly SpeakerSegment[] => {
    const result: {
      key: string;
      speakerLabel: string | null;
      entries: SpeakerSegment["entries"][number][];
    }[] = [];
    occurrences.forEach((occurrence, index) => {
      const speakerLabel = hasSpeakerLabels
        ? (speakerByWordId.get(occurrence.wordId) ?? null)
        : null;
      const last = result.at(-1);
      if (last !== undefined && last.speakerLabel === speakerLabel)
        last.entries.push({ occurrence, index });
      else
        result.push({
          key: occurrence.occurrenceId,
          speakerLabel,
          entries: [{ occurrence, index }],
        });
    });
    return result;
  }, [hasSpeakerLabels, occurrences, speakerByWordId]);

  const activeIndex = useMemo(
    () => findActiveOccurrenceIndex(occurrences, playheadFrame),
    [occurrences, playheadFrame],
  );

  // Keep the spoken word visible, but only while paused so playback never
  // fights the user's own scrolling.
  useEffect(() => {
    if (playing || activeIndex < 0) return;
    const active = wordListRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, playing]);

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

  // Step 1: build the proposal and show it for review.
  const previewSelected = () =>
    run(async () => {
      if (load.phase !== "loaded" || projection === null || target === null) return;
      setProposal(
        await createTranscriptEditProposal({
          artifact: load.artifact,
          projection,
          sequenceId: target.sequenceId,
          trackId: target.trackId,
          deletedOccurrenceIds: [...selected],
        }),
      );
    });
  // Close the modal before moving focus: while it is open the rest of the
  // page is inert and cannot take focus.
  const dismissCutDialog = () => {
    const dialog = cutDialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    setProposal(null);
  };
  const closeCutPreview = () => {
    dismissCutDialog();
    removeButtonRef.current?.focus();
  };
  // Step 2: apply exactly the reviewed proposal. It is bound to the project
  // revision it was built from, so a stale proposal is rejected on apply.
  const applyCut = () =>
    run(async () => {
      if (proposal === null || load.phase !== "loaded") return;
      const applied = await onApplyProposal(proposal, load.artifact);
      dismissCutDialog();
      if (applied) setSelected(new Set());
      removeButtonRef.current?.focus();
    });

  useEffect(() => {
    const dialog = cutDialogRef.current;
    if (dialog === null) return;
    if (proposal !== null && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (proposal === null && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [proposal]);

  // A proposal built from an older revision must not be applied.
  useEffect(() => {
    if (proposal !== null && projection?.revision.id !== proposal.projectRevision.id) {
      setProposal(null);
    }
  }, [projection, proposal]);

  const generateCaptions = () =>
    run(async () => {
      if (load.phase !== "loaded") return;
      await onGenerateCaptions(load.artifact);
    });

  const toggle = useCallback(
    (occurrenceId: string) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(occurrenceId)) next.delete(occurrenceId);
        else next.add(occurrenceId);
        return next;
      }),
    [],
  );

  // The word list re-renders only when its words, selection or active word
  // change, not on every playhead frame.
  const wordList = useMemo(
    () =>
      segments.map((segment) => (
        <div key={segment.key} className="transcript-segment">
          {hasSpeakerLabels ? (
            <h3 className="transcript-speaker">{speakerDisplayName(segment.speakerLabel)}</h3>
          ) : null}
          <ul className="transcript-words" aria-describedby="transcript-help">
            {segment.entries.map(({ occurrence, index }) => {
              const current = index === activeIndex;
              const at = formatTimelineTime(
                occurrence.timelineRange.start.value,
                occurrence.timelineRange.start,
              );
              return (
                <li
                  key={occurrence.occurrenceId}
                  className="transcript-word-item"
                  data-current={current ? "true" : undefined}
                >
                  <button
                    className="transcript-word"
                    type="button"
                    aria-pressed={selected.has(occurrence.occurrenceId)}
                    aria-current={current ? "true" : undefined}
                    onClick={() => toggle(occurrence.occurrenceId)}
                  >
                    {occurrence.text}
                  </button>
                  {!canSeek ? null : (
                    <button
                      className="transcript-seek"
                      type="button"
                      aria-label={`Seek to ${occurrence.text} at ${at}`}
                      title={`Seek to ${at}`}
                      onClick={() => seek(occurrence.timelineRange.start.value)}
                    >
                      <LocateFixed size={14} aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )),
    [activeIndex, canSeek, hasSpeakerLabels, seek, segments, selected, toggle],
  );

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
            <p>
              {status.license.commercialUse
                ? "Both licenses allow commercial use of your videos."
                : "One of these licenses does not allow commercial use. Check the license terms before using transcripts commercially."}
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
            {hasSpeakerLabels ? " Speaker names are detected automatically and may be wrong." : ""}
          </p>
          <div ref={wordListRef} className="transcript-word-list">
            {wordList}
          </div>
          {offTimelineWords.length > 0 ? (
            <details className="transcript-off-timeline">
              <summary>
                {offTimelineWords.length} {offTimelineWords.length === 1 ? "word is" : "words are"}{" "}
                not on the timeline
              </summary>
              <p className="muted-copy">{offTimelineWords.map((word) => word.text).join(" ")}</p>
            </details>
          ) : null}
          <div className="transcript-actions">
            <button
              ref={removeButtonRef}
              className="secondary-button"
              type="button"
              disabled={selected.size === 0 || pending || disabled}
              onClick={() => void previewSelected()}
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
      <dialog
        ref={cutDialogRef}
        className="overwrite-dialog transcript-cut-dialog"
        aria-labelledby="transcript-cut-title"
        onCancel={(event) => {
          event.preventDefault();
          closeCutPreview();
        }}
      >
        {proposal === null ? null : <CutPreview proposal={proposal} />}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={closeCutPreview}>
            Keep editing
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={pending || disabled || proposal === null}
            onClick={() => void applyCut()}
          >
            <Scissors size={16} aria-hidden />
            Apply cut
          </button>
        </div>
      </dialog>
    </section>
  );
}
