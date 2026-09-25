// Shared deterministic sequence construction; caller supplies two actually imported asset IDs.
export const fixtureId = (n) => `91000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function workload(kind, rate, assetIds) {
  if (!["small", "timeline-1000", "two-layer", "export-reference"].includes(kind))
    throw new Error("Unknown workload");
  if (!(
    (rate.numerator === 30 && rate.denominator === 1) ||
    (rate.numerator === 30000 && rate.denominator === 1001)
  ))
    throw new Error("Unsupported fixture cadence");
  if (
    assetIds.length !== 2 ||
    new Set(assetIds).size !== 2 ||
    assetIds.some(
      (id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
    )
  )
    throw new Error("Two distinct imported UUIDs required");
  const time = (value) => ({
    value,
    rateNumerator: rate.numerator,
    rateDenominator: rate.denominator,
  });
  const transform = {
    positionXPermille: 0,
    positionYPermille: 0,
    scaleXPermille: 1000,
    scaleYPermille: 1000,
    rotationMilliDegrees: 0,
    opacityPermille: 1000,
  };
  const clip = (n, start, frames, source = n % 2) => ({
    id: fixtureId(1000 + n),
    source: { kind: "asset", assetId: assetIds[source] },
    timelineStart: time(start),
    sourceIn: time(0),
    sourceOut: time(frames),
    transform: { ...transform },
    gainMilliDecibels: 0,
  });
  const tracks = [];
  const edges = [];
  if (kind === "timeline-1000") {
    // Exactly 1000 sequential items, 334 video + 333 audio + 333 captions; 15-frame gaps.
    const video = [],
      audio = [],
      captions = [];
    for (let n = 0; n < 1000; n++) {
      const start = n * 45;
      edges.push(start, start + 30);
      if (n % 3 === 0) video.push(clip(n, start, 30));
      else if (n % 3 === 1) audio.push(clip(n, start, 30));
      else
        captions.push({
          id: fixtureId(1000 + n),
          start: time(start),
          end: time(start + 30),
          text: `Synthetic caption ${n}`,
        });
    }
    tracks.push(
      { id: fixtureId(10), name: "Video", kind: "video", clips: video },
      { id: fixtureId(11), name: "Audio", kind: "audio", clips: audio },
      { id: fixtureId(12), name: "Captions", kind: "caption", captions },
    );
  } else if (kind === "export-reference") {
    // Separately authorized supported export reference; original multi-clip failures remain.
    tracks.push({
      id: fixtureId(10),
      name: "Export reference",
      kind: "video",
      clips: [clip(0, 0, 2415, 0)],
    });
    edges.push(0, 2415);
  } else {
    // 80+ seconds at either cadence; bounded source segments reuse 40-second fixtures.
    const clips = [clip(0, 0, 900, 0), clip(1, 915, 900, 1), clip(2, 1815, 600, 0)];
    edges.push(0, 900, 915, 1815, 2415);
    tracks.push({ id: fixtureId(10), name: "Reference video", kind: "video", clips });
    if (kind === "two-layer") {
      tracks.push({
        id: fixtureId(11),
        name: "Second visible muted layer",
        kind: "video",
        muted: true,
        clips: [clip(3, 0, 900, 1), clip(4, 900, 900, 0), clip(5, 1800, 615, 1)].map((c) => ({
          ...c,
          transform: { ...transform, scaleXPermille: 500, scaleYPermille: 500 },
        })),
      });
      tracks.push({
        id: fixtureId(12),
        name: "Hidden muted layer",
        kind: "video",
        hidden: true,
        muted: true,
        clips: [clip(6, 0, 900, 0)],
      });
    }
  }
  return {
    schemaVersion: 1,
    kind,
    sequence: {
      id: fixtureId(1),
      name: `P2 ${kind}`,
      rate,
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks,
      markers: [],
    },
    durationFrames: kind === "timeline-1000" ? 44985 : 2415,
    edges,
  };
}
