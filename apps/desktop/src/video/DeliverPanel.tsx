import { DELIVERY_PRESETS, type DeliveryPresetId } from "@supa-video/contracts";
import type { ReviewState } from "@supa-video/qc";

export type DeliveryOutputStatus =
  | { readonly phase: "queued" | "running" }
  | { readonly phase: "done"; readonly outputPath: string; readonly manifestPath: string }
  | { readonly phase: "failed"; readonly message: string };

export interface DeliverPanelProps {
  readonly review: ReviewState | null;
  readonly selected: readonly DeliveryPresetId[];
  readonly outputs: Readonly<Partial<Record<DeliveryPresetId, DeliveryOutputStatus>>>;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onToggle: (presetId: DeliveryPresetId, selected: boolean) => void;
  readonly onDeliver: () => void;
}

function statusText(status: DeliveryOutputStatus | undefined): string | null {
  if (status === undefined) return null;
  switch (status.phase) {
    case "queued":
      return "Waiting";
    case "running":
      return "Rendering and checking";
    case "done":
      return `Done · ${status.outputPath.split(/[\\/]/u).pop() ?? status.outputPath}`;
    case "failed":
      return `Failed · ${status.message}`;
  }
}

export function DeliverPanel({
  review,
  selected,
  outputs,
  pending,
  error,
  onToggle,
  onDeliver,
}: DeliverPanelProps) {
  const blocked = review?.release.status === "blocked" ? review.release.unresolvedFindingIds : null;
  const findings = new Map(
    (review?.manifest.qc.findings ?? []).map((finding) => [finding.findingId, finding]),
  );
  const disabled = review === null || blocked !== null || selected.length === 0 || pending;
  return (
    <section className="panel deliver-panel" aria-labelledby="deliver-title" aria-busy={pending}>
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Formats</p>
          <h2 id="deliver-title">Deliver</h2>
        </div>
      </div>
      <fieldset className="deliver-presets" disabled={pending}>
        <legend>Formats to export</legend>
        {DELIVERY_PRESETS.map((preset) => (
          <label key={preset.id} className="checkbox-row">
            <input
              type="checkbox"
              checked={selected.includes(preset.id)}
              onChange={(event) => onToggle(preset.id, event.target.checked)}
            />
            {preset.label}
            {statusText(outputs[preset.id]) === null ? null : (
              <span className="deliver-status"> — {statusText(outputs[preset.id])}</span>
            )}
          </label>
        ))}
      </fieldset>
      {blocked !== null ? (
        <div role="status">
          <p>Delivery is blocked until these are fixed or accepted in Review:</p>
          <ul aria-label="Unresolved findings">
            {blocked.map((findingId) => (
              <li key={findingId}>{findings.get(findingId)?.message ?? findingId}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {review === null ? <p>Export and review the video first.</p> : null}
      {error !== null ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="secondary-button" type="button" disabled={disabled} onClick={onDeliver}>
        {pending ? "Delivering…" : "Deliver selected formats"}
      </button>
    </section>
  );
}
