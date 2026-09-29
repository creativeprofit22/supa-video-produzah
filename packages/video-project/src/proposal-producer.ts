import type { ProjectTranscriptScopeInput } from "./transcript-edit-mapping.js";

/** Stable, lowercase identifier of the producer that generated a proposal. */
export type ProducerId = string & { readonly __brand: "ProducerId" };

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Who authored a proposal: the user's own selection, a built-in rule, or a model. */
export type ProducerKind = "rule" | "model";
export type ProvenanceKind = "user" | ProducerKind;

export type ProducerParameterValue = string | number | boolean | readonly string[];
export type ProducerParameters = Readonly<Record<string, ProducerParameterValue>>;

/** Recorded on every proposal so review, audit and history can name its origin. */
export interface ProducerProvenance {
  readonly id: ProducerId;
  readonly version: string;
  readonly kind: ProvenanceKind;
  readonly parameters: ProducerParameters;
}

/**
 * One candidate cut. Producers only ever describe deletions; they never emit
 * project commands. Every candidate goes through `createTranscriptEditProposal`
 * so all producers share the same validation.
 */
export type ProducedEdit =
  | {
      readonly kind: "delete-words";
      readonly editId: string;
      readonly occurrenceIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: "delete-gap";
      readonly editId: string;
      readonly clipId: string;
      /** Clip source frames, half-open `[start, end)`, at the clip source rate. */
      readonly sourceStartFrame: number;
      readonly sourceEndFrame: number;
      readonly reason: string;
    };

export type ProducerError =
  | { readonly code: "cancelled" }
  | { readonly code: "invalid_input"; readonly message: string }
  | { readonly code: "invalid_output"; readonly message: string }
  | { readonly code: "producer_failed"; readonly message: string };

export type ProposalProducerInput = ProjectTranscriptScopeInput;

export interface ProposalProducer {
  readonly id: ProducerId;
  readonly version: string;
  readonly kind: ProducerKind;
  readonly parameters: ProducerParameters;
  produce(
    input: ProposalProducerInput,
    signal: AbortSignal,
  ): Promise<Result<readonly ProducedEdit[], ProducerError>>;
}

const producerIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^[0-9A-Za-z.+-]{1,32}$/;
export const maxProducedEdits = 500;

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

export function parseProducerId(value: string): Result<ProducerId, ProducerError> {
  return producerIdPattern.test(value)
    ? ok(value as ProducerId)
    : err({ code: "invalid_input", message: `Invalid producer id: ${JSON.stringify(value)}` });
}

/** Provenance for proposals made from the user's own word selection. */
export const userSelectionProvenance: ProducerProvenance = Object.freeze({
  id: "user-selection" as ProducerId,
  version: "1",
  kind: "user",
  parameters: Object.freeze({}),
});

export function provenanceOf(producer: ProposalProducer): ProducerProvenance {
  const parameters = Object.fromEntries(
    Object.keys(producer.parameters)
      .sort()
      .map((key) => {
        const value = producer.parameters[key] as ProducerParameterValue;
        return [key, Array.isArray(value) ? Object.freeze([...value]) : value];
      }),
  );
  return Object.freeze({
    id: producer.id,
    version: producer.version,
    kind: producer.kind,
    parameters: Object.freeze(parameters),
  });
}

function validateEdits(edits: readonly ProducedEdit[]): ProducerError | null {
  if (edits.length > maxProducedEdits) {
    return {
      code: "invalid_output",
      message: `Producer returned more than ${maxProducedEdits} edits`,
    };
  }
  const seen = new Set<string>();
  for (const edit of edits) {
    if (edit.editId.length === 0 || seen.has(edit.editId)) {
      return { code: "invalid_output", message: `Duplicate or empty edit id: ${edit.editId}` };
    }
    seen.add(edit.editId);
    if (edit.kind === "delete-words") {
      if (edit.occurrenceIds.length === 0) {
        return { code: "invalid_output", message: `Edit ${edit.editId} deletes no words` };
      }
    } else if (
      !Number.isSafeInteger(edit.sourceStartFrame) ||
      !Number.isSafeInteger(edit.sourceEndFrame) ||
      edit.sourceStartFrame < 0 ||
      edit.sourceEndFrame <= edit.sourceStartFrame
    ) {
      return { code: "invalid_output", message: `Edit ${edit.editId} has an invalid gap range` };
    }
  }
  return null;
}

/**
 * Runs a producer and enforces the shared output contract: cancellation is
 * honoured, thrown errors become `producer_failed`, and malformed output is
 * rejected before it can reach proposal creation. Edits are returned sorted by
 * id so output is deterministic.
 */
export async function runProposalProducer(
  producer: ProposalProducer,
  input: ProposalProducerInput,
  signal: AbortSignal,
): Promise<Result<readonly ProducedEdit[], ProducerError>> {
  if (!producerIdPattern.test(producer.id) || !versionPattern.test(producer.version)) {
    return err({ code: "invalid_input", message: "Producer id or version is malformed" });
  }
  if (signal.aborted) return err({ code: "cancelled" });
  let outcome: Result<readonly ProducedEdit[], ProducerError>;
  try {
    outcome = await producer.produce(input, signal);
  } catch (error) {
    return err({
      code: "producer_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (signal.aborted) return err({ code: "cancelled" });
  if (!outcome.ok) return outcome;
  const invalid = validateEdits(outcome.value);
  if (invalid !== null) return err(invalid);
  return ok(
    Object.freeze(
      [...outcome.value].sort((left, right) =>
        left.editId < right.editId ? -1 : left.editId > right.editId ? 1 : 0,
      ),
    ),
  );
}
