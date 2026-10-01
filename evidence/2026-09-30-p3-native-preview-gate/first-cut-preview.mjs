// P3 native preview gate: first-cut-shaped playback and seek check.
// Applies the committed explainer first-cut command group (the output of
// `packages/video-produce` fixtures, see ../2026-09-30-p3-first-cut/) to a fresh
// native project through the real `video_execute_project_group` path, reopens it,
// then measures Preview playback (visible-layer drop attribution, React commits) and
// 100 seeded seeks with the existing P2 harness (measure-page.mjs / metrics.mjs).
//
// The fixture's assets are synthetic metadata, so each first-cut clip is bound to
// one of the two pinned 30/1 P2 sources (alternating by clip order). Clip timing,
// caption track, markers, command IDs and track IDs are kept verbatim.
//
// The first cut (834 frames, 27.8 s) is shorter than the harness's 5 s warm-up plus 60 s
// window, so the clip and caption layout is repeated back to back (copy k offset by
// k × first-cut length, copy 0 verbatim, later copies get derived IDs) until the timeline
// covers ≥ 66 s. Playback is then continuous for the whole measured window. Seeks stay on
// the first copy, so they are the same 100 seeded frames as over the single first cut.
//
// Usage (repo root; the release must be built by assemble-release.mjs):
//   node evidence/2026-09-30-p3-native-preview-gate/first-cut-preview.mjs \
//     <native-profile|native-uninstrumented> <release.json> <launcher receipt> <media receipt>
// Raw artifacts go to evidence/p2-native-performance/runs/p3-first-cut-<target>-*/
// (git-ignored); a summary is written next to this script.
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import {
  commandGroupRequestSchema,
  commandResultSchema,
  projectProjectionSchema,
  mediaProbeSchema,
} from "../../packages/video-contracts/dist/index.js";
import { preparedVideoAssetSchema } from "../../packages/video-media/dist/index.js";
import { nativeSession } from "../p2-native-performance/native-session.mjs";
import { fixtureData } from "../p2-native-performance/fixture-data.mjs";
import { invokeNative, pickNative, submitOwnedPicker } from "../p2-native-performance/native-picker.mjs";
import { playbackSamples, seekSamples } from "../p2-native-performance/measure-page.mjs";
import { VISIBLE_DROP_TARGET } from "../p2-native-performance/metrics.mjs";

const [target, releasePath, launcherReceipt, mediaReceipt] = process.argv.slice(2);
if (!["native-profile", "native-uninstrumented"].includes(target))
  throw new Error("Explicit native measurement target required");
