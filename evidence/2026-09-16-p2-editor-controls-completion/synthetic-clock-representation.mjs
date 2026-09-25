import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// Offline arithmetic only. Never pass capture directories to this driver.
const LABEL = "SYNTHETIC — NOT CAPTURE OR ACCEPTANCE EVIDENCE";
const SOURCE_SHA256 = "0fb3fb9f2aac43d945e9e1a52b38b1510632182a73e8cba912aec2f4ae471ab3";
const base = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const analyzer = path.resolve(base, "../2026-09-14-p2-speed/output-capture/analyze-bounded.mjs");
const INPUT_LIMIT = 4 * 1024 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const spec = {
  label: LABEL,
  reference: "Analytically specified integer microseconds, not a physical clock",
  representations: [
    { id: "A", epochSeconds: 100, frequency: 10000000 },
    { id: "B", epochSeconds: 100000, frequency: 3000000 },
  ],
  conditions: [
    {
      name: "sync",
      onsetUs: 1000000,
      sampleIndex: 24000,
      intervalMs: [-37, -13],
      classification: "inconclusive",
    },
    {
      name: "late",
      onsetUs: 1100000,
      sampleIndex: 28800,
      intervalMs: [63, 87],
      classification: "pass",
    },
    {
      name: "early",
      onsetUs: 900000,
      sampleIndex: 19200,
      intervalMs: [-137, -113],
      classification: "pass",
    },
  ],
  frameTimesUs: [
    [1024000, 1014000, 1016000],
    [1036000, 1030000, 1032000],
  ],
  expectedSixRelativeMs: [1024, 1014, 1016, 1036, 1030, 1032],
  expectedHullRelativeMs: [1014, 1036],
  audioStartStopUs: [500000, 1500000],
  visualStartStopUs: [400000, 1600000],
  stopRequestAckUs: [1550000, 1600000],
  playBoundsUs: [700000, 701000],
  sampleRate: 48000,
  channels: 2,
  sampleFrames: 48000,
  pulseSamples: 48,
  amplitude: 0.25,
  expectedCalibration: "inconclusive",
  toleranceMs: 0.0001,
  limits: {
    inputBytesExclusive: INPUT_LIMIT,
    childOutputBytes: OUTPUT_LIMIT,
    childTimeoutMs: 10000,
  },
  caveat:
    "Fabricated validity fields do not establish real isolation or shutdown. Cause unresolved. No real-capture or acceptance gates are waived.",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let root;
const fixtures = [];
let inputBytes = 0;
const report = {
  label: LABEL,
  verdict: "inconclusive",
  sourceSha256: SOURCE_SHA256,
  preflight: false,
  subprocesses: [],
  comparisons: [],
  mismatches: [],
  cause: "unresolved",
};

function contained(parent, target) {
  const rel = path.relative(parent, target);
  assert(
    rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel),
    "Path escapes synthetic root",
  );
  return target;
}
function output(relative) {
  return contained(root, path.resolve(root, relative));
}
function put(relative, bytes, fixture = false) {
  const target = output(relative);
  if (fixture)
    assert(
      inputBytes + Buffer.byteLength(bytes) < INPUT_LIMIT,
      "Generated fixture input limit exceeded",
    );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== root) contained(root, parent);
  fs.writeFileSync(target, bytes, { flag: "wx" });
  if (fixture) {
    inputBytes += Buffer.byteLength(bytes);
    fixtures.push({ path: relative, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
  }
}
function readNew(relative, limit = OUTPUT_LIMIT) {
  const target = output(relative);
  const st = fs.lstatSync(target);
  assert(st.isFile() && !st.isSymbolicLink() && st.size <= limit, `Invalid file: ${relative}`);
  contained(root, fs.realpathSync(target));
  return fs.readFileSync(target);
}
function unchanged() {
  assert.equal(hash(fs.readFileSync(analyzer)), SOURCE_SHA256, "Analyzer source changed");
  for (const f of fixtures) {
    const bytes = readNew(f.path);
    assert.equal(bytes.length, f.bytes, `Fixture size changed: ${f.path}`);
    assert.equal(hash(bytes), f.sha256, `Fixture changed: ${f.path}`);
  }
}
function ticks(rep, us, frequency = rep.frequency) {
  const numerator = (BigInt(rep.epochSeconds) * 1000000n + BigInt(us)) * BigInt(frequency);
  assert.equal(numerator % 1000000n, 0n, "Non-integral timestamp");
  const value = Number(numerator / 1000000n);
  assert(Number.isSafeInteger(value), "Unsafe timestamp");
  return value;
}
function kv(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
}
function csv(header, rows) {
  return `${header}\n${rows.map((r) => r.join(",")).join("\n")}\n`;
}
function wave(condition) {
  const start = ((condition.onsetUs - 500000) * 48000) / 1000000;
  assert.equal(start, condition.sampleIndex);
  const wav = Buffer.alloc(44 + 48000 * 8);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(384000, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(384000, 40);
  for (let i = start; i < start + 48; i++) {
    wav.writeFloatLE(0.25, 44 + i * 8);
    wav.writeFloatLE(0.25, 48 + i * 8);
  }
  return wav;
}
function generate(rep, c) {
  const dir = `${rep.id}/${c.name}`;
  const save = (name, bytes) => put(`${dir}/${name}`, bytes, true);
  save(
    "audio/clock.txt",
    kv({
      qpcFrequency: rep.frequency,
      sampleRate: 48000,
      blockAlign: 8,
      startBeforeQpcTicks: ticks(rep, 500000),
      stopAfterQpcTicks: ticks(rep, 1500000),
    }),
  );
  save("visual/clock.txt", kv({ qpcFrequency: rep.frequency }));
  save(
    "visual/start-stop.txt",
    kv({
      startBeforeQpcTicks: ticks(rep, 400000),
      stopBeforeQpcTicks: ticks(rep, 1550000),
      stopAfterQpcTicks: ticks(rep, 1600000),
      ownedStopMarkerAcknowledged: 1,
      hardDeadlineBeforeAck: 0,
    }),
  );
  save("play-qpc.json", JSON.stringify({ before: ticks(rep, 700000), after: ticks(rep, 701000) }));
  save(
    "audio/packets.csv",
    csv("offset,count,flags,device,qpc100ns", [[0, 48000, 0, 0, ticks(rep, 500000, 10000000)]]),
  );
  save(
    "visual/frames.csv",
    csv(
      "index,systemRelative100ns,acquisitionQpc,readbackQpc,width,height,luma,bright",
      spec.frameTimesUs.map((times, i) => [
        i,
        ticks(rep, times[0], 10000000),
        ticks(rep, times[1]),
        ticks(rep, times[2]),
        1,
        1,
        i * 255,
        i,
      ]),
    ),
  );
  save("audio/loopback.wav", wave(c));
}
// Verify serialized shapes and inverse time encodings independently of analyzer code.
function verifyFixture(rep, c) {
  const prefix = `${rep.id}/${c.name}/`;
  const text = (p) => readNew(prefix + p).toString("utf8");
  const parseKv = (p) =>
    Object.fromEntries(
      text(p)
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split("=");
          assert(Number.isSafeInteger(Number(value)));
          return [key, Number(value)];
        }),
    );
  const time = (value, frequency, us) => {
    assert(Number.isSafeInteger(value));
    assert.equal(
      (BigInt(value) * 1000000n) / BigInt(frequency) - BigInt(rep.epochSeconds) * 1000000n,
      BigInt(us),
    );
    assert.equal((BigInt(value) * 1000000n) % BigInt(frequency), 0n);
  };
  const audio = parseKv("audio/clock.txt");
  assert.equal(audio.qpcFrequency, rep.frequency);
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.blockAlign, 8);
  time(audio.startBeforeQpcTicks, rep.frequency, 500000);
  time(audio.stopAfterQpcTicks, rep.frequency, 1500000);
  assert.deepEqual(parseKv("visual/clock.txt"), { qpcFrequency: rep.frequency });
  const stop = parseKv("visual/start-stop.txt");
  time(stop.startBeforeQpcTicks, rep.frequency, 400000);
  time(stop.stopBeforeQpcTicks, rep.frequency, 1550000);
  time(stop.stopAfterQpcTicks, rep.frequency, 1600000);
  assert.equal(stop.ownedStopMarkerAcknowledged, 1);
  assert.equal(stop.hardDeadlineBeforeAck, 0);
  const play = JSON.parse(text("play-qpc.json"));
  time(play.before, rep.frequency, 700000);
  time(play.after, rep.frequency, 701000);
  const rows = (p, header, count, width) => {
    const lines = text(p).trim().split("\n");
    assert.equal(lines.shift(), header);
    assert.equal(lines.length, count);
    return lines.map((line) => {
      const r = line.split(",").map(Number);
      assert.equal(r.length, width);
      assert(r.every(Number.isSafeInteger));
      return r;
    });
  };
  const [packet] = rows("audio/packets.csv", "offset,count,flags,device,qpc100ns", 1, 5);
  assert.deepEqual(packet.slice(0, 4), [0, 48000, 0, 0]);
  time(packet[4], 10000000, 500000);
  const frames = rows(
    "visual/frames.csv",
    "index,systemRelative100ns,acquisitionQpc,readbackQpc,width,height,luma,bright",
    2,
    8,
  );
  for (let i = 0; i < 2; i++) {
    assert.equal(frames[i][0], i);
    assert.deepEqual(frames[i].slice(4), [1, 1, i * 255, i]);
    for (let j = 0; j < 3; j++)
      time(
        frames[i][j + 1],
        j === 0 ? 10000000 : rep.frequency,
        spec.expectedSixRelativeMs[i * 3 + j] * 1000,
      );
  }
  const wav = readNew(prefix + "audio/loopback.wav");
  assert.equal(wav.length, 384044);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 384036);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 3);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 384000);
  assert.equal(wav.readUInt16LE(32), 8);
  assert.equal(wav.readUInt16LE(34), 32);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 384000);
  for (let i = 0; i < 48000; i++)
    for (let ch = 0; ch < 2; ch++) {
      assert.equal(
        wav.readFloatLE(44 + i * 8 + ch * 4),
        i >= c.sampleIndex && i < c.sampleIndex + 48 ? 0.25 : 0,
      );
    }
}
function compare(rep, result) {
  assert(
    result && Array.isArray(result.results) && result.results.length === 3,
    "Malformed result list",
  );
  const check = (field, actual, expected, numeric = false) => {
    if (
      actual === undefined ||
      (numeric && (typeof actual !== "number" || !Number.isFinite(actual)))
    )
      throw Error(`Missing/malformed output: ${rep.id}.${field}`);
    const ok = numeric
      ? Math.abs(actual - expected) <= spec.toleranceMs
      : JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) report.mismatches.push({ representation: rep.id, field, expected, actual });
  };
  check("calibration", result.calibration, "inconclusive");
  check("threshold", result.threshold, 0.005);
  check("soundGroupingSeconds", result.soundGroupingSeconds, 0.1);
  check("onsetUncertaintySeconds", result.onsetUncertaintySeconds, 0.001);
  check("sequenceFrameMs", result.sequenceFrameMs, 1000 / 30);
  check("strictSixSecondBoundMet", result.strictSixSecondBoundMet, true);
  check("protocolFailure", result.protocolFailure, null);
  check("noOffsetSubtraction", result.noOffsetSubtraction, true);
  for (const [i, c] of spec.conditions.entries()) {
    const r = result.results[i];
    assert(r && Array.isArray(r.sounds) && Array.isArray(r.visualOnsets), "Malformed events");
    const eq = (field, actual, expected, numeric = false) =>
      check(`${c.name}.${field}`, actual, expected, numeric);
    eq("name", r.name, c.name);
    eq("classification", r.classification, c.classification);
    eq("soundCount", r.sounds.length, 1);
    eq("visualCount", r.visualOnsets.length, 1);
    for (const field of ["stopHandshakeAndStrictBoundsMet", "audioStoppedBeforeWgcClose"])
      eq(field, r[field], true);
    for (const field of ["inconsistentTimestamps", "initialDiscontinuityAcceptedAsPreplayBoundary"])
      eq(field, r[field], false);
    eq("flags", r.flags, []);
    eq("deviceGaps", r.deviceGaps, []);
    eq("audioDurationMs", r.audioDurationSeconds * 1000, 1000, true);
    eq("visualDurationMs", r.wgcDurationSeconds * 1000, 1200, true);
    assert(
      r.futureSystemRelativeTime && Array.isArray(r.futureSystemRelativeTime.all),
      "Malformed future timestamps",
    );
    eq("futureCount", r.futureSystemRelativeTime.count, 2);
    eq("futureRows", r.futureSystemRelativeTime.all.length, 2);
    for (const [j, f] of r.futureSystemRelativeTime.all.entries()) {
      eq(`future[${j}].index`, f.index, j);
      eq(`future[${j}].ms`, f.futureMs, [8, 4][j], true);
    }
    if (r.sounds.length === 1) {
      eq("sound.sampleIndex", r.sounds[0].sampleIndex, c.sampleIndex);
      eq(
        "sound.onsetRelativeMs",
        (r.sounds[0].onsetSeconds - rep.epochSeconds) * 1000,
        c.onsetUs / 1000,
        true,
      );
      eq("sound.peak", r.sounds[0].peak, 0.25);
    }
    if (r.visualOnsets.length === 1) {
      const v = r.visualOnsets[0];
      assert(
        Array.isArray(v.V) &&
          v.V.length === 2 &&
          Array.isArray(v.sixSeconds) &&
          v.sixSeconds.length === 6,
        "Malformed hull",
      );
      eq("visual.previousIndex", v.previousIndex, 0);
      eq("visual.currentIndex", v.currentIndex, 1);
      v.sixSeconds.forEach((t, j) =>
        eq(
          `sixRelativeMs[${j}]`,
          (t - rep.epochSeconds) * 1000,
          spec.expectedSixRelativeMs[j],
          true,
        ),
      );
      v.V.forEach((t, j) =>
        eq(
          `hullRelativeMs[${j}]`,
          (t - rep.epochSeconds) * 1000,
          spec.expectedHullRelativeMs[j],
          true,
        ),
      );
    }
    if (r.sounds.length === 1 && r.visualOnsets.length === 1) {
      assert(
        Array.isArray(r.audioMinusVisualMs) && r.audioMinusVisualMs.length === 2,
        "Malformed interval",
      );
      r.audioMinusVisualMs.forEach((v, j) => eq(`intervalMs[${j}]`, v, c.intervalMs[j], true));
    }
    report.comparisons.push({
      representation: rep.id,
      condition: c.name,
      expectedMs: c.intervalMs,
      actualMs: r.audioMinusVisualMs,
      classification: r.classification,
      calibration: result.calibration,
    });
  }
}

