import {
  VideoDomainError,
  type AcquisitionReceipt,
  type MediaKind,
  type ProviderId,
  type ProviderStatus,
  type ReceiptInspection,
  type RightsAcquireResponse,
  type RightsCandidate,
  type UsePolicyProfile,
} from "@supa-video/contracts";
import { renderCreditsText, type CreditEntry } from "@supa-video/rights";
import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { AcquisitionProposal } from "../rights-agent-tools";
import { tauriRightsBackend, type RightsBackend } from "../rights-ipc";
import { intendedUseLabels } from "./export-rights";

/*
 * Stock and public media search, candidate comparison, rights inspector and
 * credits preview. Everything shown here is advisory: acquiring an item makes
 * Rust fetch its record fresh, and the render gate re-checks by content digest.
 */

const mediaKindLabels: Readonly<Record<MediaKind, string>> = {
  video: "Video",
  image: "Image",
  audio: "Audio",
};

const outcomeLabels: Readonly<Record<RightsCandidate["advisoryPolicy"]["outcome"], string>> = {
  allow: "Allowed",
  warn: "Check terms",
  block: "Not allowed",
};

const reasonLabels: Readonly<Record<string, string>> = {
  "attribution-required": "Credit the creator",
  "share-alike-obligation": "Share-alike: derivatives must use the same license",
  "noncommercial-only": "Non-commercial use only",
  "no-derivatives": "No edits or adaptations allowed",
  "custom-terms-review": "Provider-specific terms apply",
  "license-unknown": "License could not be determined",
  "license-conflict": "Item and collection licenses disagree; the stricter one applies",
};

const refreshLabels: Readonly<Record<AcquisitionReceipt["lastRefreshStatus"], string>> = {
  unchanged: "Unchanged at the provider",
  changed: "Changed at the provider",
  withdrawn: "Withdrawn by the provider",
};

const integrityLabels: Readonly<
  Record<ReceiptInspection["snapshots"][number]["integrity"], string>
> = {
  ok: "Verified",
  missing: "Missing",
  tampered: "Altered",
};

const snapshotLabels: Readonly<Record<string, string>> = {
  "api-record": "Provider record",
  "landing-page": "Item page",
  "provider-terms": "Provider terms",
  "license-page": "License text",
};

function licenseLabel(license: RightsCandidate["license"]): string {
  switch (license.code) {
    case "cc0":
      return "CC0";
    case "pdm":
      return "Public domain";
    case "custom":
      return "Provider license";
    case "unknown":
      return "Unknown license";
    default:
      return `CC ${license.code.toUpperCase()}${license.version === null ? "" : ` ${license.version}`}`;
  }
}

function rightsMessage(error: unknown): string {
  if (error instanceof VideoDomainError) {
    const category = error.details["category"];
    if (category === "provider_key_missing")
      return "This provider needs an API key saved in the system keyring.";
    return error.message;
  }
  return "The rights request failed.";
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function candidateKey(candidate: RightsCandidate): string {
  return `${candidate.providerId}\u0000${candidate.providerItemId}`;
}

export interface RightsPanelProps {
  readonly projectId: string | null;
  readonly disabled: boolean;
  readonly intendedUse: UsePolicyProfile | null;
  /** Adds acquired media to the project; returns once the import has settled. */
  readonly onImportAcquired: (acquired: RightsAcquireResponse) => Promise<void>;
  readonly backend?: RightsBackend;
  readonly now?: () => number;
  /** Agent-proposed acquisitions awaiting the user's decision. */
  readonly agentProposals?: readonly AcquisitionProposal[];
  readonly onDecideAgentProposal?: (
    proposalId: string,
    decision: "approve" | "reject",
  ) => Promise<RightsAcquireResponse | null>;
}

type Status =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly label: string }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "done"; readonly message: string };

