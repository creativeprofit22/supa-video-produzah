/*
 * QC finding taxonomy. A finding is one time-ranged result of a quality check.
 * Its id is a SHA-256 over kind, source, subject, a range rounded to tenths of
 * a second and the revision state hash. Frame size is deliberately excluded so
 * the same finding keeps its id across delivery presets. The Rust worker
 * computes the same id (`video/qc.rs`), so the encoding here is a contract.
 */
import {
  qcFindingSchema,
  type QcFinding,
  type QcFindingKind,
  type QcRange,
  type QcSeverity,
  type QcSource,
} from "@supa-video/contracts";
import { canonicalJson, sha256Hex } from "@supa-video/produce";

export type FindingId = string & { readonly __brand: "FindingId" };

/** Tenth-of-a-second bucket, round half up; must match `qc::round_decisecond` in Rust. */
export function roundToDeciseconds(us: number): number {
  return Math.floor((us + 50_000) / 100_000);
}

export interface FindingIdInput {
  readonly kind: QcFindingKind;
  readonly source: QcSource;
  readonly subject: string;
  readonly range: QcRange;
  readonly revisionStateHash: string;
}

export function findingIdPayload(input: FindingIdInput): string {
  return canonicalJson({
    endDs: roundToDeciseconds(input.range.endUs),
    kind: input.kind,
    revisionStateHash: input.revisionStateHash,
    source: input.source,
    startDs: roundToDeciseconds(input.range.startUs),
    subject: input.subject,
  });
}

export async function computeFindingId(input: FindingIdInput): Promise<FindingId> {
  return (await sha256Hex(findingIdPayload(input))) as FindingId;
}

export interface NewFinding extends FindingIdInput {
  readonly severity: QcSeverity;
  readonly message: string;
}

export async function createFinding(input: NewFinding): Promise<QcFinding> {
  return qcFindingSchema.parse({
    findingId: await computeFindingId(input),
    kind: input.kind,
    severity: input.severity,
    source: input.source,
    subject: input.subject,
    range: { startUs: input.range.startUs, endUs: input.range.endUs },
    message: input.message,
  });
}

/** Deterministic order: range start, then kind, then id. */
export function sortFindings(findings: readonly QcFinding[]): QcFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.range.startUs - right.range.startUs ||
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
      (left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0),
  );
}
