import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { mediaCacheStatusSchema } from "./cache.js";
import {
  listMediaJobsRequestSchema,
  mediaJobEventSchema,
  mediaJobListSchema,
  mediaJobRecordSchema,
  mediaJobRecoveryReportSchema,
} from "./jobs.js";

describe("shared media job public fixtures", () => {
  it("parses every public state and remains path/process/database free", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/media-state-v1/public-contracts.json", import.meta.url),
        "utf8",
      ),
    ) as {
      jobs: unknown[];
      listEnvelopes: Array<{
        listRequest: Record<string, unknown>;
        listResponse: Record<string, unknown>;
      }>;
      events: unknown[];
      cacheStatus: unknown;
      recovery: unknown;
    };

    const jobs = fixture.jobs.map((job) => mediaJobRecordSchema.parse(job));
    const listEnvelopes = fixture.listEnvelopes.map(({ listRequest, listResponse }) => ({
      request: listMediaJobsRequestSchema.parse(listRequest),
      response: mediaJobListSchema.parse(listResponse),
    }));
    const events = fixture.events.map((event) => mediaJobEventSchema.parse(event));
    mediaCacheStatusSchema.parse(fixture.cacheStatus);
    mediaJobRecoveryReportSchema.parse(fixture.recovery);

    expect(jobs.map((job) => job.state)).toEqual([
      "queued",
      "probing",
      "running",
      "blocked",
      "retrying",
      "cancelled",
      "failed",
      "complete",
    ]);
    expect(events.map((event) => event.eventId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(listEnvelopes.map(({ request }) => request.beforeUpdatedAt)).toEqual([
      null,
      "2026-07-27T12:00:14.000Z",
    ]);
    expect(listEnvelopes.map(({ response }) => response.nextBeforeJobId)).toEqual([
      "00000000-0000-4000-8000-000000000007",
      null,
    ]);

    const continuationRequest = fixture.listEnvelopes[1]!.listRequest;
    expect(
      listMediaJobsRequestSchema.safeParse({ ...continuationRequest, beforeUpdatedAt: null })
        .success,
    ).toBe(false);
    expect(
      listMediaJobsRequestSchema.safeParse({ ...continuationRequest, beforeJobId: null }).success,
    ).toBe(false);

    const firstPageResponse = fixture.listEnvelopes[0]!.listResponse;
    expect(
      mediaJobListSchema.safeParse({ ...firstPageResponse, nextBeforeUpdatedAt: null }).success,
    ).toBe(false);
    expect(
      mediaJobListSchema.safeParse({ ...firstPageResponse, nextBeforeJobId: null }).success,
    ).toBe(false);

    const serialized = JSON.stringify(fixture);
    for (const forbidden of [
      "privatePayload",
      "sourcePath",
      "ffmpegArgv",
      "stderr",
      "databasePath",
      "lockError",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