try {
  assert.equal(
    process.argv.length,
    2,
    "No arguments accepted; existing directories are never inputs",
  );
  assert.equal(
    hash(fs.readFileSync(analyzer)),
    SOURCE_SHA256,
    "Analyzer differs from inspected source",
  );
  root = fs.mkdtempSync(path.join(base, "synthetic-clock-check-"));
  contained(base, fs.realpathSync(root));
  // Keep generated artifacts out of git without editing any existing ignore file.
  put(".gitignore", "*\n");
  for (const rep of spec.representations) for (const c of spec.conditions) generate(rep, c);
  for (const rep of spec.representations) for (const c of spec.conditions) verifyFixture(rep, c);
  for (const c of spec.conditions)
    assert.equal(
      hash(readNew(`A/${c.name}/audio/loopback.wav`)),
      hash(readNew(`B/${c.name}/audio/loopback.wav`)),
    );
  put(
    "manifest.json",
    JSON.stringify(
      {
        ...spec,
        source: { path: analyzer, sha256: SOURCE_SHA256 },
        fixtureInputBytes: inputBytes,
        fixtures,
      },
      null,
      2,
    ),
  );
  assert(
    inputBytes + fs.statSync(output("manifest.json")).size < INPUT_LIMIT,
    "Total generated inputs exceed limit",
  );
  unchanged();
  report.preflight = true;
  console.log(
    "[DONE:2] Synthetic schemas, encodings, hashes and limits verified before either child.",
  );
  for (const rep of spec.representations) {
    unchanged();
    const dir = output(rep.id);
    contained(root, fs.realpathSync(dir));
    assert(!fs.existsSync(path.join(dir, "results.json")), "Output already exists");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawnSync(process.execPath, [analyzer, dir], {
      cwd: dir,
      shell: false,
      timeout: 10000,
      maxBuffer: OUTPUT_LIMIT,
      killSignal: "SIGKILL",
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout ?? Buffer.alloc(0),
      stderr = child.stderr ?? Buffer.alloc(0);
    report.subprocesses.push({
      representation: rep.id,
      status: child.status,
      signal: child.signal,
      error: child.error ? { code: child.error.code, message: child.error.message } : null,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    });
    put(`${rep.id}/stdout.txt`, stdout.subarray(0, OUTPUT_LIMIT));
    put(`${rep.id}/stderr.txt`, stderr.subarray(0, Math.max(0, OUTPUT_LIMIT - stdout.length)));
    assert(
      !child.error && child.status === 0 && !child.signal,
      `Operational child failure: ${rep.id}`,
    );
    assert(stdout.length + stderr.length <= OUTPUT_LIMIT, "Child output limit exceeded");
    unchanged();
    const bytes = readNew(`${rep.id}/results.json`);
    report.subprocesses.at(-1).resultSha256 = hash(bytes);
    compare(rep, JSON.parse(bytes.toString("utf8")));
  }
  unchanged();
  report.verdict = report.mismatches.length ? "fail" : "pass";
} catch (error) {
  report.verdict = "inconclusive";
  report.operationalReason = error.message;
} finally {
  if (root) put("experiment-result.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory: root, ...report }, null, 2));
  process.exitCode = report.verdict === "pass" ? 0 : report.verdict === "fail" ? 1 : 2;
}
