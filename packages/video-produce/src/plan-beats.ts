import { canonicalJson, stableShortHash } from "./canonical.js";
import {
  NARRATIVE_BEAT_SCHEMA_VERSION,
  type NarrativeBeat,
  type OrientationPreference,
  type ShotIntent,
  narrativeBeatSchema,
} from "./narrative-beat.js";
import type { Result } from "./result.js";

/*
 * Rule-based beat planners. Explainer beats come from script sentences timed at
 * a fixed words-per-minute rate; podcast beats come from transcript sentences
 * using real word times. Both produce contiguous beats with content-derived ids.
 */

export const SCRIPT_BEAT_PLANNER_VERSION = "script-wpm/1";
export const TRANSCRIPT_BEAT_PLANNER_VERSION = "transcript-sentences/1";
export const DEFAULT_WORDS_PER_MINUTE = 150;
export const MIN_NARRATION_BEAT_US = 1_500_000;
export const GRAPHIC_BEAT_US = 3_000_000;
const MAX_SENTENCE_WORDS = 40;

export type BeatPlanError =
  | { readonly code: "empty-script" }
  | { readonly code: "invalid-words-per-minute" }
  | { readonly code: "empty-transcript-range" }
  | { readonly code: "invalid-clip-range" }
  | { readonly code: "invalid-beat"; readonly order: number; readonly message: string };

export interface ScriptPlanOptions {
  readonly language: string;
  readonly wordsPerMinute?: number;
}

interface BeatDraft {
  readonly text: string;
  readonly durationUs: number;
  readonly mustShow: readonly string[];
  readonly mustNotShow: readonly string[];
  readonly orientation: OrientationPreference;
  readonly intent: ShotIntent;
}

const DIRECTIVES: readonly {
  readonly pattern: RegExp;
  readonly intent: (text: string) => ShotIntent;
}[] = [
  { pattern: /^#\s+(.+)$/u, intent: (text) => ({ kind: "title", text }) },
  { pattern: /^lower third:\s*(.+)$/iu, intent: (text) => ({ kind: "lower-third", text }) },
  { pattern: /^map:\s*(.+)$/iu, intent: (subject) => ({ kind: "map", subject }) },
  { pattern: /^chart:\s*(.+)$/iu, intent: (subject) => ({ kind: "chart", subject }) },
  { pattern: /^screenshot:\s*(.+)$/iu, intent: (subject) => ({ kind: "screenshot", subject }) },
  { pattern: /^still:\s*(.+)$/iu, intent: (subject) => ({ kind: "still-motion", subject }) },
];

function wordCount(text: string, language: string): number {
  const segmenter = new Intl.Segmenter(language, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(text)) if (segment.isWordLike === true) count += 1;
  return count;
}

function sentences(text: string, language: string): string[] {
  const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  return Array.from(segmenter.segment(text), (segment) => segment.segment.trim()).filter(
    (sentence) => sentence.length > 0,
  );
}

function splitTerms(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort();
}

interface InlineConstraints {
  readonly text: string;
  readonly mustShow: readonly string[];
  readonly mustNotShow: readonly string[];
  readonly orientation: OrientationPreference;
}

/** Strips `[show: a, b]`, `[avoid: c]` and `[portrait|landscape|square]` tags. */
function inlineConstraints(line: string): InlineConstraints {
  const mustShow: string[] = [];
  const mustNotShow: string[] = [];
  let orientation: OrientationPreference = "any";
  const text = line
    .replace(/\[(show|avoid):([^\]]*)\]/giu, (_match, kind: string, terms: string) => {
      (kind.toLowerCase() === "show" ? mustShow : mustNotShow).push(...splitTerms(terms));
      return " ";
    })
    .replace(/\[(portrait|landscape|square)\]/giu, (_match, value: string) => {
      orientation = value.toLowerCase() as OrientationPreference;
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim();
  return { text, mustShow: mustShow.sort(), mustNotShow: mustNotShow.sort(), orientation };
}

function narrationDurationUs(text: string, language: string, wordsPerMinute: number): number {
  const words = Math.max(1, wordCount(text, language));
  return Math.max(MIN_NARRATION_BEAT_US, Math.round((words * 60_000_000) / wordsPerMinute));
}

function scriptDrafts(script: string, language: string, wordsPerMinute: number): BeatDraft[] {
  const drafts: BeatDraft[] = [];
  for (const rawLine of script.split(/\r?\n/u)) {
    const constraints = inlineConstraints(rawLine.trim());
    if (constraints.text.length === 0) continue;
    const directive = DIRECTIVES.find((item) => item.pattern.test(constraints.text));
    const match = directive?.pattern.exec(constraints.text);
    const directiveText = match?.[1]?.trim();
    if (directive !== undefined && directiveText !== undefined && directiveText.length > 0) {
      const intent = directive.intent(directiveText);
      const isText = intent.kind === "title" || intent.kind === "lower-third";
      drafts.push({
        ...constraints,
        text: directiveText,
        durationUs: isText
          ? GRAPHIC_BEAT_US
          : Math.max(GRAPHIC_BEAT_US, narrationDurationUs(directiveText, language, wordsPerMinute)),
        intent,
      });
      continue;
    }
    for (const sentence of sentences(constraints.text, language)) {
      drafts.push({
        ...constraints,
        text: sentence,
        durationUs: narrationDurationUs(sentence, language, wordsPerMinute),
        intent: { kind: "owned-footage" },
      });
    }
  }
  return drafts;
}

function materialize(
  drafts: readonly BeatDraft[],
  language: string,
  startUs: number,
  endOverrides: readonly number[] | null,
): Result<NarrativeBeat[], BeatPlanError> {
  const beats: NarrativeBeat[] = [];
  let cursor = startUs;
  for (const [order, draft] of drafts.entries()) {
    const endUs = endOverrides?.[order] ?? cursor + draft.durationUs;
    const body = {
      schemaVersion: NARRATIVE_BEAT_SCHEMA_VERSION,
      order,
      text: draft.text,
      language,
      startUs: cursor,
      endUs,
      mustShow: draft.mustShow,
      mustNotShow: draft.mustNotShow,
      orientation: draft.orientation,
      intent: draft.intent,
    };
    const parsed = narrativeBeatSchema.safeParse({
      ...body,
      id: `beat-${stableShortHash(canonicalJson(body))}`,
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "invalid-beat", order, message: parsed.error.issues[0]?.message ?? "" },
      };
    }
    beats.push(parsed.data);
    cursor = endUs;
  }
  return { ok: true, value: beats };
}

/**
 * Re-numbers already planned beats into one contiguous plan starting at the
 * first beat's start. Each beat keeps its text, constraints, intent and end;
 * starts follow the previous end, and ids are recomputed from the new body.
 */
export function rematerializeBeats(
  beats: readonly NarrativeBeat[],
  language: string,
): Result<NarrativeBeat[], BeatPlanError> {
  const first = beats[0];
  if (first === undefined) return { ok: true, value: [] };
  const drafts: BeatDraft[] = beats.map((beat) => ({
    text: beat.text,
    durationUs: beat.endUs - beat.startUs,
    mustShow: beat.mustShow,
    mustNotShow: beat.mustNotShow,
    orientation: beat.orientation,
    intent: beat.intent,
  }));
  return materialize(
    drafts,
    language,
    first.startUs,
    beats.map((beat) => beat.endUs),
  );
}

export function planBeatsFromScript(
  script: string,
  options: ScriptPlanOptions,
): Result<NarrativeBeat[], BeatPlanError> {
  const wordsPerMinute = options.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE;
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute < 60 || wordsPerMinute > 400) {
    return { ok: false, error: { code: "invalid-words-per-minute" } };
  }
  const drafts = scriptDrafts(script, options.language, wordsPerMinute);
  if (drafts.length === 0) return { ok: false, error: { code: "empty-script" } };
  return materialize(drafts, options.language, 0, null);
}

