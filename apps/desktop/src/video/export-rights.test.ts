import { VideoDomainError, type VideoProjectStateV2 } from "@supa-video/contracts";
import { describe, expect, it, vi } from "vitest";

import { acquiredDigest, rightsIds, sampleReceipt } from "../rights-fixtures";
import {
  needsRightsPreflight,
  rightsRenderErrorMessage,
  runRightsPreflight,
} from "./export-rights";

const NOW = 1_700_000_000_000 + 24 * 60 * 60 * 1000;

function state(origin: boolean): VideoProjectStateV2 {
  return {
    assets: [
      {
        id: "00000000-0000-4000-8000-00000000c001",
        displayName: "clip.webm",
        locator: { absolutePath: "C:\\cache\\clip.blob" },
        probe: {
          durationMicroseconds: 4_000_000,
          averageFrameRate: { numerator: 25, denominator: 1 },
          realFrameRate: { numerator: 25, denominator: 1 },
          variableFrameRate: false,
          width: 640,
          height: 360,
          videoCodecName: "vp9",
          audio: null,
          fileSizeBytes: 4100,
        },
        contentIdentity: {
          schemaVersion: 1,
          algorithm: "sha256",
          digest: acquiredDigest,
          byteLength: 4100,
        },
        ...(origin
          ? { origin: { kind: "acquired" as const, acquisitionReceiptId: rightsIds.receipt } }
          : {}),
      },
    ],
    sequences: [],
    activeSequenceId: null,
  } as unknown as VideoProjectStateV2;
}

describe("export rights preflight", () => {
  it("skips the round-trip for local-only projects without a declared use", async () => {
    const backend = { listRightsReceipts: vi.fn() };
    expect(needsRightsPreflight(state(false), null)).toBe(false);
    await expect(runRightsPreflight(backend, state(false), null, NOW)).resolves.toBeNull();
    expect(backend.listRightsReceipts).not.toHaveBeenCalled();
  });

  it("passes a valid acquired asset", async () => {
    const backend = { listRightsReceipts: vi.fn().mockResolvedValue([sampleReceipt()]) };
    await expect(
      runRightsPreflight(backend, state(true), "commercial-online", NOW),
    ).resolves.toBeNull();
  });

  it("explains a withdrawn item before rendering", async () => {
    const backend = {
      listRightsReceipts: vi
        .fn()
        .mockResolvedValue([sampleReceipt({ lastRefreshStatus: "withdrawn" })]),
    };
    const error = await runRightsPreflight(backend, state(true), null, NOW);
    expect(error).toBeInstanceOf(VideoDomainError);
    expect(error?.details["category"]).toBe("rights_preflight");
    expect(error?.message).toBe(
      "clip.webm: The provider no longer offers this item. Remove it from the timeline.",
    );
  });

  it("blocks a noncommercial license for a broadcast export", async () => {
    const nc = sampleReceipt({
      license: {
        code: "by-nc",
        version: "4.0",
        url: "https://creativecommons.org/licenses/by-nc/4.0/",
      },
    });
    const backend = { listRightsReceipts: vi.fn().mockResolvedValue([nc]) };
    const error = await runRightsPreflight(backend, state(true), "broadcast", NOW);
    expect(error?.details["reasons"]).toEqual(["use-blocked"]);
  });

  it("defers to the Rust gate when receipts cannot be listed", async () => {
    const backend = { listRightsReceipts: vi.fn().mockRejectedValue(new Error("offline")) };
    await expect(runRightsPreflight(backend, state(true), null, NOW)).resolves.toBeNull();
  });

  it("explains release-gate refusals from the render authority", () => {
    const fromRust = (category: string) =>
      rightsRenderErrorMessage(
        new VideoDomainError("invalid_render_plan", "invalid", { category }),
      );
    expect(fromRust("rights_snapshot_tampered")).toBe(
      "Rights check failed: Saved license evidence was altered. Acquire it again.",
    );
    expect(fromRust("rights_credits_write")).toMatch(/credits file/);
    expect(fromRust("argv_grammar")).toBeNull();
    expect(rightsRenderErrorMessage(new VideoDomainError("process_failed", "x", {}))).toBeNull();
  });
});
