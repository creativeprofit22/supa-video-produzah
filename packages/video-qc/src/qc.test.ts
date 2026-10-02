import { describe, expect, it } from "vitest";
import {
  computeFindingId,
  createFinding,
  findingIdPayload,
  roundToDeciseconds,
  type NewFinding,
} from "./finding.js";
import { qcFindingSchema, type QcFinding } from "@supa-video/contracts";
import {
  parseRenderManifest,
  qcStatusFor,
  reproducibleManifestView,
  serializeRenderManifest,
  type RenderManifest,
} from "./manifest.js";
import { evaluateRelease, isOverridable } from "./policy.js";
import type { ReviewDecision } from "./review-decision.js";

const STATE = "a".repeat(64);
const SHA = "b".repeat(64);

function base(overrides: Partial<NewFinding> = {}): NewFinding {
  return {
    kind: "black_frames",
    source: "deterministic",
    subject: "",
    range: { startUs: 1_000_000, endUs: 2_000_000 },
    revisionStateHash: STATE,
    severity: "blocker",
    message: "Black frames",
    ...overrides,
  };
}

function accept(findingId: string, decisionId: string): ReviewDecision {
  return {
    schemaVersion: 1,
    type: "accept_anyway",
    decisionId,
    findingId,
    outputSha256: SHA,
    manifestSha256: SHA,
    recordedAt: "2026-10-01T00:00:00Z",
    reason: "Intentional fade to black",
  };
}

describe("finding id", () => {
  it.each([
    [0, 0],
    [49_999, 0],
    [50_000, 1],
    [1_049_999, 10],
    [1_050_000, 11],
  ])("rounds %i us to %i deciseconds", (us, ds) => {
    expect(roundToDeciseconds(us)).toBe(ds);
  });

  it("uses a fixed canonical payload shared with the native worker", () => {
    expect(findingIdPayload(base())).toBe(
      `{"endDs":20,"kind":"black_frames","revisionStateHash":"${STATE}","source":"deterministic","startDs":10,"subject":""}`,
    );
  });

  it("matches the golden id shared with the native worker", async () => {
    expect(await computeFindingId(base())).toBe(
      "6d198444bde0eaba78dd2fde8f268b9132b968b9277b6e2924c83b729a940f53",
    );
  });

  it("is stable under sub-rounding jitter and changes with kind, source, subject or revision", async () => {
    const id = await computeFindingId(base());
    expect(await computeFindingId(base({ range: { startUs: 1_020_000, endUs: 1_990_000 } }))).toBe(
      id,
    );
    for (const changed of [
      base({ kind: "freeze_frames" }),
      base({ source: "editorial" }),
      base({ subject: "asset-1" }),
      base({ revisionStateHash: "c".repeat(64) }),
      base({ range: { startUs: 1_200_000, endUs: 2_000_000 } }),
    ]) {
      expect(await computeFindingId(changed)).not.toBe(id);
    }
  });

  it.each([
    ["reading_time_short", "c3f9d2224de525d2b655b8c9039014bca20b9a0b433aefbb01d549086e48c8b1"],
    ["text_outside_safe_area", "ebde4e964f18eeeba36ad119479ae4f2ee5462441af8131cac1f048686c86dbf"],
    ["text_overlap", "69f9f60aa4567153e2725f3c637b62d974e2e6a6d89546c1b536cadee82ff92f"],
  ] as const)("%s parses, is overridable and matches the native golden id", async (kind, id) => {
    const finding = await createFinding(base({ kind, subject: "clip:0", severity: "warning" }));
    expect(finding.findingId).toBe(id);
    expect(qcFindingSchema.parse(finding)).toEqual(finding);
    expect(isOverridable(finding)).toBe(true);
  });

  it("does not depend on severity or message", async () => {
    const a = await createFinding(base());
    const b = await createFinding(base({ severity: "warning", message: "other" }));
    expect(a.findingId).toBe(b.findingId);
  });

  it("rejects inverted ranges", async () => {
    await expect(createFinding(base({ range: { startUs: 5, endUs: 1 } }))).rejects.toThrow();
  });
});

