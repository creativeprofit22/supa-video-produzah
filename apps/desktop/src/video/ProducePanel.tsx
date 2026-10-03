import type {
  AcquisitionReceipt,
  CommandGroupRequest,
  ProjectProjection,
  UsePolicyProfile,
  VideoProjectStateV2,
} from "@supa-video/contracts";
import type { TranscriptArtifactV1 } from "@supa-video/media";
import {
  type BeatOverride,
  type BeatOverrides,
  type BeatProposal,
  DEFAULT_RANKING_CONFIG,
  type FirstCutProposal,
  type NarrativeBeat,
  type RankedCandidate,
  buildAssetIndex,
  compileFirstCut,
  planBeatsForARollClips,
  planBeatsFromScript,
  planFirstCut,
} from "@supa-video/produce";
import { getActiveSequenceRenderEligibility } from "@supa-video/render";
import { AlertCircle, Clapperboard } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { tauriRightsBackend, type RightsBackend } from "../rights-ipc";
import type { FirstCutApplyOutcome } from "../use-video-project";
import type { AppliedFirstCut } from "./applied-first-cut";

/*
 * Produce: plans a reviewable first cut from a script (explainer) or the
 * current A-roll transcript (podcast). Planning is local and deterministic;
 * only project media that passes the rights filter is offered. Nothing touches
 * the timeline until "Apply first cut", which commits one undoable group.
 */

type Workflow = "explainer" | "podcast";

export interface ProducePanelProps {
  readonly projection: ProjectProjection | null;
  /** A-roll clips of the transcribed asset for podcast planning, in timeline order. */
  readonly aRoll: { readonly assetId: string; readonly clipIds: readonly string[] } | null;
  readonly artifact: TranscriptArtifactV1 | null;
  readonly intendedUse: UsePolicyProfile | null;
  readonly disabled: boolean;
  readonly onApply: (request: CommandGroupRequest) => Promise<FirstCutApplyOutcome>;
  /** Called with the first cut and its inserted tracks once it is on the timeline. */
  readonly onFirstCutApplied?: (applied: AppliedFirstCut) => void;
  readonly backend?: Pick<RightsBackend, "listRightsReceipts">;
  readonly now?: () => number;
}

type PanelStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "applied"; readonly message: string };

const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
] as const;

const beatErrors: Readonly<Record<string, string>> = {
  "empty-script": "Write at least one sentence to plan a first cut.",
  "invalid-words-per-minute": "Speaking rate must be between 60 and 400 words per minute.",
  "empty-transcript-range": "The A-roll clip has no transcribed words.",
  "invalid-clip-range": "The A-roll clip has no length.",
  "clip-not-found": "The A-roll clip is no longer on the timeline.",
  "clip-not-asset": "The A-roll clip is not a media clip.",
  "clip-speed-changed": "Reset the A-roll clip's speed to 100% before planning a podcast cut.",
  "no-clips": "The A-roll is no longer on the timeline.",
  "clips-mixed-assets": "The A-roll clips come from different media.",
  "clips-not-contiguous":
    "The A-roll clips have gaps or overlaps on the timeline. Close the gaps before planning a podcast cut.",
};

/** The state after the first-cut group's additive InsertTrack/AddMarker commands land. */
function withFirstCut(
  state: VideoProjectStateV2,
  request: CommandGroupRequest,
): VideoProjectStateV2 | null {
  let sequences = state.sequences;
  for (const command of request.commands) {
    if (command.type !== "InsertTrack" && command.type !== "AddMarker") return null;
    if (!sequences.some((item) => item.id === command.sequenceId)) return null;
    sequences = sequences.map((sequence) => {
      if (sequence.id !== command.sequenceId) return sequence;
      if (command.type === "InsertTrack") {
        const tracks = [...sequence.tracks];
        tracks.splice(command.index, 0, command.track);
        return { ...sequence, tracks };
      }
      const markers = [...sequence.markers];
      markers.splice(command.index ?? markers.length, 0, command.marker);
      return { ...sequence, markers };
    });
  }
  return { ...state, sequences };
}

/** Why the project could not be exported once this first cut is applied, or null if it could. */
async function exportBlockAfterApply(
  projection: ProjectProjection,
  proposal: FirstCutProposal,
  overrides: BeatOverrides,
): Promise<string | null> {
  const sequence = projection.state.sequences.find(
    (item) => item.id === projection.state.activeSequenceId,
  );
  if (sequence === undefined) return null;
  const compiled = await compileFirstCut({
    proposal,
    overrides,
    projectId: projection.projectId,
    revision: projection.revision.number,
    sequence,
    assets: projection.state.assets,
  });
  if (!compiled.ok) return null;
  const next = withFirstCut(projection.state, compiled.value.request);
  if (next === null) return null;
  const eligibility = getActiveSequenceRenderEligibility({
    revision: projection.revision,
    state: next,
  });
  return eligibility.eligible ? null : eligibility.reason;
}

