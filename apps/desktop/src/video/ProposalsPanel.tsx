import {
  VideoDomainError,
  isGraphicsProposalWire,
  type CommandResult,
  type GraphicsProposalWire,
  type ProjectProjection,
  type RationalTime,
  type StoredProposal,
} from "@supa-video/contracts";
import type { TranscriptArtifactV1 } from "@supa-video/media";
import {
  createFillerWordsRule,
  createSilenceGapRule,
  createTranscriptEditProposal,
  decideAllRanges,
  decideRange,
  deriveApprovedGraphicsProposal,
  deriveApprovedProposal,
  openProposalRecord,
  parseTranscriptEditProposal,
  produceProposal,
  rangeIdOf,
  type ProposalProducer,
  type ProposalRecord,
  type TranscriptEditProposal,
} from "@supa-video/project";
import {
  DEFAULT_STYLE_RECIPE_ID,
  proposeFirstCutGraphics,
  STYLE_RECIPES,
  type FirstCutBeats,
} from "@supa-video/produce";
import { ListChecks } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  tauriProposalBackend,
  type ProposalBackend,
  type ProposalEditOutcome,
} from "../proposal-ipc";
import { formatTimelineTime } from "./TranscriptPanel";

/** A proposed cut, in sequence frames, for the timeline overlay. */
export interface ProposalTimelineRange {
  readonly trackId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly accepted: boolean;
}

interface ProposalsPanelProps {
  readonly projection: ProjectProjection | null;
  readonly target: { readonly sequenceId: string; readonly trackId: string } | null;
  readonly artifact: TranscriptArtifactV1 | null;
  readonly disabled: boolean;
  /** Runs a native proposal edit under the editor's edit lock and adopts the result. */
  readonly runEdit: (
    run: (projectId: string) => Promise<readonly CommandResult[]>,
  ) => Promise<ProposalEditOutcome>;
  readonly onPreviewRanges?: (ranges: readonly ProposalTimelineRange[]) => void;
  /** The last applied first cut; enables "Suggest graphics" with a style recipe. */
  readonly firstCut?: FirstCutBeats | null;
  /** Sorted timeline microseconds of detected music beats, for recipes that snap to them. */
  readonly musicBeatsUs?: readonly number[];
  readonly backend?: ProposalBackend;
  readonly now?: () => number;
  readonly newOperationId?: () => string;
}

const producerLabels: Readonly<Record<string, string>> = {
  "silence-gap": "Pauses",
  "filler-words": "Filler words",
  "user-selection": "Your selection",
  "recipe-graphics": "Graphics",
};

function producerLabel(stored: StoredProposal): string {
  const known = producerLabels[stored.producer.id];
  if (known !== undefined) return known;
  return stored.producer.kind === "model"
    ? `Assistant (${stored.producer.id})`
    : stored.producer.id;
}

const statusLabels: Readonly<Record<StoredProposal["status"], string>> = {
  pending: "Waiting for review",
  applied: "Applied",
  rejected: "Rejected",
  expired: "Expired",
  stale: "Out of date",
  restored: "Restored to before",
};

const TOO_MANY_GRAPHICS = "Too many graphics in one suggestion. Ask for fewer.";

function proposalMessage(error: unknown): string {
  if (error instanceof VideoDomainError) {
    const category = error.details["category"];
    if (category === "feature_disabled") return "Edit proposals are turned off.";
    if (category === "proposal_base_revision" || category === "proposal_restore_mismatch")
      return "The project changed. Review the proposal again.";
    if (
      category === "proposal_range_not_offered" ||
      category === "proposal_item_not_offered" ||
      category === "proposal_mismatch" ||
      category === "proposal_not_open"
    )
      return "This proposal no longer matches the project. Find suggestions again.";
    if (category === "proposal_restore_unavailable")
      return "This change is no longer in the undo history, so it cannot be restored.";
    if (category === "proposal_track_locked") return "Unlock the track to apply this proposal.";
    if (category === "proposal_track_hidden")
      return "The graphics track is hidden, so this proposal is out of date. Suggest graphics again.";
    if (category === "proposal_open_limit")
      return "Too many proposals are waiting. Apply or reject some first.";
    if (category === "proposal_command_group_bytes" || category === "proposal_bytes")
      return TOO_MANY_GRAPHICS;
  }
  return "The proposal could not be processed. Try again.";
}

