// Pure, browser-compatible evidence accounting. Missing measurements stay null.
export function distribution(values) {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
export function sampleBuffer(cap = 20000) {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100000)
    throw new RangeError("Invalid sample cap");
  const values = [];
  let omitted = 0;
  return {
    push(value) {
      if (values.length < cap) values.push(value);
      else omitted++;
    },
    snapshot() {
      return { values: globalThis.structuredClone(values), omitted };
    },
    clear() {
      values.length = 0;
      omitted = 0;
    },
  };
}
export function counterDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < before)
    return null;
  return after - before;
}
export function seekSummary(samples) {
  return {
    requested: samples.length,
    // Already-displayed frame: correct outcome without a presentation-latency observation.
    sameFrameNoNewFrame: samples.filter((s) => s.status === "same-frame-no-new-frame").length,
    failures: samples.filter((s) => s.status !== "ok" && s.status !== "same-frame-no-new-frame")
      .length,
    seekedMs: distribution(samples.map((s) => s.seekedMs)),
    presentedMs: distribution(samples.map((s) => s.presentedMs)),
    samples,
  };
}
export function slope(samples, key) {
  const valid = samples.filter((s) => Number.isFinite(s.seconds) && Number.isFinite(s[key]));
  if (valid.length < 2) return null;
  const x = valid.reduce((sum, s) => sum + s.seconds, 0) / valid.length;
  const y = valid.reduce((sum, s) => sum + s[key], 0) / valid.length;
  const denominator = valid.reduce((sum, s) => sum + (s.seconds - x) ** 2, 0);
  return denominator === 0
    ? null
    : valid.reduce((sum, s) => sum + (s.seconds - x) * (s[key] - y), 0) / denominator;
}
export function seededSeeks(seed, durationFrames, edges = [], count = 100) {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 || count !== 100)
    throw new RangeError("Expected positive duration and 100 seeks");
  let state = seed >>> 0;
  const boundaries = edges
    .flatMap((f) => [f - 1, f, f + 1])
    .filter((f) => Number.isSafeInteger(f) && f >= 0 && f < durationFrames);
  return Array.from({ length: count }, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return i % 2 === 0 && boundaries.length
      ? boundaries[Math.floor((state / 4294967296) * boundaries.length)]
      : Math.floor((state / 4294967296) * durationFrames);
  });
}
// Frames decoded during the measured window, summed over video elements present at its end.
// Elements created inside the window count from zero; removed elements are not counted.
export function assertPlaybackAdvanced(videoFramesAdvanced, elapsedSeconds) {
  if (!(Number.isFinite(videoFramesAdvanced) && videoFramesAdvanced > 0))
    throw new Error(
      `Playback stalled: totalVideoFrames did not advance during the ${elapsedSeconds}-s window`,
    );
}
// Visible-layer decoder drop attribution over one observer snapshot. Each element/segment's
// observations (state changes, frames, endpoint) are ordered as recorded; the counter delta
// between two consecutive observations belongs to the earlier observation's state. Deltas that
// go backwards (a counter reset) or lack a state are reported as unattributed, never visible.
// CSS-visible layers fully covered by an opaque video above them (`occluded`) are counted in a
// separate bucket; snapshots recorded before occlusion probing report `occlusionAvailable:false`.
export const VISIBLE_DROP_TARGET = 0.01;
export function visibleDropAttribution(snapshot) {
  const bucket = () => ({ total: 0, dropped: 0 });
  const result = {
    attributionAvailable: false,
    occlusionAvailable: false,
    visible: bucket(),
    occluded: bucket(),
    hidden: bucket(),
    unattributed: { intervals: 0 },
    byClip: {},
  };
  const streams = new Map();
  const add = (id, segment, observation) => {
    const key = `${id}:${segment}`;
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(observation);
  };
  for (const event of snapshot?.events ?? []) {
    if (event.type === "visibility" || event.type === "frame") {
      if (event.attribution) result.attributionAvailable = true;
      if (typeof event.attribution?.occluded === "boolean") result.occlusionAvailable = true;
      add(event.id, event.segment, { quality: event.quality, state: event.attribution ?? null });
    } else if (event.type === "decoder-segment") {
      add(event.id, event.segment, { quality: event.final, state: null });
    }
  }
  for (const video of snapshot?.videos ?? [])
    add(video.id, video.segment, { quality: video.final, state: null });
  const clip = (id) =>
    (result.byClip[id ?? "(none)"] ??= { visible: bucket(), occluded: bucket(), hidden: bucket() });
  for (const observations of streams.values()) {
    for (let i = 1; i < observations.length; i++) {
      const from = observations[i - 1],
        to = observations[i];
      const total = counterDelta(from.quality?.total, to.quality?.total);
      const dropped = counterDelta(from.quality?.dropped, to.quality?.dropped);
      if (from.state === null || total === null || dropped === null) {
        result.unattributed.intervals++;
        continue;
      }
      const side =
        from.state.visible !== true
          ? "hidden"
          : from.state.occluded === true
            ? "occluded"
            : "visible";
      result[side].total += total;
      result[side].dropped += dropped;
      clip(from.state.clipId)[side].total += total;
      clip(from.state.clipId)[side].dropped += dropped;
    }
  }
  result.byClip = Object.fromEntries(
    Object.entries(result.byClip).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const rate = (b) => (b.total > 0 ? b.dropped / b.total : null);
  result.visibleDropRate = rate(result.visible);
  result.occludedDropRate = rate(result.occluded);
  result.hiddenDropRate = rate(result.hidden);
  result.meetsVisibleTarget =
    result.visibleDropRate === null ? null : result.visibleDropRate <= VISIBLE_DROP_TARGET;
  return result;
}
// Presentation cross-check for visibleDropAttribution: frame callbacks each clip presented while
// visible, and the longest gap between them. Decoder counters attribute by the state at decode
// time; this shows what the visible layer actually presented.
export function visiblePresentation(snapshot) {
  const byClip = {};
  for (const event of snapshot?.events ?? []) {
    if (
      event.type !== "frame" ||
      event.attribution?.visible !== true ||
      event.attribution.occluded === true
    )
      continue;
    (byClip[event.attribution.clipId ?? "(none)"] ??= []).push(event);
  }
  const clips = Object.entries(byClip)
    .map(([clipId, frames]) => {
      frames.sort((a, b) => a.at - b.at);
      const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at);
      return {
        clipId,
        frames: frames.length,
        firstAt: frames[0].at,
        maxGapMs: gaps.length ? Math.max(...gaps) : null,
      };
    })
    .sort((a, b) => a.firstAt - b.firstAt);
  return { clips, visibleFrames: clips.reduce((sum, c) => sum + c.frames, 0) };
}
// Zero in-window commits is a valid result (p95 unavailable), but only when the profiler is
// proven live by commits recorded for the same component before the window started.
export function playbackCommitSummary({ ids, preWindowCounts, windowSamples, elapsedSeconds }) {
  return ids.map((id) => {
    const preWindowCount = preWindowCounts?.[id] ?? 0;
    if (!(preWindowCount > 0))
      throw new Error(`Profiler not live: no ${id} commits recorded before the window`);
    const items = windowSamples.filter((s) => s.id === id);
    return {
      id,
      preWindowCount,
      count: items.length,
      commitsPerSecond: items.length / elapsedSeconds,
      durationMs: distribution(items.map((s) => s.actualDuration)),
    };
  });
}
