/*
 * Revision-level editorial checks. They depend on project data, not encoded
 * pixels, so they run in TS from the exact revision being rendered and travel
 * with the render request as an `EditorialEvaluation` bound to the revision
 * state hash. The native worker validates and merges them with its own QC.
 *
 * Ids exclude frame size, so the same finding keeps its id across presets.
 */
import { z } from "zod";
import {
  clipTimelineDuration,
  isMediaTrack,
  type ProjectClip,
  type QcFinding,
  type QcFindingKind,
  qcFindingSchema,
  type QcRange,
  type QcSeverity,
  qcSha256HexSchema,
  rationalTimeToMicroseconds,
  type VideoAsset,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import { canonicalJson, normalizeTokens, sha256Hex, type NarrativeBeat } from "@supa-video/produce";
import { createFinding, sortFindings } from "./finding.js";
import { motionFindings } from "./motion.js";
import { pacingFindings } from "./pacing.js";

/** v2 adds graphics motion findings (motion.ts); v3 adds pacing findings (pacing.ts). */
export const EDITORIAL_EVALUATOR_VERSION = "editorial-v3";
export const EDITORIAL_MAX_FINDINGS = 512;

export const editorialEvaluationSchema = z.strictObject({
  evaluatorVersion: z.string().min(1).max(64),
  revisionId: z.uuid(),
  revisionStateHash: qcSha256HexSchema,
  findings: z.array(qcFindingSchema).max(EDITORIAL_MAX_FINDINGS),
});
export type EditorialEvaluation = z.infer<typeof editorialEvaluationSchema>;

export interface EditorialConfig {
  /** A reused asset within this distance of its previous use is flagged. */
  readonly repeatWindowUs: number;
  /** A beat with less visible picture coverage than this fraction is uncovered. */
  readonly minBeatCoverage: number;
}

export const DEFAULT_EDITORIAL_CONFIG: EditorialConfig = {
  repeatWindowUs: 30_000_000,
  minBeatCoverage: 0.5,
};

export interface EditorialInput {
  readonly revisionId: string;
  readonly revisionStateHash: string;
  readonly sequence: VideoSequenceV2;
  readonly assets: readonly VideoAsset[];
  /** Beats of the current first-cut plan, when one exists; [] otherwise. */
  readonly beats: readonly NarrativeBeat[];
  /** Extra searchable words per asset id (asset index / transcript tokens). */
  readonly assetTokens?: ReadonlyMap<string, readonly string[]>;
  /**
   * Sorted timeline-microsecond music beats of the sequence's music tracks;
   * omitted or [] when none were detected. Never narrative beats.
   */
  readonly musicBeatsUs?: readonly number[];
  /** The music beats came from the in-app tempo fallback, not Beat This!. */
  readonly musicBeatsFromTempoFallback?: boolean;
  readonly config?: EditorialConfig;
}

interface PlacedClip {
  readonly clipId: string;
  readonly assetId: string;
  readonly range: QcRange;
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
}

/** Marker prefix written by the first-cut compiler for beats it could not cover. */
export const UNRESOLVED_MARKER_PREFIX = "Unresolved · ";

function placeClip(clip: ProjectClip, sequence: VideoSequenceV2): PlacedClip | null {
  if (clip.source.kind !== "asset") return null;
  const startUs = rationalTimeToMicroseconds(clip.timelineStart, "floor");
  const duration = clipTimelineDuration(
    { in: clip.sourceIn, out: clip.sourceOut },
    sequence.rate,
    clip.speed,
  );
  return {
    clipId: clip.id,
    assetId: clip.source.assetId,
    range: { startUs, endUs: startUs + rationalTimeToMicroseconds(duration, "ceil") },
    sourceInUs: rationalTimeToMicroseconds(clip.sourceIn, "floor"),
    sourceOutUs: rationalTimeToMicroseconds(clip.sourceOut, "ceil"),
  };
}

/** Clips on visible video tracks (what the viewer actually sees). */
function visibleClips(sequence: VideoSequenceV2): PlacedClip[] {
  const placed: PlacedClip[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== "video" || track.hidden === true) continue;
    for (const clip of track.clips) {
      const item = placeClip(clip, sequence);
      if (item !== null) placed.push(item);
    }
  }
  return placed.sort(
    (left, right) =>
      left.range.startUs - right.range.startUs || (left.clipId < right.clipId ? -1 : 1),
  );
}