function seconds(microseconds: number): string {
  return `${(microseconds / 1_000_000).toFixed(1)} s`;
}

function selectedOf(
  item: BeatProposal,
  override: BeatOverride | undefined,
): RankedCandidate | null {
  if (override?.kind === "unresolved") return null;
  const pool = [
    ...(item.coverage.kind === "footage" ? [item.coverage.selected] : []),
    ...item.alternatives,
  ];
  if (override?.kind === "alternative") {
    return pool.find((candidate) => candidate.candidate.assetId === override.assetId) ?? null;
  }
  return item.coverage.kind === "footage" ? item.coverage.selected : null;
}

function coverageLabel(item: BeatProposal, override: BeatOverride | undefined): string {
  if (override?.kind === "unresolved") return "Unresolved (marked by you)";
  if (override?.kind === "alternative") return "Covered";
  switch (item.coverage.kind) {
    case "footage":
      return "Covered";
    case "a-roll":
      return "Covered by A-roll";
    case "graphic":
      return item.coverage.fallback.template === "title" ? "Title card" : "Lower third";
    case "unresolved":
      return "Unresolved";
  }
}

function BeatRow({
  item,
  override,
  disabled,
  onOverride,
}: {
  readonly item: BeatProposal;
  readonly override: BeatOverride | undefined;
  readonly disabled: boolean;
  readonly onOverride: (beatId: string, override: BeatOverride | null) => void;
}): React.JSX.Element {
  const beat = item.beat;
  const selectId = useId();
  const selected = selectedOf(item, override);
  const choices = [
    ...(item.coverage.kind === "footage" ? [item.coverage.selected] : []),
    ...item.alternatives,
  ];
  const value =
    override?.kind === "unresolved"
      ? "unresolved"
      : (selected?.candidate.assetId ?? (item.status === "unresolved" ? "unresolved" : "default"));
  const unresolved =
    override?.kind === "unresolved" || (item.status === "unresolved" && selected === null);
  return (
    <li className="first-cut-beat" data-status={unresolved ? "unresolved" : "covered"}>
      <p className="first-cut-beat-heading">
        <strong>Beat {beat.order + 1}</strong>{" "}
        <span className="muted-copy">
          {seconds(beat.startUs)}–{seconds(beat.endUs)}
        </span>{" "}
        · {coverageLabel(item, override)}
      </p>
      <p className="first-cut-beat-text">{beat.text}</p>
      {beat.mustShow.length > 0 ? (
        <p className="muted-copy">Must show: {beat.mustShow.join(", ")}</p>
      ) : null}
      {selected === null ? null : (
        <div className="first-cut-choice">
          <p>
            Shot: <strong>{selected.candidate.displayName}</strong> (
            {selected.candidate.provenance === "owned" ? "your media" : "cleared stock"}, score{" "}
            {selected.score.total.toFixed(2)})
          </p>
          <ul
            className="first-cut-explanation"
            aria-label={`Why beat ${beat.order + 1} uses this shot`}
          >
            {selected.score.explanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {unresolved ? (
        <p className="muted-copy">
          {override?.kind === "unresolved"
            ? "A marker and note will be added for this beat."
            : (item.unresolvedReason ?? "No shot chosen.")}
          {item.acquisitionSuggestion === null
            ? null
            : ` Try searching “${item.acquisitionSuggestion.query}” in Media search, then plan again.`}
        </p>
      ) : null}
      {choices.length > 0 ? (
        <label htmlFor={selectId}>
          Shot for beat {beat.order + 1}
          <select
            id={selectId}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "unresolved") onOverride(beat.id, { kind: "unresolved" });
              else if (
                item.coverage.kind === "footage" &&
                next === item.coverage.selected.candidate.assetId
              )
                onOverride(beat.id, null);
              else onOverride(beat.id, { kind: "alternative", assetId: next });
            }}
          >
            {choices.map((choice) => (
              <option key={choice.candidate.assetId} value={choice.candidate.assetId}>
                {choice.candidate.displayName} ({choice.score.total.toFixed(2)})
              </option>
            ))}
            <option value="unresolved">Leave unresolved</option>
          </select>
        </label>
      ) : null}
      {item.rejected.length > 0 ? (
        <details>
          <summary>Skipped media ({item.rejected.length})</summary>
          <ul>
            {item.rejected.map((rejected) => (
              <li key={rejected.assetId}>
                {rejected.displayName}: {rejected.detail}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export function ProducePanel({
  projection,
  aRoll,
  artifact,
  intendedUse,
  disabled,
  onApply,
  onFirstCutApplied,
  backend = tauriRightsBackend,
  now = Date.now,
}: ProducePanelProps): React.JSX.Element {
  const headingId = useId();
  const scriptId = useId();
  const [workflow, setWorkflow] = useState<Workflow>("explainer");
  const [script, setScript] = useState("");
  const [language, setLanguage] = useState<string>("en");
  const [proposal, setProposal] = useState<FirstCutProposal | null>(null);
  const [overrides, setOverrides] = useState<BeatOverrides>({});
  const [status, setStatus] = useState<PanelStatus>({ kind: "idle" });
  const [exportBlock, setExportBlock] = useState<string | null>(null);

  const revision = projection?.revision.number ?? null;
  const stale = proposal !== null && proposal.projectRevision !== revision;
  const busy = status.kind === "busy";
  const podcastReady = aRoll !== null && artifact !== null;
  // A transcript requested in a known language fixes the podcast language; the select then mirrors it.
  const transcriptLanguage =
    workflow === "podcast" ? (artifact?.configuration.requestedLanguage ?? null) : null;
  const shownLanguage = transcriptLanguage ?? language;
  const languageOptions: readonly (readonly [string, string])[] = LANGUAGES.some(
    ([code]) => code === shownLanguage,
  )
    ? LANGUAGES
    : [...LANGUAGES, [shownLanguage, shownLanguage]];

  useEffect(() => {
    if (workflow === "podcast" && !podcastReady) setWorkflow("explainer");
  }, [podcastReady, workflow]);

  // Export only supports one full-length clip per video track; warn before the first cut breaks that.
  useEffect(() => {
    setExportBlock(null);
    if (projection === null || proposal === null) return;
    let current = true;
    const check = async (): Promise<void> => {
      const reason = await exportBlockAfterApply(projection, proposal, overrides);
      if (current) setExportBlock(reason);
    };
    void check();
    return () => {
      current = false;
    };
  }, [overrides, projection, proposal]);

  const plan = useCallback(async () => {
    if (projection === null) return;
    setStatus({ kind: "busy", message: "Planning first cut…" });
    const podcastLanguage = artifact?.configuration.requestedLanguage ?? language;
    let beats: readonly NarrativeBeat[];
    if (workflow === "podcast") {
      if (aRoll === null || artifact === null) return;
      const planned = planBeatsForARollClips(
        projection.state,
        aRoll.clipIds,
        artifact.words,
        podcastLanguage,
      );
      if (!planned.ok) {
        const reason = planned.error.code === "beats" ? planned.error.reason : planned.error.code;
        setStatus({ kind: "error", message: beatErrors[reason] ?? "Could not plan beats." });
        return;
      }
      beats = planned.value;
    } else {
      const planned = planBeatsFromScript(script, { language });
      if (!planned.ok) {
        setStatus({
          kind: "error",
          message: beatErrors[planned.error.code] ?? "Could not plan beats.",
        });
        return;
      }
      beats = planned.value;
    }
    let receipts: readonly AcquisitionReceipt[];
    try {
      receipts = await backend.listRightsReceipts(projection.projectId);
    } catch {
      setStatus({ kind: "error", message: "Could not load rights receipts, so no plan was made." });
      return;
    }
    const transcripts =
      workflow === "podcast" && aRoll !== null && artifact !== null
        ? [{ assetId: aRoll.assetId, language: podcastLanguage, words: artifact.words }]
        : [];
    const result = await planFirstCut({
      projectId: projection.projectId,
      projectRevision: projection.revision.number,
      workflow,
      beats,
      index: buildAssetIndex({ assets: projection.state.assets, receipts, transcripts }),
      receipts,
      intendedUse: intendedUse ?? "private-preview",
      nowMs: now(),
      config: DEFAULT_RANKING_CONFIG,
    });
    if (!result.ok) {
      setStatus({
        kind: "error",
        message: "The beat plan was invalid. Edit the script and try again.",
      });
      return;
    }
    setProposal(result.value);
    setOverrides({});
    setStatus({ kind: "idle" });
  }, [aRoll, artifact, backend, intendedUse, language, now, projection, script, workflow]);

  const apply = useCallback(async () => {
    if (projection === null || proposal === null) return;
    const sequence = projection.state.sequences.find(
      (item) => item.id === projection.state.activeSequenceId,
    );
    if (sequence === undefined) return;
    setStatus({ kind: "busy", message: "Applying first cut…" });
    const compiled = await compileFirstCut({
      proposal,
      overrides,
      projectId: projection.projectId,
      revision: projection.revision.number,
      sequence,
      assets: projection.state.assets,
    });
    if (!compiled.ok) {
      setStatus({
        kind: "error",
        message:
          compiled.error.code === "stale-proposal"
            ? "The project changed since this first cut was planned. Re-plan it."
            : compiled.error.code === "nothing-to-apply"
              ? "Nothing to apply: every beat is covered by existing A-roll."
              : "This first cut could not be built. Re-plan it.",
      });
      return;
    }
    const outcome = await onApply(compiled.value.request);
    if (!outcome.ok) {
      setStatus({ kind: "error", message: outcome.message });
      return;
    }
    onFirstCutApplied?.({
      firstCut: proposal,
      sequenceId: sequence.id,
      trackIds: [compiled.value.videoTrackId, compiled.value.titleTrackId].filter(
        (trackId): trackId is string => trackId !== null,
      ),
    });
    setProposal(null);
    setOverrides({});
    setStatus({
      kind: "applied",
      message: `First cut added on new tracks (${compiled.value.clipCount} shots, ${compiled.value.markerCount} unresolved markers). Undo removes it in one step.`,
    });
  }, [onApply, onFirstCutApplied, overrides, projection, proposal]);

  const covered = proposal?.beats.filter(
    (item) =>
      overrides[item.beat.id]?.kind !== "unresolved" &&
      (item.status === "covered" || overrides[item.beat.id] !== undefined),
  ).length;

  return (
    <section className="panel produce-panel" aria-labelledby={headingId} aria-busy={busy}>
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Produce</p>
          <h2 id={headingId}>First cut</h2>
        </div>
        <Clapperboard aria-hidden="true" size={18} />
      </div>

      {projection === null ? (
        <p className="muted-copy">Create or open a project to plan a first cut.</p>
      ) : (
        <form
          className="produce-form"
          onSubmit={(event) => {
            event.preventDefault();
            void plan();
          }}
        >
          <fieldset disabled={disabled || busy}>
            <legend>Workflow</legend>
            <label>
              <input
                type="radio"
                name={`${headingId}-workflow`}
                value="explainer"
                checked={workflow === "explainer"}
                onChange={() => setWorkflow("explainer")}
              />
              Explainer from a script
            </label>
            <label>
              <input
                type="radio"
                name={`${headingId}-workflow`}
                value="podcast"
                checked={workflow === "podcast"}
                disabled={!podcastReady}
                onChange={() => setWorkflow("podcast")}
              />
              Podcast from the A-roll transcript
            </label>
            {podcastReady ? null : (
              <p className="muted-copy">Transcribe the A-roll clip to plan a podcast cut.</p>
            )}
          </fieldset>
          <label>
            Language
            <select
              value={shownLanguage}
              disabled={disabled || busy || transcriptLanguage !== null}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {languageOptions.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {workflow === "explainer" ? (
            <label htmlFor={scriptId}>
              Script
              <textarea
                id={scriptId}
                rows={6}
                value={script}
                disabled={disabled || busy}
                onChange={(event) => setScript(event.target.value)}
                aria-describedby={`${scriptId}-hint`}
              />
              <span id={`${scriptId}-hint`} className="muted-copy">
                One sentence per beat. Use “# Title”, “Lower third: …”, “Map: …”, and tags like
                [show: kayak], [avoid: crowd], [portrait].
              </span>
            </label>
          ) : null}
          <button type="submit" className="secondary-button" disabled={disabled || busy}>
            Plan first cut
          </button>
        </form>
      )}

      <p role="status" aria-live="polite" className="muted-copy">
        {status.kind === "busy" || status.kind === "applied" ? status.message : ""}
      </p>
      {status.kind === "error" ? (
        <p role="alert" className="inline-error">
          {status.message}
        </p>
      ) : null}

      {proposal === null ? null : (
        <div className="first-cut-review">
          <p>
            {covered} of {proposal.beats.length} beats covered ·{" "}
            {seconds(proposal.endUs - proposal.startUs)} planned
          </p>
          {stale ? (
            <p role="alert" className="inline-error">
              The project changed since this first cut was planned. Re-plan it.
            </p>
          ) : null}
          <ol className="first-cut-beats" aria-label="First cut beats">
            {proposal.beats.map((item) => (
              <BeatRow
                key={item.beat.id}
                item={item}
                override={overrides[item.beat.id]}
                disabled={disabled || busy}
                onOverride={(beatId, next) =>
                  setOverrides((current) => {
                    const rest = Object.fromEntries(
                      Object.entries(current).filter(([key]) => key !== beatId),
                    );
                    return next === null ? rest : { ...rest, [beatId]: next };
                  })
                }
              />
            ))}
          </ol>
          {exportBlock === null || stale ? null : (
            <div className="neutral-status" role="status">
              <AlertCircle size={18} aria-hidden />
              <p>
                After applying, this project can’t be exported yet: {exportBlock}. You can still
                review it on the timeline and undo in one step.
              </p>
            </div>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={disabled || busy || stale}
            onClick={() => void apply()}
          >
            Apply first cut
          </button>
        </div>
      )}
    </section>
  );
}