interface TranscriptReview {
  readonly kind: "transcript";
  readonly stored: StoredProposal;
  readonly proposal: TranscriptEditProposal;
  readonly record: ProposalRecord;
}

interface GraphicsReview {
  readonly kind: "graphics";
  readonly stored: StoredProposal;
  readonly proposal: GraphicsProposalWire;
  readonly record: ProposalRecord<GraphicsProposalWire>;
}

type ReviewState = TranscriptReview | GraphicsReview;

interface FrameRange {
  readonly startFrame: number;
  readonly endFrame: number;
}

/** Sequence frames per range id, as placed in one revision of the project. */
type RangeFrames = ReadonlyMap<string, FrameRange>;

/** A proposal's ranges re-placed against a newer revision; `null` if that failed. */
interface RebasedFrames {
  readonly revisionId: string;
  readonly frames: RangeFrames | null;
}

function framesOf(proposal: TranscriptEditProposal): RangeFrames {
  return new Map(
    proposal.deletedRanges.map((range) => [
      rangeIdOf(range),
      {
        startFrame: range.originalTimelineRange.start.value,
        endFrame: range.originalTimelineRange.end.value,
      },
    ]),
  );
}

/**
 * Re-places every range of `proposal` on the current projection, the same way
 * an approval is re-derived. Range ids come from source frames, so they still
 * match the review's decisions. Returns `null` if the cuts no longer fit.
 */
async function rebaseFrames(
  proposal: TranscriptEditProposal,
  artifact: TranscriptArtifactV1,
  projection: ProjectProjection,
): Promise<RangeFrames | null> {
  try {
    const current = await createTranscriptEditProposal({
      artifact,
      projection,
      sequenceId: proposal.sequenceId,
      trackId: proposal.trackId,
      deletedOccurrenceIds: proposal.selectedOccurrenceIds,
      deletedGaps: proposal.deletedGaps,
      producer: proposal.producer,
    });
    return framesOf(current);
  } catch {
    return null;
  }
}

function reviewFor(stored: StoredProposal, nowMs: number): ReviewState | null {
  const scope = { sequenceId: stored.sequenceId, trackId: stored.trackId };
  if (isGraphicsProposalWire(stored.proposal)) {
    const proposal = stored.proposal;
    const opened = openProposalRecord({ proposal, scope, nowMs });
    if (!opened.ok) return null;
    // Every graphic starts approved; the user unticks the ones to leave out.
    const decided = decideAllRanges(opened.value, "accepted");
    return decided.ok ? { kind: "graphics", stored, proposal, record: decided.value } : null;
  }
  const parsed = parseTranscriptEditProposal(stored.proposal);
  if (!parsed.ok) return null;
  const opened = openProposalRecord({ proposal: parsed.value, scope, nowMs });
  if (!opened.ok) return null;
  // Every cut starts approved; the user unticks the ones to keep.
  const decided = decideAllRanges(opened.value, "accepted");
  return decided.ok
    ? { kind: "transcript", stored, proposal: parsed.value, record: decided.value }
    : null;
}

function withRecord<R extends ReviewState>(review: R, record: R["record"]): R {
  return { ...review, record };
}

/** Where each graphics item sits on the timeline, from its offered clip. */
function graphicsPlacement(
  proposal: GraphicsProposalWire,
): ReadonlyMap<string, { readonly start: RationalTime; readonly endFrame: number }> {
  const placement = new Map<string, { readonly start: RationalTime; readonly endFrame: number }>();
  for (const command of proposal.commandGroup.commands) {
    if (command.type !== "AddGraphicsClip") continue;
    const { id, timelineStart, duration } = command.graphicsClip;
    placement.set(id, { start: timelineStart, endFrame: timelineStart.value + duration.value });
  }
  return placement;
}