function overlap(left: QcRange, right: QcRange): number {
  return Math.max(0, Math.min(left.endUs, right.endUs) - Math.max(left.startUs, right.startUs));
}

/** Union length of `ranges` inside `window`. */
function coveredLength(window: QcRange, ranges: readonly QcRange[]): number {
  const clipped = ranges
    .map((range) => ({
      startUs: Math.max(range.startUs, window.startUs),
      endUs: Math.min(range.endUs, window.endUs),
    }))
    .filter((range) => range.endUs > range.startUs)
    .sort((left, right) => left.startUs - right.startUs);
  let total = 0;
  let cursor = window.startUs;
  for (const range of clipped) {
    const start = Math.max(cursor, range.startUs);
    if (range.endUs > start) total += range.endUs - start;
    cursor = Math.max(cursor, range.endUs);
  }
  return total;
}

type Draft = Readonly<{
  kind: QcFindingKind;
  severity: QcSeverity;
  subject: string;
  range: QcRange;
  message: string;
}>;

function repeatedAssetFindings(clips: readonly PlacedClip[], config: EditorialConfig): Draft[] {
  const drafts: Draft[] = [];
  const lastByAsset = new Map<string, PlacedClip>();
  for (const clip of clips) {
    const previous = lastByAsset.get(clip.assetId);
    if (previous !== undefined) {
      const gap = clip.range.startUs - previous.range.endUs;
      const sameShot =
        Math.min(clip.sourceOutUs, previous.sourceOutUs) -
          Math.max(clip.sourceInUs, previous.sourceInUs) >
        0;
      if (gap <= config.repeatWindowUs && sameShot) {
        drafts.push({
          kind: "repeated_asset",
          severity: "warning",
          subject: clip.clipId,
          range: clip.range,
          message: "The same shot is used again shortly after its last use",
        });
      }
    }
    lastByAsset.set(clip.assetId, clip);
  }
  return drafts;
}

function missingMediaFindings(sequence: VideoSequenceV2, assets: readonly VideoAsset[]): Draft[] {
  const known = new Set(assets.map((asset) => asset.id));
  const drafts: Draft[] = [];
  for (const track of sequence.tracks) {
    if (!isMediaTrack(track)) continue;
    for (const clip of track.clips) {
      if (clip.source.kind !== "asset" || known.has(clip.source.assetId)) continue;
      const placed = placeClip(clip, sequence);
      if (placed === null) continue;
      drafts.push({
        kind: "missing_media",
        severity: "blocker",
        subject: clip.id,
        range: placed.range,
        message: "A clip points at media that is no longer in the project",
      });
    }
  }
  return drafts;
}

function beatFindings(input: EditorialInput, clips: readonly PlacedClip[]): Draft[] {
  const config = input.config ?? DEFAULT_EDITORIAL_CONFIG;
  const names = new Map(input.assets.map((asset) => [asset.id, asset.displayName]));
  const tokensFor = (assetId: string, language: string): Set<string> =>
    new Set([
      ...normalizeTokens(names.get(assetId) ?? "", language),
      ...(input.assetTokens?.get(assetId) ?? []).flatMap((word) => normalizeTokens(word, language)),
    ]);
  const drafts: Draft[] = [];
  for (const beat of input.beats) {
    const window = { startUs: beat.startUs, endUs: beat.endUs };
    const inside = clips.filter((clip) => overlap(clip.range, window) > 0);
    const covered = coveredLength(
      window,
      inside.map((clip) => clip.range),
    );
    if (covered < (beat.endUs - beat.startUs) * config.minBeatCoverage) {
      drafts.push({
        kind: "uncovered_beat",
        severity: "blocker",
        subject: beat.id,
        range: window,
        message: `Beat ${beat.order + 1} has no picture for most of its length`,
      });
    }
    const shown = new Set(inside.flatMap((clip) => [...tokensFor(clip.assetId, beat.language)]));
    const required = [
      ...new Set(beat.mustShow.flatMap((term) => normalizeTokens(term, beat.language))),
    ];
    const missing = required.filter((token) => !shown.has(token));
    if (missing.length > 0) {
      drafts.push({
        kind: "must_show_missing",
        severity: "warning",
        subject: beat.id,
        range: window,
        message: `Beat ${beat.order + 1} does not show: ${missing.sort().join(", ")}`,
      });
    }
    const forbidden = [
      ...new Set(beat.mustNotShow.flatMap((term) => normalizeTokens(term, beat.language))),
    ].filter((token) => shown.has(token));
    if (forbidden.length > 0) {
      drafts.push({
        kind: "must_not_show_present",
        severity: "blocker",
        subject: beat.id,
        range: window,
        message: `Beat ${beat.order + 1} shows something it must not: ${forbidden.sort().join(", ")}`,
      });
    }
  }
  return drafts;
}

