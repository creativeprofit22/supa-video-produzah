import type { MediaJobRecord } from "@supa-video/media";
import { AlertCircle, Ban, CheckCircle2, Clock3, ListTodo, type LucideIcon } from "lucide-react";

export const mediaJobStateLabels: Record<MediaJobRecord["state"], string> = {
  queued: "Queued",
  probing: "Checking media",
  running: "Running",
  blocked: "Needs attention",
  retrying: "Retry scheduled",
  cancelled: "Cancelled",
  failed: "Failed",
  complete: "Complete",
};

const mediaJobStateIcons: Record<MediaJobRecord["state"], LucideIcon> = {
  queued: Clock3,
  probing: ListTodo,
  running: ListTodo,
  blocked: AlertCircle,
  retrying: Clock3,
  cancelled: Ban,
  failed: AlertCircle,
  complete: CheckCircle2,
};

const activeJobStates = new Set<MediaJobRecord["state"]>([
  "queued",
  "probing",
  "running",
  "retrying",
]);

export function isMediaJobActive(job: MediaJobRecord): boolean {
  return activeJobStates.has(job.state) || job.cancellationRequested;
}

export function isMediaJobSettled(job: MediaJobRecord): boolean {
  return job.state === "cancelled" || job.state === "failed" || job.state === "complete";
}

export function MediaJobStateIcon({ state }: { readonly state: MediaJobRecord["state"] }) {
  const Icon = mediaJobStateIcons[state];
  return <Icon size={18} aria-hidden />;
}

function statusDetail(job: MediaJobRecord, subject: string): string {
  if (job.cancellationRequested) return `${subject} cancellation is pending.`;
  const progress =
    job.progress.total > 0
      ? ` ${Math.floor((job.progress.completed / job.progress.total) * 100)}% complete.`
      : "";
  switch (job.state) {
    case "queued":
      return `${subject} is waiting to start.`;
    case "probing":
      return `${subject} is checking its media.${progress}`;
    case "running":
      return `${subject} is in progress.${progress}`;
    case "blocked":
      return `${subject} needs attention before it can continue.`;
    case "retrying":
      return `${subject} will retry automatically.`;
    case "cancelled":
      return `${subject} was cancelled.`;
    case "failed":
      return `${subject} did not finish.`;
    case "complete":
      return `${subject} is durable and complete.`;
  }
}

interface MediaJobStatusProps {
  readonly job: MediaJobRecord;
  readonly label: string;
  readonly subject: string;
  readonly onOpenJobCenter: (jobId: string) => void;
}

export function MediaJobStatus({ job, label, subject, onOpenJobCenter }: MediaJobStatusProps) {
  return (
    <div
      className={`linked-job-status job-state-${job.state}`}
      role={job.state === "failed" ? "alert" : "status"}
    >
      <MediaJobStateIcon state={job.state} />
      <div>
        <strong>
          {label}: {job.cancellationRequested ? "Cancelling" : mediaJobStateLabels[job.state]}
        </strong>
        <p>{statusDetail(job, subject)}</p>
        <button
          className="secondary-button compact-button"
          type="button"
          aria-label={`Open ${label.toLocaleLowerCase()} in Job Center`}
          onClick={() => onOpenJobCenter(job.id)}
        >
          <ListTodo size={16} aria-hidden />
          Open Job Center
        </button>
      </div>
    </div>
  );
}
