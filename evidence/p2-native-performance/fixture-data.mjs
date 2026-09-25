import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  videoProjectStateV2Schema,
  projectProjectionSchema,
} from "../../packages/video-contracts/dist/index.js";
import { workload, fixtureId } from "./workloads.mjs";
export function fixtureData(receiptPath, kind, rateText) {
  const root = realpathSync(fileURLToPath(new URL("./runs/", import.meta.url)));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.status !== "passed") throw new Error("Generated media prerequisite not passed");
  const [numerator, denominator] = rateText.split("/").map(Number),
    rate = { numerator, denominator };
  const media = receipt.generated
    .filter((m) => m.rate === rateText)
    .sort((a, b) => a.variant - b.variant);
  if (media.length !== 2) throw new Error("Two pinned sources required");
  const assets = media.map((m, i) => {
    const relative = path.relative(root, realpathSync(m.output));
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Media escaped disposable root");
    const bytes = readFileSync(m.output);
    if (bytes.length !== m.bytes || createHash("sha256").update(bytes).digest("hex") !== m.sha256)
      throw new Error("Source fixture identity mismatch");
    return {
      id: fixtureId(101 + i),
      displayName: `P2 source ${i}`,
      locator: { absolutePath: m.output },
      contentIdentity: {
        schemaVersion: 1,
        algorithm: "sha256",
        digest: m.sha256,
        byteLength: m.bytes,
      },
      probe: {
        durationMicroseconds: Math.round(Number(m.probe.format.duration) * 1000000),
        averageFrameRate: rate,
        realFrameRate: rate,
        variableFrameRate: false,
        width: 1920,
        height: 1080,
        videoCodecName: "h264",
        audio: { codecName: "aac", channels: 1, sampleRate: 48000 },
        fileSizeBytes: m.bytes,
      },
    };
  });
  const input = workload(
    kind,
    rate,
    assets.map((a) => a.id),
  );
  const state = videoProjectStateV2Schema.parse({
    assets,
    sequences: [input.sequence],
    activeSequenceId: input.sequence.id,
  });
  for (const track of input.sequence.tracks)
    for (const clip of track.clips ?? []) {
      const asset = assets.find((a) => a.id === clip.source.assetId);
      const endSeconds =
        (clip.sourceOut.value * clip.sourceOut.rateDenominator) / clip.sourceOut.rateNumerator;
      if (!asset || endSeconds > asset.probe.durationMicroseconds / 1000000)
        throw new Error("Fixture source is too short for clip");
    }
  const projection = projectProjectionSchema.parse({
    projectId: fixtureId(9000),
    name: `P2 ${kind}`,
    revision: {
      id: fixtureId(9002),
      parentId: null,
      committedAt: "2026-09-19T00:00:00.000Z",
      number: 0,
      stateHash: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
      operationId: fixtureId(9001),
    },
    state,
    canUndo: false,
    canRedo: false,
    lastCommand: null,
    sources: assets.map((a) => ({
      assetId: a.id,
      status: "resolved",
      resolvedPath: a.locator.absolutePath,
    })),
    journalHealth: "healthy",
    snapshotRevision: 0,
    recoveryStatus: "clean",
    replayedRecordCount: 0,
  });
  return {
    ...input,
    projection,
    media,
    fixtureSha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
  };
}
