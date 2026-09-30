// @vitest-environment jsdom

import type { ProviderStatus, ReceiptInspection } from "@supa-video/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquiredDigest,
  rightsIds,
  sampleCandidate,
  sampleProbe,
  sampleReceipt,
} from "../rights-fixtures";
import type { RightsBackend } from "../rights-ipc";
import { RightsPanel } from "./RightsPanel";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));

afterEach(cleanup);

const providers: readonly ProviderStatus[] = [
  {
    providerId: "wikimedia-commons",
    displayName: "Wikimedia Commons",
    requiresKey: false,
    keyConfigured: true,
  },
  { providerId: "pexels", displayName: "Pexels", requiresKey: true, keyConfigured: false },
];

function backend(overrides: Partial<RightsBackend> = {}): RightsBackend {
  return {
    getProviderStatus: vi.fn(async () => providers),
    listRightsReceipts: vi.fn(async () => []),
    searchRights: vi.fn(async () => ({
      providerId: "wikimedia-commons" as const,
      candidates: [
        sampleCandidate(),
        sampleCandidate({
          providerItemId: "File:Other.webm",
          title: "Other",
          license: { code: "by-nc", version: "4.0", url: null },
          advisoryPolicy: {
            outcome: "block",
            reasons: ["attribution-required", "noncommercial-only"],
          },
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
    cancelRightsAcquire: vi.fn(async () => true),
    refreshRightsReceipt: vi.fn(async () => sampleReceipt({ lastRefreshStatus: "withdrawn" })),
    inspectRightsReceipt: vi.fn(async (): Promise<ReceiptInspection> => ({
      receipt: sampleReceipt(),
      snapshots: [{ snapshot: sampleReceipt().snapshots[0]!, integrity: "tampered" }],
      refreshes: [],
      freshnessWindowMs: 30 * 24 * 60 * 60 * 1000,
    })),
    ...overrides,
  };
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
  });
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

function renderPanel(b: RightsBackend, onImportAcquired = vi.fn(async () => undefined)) {
  return render(
    <RightsPanel
      projectId={rightsIds.project}
      disabled={false}
      intendedUse="commercial-online"
      onImportAcquired={onImportAcquired}
      backend={b}
      now={() => 1_700_000_000_000 + 1_000}
    />,
  );
}

async function searchFor(text: string) {
  await screen.findByRole("option", { name: "Wikimedia Commons" });
  fireEvent.change(screen.getByLabelText("Search terms"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("list", { name: "Search results" });
}

describe("RightsPanel", () => {
  it("searches with the export's intended use and marks blocked candidates", async () => {
    const b = backend();
    renderPanel(b);
    await searchFor("sunrise");
    expect(b.searchRights).toHaveBeenCalledWith({
      providerId: "wikimedia-commons",
      query: "sunrise",
      mediaKind: "video",
      intendedUse: "commercial-online",
    });
    expect(screen.getByText("2 results.")).toBeTruthy();
    const blocked = screen.getByRole("button", { name: "Acquire Other" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByText("Not allowed")).toBeTruthy();
  });

  it("flags providers that need an API key", async () => {
    renderPanel(backend());
    await screen.findByRole("option", { name: "Pexels (needs API key)" });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "pexels" } });
    expect(screen.getByText(/Pexels needs an API key/)).toBeTruthy();
  });

  it("acquires with ids only and imports the result", async () => {
    const b = backend();
    const onImportAcquired = vi.fn(async () => undefined);
    renderPanel(b, onImportAcquired);
    await searchFor("sunrise");
    fireEvent.click(screen.getByRole("button", { name: "Acquire Clip" }));
    await screen.findByText("Acquired, receipted and added to the timeline.");
    expect(b.acquireRights).toHaveBeenCalledWith({
      providerId: "wikimedia-commons",
      providerItemId: "File:Clip.webm",
      intendedUse: "commercial-online",
      projectId: rightsIds.project,
    });
    expect(onImportAcquired).toHaveBeenCalledOnce();
  });

  it("explains acquisition failures", async () => {
    const { VideoDomainError } = await import("@supa-video/contracts");
    const b = backend({
      acquireRights: vi.fn(async () => {
        throw new VideoDomainError(
          "invalid_command",
          "This license does not allow the intended use.",
          {
            category: "policy_blocked",
          },
        );
      }),
    });
    renderPanel(b);
    await searchFor("sunrise");
    fireEvent.click(screen.getByRole("button", { name: "Acquire Clip" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This license does not allow the intended use.",
    );
  });

  it("compares candidates side by side", async () => {
    renderPanel(backend());
    await searchFor("sunrise");
    const toggles = screen.getAllByRole("checkbox", { name: "Compare" });
    toggles.forEach((toggle) => fireEvent.click(toggle));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Comparing 2 candidates")).toBeTruthy();
    expect(within(table).getByText("Non-commercial use only", { exact: false })).toBeTruthy();
  });

  it("inspects a receipt, shows evidence integrity and previews credits", async () => {
    const b = backend({ listRightsReceipts: vi.fn(async () => [sampleReceipt()]) });
    const { container } = renderPanel(b);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect rights for Clip" }));
    const inspector = await screen.findByRole("region", { name: "Rights inspector" });
    expect(within(inspector).getByText(/Provider record · .* · Altered/)).toBeTruthy();
    expect(within(inspector).getByText(/not legal advice/)).toBeTruthy();
    expect(screen.getByLabelText("Credits text").textContent).toContain('"Clip" by Jane Doe');
    await expectNoAxeViolations(container);
  });

  it("re-checks a receipt with the provider", async () => {
    const b = backend({ listRightsReceipts: vi.fn(async () => [sampleReceipt()]) });
    renderPanel(b);
    fireEvent.click(await screen.findByRole("button", { name: "Re-check Clip with the provider" }));
    await screen.findByText("Withdrawn by the provider");
    expect(b.refreshRightsReceipt).toHaveBeenCalledWith(rightsIds.receipt);
  });

  it("has no accessibility violations with results shown", async () => {
    const { container } = renderPanel(backend());
    await searchFor("sunrise");
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Compare" })[0]!);
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Compare" })[1]!);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    await expectNoAxeViolations(container);
  });
});

describe("RightsPanel agent proposals", () => {
  const proposal = {
    proposalId: "00000000-0000-4000-8000-00000000d001",
    candidate: sampleCandidate(),
    rationale: "Establishing shot for the intro",
    intendedUse: "commercial-online" as const,
    status: "pending" as const,
  };

  it("acquires only when the user approves an assistant suggestion", async () => {
    const b = backend();
    const onImportAcquired = vi.fn(async () => undefined);
    const acquired = await b.acquireRights({
      providerId: "wikimedia-commons",
      providerItemId: "File:Clip.webm",
      intendedUse: "commercial-online",
      projectId: rightsIds.project,
    });
    vi.mocked(b.acquireRights).mockClear();
    const onDecide = vi.fn(async (_id: string, decision: "approve" | "reject") =>
      decision === "approve" ? acquired : null,
    );
    const { container } = render(
      <RightsPanel
        projectId={rightsIds.project}
        disabled={false}
        intendedUse="commercial-online"
        onImportAcquired={onImportAcquired}
        backend={b}
        agentProposals={[proposal]}
        onDecideAgentProposal={onDecide}
      />,
    );
    expect(screen.getByText("Establishing shot for the intro")).toBeTruthy();
    await expectNoAxeViolations(container);
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve acquiring Clip" }));
    await screen.findByText("Acquired, receipted and added to the timeline.");
    expect(onDecide).toHaveBeenCalledWith(proposal.proposalId, "approve");
    expect(onImportAcquired).toHaveBeenCalledOnce();
    expect(b.acquireRights).not.toHaveBeenCalled();
  });

  it("rejecting never acquires", async () => {
    const onImportAcquired = vi.fn(async () => undefined);
    const onDecide = vi.fn(async () => null);
    render(
      <RightsPanel
        projectId={rightsIds.project}
        disabled={false}
        intendedUse={null}
        onImportAcquired={onImportAcquired}
        backend={backend()}
        agentProposals={[proposal]}
        onDecideAgentProposal={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject acquiring Clip" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(proposal.proposalId, "reject"));
    expect(onImportAcquired).not.toHaveBeenCalled();
  });
});
