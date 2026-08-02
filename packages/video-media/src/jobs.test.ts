import { describe, expect, it } from "vitest";

import {
  getMediaJobEventsRequestSchema,
  listMediaJobsRequestSchema,
  mediaJobActionRequestSchema,
  mediaJobEventSchema,
  mediaJobListSchema,
  mediaJobProgressSchema,
  mediaJobRecordSchema,
  mediaJobRecoveryReportSchema,
  reauthorizeMediaJobOutputRequestSchema,
} from "./jobs.js";

const timestamp = "2026-07-27T12:00:00.000Z";
const laterTimestamp = "2026-07-27T12:00:01.000Z";
const jobId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const progress = { completed: 1, total: 2, unit: "stages" } as const;
const safeError = {
  code: "source_authorization_required",
  category: "authorization_required",
  message: "Choose the source again to continue.",
  retryable: false,
  action: "reauthorize_source",
} as const;
const base = {
  schemaVersion: 1,
  id: jobId,
  kind: "asset_preparation",
  parentId: null,
  projectId,
  assetId,
  revisionId: null,
  priority: "interactive",
  stage: "proxy",
  progress,
  attempt: 1,
  maxAttempts: 3,
  summary: "Prepare clip.mp4",
  createdAt: timestamp,
  updatedAt: laterTimestamp,
  startedAt: timestamp,
  cancellationRequested: false,
} as const;

function candidateForState(state: string): Record<string, unknown> {
  switch (state) {
    case "queued":
    case "probing":
    case "running":
      return {
        ...base,
        state,
        settledAt: null,
        retryAt: null,
        error: null,
        resultAvailable: false,
      };
    case "blocked":
      return {
        ...base,
        state,
        settledAt: null,
        retryAt: null,
        error: safeError,
        resultAvailable: false,
      };
    case "retrying":
      return {
        ...base,
        state,
        settledAt: null,
        retryAt: "2026-07-27T12:00:05.000Z",
        error: { ...safeError, category: "transient_io", action: "retry", retryable: true },
        resultAvailable: false,
      };
    case "cancelled":
      return {
        ...base,
        state,
        settledAt: laterTimestamp,
        retryAt: null,
        error: null,
        resultAvailable: false,
      };
    case "failed":
      return {
        ...base,
        state,
        settledAt: laterTimestamp,
        retryAt: null,
        error: { ...safeError, category: "invalid_media", action: null },
        resultAvailable: false,
      };
    case "complete":
      return {
        ...base,
        state,
        progress: { completed: 2, total: 2, unit: "stages" },
        settledAt: laterTimestamp,
        retryAt: null,
        error: null,
        resultAvailable: true,
      };
    default:
      throw new Error(`Unknown state ${state}`);
  }
}

const states = [
  "queued",
  "probing",
  "running",
  "blocked",
  "retrying",
  "cancelled",
  "failed",
  "complete",
] as const;