const here = fileURLToPath(new URL("./", import.meta.url));
const harness = fileURLToPath(new URL("../p2-native-performance/", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const release = JSON.parse(readFileSync(releasePath, "utf8"));
assert.equal(release.status, "passed");
assert.equal(release.mode, target);

const proposalPath = path.join(here, "../2026-09-30-p3-first-cut/explainer-proposal.json");
const fixturePath = path.join(here, "../../packages/video-produce/fixtures/v1/explainer.json");
const proposalBytes = readFileSync(proposalPath);
const firstCut = JSON.parse(proposalBytes.toString("utf8")).compiled;
const explainer = JSON.parse(readFileSync(fixturePath, "utf8"));
const baseSequence = explainer.state.sequences.find((s) => s.id === explainer.state.activeSequenceId);
assert.ok(baseSequence && baseSequence.tracks.length === 0, "explainer applies onto an empty sequence");

// Two pinned 30/1 sources, already verified against the media receipt by fixtureData.
const pinned = fixtureData(mediaReceipt, "two-layer", "30/1").projection.state.assets;
const remap = new Map();
for (const command of firstCut.request.commands)
  for (const clip of command.track?.clips ?? [])
    if (!remap.has(clip.source.assetId)) remap.set(clip.source.assetId, pinned[remap.size % 2].id);

const rate = baseSequence.rate.numerator / baseSequence.rate.denominator;
const cutFrames = Math.max(
  ...firstCut.request.commands.flatMap((command) => [
    ...(command.track?.clips ?? []).map(
      (c) => c.timelineStart.value + c.sourceOut.value - c.sourceIn.value,
    ),
    ...(command.track?.captions ?? []).map((c) => c.end.value),
  ]),
);
// Warm-up (5 s) + measured window (60 s) + 1 s margin for play start and snapshot.
const minimumFrames = Math.ceil(66 * rate);
const copies = Math.ceil(minimumFrames / cutFrames);

// Deterministic RFC 4122 v4-shaped ID for copy k of an item (copy 0 keeps its own ID).
function copyId(id, copy) {
  if (copy === 0) return id;
  const h = createHash("sha256").update(`${id}#${copy}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const shift = (time, by) => ({ ...time, value: time.value + by });
const repeat = (items, copyItem) =>
  Array.from({ length: copies }, (_, copy) => items.map((item) => copyItem(item, copy))).flat();

function applyRequest(projectId, baseRevision) {
  const commands = firstCut.request.commands.map((command) => {
    if (!command.track) return command;
    const { clips, captions } = command.track;
    return {
      ...command,
      track: {
        ...command.track,
        ...(clips
          ? {
              clips: repeat(clips, (clip, copy) => ({
                ...clip,
                id: copyId(clip.id, copy),
                timelineStart: shift(clip.timelineStart, copy * cutFrames),
                source: { ...clip.source, assetId: remap.get(clip.source.assetId) },
              })),
            }
          : {}),
        ...(captions
          ? {
              captions: repeat(captions, (caption, copy) => ({
                ...caption,
                id: copyId(caption.id, copy),
                start: shift(caption.start, copy * cutFrames),
                end: shift(caption.end, copy * cutFrames),
              })),
            }
          : {}),
      },
    };
  });
  return commandGroupRequestSchema.parse({ projectId, baseRevision, groupId: randomUUID(), commands });
}

async function createFirstCutProject(session) {
  const directory = path.join(session.run, "first-cut-explainer");
  mkdirSync(directory);
  const file = path.join(directory, "project.svpvideo");
  await pickNative(session, "video_pick_new_project_path", { defaultName: "P3 first cut.svpvideo" }, file);
  const created = projectProjectionSchema.parse(
    await invokeNative(session.page, "video_create_project", { path: file, name: "P3 first cut" }),
  );
  const assets = [];
  for (const asset of pinned) {
    await pickNative(session, "video_pick_source", {}, asset.locator.absolutePath);
    const probe = mediaProbeSchema.parse(
      await invokeNative(session.page, "video_probe_media", { path: asset.locator.absolutePath }),
    );
    assets.push({ ...asset, probe });
  }
  const setup = commandResultSchema.parse(
    await invokeNative(session.page, "video_execute_project_group", {
      request: commandGroupRequestSchema.parse({
        projectId: created.projectId,
        baseRevision: created.revision.number,
        groupId: randomUUID(),
        commands: [
          ...assets.map((asset) => ({ type: "ImportAsset", commandId: randomUUID(), asset })),
          {
            type: "CreateSequence",
            commandId: randomUUID(),
            sequence: baseSequence,
            activeSequenceId: baseSequence.id,
          },
        ],
      }),
    }),
  );
  // The first-cut apply itself: the compiled group, committed as one undoable group.
  const applied = commandResultSchema.parse(
    await invokeNative(session.page, "video_execute_project_group", {
      request: applyRequest(created.projectId, setup.projection.revision.number),
    }),
  );
  const preparation = [];
  for (const asset of assets) {
    const started = Date.now();
    preparedVideoAssetSchema.parse(
      await invokeNative(session.page, "video_prepare_asset", {
        projectId: created.projectId,
        assetId: asset.id,
        path: asset.locator.absolutePath,
        sequenceRate: baseSequence.rate,
      }),
    );
    preparation.push({ assetId: asset.id, elapsedMs: Date.now() - started });
  }
  await invokeNative(session.page, "video_close_project", { projectId: created.projectId });
  await session.page.getByRole("button", { name: "Open project", exact: true }).click();
  submitOwnedPicker(session, file);
  await session.page.locator(".transport-play").waitFor({ state: "visible", timeout: 30000 });
  await session.page.waitForFunction(
    () => globalThis.__p2SeekTo && !globalThis.document.querySelector(".transport-play")?.disabled,
    undefined,
    { timeout: 30000 },
  );
  return { file, projection: applied.projection, preparation };
}

// Seek fixture derived from the applied (not the requested) sequence.
function seekFixture(projection) {
  const sequence = projection.state.sequences.find((s) => s.id === baseSequence.id);
  const edges = [];
  let durationFrames = 0;
  for (const track of sequence.tracks) {
    for (const clip of track.clips ?? []) {
      const end = clip.timelineStart.value + clip.sourceOut.value - clip.sourceIn.value;
      edges.push(clip.timelineStart.value, end);
      durationFrames = Math.max(durationFrames, end);
    }
    for (const caption of track.captions ?? []) durationFrames = Math.max(durationFrames, caption.end.value);
  }
  return { sequence, durationFrames, edges: [...new Set(edges)].sort((a, b) => a - b) };
}

const directory = mkdtempSync(path.join(harness, "runs", `p3-first-cut-${target}-`));
const summary = {
  utc: new Date().toISOString(),
  target,
  releaseSha256: sha(readFileSync(releasePath)),
  executableSha256: release.executableSha256,
  mediaReceiptSha256: sha(readFileSync(mediaReceipt)),
  firstCutProposalSha256: sha(proposalBytes),
  visibleDropTarget: VISIBLE_DROP_TARGET,
  rawArtifacts: path.relative(path.join(here, "../.."), directory).replaceAll("\\", "/"),
  status: "running",
};
let session;
try {
  session = await nativeSession({
    launcherReceipt,
    executable: release.executable,
    executableSha256: release.executableSha256,
    leaseMs: 1800000,
  });
  summary.webviewVersion = session.page.context().browser().version();
  const project = await createFirstCutProject(session);
  const fixture = seekFixture(project.projection);
  assert.equal(fixture.durationFrames, copies * cutFrames);
  // Seeks over the first copy only: the verbatim first cut.
  const seekFixtureFirstCopy = {
    ...fixture,
    durationFrames: cutFrames,
    edges: fixture.edges.filter((edge) => edge <= cutFrames),
  };
  summary.timeline = {
    firstCutFrames: cutFrames,
    repeatCount: copies,
    durationFrames: fixture.durationFrames,
    durationSeconds: fixture.durationFrames / rate,
    seekWindowFrames: seekFixtureFirstCopy.durationFrames,
    tracks: fixture.sequence.tracks.map((t) => ({
      kind: t.kind,
      name: t.name,
      items: (t.clips ?? t.captions ?? []).length,
    })),
    markers: fixture.sequence.markers.length,
    assetBinding: Object.fromEntries([...remap].sort(([a], [b]) => a.localeCompare(b))),
    preparation: project.preparation,
  };
  await session.page.setViewportSize({ width: 1280, height: 720 });
  const mute = session.page.getByRole("button", { name: "Mute audio", exact: true });
  if (await mute.count()) await mute.click();
  const playback = await playbackSamples(session.page, directory, "first-cut-Preview", {
    profiling: target === "native-profile",
  });
  summary.playback = playback.map((s) => ({
    repeat: s.repeat,
    elapsedSeconds: s.elapsedSeconds,
    stillPlayingAtEnd: s.stillPlayingAtEnd,
    videoFramesAdvanced: s.videoFramesAdvanced,
    visibleDrops: s.visibleDrops,
    commits: s.commits,
    longTaskDurationMs: s.longTaskDurationMs,
    frameGapMs: s.frameGapMs,
  }));
  if (!summary.playback.every((s) => s.stillPlayingAtEnd))
    throw new Error("Playback stopped inside the measured window");
  const seeks = await seekSamples(
    session.page,
    directory,
    "first-cut-Preview",
    seekFixtureFirstCopy,
    "Preview",
  );
  summary.seeks = seeks;
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.error = String(error);
  process.exitCode = 1;
} finally {
  if (session) summary.cleanup = await session.close();
  const out = path.join(here, `first-cut-${target}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ out, status: summary.status, error: summary.error }));
}
