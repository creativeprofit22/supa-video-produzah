// Final-seek diagnosis: joins recorded per-seek latencies with the keyframe layout of the exact
// media each mode played. No app change and no new measurement are involved; inputs are hash-checked.
// Usage: node final-seek-diagnosis.mjs <workloads index.json> [...]  (prints JSON to stdout)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const stripLong = (p) => p.replace(/^\\\\\?\\/, "");

// Keyframe presentation times from packet flags (container index; no decode).
function keyframes(probeExe, file) {
  const out = execFileSync(
    probeExe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "csv=p=0",
      file,
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
  );
  const all = out
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","))
    .filter(([pts]) => pts !== "N/A" && pts !== "");
  const keys = all
    .filter(([, flags]) => flags.startsWith("K"))
    .map(([pts]) => Number(pts))
    .sort((a, b) => a - b);
  return { keys, packets: all.length };
}

const rank = (values) => {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return ranks;
};
const pearson = (x, y) => {
  const n = x.length,
    mx = x.reduce((a, b) => a + b, 0) / n,
    my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
};
const slope = (x, y) => {
  const n = x.length,
    mx = x.reduce((a, b) => a + b, 0) / n,
    my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx === 0 ? null : { perSecond: sxy / sxx, intercept: my - (sxy / sxx) * mx };
};
const pct = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
};
const round = (v, d = 3) => (v === null ? null : Number(v.toFixed(d)));

function analyse(seeksFile, media, probeExe) {
  const seeks = JSON.parse(readFileSync(seeksFile, "utf8")).filter(
    (s) => s.status === "ok" && s.presentedMs !== null,
  );
  const { keys, packets } = keyframes(probeExe, media);
  assert.ok(keys.length > 0, `no keyframes in ${media}`);
  const gaps = keys.slice(1).map((k, i) => k - keys[i]);
  let previousTarget = null;
  const rows = seeks.map((s) => {
    const target = s.requestedValue;
    const key = keys.filter((k) => k <= target + 1e-6).at(-1) ?? keys[0];
    const sameGopForward =
      previousTarget !== null &&
      previousTarget <= target &&
      (keys.filter((k) => k <= previousTarget + 1e-6).at(-1) ?? keys[0]) === key;
    previousTarget = target;
    return {
      index: s.index,
      target,
      distance: target - key,
      presentedMs: s.presentedMs,
      seekedMs: s.seekedMs,
      sameGopForward,
    };
  });
  const x = rows.map((r) => r.distance),
    y = rows.map((r) => r.presentedMs);
  const near = rows.filter((r) => r.distance < 1).map((r) => r.presentedMs),
    far = rows.filter((r) => r.distance >= 4).map((r) => r.presentedMs);
  return {
    seeksFile: path.basename(path.dirname(seeksFile)) + "/" + path.basename(seeksFile),
    seeksSha256: sha(seeksFile),
    media: path.relative(process.cwd(), media),
    mediaSha256: sha(media),
    packets,
    keyframes: keys.length,
    keyframeIntervalSeconds: {
      min: round(Math.min(...gaps)),
      median: round(pct(gaps, 50)),
      max: round(Math.max(...gaps)),
    },
    seeks: rows.length,
    distanceSeconds: { p50: round(pct(x, 50)), max: round(Math.max(...x)) },
    presentedMs: { p50: round(pct(y, 50), 1), p95: round(pct(y, 95), 1) },
    pearson: round(pearson(x, y)),
    spearman: round(pearson(rank(x), rank(y))),
    fit: (({ perSecond, intercept } = {}) => ({
      msPerSecondOfDistance: round(perSecond, 1),
      interceptMs: round(intercept, 1),
    }))(slope(x, y) ?? {}),
    nearKeyframeUnder1s: { n: near.length, p95: round(pct(near, 95), 1) },
    farFromKeyframeOver4s: { n: far.length, p95: round(pct(far, 95), 1) },
    sameGopForwardSeeks: rows.filter((r) => r.sameGopForward).length,
  };
}

const results = [];
for (const indexPath of process.argv.slice(2)) {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const release = JSON.parse(readFileSync(index.releasePath, "utf8"));
  const probeExe = path.join(path.dirname(release.executable), "media-tools", "ffprobe.exe");
  assert.equal(
    sha(probeExe),
    release.resources.find((r) => r.path === "media-tools/ffprobe.exe").sha256,
  );
  for (const workload of index.workloads.filter((w) => w.kind === "export-reference")) {
    const final = workload.nativeData.finalOutput.outputPath;
    assert.equal(sha(final), workload.nativeData.finalOutputSha256, "Final output changed");
    const clip = workload.nativeData.projection.state.sequences[0].tracks[0].clips[0];
    assert.equal(clip.sourceIn.value, 0);
    assert.equal(clip.timelineStart.value, 0);
    const asset = workload.nativeData.projection.state.assets.find(
      (a) => a.id === clip.source.assetId,
    );
    const source = stripLong(asset.locator.absolutePath);
    assert.equal(sha(source), asset.contentIdentity.digest, "source media changed");
    for (const mode of workload.modes) {
      const media = mode.mode === "Final" ? final : source;
      results.push({
        run: path.basename(path.dirname(indexPath)),
        target: index.target,
        rate: workload.rate,
        mode: mode.mode,
        recordedP95: round(mode.seeks.presentedMs.p95, 1),
        ...analyse(mode.seeks.artifact.file, media, probeExe),
      });
    }
  }
}
console.log(JSON.stringify(results, null, 2));