describe("release policy", () => {
  it("is releasable with no findings", () => {
    expect(evaluateRelease([], [])).toEqual({
      status: "releasable",
      acceptedDecisionIds: [],
      acceptedFindingIds: [],
    });
  });

  it("does not block on warnings or info", async () => {
    const findings = [
      await createFinding(base({ severity: "warning" })),
      await createFinding(base({ severity: "info", kind: "silence" })),
    ];
    expect(evaluateRelease(findings, []).status).toBe("releasable");
  });

  it("blocks on an unaccepted blocker and resolves it with accept_anyway", async () => {
    const finding = await createFinding(base());
    expect(evaluateRelease([finding], [])).toEqual({
      status: "blocked",
      unresolvedFindingIds: [finding.findingId],
    });
    const decisionId = "00000000-0000-4000-8000-000000000001";
    expect(evaluateRelease([finding], [accept(finding.findingId, decisionId)])).toEqual({
      status: "releasable",
      acceptedDecisionIds: [decisionId],
      acceptedFindingIds: [finding.findingId],
    });
  });

  it("never lets an override resolve a rights finding", async () => {
    const rights = await createFinding(base({ kind: "rights_blocked", source: "rights" }));
    expect(isOverridable(rights)).toBe(false);
    const decision = accept(rights.findingId, "00000000-0000-4000-8000-000000000002");
    expect(evaluateRelease([rights], [decision]).status).toBe("blocked");
  });

  it("ignores decisions for findings that are not in the manifest", async () => {
    const finding = await createFinding(base());
    const decision = accept("d".repeat(64), "00000000-0000-4000-8000-000000000003");
    expect(evaluateRelease([finding], [decision]).status).toBe("blocked");
  });
});

async function manifest(findings: QcFinding[]): Promise<RenderManifest> {
  return {
    schemaVersion: 1,
    kind: "review",
    presetId: null,
    project: { revisionId: "00000000-0000-4000-8000-00000000000a", revisionStateHash: STATE },
    renderPlanSha256: SHA,
    toolchainId: "ffmpeg-8.1.2-win64-gpl-shared",
    inputs: [
      {
        assetId: "00000000-0000-4000-8000-00000000000c",
        contentSha256: SHA,
        rightsReceiptId: null,
      },
      {
        assetId: "00000000-0000-4000-8000-00000000000b",
        contentSha256: null,
        rightsReceiptId: null,
      },
    ],
    output: {
      fileName: "export.mp4",
      sha256: SHA,
      sizeBytes: 10,
      durationMicroseconds: 3_000_000,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac",
    },
    loudness: null,
    qc: { status: qcStatusFor(findings), detectorVersion: "qc-v1", findings },
    editorial: { evaluatorVersion: "editorial-v1", evaluationSha256: SHA },
    source: null,
    appVersion: "0.1.0",
    createdAt: "2026-10-01T00:00:00Z",
  };
}

describe("render manifest", () => {
  it.each([
    [[], "passed"],
    [["warning"], "warnings"],
    [["warning", "blocker"], "blocked"],
  ] as const)("status for %j is %s", async (severities, status) => {
    const findings = await Promise.all(
      severities.map((severity, index) =>
        createFinding(base({ severity, subject: String(index) })),
      ),
    );
    expect(qcStatusFor(findings)).toBe(status);
  });

  it("serializes canonically regardless of input order and round-trips", async () => {
    const first = await createFinding(base({ range: { startUs: 0, endUs: 1 } }));
    const second = await createFinding(base());
    const a = await manifest([second, first]);
    const b = { ...(await manifest([first, second])), inputs: [...a.inputs].reverse() };
    const text = serializeRenderManifest(a);
    expect(serializeRenderManifest(b)).toBe(text);
    const parsed = parseRenderManifest(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeRenderManifest(parsed.value)).toBe(text);
  });

  it("ignores only the timestamp in the reproducibility view", async () => {
    const a = await manifest([]);
    expect(reproducibleManifestView({ ...a, createdAt: "2027-01-01T00:00:00Z" })).toBe(
      reproducibleManifestView(a),
    );
    expect(
      reproducibleManifestView({ ...a, output: { ...a.output, sha256: "e".repeat(64) } }),
    ).not.toBe(reproducibleManifestView(a));
  });

  it.each([
    ["not json", "invalid_json"],
    ['{"schemaVersion":1}', "invalid_manifest"],
  ])("fails closed on %s", (text, kind) => {
    const parsed = parseRenderManifest(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe(kind);
  });

  it("rejects review decisions smuggled into the manifest", async () => {
    const text = JSON.stringify({ ...(await manifest([])), decisions: [] });
    expect(parseRenderManifest(text).ok).toBe(false);
  });
});
