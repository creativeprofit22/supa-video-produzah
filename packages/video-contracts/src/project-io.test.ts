import { describe, expect, it } from "vitest";

import { openedVideoProjectSchema, videoSourceRecordSchema } from "./project-io.js";
import type { VideoProjectFileV1 } from "./project.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000101",
  revision: "00000000-0000-4000-8000-000000000102",
  asset: "00000000-0000-4000-8000-000000000103",
  otherAsset: "00000000-0000-4000-8000-000000000104",
} as const;
const timestamp = "2026-07-25T12:00:00.000Z";

function makeDocument(withAsset = true): VideoProjectFileV1 {
  return {
    schemaVersion: 1,
    id: ids.project,
    name: "Opened fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentRevisionId: ids.revision,
    revisions: [
      {
        id: ids.revision,
        parentRevisionId: null,
        sequenceNumber: 0,
        committedAt: timestamp,
        commandSummary: "Created project",
        state: {
          asset: withAsset
            ? {
                id: ids.asset,
                displayName: "fixture.mp4",
                locator: {
                  relativePath: "media/fixture.mp4",
                  absolutePath: "C:\\Media\\fixture.mp4",
                },
                probe: {
                  durationMicroseconds: 2_000_000,
                  averageFrameRate: { numerator: 30, denominator: 1 },
                  realFrameRate: { numerator: 30, denominator: 1 },
                  variableFrameRate: false,
                  width: 320,
                  height: 180,
                  videoCodecName: "h264",
                  audio: { codecName: "aac", channels: 2, sampleRate: 48_000 },
                  fileSizeBytes: 100_000,
                },
              }
            : null,
          sequence: null,
        },
      },
    ],
  };
}

function makeOpened(status: "resolved" | "missing" | "relink_required") {
  return {
    path: "C:\\Projects\\fixture.svpvideo",
    document: makeDocument(),
    sources: [
      {
        assetId: ids.asset,
        status,
        resolvedPath: status === "resolved" ? "C:\\Projects\\media\\fixture.mp4" : null,
      },
    ],
  };
}

describe("opened video project contracts", () => {
  it.each(["resolved", "missing", "relink_required"] as const)(
    "accepts the strict %s source status",
    (status) => {
      expect(openedVideoProjectSchema.parse(makeOpened(status))).toEqual(makeOpened(status));
    },
  );

  it("accepts an empty project without source records", () => {
    const opened = {
      path: "/projects/empty.svpvideo",
      document: makeDocument(false),
      sources: [],
    };
    expect(openedVideoProjectSchema.parse(opened)).toEqual(opened);
  });

  it("enforces status-specific resolved paths", () => {
    expect(() =>
      videoSourceRecordSchema.parse({
        assetId: ids.asset,
        status: "resolved",
        resolvedPath: null,
      }),
    ).toThrow();
    expect(() =>
      videoSourceRecordSchema.parse({
        assetId: ids.asset,
        status: "missing",
        resolvedPath: "C:\\Media\\fixture.mp4",
      }),
    ).toThrow();
    expect(() =>
      videoSourceRecordSchema.parse({
        assetId: ids.asset,
        status: "relink_required",
        resolvedPath: "relative/fixture.mp4",
      }),
    ).toThrow();
  });

  it("rejects malformed project and resolved paths", () => {
    for (const path of ["", "relative/project.svpvideo", "C:project.svpvideo", "bad\0path"]) {
      expect(() => openedVideoProjectSchema.parse({ ...makeOpened("resolved"), path })).toThrow();
    }
    const malformedResolved = structuredClone(makeOpened("resolved"));
    malformedResolved.sources[0]!.resolvedPath = "relative/fixture.mp4";
    expect(() => openedVideoProjectSchema.parse(malformedResolved)).toThrow();
  });

  it("rejects malformed UUIDs, documents, and unknown fields", () => {
    expect(() =>
      openedVideoProjectSchema.parse({
        ...makeOpened("missing"),
        sources: [{ assetId: "not-a-uuid", status: "missing", resolvedPath: null }],
      }),
    ).toThrow();
    expect(() =>
      openedVideoProjectSchema.parse({ ...makeOpened("missing"), document: { schemaVersion: 1 } }),
    ).toThrow();
    expect(() =>
      openedVideoProjectSchema.parse({ ...makeOpened("missing"), private: true }),
    ).toThrow();
    expect(() =>
      openedVideoProjectSchema.parse({
        ...makeOpened("missing"),
        sources: [{ ...makeOpened("missing").sources[0], extra: true }],
      }),
    ).toThrow();
  });

  it("rejects duplicate, mismatched, missing, and empty-project source records", () => {
    const source = makeOpened("missing").sources[0];
    expect(() =>
      openedVideoProjectSchema.parse({ ...makeOpened("missing"), sources: [source, source] }),
    ).toThrow("unique asset IDs");
    expect(() =>
      openedVideoProjectSchema.parse({
        ...makeOpened("missing"),
        sources: [{ ...source, assetId: ids.otherAsset }],
      }),
    ).toThrow("current revision");
    expect(() => openedVideoProjectSchema.parse({ ...makeOpened("missing"), sources: [] })).toThrow(
      "requires one source record",
    );
    expect(() =>
      openedVideoProjectSchema.parse({
        ...makeOpened("missing"),
        document: makeDocument(false),
      }),
    ).toThrow("empty current revision");
  });
});
