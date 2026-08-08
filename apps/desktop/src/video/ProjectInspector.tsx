import type { ProjectProjection, RecoveryReport } from "@supa-video/contracts";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { useCommand } from "../commands/CommandProvider";

interface ProjectInspectorProps {
  readonly projection: ProjectProjection;
  readonly recovery: RecoveryReport | null;
}

const recoveryFallback: Record<RecoveryReport["status"], string> = {
  clean: "Project opened with a clean recovery journal.",
  recovered: "Project recovered from verified journal data.",
  degraded: "Project recovered to the last verified journal record.",
  journal_recreated: "The recovery journal was recreated from the validated project snapshot.",
  migrated_v1: "Current project content was migrated and legacy undo history was reset.",
};

function sanitizedRecoveryMessage(report: RecoveryReport): string {
  const message = report.message.replace(/\s+/g, " ").trim();
  const containsPrivatePath =
    /(?:\b[a-z]:[\\/]|\\\\|file:\/\/|(?:^|\s)\/(?:users|home|var|tmp|volumes|mnt|media|opt|srv)(?:\/|\s|$))/i.test(
      message,
    );
  const containsRawData = /(?:\b[0-9a-f]{32,}\b|(?:\\x[0-9a-f]{2}){4,})/i.test(message);
  return containsPrivatePath || containsRawData ? recoveryFallback[report.status] : message;
}

function formatDiscardedTail(byteCount: number): string {
  if (byteCount === 0) return "None";
  if (byteCount < 1_024) return `${byteCount.toLocaleString()} bytes`;
  const units = ["KB", "MB", "GB"] as const;
  let value = byteCount / 1_024;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = nextUnit;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

function recoveryLabel(status: RecoveryReport["status"]): string {
  return status.replaceAll("_", " ");
}

export function ProjectInspector({ projection, recovery }: ProjectInspectorProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const inspectorCommand = useCommand("view.toggleProjectInspector");
  useEffect(() => {
    if (inspectorCommand.canExecute) closeRef.current?.focus();
  }, [inspectorCommand.canExecute]);
  const lastCommand = projection.lastCommand;
  const recoveryStatus = recovery?.status ?? projection.recoveryStatus;
  const replayedRecordCount = recovery?.replayedRecordCount ?? projection.replayedRecordCount;
  return (
    <section className="project-inspector" aria-labelledby="project-inspector-title">
      <div className="project-inspector-heading">
        <div>
          <p className="state-kicker">Read-only project state</p>
          <h2 id="project-inspector-title">Project diagnostics</h2>
        </div>
        <button
          ref={closeRef}
          className="secondary-button compact-button"
          type="button"
          disabled={!inspectorCommand.canExecute}
          aria-keyshortcuts={inspectorCommand.ariaKeyShortcuts}
          onClick={inspectorCommand.execute}
        >
          <X size={16} aria-hidden />
          Close
        </button>
      </div>
      <dl className="project-inspector-facts">
        <div>
          <dt>Revision number</dt>
          <dd>{projection.revision.number}</dd>
        </div>
        <div>
          <dt>Revision ID</dt>
          <dd>{projection.revision.id}</dd>
        </div>
        <div>
          <dt>State hash</dt>
          <dd>{projection.revision.stateHash}</dd>
        </div>
        <div>
          <dt>Last command</dt>
          <dd>{lastCommand?.summary ?? "Project initialization"}</dd>
        </div>
        <div>
          <dt>Operation ID</dt>
          <dd>{lastCommand?.operationId ?? "Not applicable"}</dd>
        </div>
        <div>
          <dt>Group ID</dt>
          <dd>{lastCommand?.groupId ?? "Not applicable"}</dd>
        </div>
        <div>
          <dt>Snapshot revision</dt>
          <dd>{projection.snapshotRevision}</dd>
        </div>
        <div>
          <dt>Journal health</dt>
          <dd>{projection.journalHealth.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Replayed records</dt>
          <dd>{replayedRecordCount}</dd>
        </div>
        <div>
          <dt>Recovery status</dt>
          <dd>{recoveryLabel(recoveryStatus)}</dd>
        </div>
      </dl>
      {recovery !== null ? (
        <section className="project-recovery-report" aria-labelledby="project-recovery-title">
          <div>
            <p className="state-kicker">Last project open</p>
            <h3 id="project-recovery-title">Recovery report</h3>
            <p className="project-recovery-message">{sanitizedRecoveryMessage(recovery)}</p>
          </div>
          <dl className="project-inspector-facts project-recovery-facts">
            <div>
              <dt>Recovered revision</dt>
              <dd>{recovery.recoveredRevision}</dd>
            </div>
            <div>
              <dt>Discarded journal tail</dt>
              <dd>{formatDiscardedTail(recovery.discardedTailBytes)}</dd>
            </div>
            <div>
              <dt>Legacy undo history</dt>
              <dd>{recovery.legacyHistoryReset ? "Reset permanently" : "Preserved"}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        Journal {projection.journalHealth.replaceAll("_", " ")}; recovery{" "}
        {recoveryLabel(recoveryStatus)}.
      </p>
    </section>
  );
}