export function RightsPanel({
  projectId,
  disabled,
  intendedUse,
  onImportAcquired,
  backend = tauriRightsBackend,
  now = Date.now,
  agentProposals = [],
  onDecideAgentProposal,
}: RightsPanelProps) {
  const headingId = useId();
  const queryId = useId();
  const [providers, setProviders] = useState<readonly ProviderStatus[]>([]);
  const [providerId, setProviderId] = useState<ProviderId>("wikimedia-commons");
  const [mediaKind, setMediaKind] = useState<MediaKind>("video");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<readonly RightsCandidate[]>([]);
  const [compare, setCompare] = useState<readonly string[]>([]);
  const [receipts, setReceipts] = useState<readonly AcquisitionReceipt[]>([]);
  const [inspection, setInspection] = useState<ReceiptInspection | null>(null);
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const mounted = useRef(true);
  const profile: UsePolicyProfile = intendedUse ?? "private-preview";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadReceipts = useCallback(async () => {
    if (projectId === null) {
      setReceipts([]);
      return;
    }
    try {
      const list = await backend.listRightsReceipts(projectId);
      if (mounted.current) setReceipts(list);
    } catch (error) {
      if (mounted.current) setStatus({ phase: "error", message: rightsMessage(error) });
    }
  }, [backend, projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await backend.getProviderStatus();
        if (!cancelled) setProviders(list);
      } catch {
        if (!cancelled) setProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend]);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  const pending = status.phase === "pending";
  const locked = disabled || pending || projectId === null;
  const selectedProvider = providers.find((provider) => provider.providerId === providerId);
  const providerUsable = selectedProvider === undefined || selectedProvider.keyConfigured;

  const search = async () => {
    const text = query.trim();
    if (text.length === 0) return;
    setStatus({ phase: "pending", label: "Searching…" });
    try {
      const result = await backend.searchRights({
        providerId,
        query: text,
        mediaKind,
        intendedUse: profile,
      });
      if (!mounted.current) return;
      setCandidates(result.candidates);
      setCompare([]);
      setStatus({
        phase: "done",
        message:
          result.candidates.length === 0
            ? "No results."
            : `${result.candidates.length} result${result.candidates.length === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      if (mounted.current) setStatus({ phase: "error", message: rightsMessage(error) });
    }
  };

  const acquire = async (candidate: RightsCandidate) => {
    if (projectId === null) return;
    await runAcquisition(() =>
      backend.acquireRights({
        providerId: candidate.providerId,
        providerItemId: candidate.providerItemId,
        intendedUse: profile,
        projectId,
      }),
    );
  };

  const decideProposal = async (proposalId: string, decision: "approve" | "reject") => {
    if (onDecideAgentProposal === undefined) return;
    if (decision === "reject") {
      await onDecideAgentProposal(proposalId, "reject");
      return;
    }
    await runAcquisition(async () => {
      const acquired = await onDecideAgentProposal(proposalId, "approve");
      if (acquired === null) throw new Error("The proposal could not be acquired.");
      return acquired;
    });
  };

  const runAcquisition = async (run: () => Promise<RightsAcquireResponse>) => {
    setStatus({ phase: "pending", label: "Checking rights and downloading…" });
    try {
      const acquired = await run();
      if (!mounted.current) return;
      if (acquired.importSource.probe !== null) {
        await onImportAcquired(acquired);
      }
      if (!mounted.current) return;
      await loadReceipts();
      setStatus({
        phase: "done",
        message:
          acquired.importSource.probe === null
            ? "Acquired and receipted. Only video can be placed on the timeline for now."
            : "Acquired, receipted and added to the timeline.",
      });
    } catch (error) {
      if (mounted.current) setStatus({ phase: "error", message: rightsMessage(error) });
    }
  };

  const cancelAcquire = async () => {
    try {
      await backend.cancelRightsAcquire();
    } catch {
      // The acquisition reports its own cancellation or failure.
    }
  };

  const inspect = async (receiptId: string) => {
    setStatus({ phase: "pending", label: "Loading receipt…" });
    try {
      const result = await backend.inspectRightsReceipt(receiptId);
      if (!mounted.current) return;
      setInspection(result);
      setStatus({ phase: "idle" });
    } catch (error) {
      if (mounted.current) setStatus({ phase: "error", message: rightsMessage(error) });
    }
  };

  const refresh = async (receiptId: string) => {
    setStatus({ phase: "pending", label: "Re-checking with the provider…" });
    try {
      const updated = await backend.refreshRightsReceipt(receiptId);
      if (!mounted.current) return;
      await loadReceipts();
      if (inspection?.receipt.receiptId === receiptId) {
        setInspection(await backend.inspectRightsReceipt(receiptId));
      }
      setStatus({ phase: "done", message: refreshLabels[updated.lastRefreshStatus] });
    } catch (error) {
      if (mounted.current) setStatus({ phase: "error", message: rightsMessage(error) });
    }
  };

  const compared = useMemo(
    () => candidates.filter((candidate) => compare.includes(candidateKey(candidate))),
    [candidates, compare],
  );
  const credits: readonly CreditEntry[] = useMemo(
    () =>
      receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        attribution: receipt.attribution,
      })),
    [receipts],
  );
  const freshnessWindowMs = inspection?.freshnessWindowMs ?? null;
  const nowMs = now();

  return (
    <section className="panel rights-panel" aria-labelledby={headingId} aria-busy={pending}>
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Stock &amp; public media</p>
          <h2 id={headingId}>Media search</h2>
        </div>
        <ShieldCheck aria-hidden="true" size={18} />
      </div>

      {projectId === null ? (
        <p className="muted-copy">Create or open a project to search for media.</p>
      ) : null}

      <form
        className="rights-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          Provider
          <select
            value={providerId}
            disabled={locked}
            onChange={(event) => {
              const next = providers.find((p) => p.providerId === event.target.value);
              if (next !== undefined) setProviderId(next.providerId);
            }}
          >
            {providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.displayName}
                {provider.keyConfigured ? "" : " (needs API key)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Media type
          <select
            value={mediaKind}
            disabled={locked}
            onChange={(event) => {
              const next = (Object.keys(mediaKindLabels) as MediaKind[]).find(
                (kind) => kind === event.target.value,
              );
              if (next !== undefined) setMediaKind(next);
            }}
          >
            {(Object.keys(mediaKindLabels) as MediaKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {mediaKindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={queryId}>
          Search terms
          <input
            id={queryId}
            type="search"
            value={query}
            maxLength={200}
            disabled={locked}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="secondary-button compact-button"
          type="submit"
          disabled={locked || !providerUsable || query.trim().length === 0}
        >
          Search
        </button>
      </form>
      {!providerUsable ? (
        <p className="muted-copy">
          {selectedProvider?.displayName ?? "This provider"} needs an API key saved in the system
          keyring before it can be searched.
        </p>
      ) : null}
      <p className="muted-copy">
        Checked against: {intendedUseLabels[profile]}. Results are a preview; rights are verified
        again when you acquire.
      </p>

      <div role="status" aria-live="polite" className="rights-status">
        {status.phase === "pending" ? status.label : null}
        {status.phase === "done" ? status.message : null}
      </div>
      {status.phase === "error" ? (
        <p className="inline-error" role="alert">
          {status.message}
        </p>
      ) : null}
      {pending ? (
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => void cancelAcquire()}
        >
          Cancel
        </button>
      ) : null}

      {candidates.length > 0 ? (
        <ul className="rights-results" aria-label="Search results">
          {candidates.map((candidate) => {
            const key = candidateKey(candidate);
            const checked = compare.includes(key);
            const title = candidate.title ?? candidate.providerItemId;
            return (
              <li key={key} className="rights-result">
                <div className="rights-result-body">
                  <strong>{title}</strong>
                  <span>
                    {candidate.creator ?? "Unknown creator"} · {licenseLabel(candidate.license)}
                  </span>
                  <span
                    className={`rights-outcome rights-outcome-${candidate.advisoryPolicy.outcome}`}
                  >
                    {outcomeLabels[candidate.advisoryPolicy.outcome]}
                  </span>
                </div>
                <div className="rights-result-actions">
                  <label className="rights-compare-toggle">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && compare.length >= 3}
                      onChange={() =>
                        setCompare((current) =>
                          checked ? current.filter((k) => k !== key) : [...current, key],
                        )
                      }
                    />
                    Compare
                  </label>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={locked || candidate.advisoryPolicy.outcome === "block"}
                    aria-label={`Acquire ${title}`}
                    onClick={() => void acquire(candidate)}
                  >
                    Acquire
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {compared.length > 1 ? (
        <div className="rights-compare" role="region" aria-label="Candidate comparison">
          <table>
            <caption>Comparing {compared.length} candidates</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">License</th>
                <th scope="col">Use</th>
                <th scope="col">Obligations</th>
                <th scope="col">Size</th>
              </tr>
            </thead>
            <tbody>
              {compared.map((candidate) => (
                <tr key={candidateKey(candidate)}>
                  <th scope="row">{candidate.title ?? candidate.providerItemId}</th>
                  <td>{licenseLabel(candidate.license)}</td>
                  <td>{outcomeLabels[candidate.advisoryPolicy.outcome]}</td>
                  <td>
                    {candidate.advisoryPolicy.reasons.length === 0
                      ? "None"
                      : candidate.advisoryPolicy.reasons
                          .map((r) => reasonLabels[r] ?? r)
                          .join("; ")}
                  </td>
                  <td>
                    {candidate.width !== null && candidate.height !== null
                      ? `${candidate.width} × ${candidate.height}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {agentProposals.some((proposal) => proposal.status === "pending") ? (
        <div className="rights-receipts">
          <h3>Assistant suggestions</h3>
          <ul aria-label="Assistant acquisition suggestions">
            {agentProposals
              .filter((proposal) => proposal.status === "pending")
              .map((proposal) => {
                const name = proposal.candidate.title ?? proposal.candidate.providerItemId;
                return (
                  <li key={proposal.proposalId} className="rights-receipt">
                    <div className="rights-result-body">
                      <strong>{name}</strong>
                      <span>
                        {licenseLabel(proposal.candidate.license)} ·{" "}
                        {outcomeLabels[proposal.candidate.advisoryPolicy.outcome]} for{" "}
                        {intendedUseLabels[proposal.intendedUse]}
                      </span>
                      <span className="muted-copy">{proposal.rationale}</span>
                    </div>
                    <div className="rights-result-actions">
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        disabled={locked}
                        aria-label={`Approve acquiring ${name}`}
                        onClick={() => void decideProposal(proposal.proposalId, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        disabled={pending}
                        aria-label={`Reject acquiring ${name}`}
                        onClick={() => void decideProposal(proposal.proposalId, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                );
              })}
          </ul>
        </div>
      ) : null}

      {receipts.length > 0 ? (
        <div className="rights-receipts">
          <h3>Acquired media</h3>
          <ul aria-label="Rights receipts">
            {receipts.map((receipt) => (
              <li key={receipt.receiptId} className="rights-receipt">
                <span>
                  <strong>{receipt.attribution.title ?? receipt.providerItemId}</strong> ·{" "}
                  {licenseLabel(receipt.license)} · {refreshLabels[receipt.lastRefreshStatus]}
                </span>
                <span className="rights-result-actions">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={pending}
                    aria-label={`Inspect rights for ${receipt.attribution.title ?? receipt.providerItemId}`}
                    onClick={() => void inspect(receipt.receiptId)}
                  >
                    Inspect
                  </button>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={pending}
                    aria-label={`Re-check ${receipt.attribution.title ?? receipt.providerItemId} with the provider`}
                    onClick={() => void refresh(receipt.receiptId)}
                  >
                    Re-check
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inspection !== null ? (
        <div className="rights-inspector" role="region" aria-label="Rights inspector">
          <h3>Rights inspector</h3>
          <dl>
            <dt>License</dt>
            <dd>
              {inspection.receipt.attribution.licenseName}
              {inspection.receipt.collectionLicense !== null &&
              inspection.receipt.collectionLicense.code !== inspection.receipt.itemLicense.code
                ? " (item and collection licenses disagree; the stricter one applies)"
                : ""}
            </dd>
            <dt>Declared use</dt>
            <dd>
              {intendedUseLabels[inspection.receipt.intendedUse]} ·{" "}
              {outcomeLabels[inspection.receipt.policy.outcome]}
            </dd>
            <dt>Obligations</dt>
            <dd>
              {inspection.receipt.policy.reasons.length === 0
                ? "None"
                : inspection.receipt.policy.reasons.map((r) => reasonLabels[r] ?? r).join("; ")}
            </dd>
            <dt>Last checked</dt>
            <dd>
              {formatDate(inspection.receipt.lastRefreshAtMs)} ·{" "}
              {refreshLabels[inspection.receipt.lastRefreshStatus]}
              {freshnessWindowMs !== null &&
              nowMs - inspection.receipt.lastRefreshAtMs > freshnessWindowMs
                ? " · Out of date: re-check before exporting"
                : ""}
            </dd>
            <dt>Content</dt>
            <dd className="rights-digest">{inspection.receipt.content.digest}</dd>
          </dl>
          <h4>Saved evidence</h4>
          <ul aria-label="License evidence snapshots">
            {inspection.snapshots.map(({ snapshot, integrity }) => (
              <li key={`${snapshot.kind}-${snapshot.digest}`}>
                {snapshotLabels[snapshot.kind] ?? snapshot.kind} ·{" "}
                {formatDate(snapshot.fetchedAtMs)} · {integrityLabels[integrity]}
              </li>
            ))}
          </ul>
          <p className="muted-copy">
            This is a record of what the provider stated, not legal advice. Licenses can be wrong at
            the source; provider terms may add conditions.
          </p>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => setInspection(null)}
          >
            Close inspector
          </button>
        </div>
      ) : null}

      {credits.length > 0 ? (
        <details className="rights-credits">
          <summary>Credits preview</summary>
          <pre aria-label="Credits text">{renderCreditsText(credits)}</pre>
        </details>
      ) : null}
    </section>
  );
}
