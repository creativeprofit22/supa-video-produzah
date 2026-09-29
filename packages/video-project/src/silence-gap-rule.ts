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

export interface SilenceGapRuleOptions {
  /** Pauses between words at least this long are proposed for removal. */
  readonly minGapMs: number;
  /** Silence kept on each side of the cut so speech does not sound clipped. */
  readonly paddingMs: number;
}

export const defaultSilenceGapRuleOptions: SilenceGapRuleOptions = Object.freeze({
  minGapMs: 800,
  paddingMs: 150,
});

const silenceGapProducerId = "silence-gap" as ProducerId;

// Rounds up so both the gap threshold and the kept padding err toward keeping media.
function msToFramesCeil(ms: number, numerator: number, denominator: number): number {
  return Math.ceil((ms * numerator) / (denominator * 1_000));
}

function validateOptions(options: SilenceGapRuleOptions): ProducerError | null {
  const valid =
    Number.isFinite(options.minGapMs) &&
    Number.isFinite(options.paddingMs) &&
    options.minGapMs > 0 &&
    options.minGapMs <= 60_000 &&
    options.paddingMs >= 0 &&
    options.paddingMs * 2 < options.minGapMs;
  return valid
    ? null
    : {
        code: "invalid_input",
        message: "Silence gap needs 0 < minGapMs <= 60000 and 0 <= 2 * paddingMs < minGapMs",
      };
}

/**
 * Finds pauses between consecutive transcribed words in the same clip. Uses
 * word timings only; there is no audio analysis, so non-speech sound inside a
 * pause is also removed. Every result still needs the user's approval.
 */
export function findSilenceGaps(
  occurrences: readonly TranscriptTimelineOccurrence[],
  options: SilenceGapRuleOptions,
  signal: AbortSignal,
): Result<readonly ProducedEdit[], ProducerError> {
  const invalid = validateOptions(options);
  if (invalid !== null) return err(invalid);
  const byClip = new Map<string, TranscriptTimelineOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = byClip.get(occurrence.clipId) ?? [];
    list.push(occurrence);
    byClip.set(occurrence.clipId, list);
  }
  const edits: ProducedEdit[] = [];
  for (const clipId of [...byClip.keys()].sort()) {
    if (signal.aborted) return err({ code: "cancelled" });
    const list = (byClip.get(clipId) ?? []).sort(
      (left, right) =>
        left.sourceRange.start.value - right.sourceRange.start.value ||
        left.sourceRange.end.value - right.sourceRange.end.value,
    );
    let furthestEnd: number | null = null;
    for (const occurrence of list) {
      const { start, end } = occurrence.sourceRange;
      if (furthestEnd !== null) {
        const minGap = msToFramesCeil(options.minGapMs, start.rateNumerator, start.rateDenominator);
        const padding = msToFramesCeil(
          options.paddingMs,
          start.rateNumerator,
          start.rateDenominator,
        );
        const gap = start.value - furthestEnd;
        const cutStart = furthestEnd + padding;
        const cutEnd = start.value - padding;
        if (gap >= minGap && cutEnd > cutStart) {
          const lengthMs = Math.round(
            ((gap * start.rateDenominator) / start.rateNumerator) * 1_000,
          );
          edits.push({
            kind: "delete-gap",
            editId: `silence:${clipId}:${cutStart}:${cutEnd}`,
            clipId,
            sourceStartFrame: cutStart,
            sourceEndFrame: cutEnd,
            reason: `Pause of about ${lengthMs} ms`,
          });
        }
      }
      furthestEnd = Math.max(furthestEnd ?? end.value, end.value);
    }
  }
  return ok(Object.freeze(edits));
}

export function createSilenceGapRule(
  options: SilenceGapRuleOptions = defaultSilenceGapRuleOptions,
): ProposalProducer {
  return Object.freeze({
    id: silenceGapProducerId,
    version: "1",
    kind: "rule",
    parameters: Object.freeze({ minGapMs: options.minGapMs, paddingMs: options.paddingMs }),
    async produce(
      input: ProposalProducerInput,
      signal: AbortSignal,
    ): Promise<Result<readonly ProducedEdit[], ProducerError>> {
      const timeline = projectTranscriptToTimeline(input);
      return findSilenceGaps(timeline.occurrences, options, signal);
    },
  });
}