describe("media job contracts", () => {
  it.each(states)("accepts the strict %s state discriminant", (state) => {
    expect(mediaJobRecordSchema.parse(candidateForState(state))).toEqual(candidateForState(state));
  });

  it("rejects mismatched state-specific fields and unsafe chronology", () => {
    expect(() =>
      mediaJobRecordSchema.parse({ ...candidateForState("running"), settledAt: laterTimestamp }),
    ).toThrow();
    expect(() =>
      mediaJobRecordSchema.parse({ ...candidateForState("retrying"), retryAt: null }),
    ).toThrow();
    expect(() =>
      mediaJobRecordSchema.parse({ ...candidateForState("failed"), error: null }),
    ).toThrow();
    expect(() =>
      mediaJobRecordSchema.parse({
        ...candidateForState("complete"),
        updatedAt: "2026-07-27T11:59:59.000Z",
      }),
    ).toThrow("precedes");
  });

  it("bounds progress, attempts, query sizes, and timestamps", () => {
    expect(() => mediaJobProgressSchema.parse({ completed: 3, total: 2, unit: "items" })).toThrow();
    expect(() =>
      mediaJobProgressSchema.parse({ completed: 1.5, total: 2, unit: "items" }),
    ).toThrow();
    expect(() =>
      mediaJobRecordSchema.parse({ ...candidateForState("running"), attempt: 4, maxAttempts: 3 }),
    ).toThrow("exceeds");
    expect(() => listMediaJobsRequestSchema.parse({ limit: 101 })).toThrow();
    expect(() => getMediaJobEventsRequestSchema.parse({ limit: 501 })).toThrow();
    expect(() =>
      mediaJobEventSchema.parse({
        schemaVersion: 1,
        eventId: 1,
        jobId,
        eventType: "progress",
        state: "running",
        stage: "proxy",
        progress,
        message: null,
        category: null,
        createdAt: "1969-12-31T23:59:59.000Z",
      }),
    ).toThrow("Unix epoch");
  });

  it("requires an unsettled-parent count that is a JavaScript-safe nonnegative integer", () => {
    const envelope = {
      schemaVersion: 1,
      jobs: [],
      unsettledParentCount: 123,
      nextBeforeUpdatedAt: null,
      nextBeforeJobId: null,
      latestEventId: 0,
      recovery: null,
    };

    expect(mediaJobListSchema.parse(envelope).unsettledParentCount).toBe(123);
    for (const unsettledParentCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => mediaJobListSchema.parse({ ...envelope, unsettledParentCount })).toThrow();
    }
  });

  it("rejects unknown fields and private native details", () => {
    for (const privateField of [
      "privatePayload",
      "sourcePath",
      "ffmpegArgv",
      "stderr",
      "databasePath",
    ]) {
      expect(() =>
        mediaJobRecordSchema.parse({
          ...candidateForState("running"),
          [privateField]: privateField === "ffmpegArgv" ? ["-i", "private.mp4"] : "private",
        }),
      ).toThrow();
    }
    expect(() => mediaJobActionRequestSchema.parse({ jobId, force: true })).toThrow();
    expect(
      reauthorizeMediaJobOutputRequestSchema.parse({
        jobId,
        outputPath: "C:\\Exports\\launch.mp4",
      }),
    ).toEqual({ jobId, outputPath: "C:\\Exports\\launch.mp4" });
    expect(() =>
      reauthorizeMediaJobOutputRequestSchema.parse({
        jobId,
        outputPath: "relative.mp4",
      }),
    ).toThrow();
    expect(() =>
      reauthorizeMediaJobOutputRequestSchema.parse({
        jobId,
        outputPath: "C:\\Exports\\launch.mp4",
        planId: jobId,
      }),
    ).toThrow();
  });

  it("accepts bounded list, event, and recovery envelopes", () => {
    const job = mediaJobRecordSchema.parse(candidateForState("complete"));
    const recovery = mediaJobRecoveryReportSchema.parse({
      schemaVersion: 1,
      requeuedCount: 1,
      blockedCount: 1,
      cancelledCount: 0,
      staleLeaseCount: 2,
      databaseRecovered: false,
      warning: null,
      recoveredAt: timestamp,
    });
    expect(
      mediaJobListSchema.parse({
        schemaVersion: 1,
        jobs: [job],
        unsettledParentCount: 0,
        nextBeforeUpdatedAt: laterTimestamp,
        nextBeforeJobId: jobId,
        latestEventId: 9,
        recovery,
      }).jobs,
    ).toHaveLength(1);
    expect(listMediaJobsRequestSchema.parse({})).toEqual({
      limit: 100,
      includeSettled: true,
      projectId: null,
      beforeUpdatedAt: null,
      beforeJobId: null,
    });
  });

  it("requires both parts of every composite list cursor", () => {
    expect(
      listMediaJobsRequestSchema.parse({ beforeUpdatedAt: laterTimestamp, beforeJobId: jobId }),
    ).toMatchObject({ beforeUpdatedAt: laterTimestamp, beforeJobId: jobId });
    expect(() => listMediaJobsRequestSchema.parse({ beforeUpdatedAt: laterTimestamp })).toThrow(
      "provided together",
    );
    expect(() => listMediaJobsRequestSchema.parse({ beforeJobId: jobId })).toThrow(
      "provided together",
    );
    expect(() =>
      mediaJobListSchema.parse({
        schemaVersion: 1,
        jobs: [],
        unsettledParentCount: 0,
        nextBeforeUpdatedAt: laterTimestamp,
        nextBeforeJobId: null,
        latestEventId: 0,
        recovery: null,
      }),
    ).toThrow("provided together");
  });
});
