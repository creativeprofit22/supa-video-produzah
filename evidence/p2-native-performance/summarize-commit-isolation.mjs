// Read-only summary of workload indexes: commit rates, commit p95s and seek outcomes per row.
// Usage: node summarize-commit-isolation.mjs <index.json> [<index.json> ...]
import { readFileSync } from "node:fs";
import process from "node:process";
import console from "node:console";

const range = (values) => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return "n/a";
  const lo = Math.min(...finite),
    hi = Math.max(...finite);
  return lo === hi ? lo.toFixed(1) : `${lo.toFixed(1)}–${hi.toFixed(1)}`;
};
const percentile = (sorted, p) =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

for (const indexPath of process.argv.slice(2)) {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  console.log(`\n## ${index.target} — ${indexPath}`);
  console.log(
    "| Workload | Rate | Mode | Workspace commits/s | Timeline commits/s | Workspace p95 ms | Timeline p95 ms | Seeks ok/gap/other | Seek presented p95 ms (ok only) |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const workload of index.workloads) {
    for (const mode of workload.modes) {
      const commit = (id, key) =>
        mode.playback.map((sample) => {
          // Uninstrumented builds carry no profiler; their commit fields are unavailable.
          if (sample.commits === null) return Number.NaN;
          const entry = sample.commits.find((c) => c.id === id);
          if (entry === undefined) return 0;
          return key === "rate" ? entry.commitsPerSecond : (entry.durationMs?.p95 ?? Number.NaN);
        });
      const statuses = new Map();
      for (const sample of mode.seeks.samples)
        statuses.set(sample.status, (statuses.get(sample.status) ?? 0) + 1);
      const ok = statuses.get("ok") ?? 0,
        gap = statuses.get("gap-no-video-frame") ?? 0;
      const other = [...statuses.entries()]
        .filter(([status]) => status !== "ok" && status !== "gap-no-video-frame")
        .map(([status, count]) => `${status}:${count}`)
        .join(" ");
      const presented = mode.seeks.samples
        .filter((sample) => sample.status === "ok" && Number.isFinite(sample.presentedMs))
        .map((sample) => sample.presentedMs)
        .sort((a, b) => a - b);
      const p95 = percentile(presented, 0.95);
      console.log(
        `| ${workload.kind} | ${workload.rate} | ${mode.mode} | ${range(commit("VideoWorkspace", "rate"))} | ${range(commit("MultitrackTimeline", "rate"))} | ${range(commit("VideoWorkspace", "p95"))} | ${range(commit("MultitrackTimeline", "p95"))} | ${ok}/${gap}/${other || "0"} | ${p95 === null ? "n/a" : p95.toFixed(0)} |`,
      );
    }
  }
}
