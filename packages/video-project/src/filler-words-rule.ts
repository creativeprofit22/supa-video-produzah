import {
  err,
  ok,
  type ProducedEdit,
  type ProducerError,
  type ProducerId,
  type ProposalProducer,
  type ProposalProducerInput,
  type Result,
} from "./proposal-producer.js";
import {
  projectTranscriptToTimeline,
  type TranscriptTimelineOccurrence,
} from "./transcript-edit-mapping.js";

/**
 * Conservative per-language filler lists. Only sounds that are almost never
 * meaningful words are included; "like", "so" or "you know" are left out on
 * purpose because they are usually real speech.
 */
export const fillerWordsByLanguage: Readonly<Record<string, readonly string[]>> = Object.freeze({
  en: Object.freeze(["ah", "eh", "er", "erm", "hm", "hmm", "mm", "uh", "uhm", "um", "umm"]),
  de: Object.freeze(["äh", "ähm", "hm", "hmm", "öh"]),
  es: Object.freeze(["eh", "em", "este", "mm"]),
  fr: Object.freeze(["euh", "hm", "hmm", "heu"]),
});

export interface FillerWordsRuleOptions {
  /**
   * BCP 47 language; only the primary subtag is used. Defaults to the
   * transcript's requested language. An auto-detected transcript has none, so
   * callers must pass one; there is no silent default. Passing it also records
   * the language that ran in the proposal's provenance.
   */
  readonly language?: string;
  /**
   * Context guard: a filler whose neighbour on either side is the same token
   * (e.g. "mm mm" as agreement) is kept.
   */
  readonly skipRepeated: boolean;
}

const fillerWordsProducerId = "filler-words" as ProducerId;

/** Lowercases and strips surrounding punctuation; inner characters are kept. */
export function normalizeToken(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function primaryLanguage(language: string | undefined): string {
  return (language ?? "").split(/[-_]/)[0]?.toLowerCase() ?? "";
}

export function findFillerWords(
  occurrences: readonly TranscriptTimelineOccurrence[],
  language: string,
  options: Pick<FillerWordsRuleOptions, "skipRepeated">,
  signal: AbortSignal,
): Result<readonly ProducedEdit[], ProducerError> {
  const fillers = fillerWordsByLanguage[primaryLanguage(language)];
  if (fillers === undefined) {
    return err({
      code: "invalid_input",
      message: `No filler list for language ${JSON.stringify(language)}`,
    });
  }
  const fillerSet = new Set(fillers);
  const ordered = [...occurrences].sort(
    (left, right) =>
      left.timelineRange.start.value - right.timelineRange.start.value ||
      (left.occurrenceId < right.occurrenceId
        ? -1
        : left.occurrenceId > right.occurrenceId
          ? 1
          : 0),
  );
  const tokens = ordered.map(({ text }) => normalizeToken(text));
  const edits: ProducedEdit[] = [];
  for (const [index, occurrence] of ordered.entries()) {
    if (index % 256 === 0 && signal.aborted) return err({ code: "cancelled" });
    const token = tokens[index] ?? "";
    if (!fillerSet.has(token)) continue;
    if (options.skipRepeated && (tokens[index - 1] === token || tokens[index + 1] === token)) {
      continue;
    }
    edits.push({
      kind: "delete-words",
      editId: `filler:${occurrence.occurrenceId}`,
      occurrenceIds: [occurrence.occurrenceId],
      reason: `Filler word "${token}" (${primaryLanguage(language)})`,
    });
  }
  return ok(Object.freeze(edits));
}

export function createFillerWordsRule(
  options: FillerWordsRuleOptions = { skipRepeated: true },
): ProposalProducer {
  return Object.freeze({
    id: fillerWordsProducerId,
    version: "1",
    kind: "rule",
    parameters: Object.freeze({
      language: options.language ?? "auto",
      skipRepeated: options.skipRepeated,
    }),
    async produce(
      input: ProposalProducerInput,
      signal: AbortSignal,
    ): Promise<Result<readonly ProducedEdit[], ProducerError>> {
      const language = options.language ?? input.artifact.configuration.requestedLanguage;
      if (language === null || language.trim() === "") {
        return err({
          code: "invalid_input",
          message: "Transcript language is unknown; choose a language for filler words",
        });
      }
      const timeline = projectTranscriptToTimeline(input);
      return findFillerWords(timeline.occurrences, language, options, signal);
    },
  });
}
