import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const walk = (s, out=[]) => { for (const x of s.suites ?? []) walk(x, out); for (const sp of s.specs ?? []) for (const t of sp.tests) for (const res of t.results) out.push({title: sp.title, status: res.status, att: res.attachments}); return out; };
for (const t of walk(r)) for (const a of t.att) if (a.body && a.name.endsWith(".json")) {
  const m = JSON.parse(Buffer.from(a.body, "base64").toString());
  const k = m.knownTime;
  console.log(t.status.padEnd(7), t.title.padEnd(55), "video", k?.videoErrorFrames?.toFixed(3), "audio", k?.audioErrorFrames?.toFixed(3), "diff", k?.differenceFrames?.toFixed(3), "absFrames", (m.avFrames ?? (m.deltaMs!=null? Math.abs(m.deltaMs)/1000*30 : null))?.toFixed?.(3), "anchors", m.anchors?.length, "outLat", m.outputLatency);
}