/** Without a beat plan, persisted "Unresolved ·" markers still mark gaps. */
function unresolvedMarkerFindings(input: EditorialInput, clips: readonly PlacedClip[]): Draft[] {
  if (input.beats.length > 0) return [];
  const drafts: Draft[] = [];
  for (const marker of input.sequence.markers) {
    if (!marker.label.startsWith(UNRESOLVED_MARKER_PREFIX)) continue;
    const at = rationalTimeToMicroseconds(marker.time, "floor");
    const covering = clips.some((clip) => clip.range.startUs <= at && at < clip.range.endUs);
    if (covering) continue;
    drafts.push({
      kind: "uncovered_beat",
      severity: "blocker",
      subject: marker.id,
      range: { startUs: at, endUs: at },
      message: marker.label.slice(0, 480),
    });
  }
  return drafts;
}

export async function evaluateEditorial(input: EditorialInput): Promise<EditorialEvaluation> {
  const config = input.config ?? DEFAULT_EDITORIAL_CONFIG;
  const clips = visibleClips(input.sequence);
  const drafts = [
    ...missingMediaFindings(input.sequence, input.assets),
    ...repeatedAssetFindings(clips, config),
    ...beatFindings(input, clips),
    ...unresolvedMarkerFindings(input, clips),
  ];
  const base = sortFindings(await toFindings(drafts, input.revisionStateHash)).slice(
    0,
    EDITORIAL_MAX_FINDINGS,
  );
  // Motion warnings only fill the room the other kinds leave, so they never
  // displace them; info-only pacing findings fill what is left after that.
  const known = new Set(base.map((finding) => finding.findingId));
  const motion = sortFindings(
    await toFindings(motionFindings(input.sequence), input.revisionStateHash),
  )
    .filter((finding) => !known.has(finding.findingId))
    .slice(0, EDITORIAL_MAX_FINDINGS - base.length);
  for (const finding of motion) known.add(finding.findingId);
  const pacingDrafts = pacingFindings({
    sequence: input.sequence,
    musicBeatsUs: input.musicBeatsUs ?? [],
    musicBeatsFromTempoFallback: input.musicBeatsFromTempoFallback === true,
  });
  // The music fit summary goes first so a long list of off-beat cuts cannot crowd it out.
  const summaries = await toFindings(
    pacingDrafts.filter((draft) => draft.kind === "music_fit"),
    input.revisionStateHash,
  );
  const details = sortFindings(
    await toFindings(
      pacingDrafts.filter((draft) => draft.kind !== "music_fit"),
      input.revisionStateHash,
    ),
  );
  const pacing = [...summaries, ...details]
    .filter((finding) => !known.has(finding.findingId))
    .slice(0, EDITORIAL_MAX_FINDINGS - base.length - motion.length);
  return editorialEvaluationSchema.parse({
    evaluatorVersion: EDITORIAL_EVALUATOR_VERSION,
    revisionId: input.revisionId,
    revisionStateHash: input.revisionStateHash,
    findings: sortFindings([...base, ...motion, ...pacing]),
  });
}

/** Findings for `drafts`, first occurrence of each id kept. */
async function toFindings(
  drafts: readonly Draft[],
  revisionStateHash: string,
): Promise<QcFinding[]> {
  const findings: QcFinding[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const finding = await createFinding({ ...draft, source: "editorial", revisionStateHash });
    if (seen.has(finding.findingId)) continue;
    seen.add(finding.findingId);
    findings.push(finding);
  }
  return findings;
}

/** SHA-256 of the evaluation's canonical JSON (matches the manifest field). */
export async function editorialEvaluationSha256(evaluation: EditorialEvaluation): Promise<string> {
  return sha256Hex(canonicalJson(evaluation));
}
