import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { mediaCacheStatusSchema } from "./cache.js";
import { mediaJobEventSchema, mediaJobRecordSchema, mediaJobRecoveryReportSchema } from "./jobs.js";

describe("shared media job public fixtures", () => {
  it("parses every public state and remains path/process/database free", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/media-state-v1/public-contracts.json", import.meta.url),
        "utf8",
      ),
    ) as {
      jobs: unknown[];
      events: unknown[];
      cacheStatus: unknown;
      recovery: unknown;
    };

    const jobs = fixture.jobs.map((job) => mediaJobRecordSchema.parse(job));
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