/**
 * Review for edit proposals from built-in rules (and later an assistant).
 * Nothing changes until the user applies a proposal; each applied proposal is
 * one undo step and can be restored to the state before it.
 * Renders nothing unless the `agentProposals` switch is on.
 */
export function ProposalsPanel({
  projection,
  target,
  artifact,
  disabled,
  runEdit,
  onPreviewRanges,
  firstCut = null,
  musicBeatsUs,
  backend = tauriProposalBackend,
  now = Date.now,
  newOperationId = () => crypto.randomUUID(),
}: ProposalsPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [listing, setListing] = useState<readonly StoredProposal[]>([]);
  const [reviews, setReviews] = useState<ReadonlyMap<string, ReviewState>>(new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const [staleIds, setStaleIds] = useState<ReadonlySet<string>>(new Set());
  const [rebased, setRebased] = useState<ReadonlyMap<string, RebasedFrames>>(new Map());
  const [recipeId, setRecipeId] = useState(DEFAULT_STYLE_RECIPE_ID);
  const recipeSelectId = useId();
  const rebasingRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const headingId = useId();
  const projectId = projection?.projectId ?? null;
  const revisionId = projection?.revision.id ?? null;

  useEffect(() => {
    let current = true;
    void (async () => {
      const on = await backend.getAgentProposalsEnabled();
      if (current) setEnabled(on);
    })();
    return () => {
      current = false;
    };
  }, [backend]);

  const refresh = useCallback(async () => {
    if (!enabled || projectId === null) return;
    try {
      const next = await backend.listProposals(projectId);
      setListing(next.proposals);
      if (next.storeDiscarded)
        setMessage({ text: "Saved proposals could not be read and were set aside.", error: true });
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    }
  }, [backend, enabled, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revisionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Keep a review record for each pending proposal, preserving user decisions.
  useEffect(() => {
    setReviews((previous) => {
      const next = new Map<string, ReviewState>();
      for (const stored of listing) {
        if (stored.status !== "pending") continue;
        const existing = previous.get(stored.proposalId);
        const review = existing ?? reviewFor(stored, now());
        if (review !== null) next.set(stored.proposalId, { ...review, stored });
      }
      return next;
    });
  }, [listing, now]);

  // Proposals made at an older revision are re-placed on the current timeline,
  // so their bands follow ripple edits made since.
  useEffect(() => {
    if (projection === null || artifact === null) return;
    const currentRevisionId = projection.revision.id;
    for (const review of reviews.values()) {
      if (review.kind !== "transcript") continue;
      const { stored, proposal } = review;
      if (proposal.projectRevision.id === currentRevisionId) continue;
      if (rebased.get(stored.proposalId)?.revisionId === currentRevisionId) continue;
      const key = `${stored.proposalId}:${currentRevisionId}`;
      if (rebasingRef.current.has(key)) continue;
      rebasingRef.current.add(key);
      void (async () => {
        const frames = await rebaseFrames(proposal, artifact, projection);
        rebasingRef.current.delete(key);
        if (!mountedRef.current) return;
        setRebased((previous) =>
          new Map(previous).set(stored.proposalId, { revisionId: currentRevisionId, frames }),
        );
        if (frames === null) {
          setStaleIds((previous) => new Set(previous).add(stored.proposalId));
        }
      })();
    }
  }, [artifact, projection, rebased, reviews]);

  /** Current sequence frames for a review's ranges; `null` while unknown or unplaceable. */
  const framesFor = useCallback(
    ({ stored, proposal }: TranscriptReview): RangeFrames | null => {
      if (revisionId === null || proposal.projectRevision.id === revisionId) {
        return framesOf(proposal);
      }
      const entry = rebased.get(stored.proposalId);
      return entry?.revisionId === revisionId ? entry.frames : null;
    },
    [rebased, revisionId],
  );

  const previewRanges = useMemo(
    (): readonly ProposalTimelineRange[] =>
      [...reviews.values()].flatMap((review) => {
        if (review.kind !== "transcript") return [];
        const frames = framesFor(review);
        if (frames === null) return [];
        return review.proposal.deletedRanges.flatMap((range) => {
          const rangeId = rangeIdOf(range);
          const placed = frames.get(rangeId);
          if (placed === undefined) return [];
          return [
            {
              trackId: review.proposal.trackId,
              startFrame: placed.startFrame,
              endFrame: placed.endFrame,
              accepted:
                review.record.ranges.find((candidate) => candidate.rangeId === rangeId)
                  ?.decision === "accepted",
            },
          ];
        });
      }),
    [framesFor, reviews],
  );
  useEffect(() => {
    onPreviewRanges?.(previewRanges);
  }, [onPreviewRanges, previewRanges]);
  useEffect(() => () => onPreviewRanges?.([]), [onPreviewRanges]);

  const produce = async (producer: ProposalProducer) => {
    if (projection === null || target === null || artifact === null) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setMessage(null);
    try {
      const result = await produceProposal(
        producer,
        { artifact, projection, sequenceId: target.sequenceId, trackId: target.trackId },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setMessage(
          result.error.code === "no_edits"
            ? { text: "Nothing to suggest for this track.", error: false }
            : { text: "Suggestions could not be made for this track.", error: true },
        );
        return;
      }
      await backend.submitProposal(projection.projectId, result.value.proposal);
      await refresh();
      setMessage({
        text: `${result.value.proposal.deletedRanges.length} suggested cuts ready to review.`,
        error: false,
      });
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  const suggestGraphics = async () => {
    if (projection === null || firstCut === null) return;
    const sequenceId = target?.sequenceId ?? projection.state.activeSequenceId;
    const sequence = projection.state.sequences.find(({ id }) => id === sequenceId);
    if (sequence === undefined) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await proposeFirstCutGraphics({
        firstCut,
        recipeId,
        sequence,
        ...(musicBeatsUs === undefined ? {} : { musicBeatsUs }),
        projectId: projection.projectId,
        revision: projection.revision,
      });
      if (!result.ok) {
        setMessage({
          text:
            result.error.kind === "invalid_description"
              ? "There is nothing to put graphics on yet."
              : result.error.kind === "overlap_limit"
                ? "Existing graphics already cover these spots."
                : result.error.kind === "too_large"
                  ? TOO_MANY_GRAPHICS
                  : "Graphics could not be suggested for this sequence.",
          error: result.error.kind !== "invalid_description",
        });
        return;
      }
      await backend.submitProposal(projection.projectId, result.value);
      await refresh();
      setMessage({
        text: `${result.value.items.length} suggested graphics ready to review.`,
        error: false,
      });
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (proposalId: string, rangeId: string, accepted: boolean) => {
    setReviews((previous) => {
      const review = previous.get(proposalId);
      if (review === undefined) return previous;
      const decision = accepted ? "accepted" : "rejected";
      if (review.kind === "graphics") {
        const decided = decideRange(review.record, rangeId, decision);
        return decided.ok
          ? new Map(previous).set(proposalId, withRecord(review, decided.value))
          : previous;
      }
      const decided = decideRange(review.record, rangeId, decision);
      return decided.ok
        ? new Map(previous).set(proposalId, withRecord(review, decided.value))
        : previous;
    });
  };

  const apply = (review: ReviewState) =>
    review.kind === "graphics" ? applyGraphics(review) : applyTranscript(review);

  const markStale = async (proposalId: string, reason: string | null) => {
    if (projection === null) return;
    // Show it as out of date right away, then record that natively so it
    // survives a reload and stops counting as open.
    setStaleIds((previous) => new Set(previous).add(proposalId));
    await backend.markProposalStale(
      projection.projectId,
      proposalId,
      reason ?? "Project changed too much since this was suggested",
    );
    await refresh();
    setMessage({ text: "This proposal is out of date. Ask for new suggestions.", error: true });
  };

  const applyApproved = async (
    proposalId: string,
    approved: Parameters<ProposalBackend["applyProposal"]>[2],
  ) => {
    const applied = await runEdit(async (id) => [
      await backend.applyProposal(id, proposalId, approved),
    ]);
    if (applied.ok) setMessage({ text: "Proposal applied. Undo reverses it.", error: false });
    else if (applied.error !== null)
      setMessage({ text: proposalMessage(applied.error), error: true });
    await refresh();
  };

  const applyGraphics = async (review: GraphicsReview) => {
    if (projection === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const derived = deriveApprovedGraphicsProposal({
        record: review.record,
        projection,
        newId: newOperationId,
      });
      if (!derived.ok) {
        setMessage({
          text:
            derived.error.code === "nothing_accepted"
              ? "Tick at least one graphic, or reject the proposal."
              : "This proposal can no longer be applied.",
          error: true,
        });
        return;
      }
      const derivedRecord = derived.value.record;
      setReviews((previous) => {
        const current = previous.get(review.stored.proposalId);
        if (current?.kind !== "graphics") return previous;
        return new Map(previous).set(review.stored.proposalId, withRecord(current, derivedRecord));
      });
      if (derived.value.kind === "stale") {
        await markStale(review.stored.proposalId, derivedRecord.statusReason);
        return;
      }
      await applyApproved(review.stored.proposalId, derived.value.proposal);
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const applyTranscript = async (review: TranscriptReview) => {
    if (projection === null || artifact === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const derived = await deriveApprovedProposal({
        record: review.record,
        artifact,
        projection,
      });
      if (!derived.ok) {
        setMessage({
          text:
            derived.error.code === "nothing_accepted"
              ? "Tick at least one cut, or reject the proposal."
              : "This proposal can no longer be applied.",
          error: true,
        });
        return;
      }
      // Keep the repair count (and stale status) so the repair bound holds across attempts.
      const derivedRecord = derived.value.record;
      setReviews((previous) => {
        const current = previous.get(review.stored.proposalId);
        if (current?.kind !== "transcript") return previous;
        return new Map(previous).set(review.stored.proposalId, withRecord(current, derivedRecord));
      });
      if (derived.value.kind === "stale") {
        await markStale(review.stored.proposalId, derivedRecord.statusReason);
        return;
      }
      await applyApproved(review.stored.proposalId, derived.value.proposal);
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const reject = async (stored: StoredProposal) => {
    if (projectId === null) return;
    setBusy(true);
    try {
      await backend.rejectProposal(projectId, stored.proposalId);
      await refresh();
      setMessage({ text: "Proposal rejected.", error: false });
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const restore = async (stored: StoredProposal) => {
    setBusy(true);
    setMessage(null);
    try {
      const operationId = newOperationId();
      const restored = await runEdit((id) =>
        backend.restoreBeforeProposal(id, stored.proposalId, operationId),
      );
      if (restored.ok) setMessage({ text: "Restored to before this proposal.", error: false });
      else if (restored.error !== null)
        setMessage({ text: proposalMessage(restored.error), error: true });
      await refresh();
    } catch (error) {
      setMessage({ text: proposalMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;
  const locked = busy || disabled;
  const canProduce = projection !== null && target !== null && artifact !== null;
  const canSuggestGraphics = projection !== null && firstCut !== null;
  const selectedRecipe = STYLE_RECIPES.find(({ id }) => id === recipeId);
  const recipeSummaryId = `${recipeSelectId}-summary`;
  const transcriptLanguage = artifact?.configuration.requestedLanguage ?? null;
  const resolved = listing
    .filter((stored) => stored.status !== "pending")
    .slice(-5)
    .reverse();

  return (
    <section className="panel proposals-panel" aria-labelledby={headingId} aria-busy={busy}>
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Suggestions</p>
          <h2 id={headingId}>Suggested edits</h2>
        </div>
      </div>
      {canProduce ? (
        <div className="proposals-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={locked}
            onClick={() => void produce(createSilenceGapRule())}
          >
            Find long pauses
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={locked || transcriptLanguage === null}
            onClick={() =>
              void produce(
                createFillerWordsRule({
                  ...(transcriptLanguage === null ? {} : { language: transcriptLanguage }),
                  skipRepeated: true,
                }),
              )
            }
          >
            Find filler words
          </button>
        </div>
      ) : (
        <p className="muted-copy">Transcribe a track to get suggested cuts.</p>
      )}
      {canProduce && transcriptLanguage === null ? (
        <p className="muted-copy">Filler words need a known transcript language.</p>
      ) : null}
      {canSuggestGraphics ? (
        <>
          <div className="proposals-actions">
            <label htmlFor={recipeSelectId}>Graphics style</label>
            <select
              id={recipeSelectId}
              aria-describedby={recipeSummaryId}
              value={recipeId}
              disabled={locked}
              onChange={(event) => setRecipeId(event.target.value)}
            >
              {STYLE_RECIPES.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.name}
                </option>
              ))}
            </select>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={locked}
              onClick={() => void suggestGraphics()}
            >
              Suggest graphics
            </button>
          </div>
          <p id={recipeSummaryId} className="muted-copy">
            {selectedRecipe?.summary}
          </p>
        </>
      ) : null}

      {reviews.size === 0 ? null : (
        <ol className="proposals-list" aria-label="Proposals waiting for review">
          {[...reviews.values()].map((review) =>
            review.kind === "graphics" ? (
              <GraphicsProposalReview
                key={review.stored.proposalId}
                review={review}
                stale={staleIds.has(review.stored.proposalId)}
                locked={locked}
                onToggle={(itemId, accepted) => toggle(review.stored.proposalId, itemId, accepted)}
                onApply={() => void apply(review)}
                onReject={() => void reject(review.stored)}
              />
            ) : (
              <ProposalReview
                key={review.stored.proposalId}
                review={review}
                frames={framesFor(review)}
                stale={staleIds.has(review.stored.proposalId)}
                locked={locked}
                onToggle={(rangeId, accepted) =>
                  toggle(review.stored.proposalId, rangeId, accepted)
                }
                onApply={() => void apply(review)}
                onReject={() => void reject(review.stored)}
              />
            ),
          )}
        </ol>
      )}

      {resolved.length === 0 ? null : (
        <>
          <h3 className="proposals-subheading">Recent</h3>
          <ul className="proposals-history">
            {resolved.map((stored) => (
              <li key={stored.proposalId} className="proposals-history-item">
                <span>
                  {producerLabel(stored)}: {statusLabels[stored.status]}
                </span>
                {stored.status === "applied" ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={locked}
                    onClick={() => void restore(stored)}
                  >
                    Restore to before
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {message === null ? null : (
        <p
          className={message.error ? "inline-error" : "muted-copy"}
          role={message.error ? "alert" : "status"}
        >
          <ListChecks aria-hidden="true" size={14} /> {message.text}
        </p>
      )}
    </section>
  );
}

function ProposalReview({
  review,
  frames,
  stale,
  locked,
  onToggle,
  onApply,
  onReject,
}: {
  readonly review: TranscriptReview;
  readonly frames: RangeFrames | null;
  readonly stale: boolean;
  readonly locked: boolean;
  readonly onToggle: (rangeId: string, accepted: boolean) => void;
  readonly onApply: () => void;
  readonly onReject: () => void;
}) {
  const legendId = useId();
  const { stored, proposal, record } = review;
  const acceptedCount = record.ranges.filter(({ decision }) => decision === "accepted").length;
  const reasonByRange = new Map(
    (proposal.reasons ?? []).map(({ rangeId, text }) => [rangeId, text]),
  );
  return (
    <li className="proposals-item">
      <fieldset
        className="proposals-fieldset"
        aria-describedby={stale ? `${legendId}-stale` : undefined}
      >
        <legend id={legendId}>
          {producerLabel(stored)}: {proposal.deletedRanges.length} cuts
        </legend>
        {stale ? (
          <p id={`${legendId}-stale`} className="inline-error" role="alert">
            The project changed too much since this was suggested. Reject it and ask again.
          </p>
        ) : null}
        <ul className="proposals-ranges">
          {proposal.deletedRanges.map((range, index) => {
            const rangeId = rangeIdOf(range);
            const accepted =
              record.ranges.find((candidate) => candidate.rangeId === rangeId)?.decision ===
              "accepted";
            const start = range.originalTimelineRange.start;
            const placed = frames?.get(rangeId);
            const startFrame = placed?.startFrame ?? start.value;
            const endFrame = placed?.endFrame ?? range.originalTimelineRange.end.value;
            const words = range.selectedWords.map(({ text }) => text).join(" ");
            const reason = reasonByRange.get(rangeId);
            const reasonId = `${legendId}-reason-${index}`;
            return (
              <li key={rangeId}>
                <label className="proposals-range">
                  <input
                    type="checkbox"
                    checked={accepted}
                    disabled={locked || stale}
                    aria-describedby={reason === undefined ? undefined : reasonId}
                    onChange={(event) => onToggle(rangeId, event.target.checked)}
                  />
                  <span>
                    {formatTimelineTime(startFrame, start)} to {formatTimelineTime(endFrame, start)}
                    {words.length > 0 ? `: "${words}"` : ": pause"}
                  </span>
                </label>
                {reason === undefined ? null : (
                  <p id={reasonId} className="proposals-reason">
                    {reason}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="proposals-actions">
          <button
            className="primary-button compact-button"
            type="button"
            disabled={locked || stale || acceptedCount === 0}
            onClick={onApply}
          >
            Apply {acceptedCount} of {proposal.deletedRanges.length}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={locked}
            onClick={onReject}
          >
            Reject all
          </button>
        </div>
      </fieldset>
    </li>
  );
}

function GraphicsProposalReview({
  review,
  stale,
  locked,
  onToggle,
  onApply,
  onReject,
}: {
  readonly review: GraphicsReview;
  readonly stale: boolean;
  readonly locked: boolean;
  readonly onToggle: (itemId: string, accepted: boolean) => void;
  readonly onApply: () => void;
  readonly onReject: () => void;
}) {
  const legendId = useId();
  const { stored, proposal, record } = review;
  const acceptedCount = record.ranges.filter(({ decision }) => decision === "accepted").length;
  const placement = graphicsPlacement(proposal);
  const recipe = STYLE_RECIPES.find(({ id }) => id === proposal.description.recipeId);
  return (
    <li className="proposals-item">
      <fieldset
        className="proposals-fieldset"
        aria-describedby={stale ? `${legendId}-stale` : undefined}
      >
        <legend id={legendId}>
          {producerLabel(stored)}
          {recipe === undefined ? "" : ` (${recipe.name})`}: {proposal.items.length} graphics
        </legend>
        {stale ? (
          <p id={`${legendId}-stale`} className="inline-error" role="alert">
            The project changed too much since this was suggested. Reject it and ask again.
          </p>
        ) : null}
        <ul className="proposals-ranges">
          {proposal.items.map((item) => {
            const accepted =
              record.ranges.find((candidate) => candidate.rangeId === item.itemId)?.decision ===
              "accepted";
            const placed = placement.get(item.graphicsClipId);
            return (
              <li key={item.itemId}>
                <label className="proposals-range">
                  <input
                    type="checkbox"
                    checked={accepted}
                    disabled={locked || stale}
                    onChange={(event) => onToggle(item.itemId, event.target.checked)}
                  />
                  <span>
                    {placed === undefined
                      ? ""
                      : `${formatTimelineTime(placed.start.value, placed.start)} to ${formatTimelineTime(placed.endFrame, placed.start)}: `}
                    {item.label}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="proposals-actions">
          <button
            className="primary-button compact-button"
            type="button"
            disabled={locked || stale || acceptedCount === 0}
            onClick={onApply}
          >
            Apply {acceptedCount} of {proposal.items.length}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={locked}
            onClick={onReject}
          >
            Reject all
          </button>
        </div>
      </fieldset>
    </li>
  );
}
