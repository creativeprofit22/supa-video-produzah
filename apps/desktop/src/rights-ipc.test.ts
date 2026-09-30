import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireRights,
  cancelRightsAcquire,
  inspectRightsReceipt,
  listRightsReceipts,
  refreshRightsReceipt,
  searchRights,
} from "./rights-ipc";
import {
  acquiredDigest,
  rightsIds,
  sampleCandidate,
  sampleProbe,
  sampleReceipt,
} from "./rights-fixtures";
import { VideoIpcResponseError } from "./video-ipc";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const acquireRequest = {
  providerId: "wikimedia-commons",
  providerItemId: "File:Clip.webm",
  intendedUse: "commercial-online",
  projectId: rightsIds.project,
} as const;

function acquireResponse(digest = acquiredDigest): unknown {
  return {
    receipt: sampleReceipt(),
    importSource: {
      absolutePath: "C:\\cache\\objects\\sha256\\ab\\x.blob",
      contentIdentity: { schemaVersion: 1, algorithm: "sha256", digest, byteLength: 4100 },
      probe: sampleProbe,
    },
  };
}

describe("rights IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("sends only ids and the intended use to acquire", async () => {
    invokeMock.mockResolvedValueOnce(acquireResponse());
    const result = await acquireRights(acquireRequest);
    expect(result.receipt.receiptId).toBe(rightsIds.receipt);
    expect(invokeMock).toHaveBeenCalledWith("rights_acquire", { request: acquireRequest });
  });

  it("refuses to send UI-supplied license data", async () => {
    await expect(
      acquireRights({ ...acquireRequest, license: "cc0" } as unknown as typeof acquireRequest),
    ).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects an acquire response whose bytes do not match the receipt", async () => {
    invokeMock.mockResolvedValueOnce(acquireResponse("ef".repeat(32)));
    await expect(acquireRights(acquireRequest)).rejects.toBeInstanceOf(VideoIpcResponseError);
  });

  it("rejects an acquire response for a different item", async () => {
    invokeMock.mockResolvedValueOnce({
      ...(acquireResponse() as Record<string, unknown>),
      receipt: sampleReceipt({ providerItemId: "File:Other.webm" }),
    });
    await expect(acquireRights(acquireRequest)).rejects.toBeInstanceOf(VideoIpcResponseError);
  });

  it("surfaces native acquisition errors as domain errors", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "invalid_command",
      message: "This license does not allow the intended use.",
      details: { category: "policy_blocked" },
    });
    await expect(acquireRights(acquireRequest)).rejects.toMatchObject({
      details: { category: "policy_blocked" },
    });
  });

  it("validates search requests and responses", async () => {
    await expect(
      searchRights({
        providerId: "openverse",
        query: "   ",
        mediaKind: "image",
        intendedUse: "private-preview",
      }),
    ).rejects.toThrow();
    invokeMock.mockResolvedValueOnce({
      providerId: "openverse",
      candidates: [sampleCandidate({ providerId: "openverse" })],
    });
    const result = await searchRights({
      providerId: "openverse",
      query: "tree",
      mediaKind: "image",
      intendedUse: "private-preview",
    });
    expect(result.candidates).toHaveLength(1);
    invokeMock.mockResolvedValueOnce({ providerId: "pexels", candidates: [] });
    await expect(
      searchRights({
        providerId: "openverse",
        query: "tree",
        mediaKind: "image",
        intendedUse: "private-preview",
      }),
    ).rejects.toBeInstanceOf(VideoIpcResponseError);
  });

  it("validates refresh, inspect, list and cancel payloads", async () => {
    invokeMock.mockResolvedValueOnce(sampleReceipt({ lastRefreshStatus: "withdrawn" }));
    await expect(refreshRightsReceipt(rightsIds.receipt)).resolves.toMatchObject({
      lastRefreshStatus: "withdrawn",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("rights_refresh_receipt", {
      request: { receiptId: rightsIds.receipt },
    });

    invokeMock.mockResolvedValueOnce({
      receipt: sampleReceipt(),
      snapshots: [{ snapshot: sampleReceipt().snapshots[0], integrity: "tampered" }],
      refreshes: [{ atMs: 1, status: "unchanged" }],
      freshnessWindowMs: 2_592_000_000,
    });
    await expect(inspectRightsReceipt(rightsIds.receipt)).resolves.toMatchObject({
      snapshots: [{ integrity: "tampered" }],
    });

    invokeMock.mockResolvedValueOnce({ receipt: sampleReceipt(), snapshots: "no" });
    await expect(inspectRightsReceipt(rightsIds.receipt)).rejects.toBeInstanceOf(
      VideoIpcResponseError,
    );

    invokeMock.mockResolvedValueOnce([sampleReceipt()]);
    await expect(listRightsReceipts(rightsIds.project)).resolves.toHaveLength(1);

    invokeMock.mockResolvedValueOnce(true);
    await expect(cancelRightsAcquire()).resolves.toBe(true);

    await expect(refreshRightsReceipt("not-a-uuid")).rejects.toThrow();
  });
});