export interface TranscriptWordInput {
  readonly text: string;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
}

export interface ARollClipRange {
  readonly assetId: string;
  readonly clipId: string;
  readonly timelineStartUs: number;
  readonly sourceInUs: number;
  readonly sourceOutUs: number;
}

export interface TranscriptPlanOptions {
  readonly language: string;
  readonly pauseUs?: number;
}

/**
 * Groups the A-roll clip's transcript words into sentence beats. Beats are
 * contiguous: silence before a sentence belongs to the previous beat, so the
 * plan spans exactly the clip's timeline range.
 */
export function planBeatsFromTranscript(
  words: readonly TranscriptWordInput[],
  clip: ARollClipRange,
  options: TranscriptPlanOptions,
): Result<NarrativeBeat[], BeatPlanError> {
  if (clip.sourceOutUs <= clip.sourceInUs) {
    return { ok: false, error: { code: "invalid-clip-range" } };
  }
  const pauseUs = options.pauseUs ?? 700_000;
  const inRange = [...words]
    .filter((word) => word.sourceEndUs > clip.sourceInUs && word.sourceStartUs < clip.sourceOutUs)
    .sort((left, right) => left.sourceStartUs - right.sourceStartUs);
  if (inRange.length === 0) return { ok: false, error: { code: "empty-transcript-range" } };

  const groups: TranscriptWordInput[][] = [];
  let current: TranscriptWordInput[] = [];
  for (const word of inRange) {
    const previous = current.at(-1);
    const pause = previous === undefined ? 0 : word.sourceStartUs - previous.sourceEndUs;
    if (previous !== undefined && (pause >= pauseUs || current.length >= MAX_SENTENCE_WORDS)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    if (/[.!?…。！？]$/u.test(word.text.trim())) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const toTimeline = (sourceUs: number): number =>
    clip.timelineStartUs +
    Math.min(Math.max(sourceUs, clip.sourceInUs), clip.sourceOutUs) -
    clip.sourceInUs;
  const starts = groups.map((group, index) =>
    index === 0 ? clip.timelineStartUs : toTimeline(group[0]?.sourceStartUs ?? clip.sourceInUs),
  );
  const planEndUs = toTimeline(clip.sourceOutUs);
  const ends = starts.map((_start, index) => starts[index + 1] ?? planEndUs);
  const drafts: BeatDraft[] = groups.map((group, index) => ({
    text: group
      .map((word) => word.text.trim())
      .join(" ")
      .replace(/\s+/gu, " "),
    durationUs: (ends[index] ?? 0) - (starts[index] ?? 0),
    mustShow: [],
    mustNotShow: [],
    orientation: "any",
    intent: { kind: "a-roll", assetId: clip.assetId, clipId: clip.clipId },
  }));
  return materialize(drafts, options.language, clip.timelineStartUs, ends);
}
