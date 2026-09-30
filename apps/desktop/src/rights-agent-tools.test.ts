import { describe, expect, it, vi } from "vitest";

import { createRightsAgentSession, rightsAgentToolDefinitions } from "./rights-agent-tools";
import {
  acquiredDigest,
  rightsIds,
  sampleCandidate,
  sampleProbe,
  sampleReceipt,
} from "./rights-fixtures";

function setup() {
  let n = 0;
  const backend = {
    searchRights: vi.fn(async () => ({
      providerId: "wikimedia-commons" as const,
      candidates: [
        sampleCandidate(),
        sampleCandidate({
          providerItemId: "File:Nc.webm",
          advisoryPolicy: { outcome: "block", reasons: ["noncommercial-only"] },
        }),
      ],
    })),
    acquireRights: vi.fn(async () => ({
      receipt: sampleReceipt(),
      importSource: {
        absolutePath: "C:\\cache\\x.blob",
        contentIdentity: {
          schemaVersion: 1 as const,
          algorithm: "sha256" as const,
          digest: acquiredDigest,
          byteLength: 4100,
        },
        probe: sampleProbe,
      },
    })),
  };
  const session = createRightsAgentSession({
    backend,
    intendedUse: () => "commercial-online",
    newId: () => `00000000-0000-4000-8000-00000000d00${++n}`,
  });
  return { backend, session, signal: new AbortController().signal };
}

describe("rights agent tools", () => {
  it("publishes JSON-schema tool definitions", () => {
    expect(rightsAgentToolDefinitions.map((tool) => tool.name)).toEqual([
      "search_stock_media",
      "propose_stock_acquisition",
    ]);
    expect(rightsAgentToolDefinitions[0].inputSchema).toMatchObject({ type: "object" });
  });

  it("search is read-only and uses the app's intended use, not the agent's", async () => {
    const { backend, session, signal } = setup();
    const result = await session.execute(
      "search_stock_media",
      { providerId: "wikimedia-commons", query: "sunrise", mediaKind: "video" },
      signal,
    );
    expect(result.ok).toBe(true);
    expect(backend.searchRights).toHaveBeenCalledWith({
      providerId: "wikimedia-commons",
      query: "sunrise",
      mediaKind: "video",
      intendedUse: "commercial-online",
    });
    expect(backend.acquireRights).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  it("rejects agent-supplied rights fields and unknown tools", async () => {
    const { session, signal } = setup();
    expect(
      await session.execute(
        "search_stock_media",
        {
          providerId: "wikimedia-commons",
          query: "x",
          mediaKind: "video",
          intendedUse: "broadcast",
        },
        signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(
      await session.execute(
        "propose_stock_acquisition",
        {
          providerId: "wikimedia-commons",
          providerItemId: "File:Clip.webm",
          rationale: "r",
          license: "cc0",
        },
        signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await session.execute("rights_acquire", {}, signal)).toEqual({
      ok: false,
      error: { code: "unknown_tool" },
    });
  });

  it("only proposes candidates the session actually searched, and never blocked ones", async () => {
    const { session, signal } = setup();
    const propose = (providerItemId: string) =>
      session.execute(
        "propose_stock_acquisition",
        { providerId: "wikimedia-commons", providerItemId, rationale: "Fits the intro" },
        signal,
      );
    expect(await propose("File:Clip.webm")).toMatchObject({ error: { code: "not_from_search" } });
    await session.execute(
      "search_stock_media",
      { providerId: "wikimedia-commons", query: "sunrise", mediaKind: "video" },
      signal,
    );
    expect(await propose("File:Nc.webm")).toMatchObject({ error: { code: "policy_blocked" } });
    expect(await propose("File:Clip.webm")).toMatchObject({
      ok: true,
      value: { status: "awaiting-user-approval" },
    });
    expect(session.proposals().map((p) => p.status)).toEqual(["pending"]);
  });

  it("acquires only after user approval, with ids only", async () => {
    const { backend, session, signal } = setup();
    await session.execute(
      "search_stock_media",
      { providerId: "wikimedia-commons", query: "sunrise", mediaKind: "video" },
      signal,
    );
    await session.execute(
      "propose_stock_acquisition",
      { providerId: "wikimedia-commons", providerItemId: "File:Clip.webm", rationale: "Intro" },
      signal,
    );
    expect(backend.acquireRights).not.toHaveBeenCalled();
    const proposalId = session.proposals()[0]!.proposalId;
    const approved = await session.approveAcquisitionProposal(proposalId, rightsIds.project);
    expect(approved.ok).toBe(true);
    expect(backend.acquireRights).toHaveBeenCalledWith({
      providerId: "wikimedia-commons",
      providerItemId: "File:Clip.webm",
      intendedUse: "commercial-online",
      projectId: rightsIds.project,
    });
    expect(await session.approveAcquisitionProposal(proposalId, rightsIds.project)).toMatchObject({
      ok: false,
    });
  });

  it("rejection never acquires", async () => {
    const { backend, session, signal } = setup();
    await session.execute(
      "search_stock_media",
      { providerId: "wikimedia-commons", query: "sunrise", mediaKind: "video" },
      signal,
    );
    await session.execute(
      "propose_stock_acquisition",
      { providerId: "wikimedia-commons", providerItemId: "File:Clip.webm", rationale: "Intro" },
      signal,
    );
    const proposalId = session.proposals()[0]!.proposalId;
    expect(session.rejectAcquisitionProposal(proposalId)).toBe(true);
    expect(session.rejectAcquisitionProposal(proposalId)).toBe(false);
    expect(await session.approveAcquisitionProposal(proposalId, rightsIds.project)).toMatchObject({
      ok: false,
    });
    expect(backend.acquireRights).not.toHaveBeenCalled();
  });
});
