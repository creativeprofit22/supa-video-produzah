import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { z } from "zod";

export const crashReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  appVersion: z.string().max(64),
  occurredAtMs: z.number().int().nonnegative(),
  thread: z.string().max(2048),
  location: z.string().max(512).nullable(),
  message: z.string().max(2048),
});
export type CrashReport = z.infer<typeof crashReportSchema>;

/** Reports written by the native panic hook during earlier runs (local only). */
export async function takeCrashReports(): Promise<readonly CrashReport[]> {
  const response = await invoke<unknown>("app_take_crash_reports");
  return z.array(crashReportSchema).max(10).parse(response);
}

export function CrashNotice({
  load = takeCrashReports,
}: {
  readonly load?: () => Promise<readonly CrashReport[]>;
}) {
  const [reports, setReports] = useState<readonly CrashReport[]>([]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await load();
        if (active) setReports(loaded);
      } catch {
        // Diagnostics are best-effort; never block the app on them.
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);
  if (reports.length === 0) return null;
  const latest = reports[reports.length - 1];
  return (
    <div className="crash-notice" role="status">
      <p>
        The app closed unexpectedly last time ({reports.length} report
        {reports.length === 1 ? "" : "s"} saved on this computer).
      </p>
      {latest === undefined ? null : (
        <p className="crash-notice-detail">
          {latest.message}
          {latest.location === null ? "" : ` (${latest.location})`}
        </p>
      )}
      <button
        className="secondary-button compact-button"
        type="button"
        onClick={() => setReports([])}
      >
        Dismiss
      </button>
    </div>
  );
}
