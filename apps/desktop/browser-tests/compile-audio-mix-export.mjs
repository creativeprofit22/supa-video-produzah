// Native actual-media regression for the role-based mix and loudness target.
// stdout is only the production compiler's JSON (packages/video-render dist).
import process from "node:process";
import console from "node:console";
import { compileActiveSequenceRenderPlan } from "../../../packages/video-render/dist/index.js";

const [speechPath, musicPath, outputPath, lufs, ducking, cleanup, seconds] = process.argv.slice(2);
const rate = { numerator: 30, denominator: 1 };
const frames = Number(seconds) * 30;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (value) => ({ value, rateNumerator: 30, rateDenominator: 1 });
const asset = (assetId, path, name) => ({
  id: assetId,
  displayName: name,
  locator: { absolutePath: path },
  probe: {
    durationMicroseconds: Number(seconds) * 1_000_000,
    averageFrameRate: rate,
    realFrameRate: rate,
    variableFrameRate: false,
    width: 320,
    height: 180,
    videoCodecName: "h264",
    audio: { codecName: "aac", channels: 1, sampleRate: 48000 },
    fileSizeBytes: 1000000,
  },
});
const clip = (clipId, assetId) => ({
  id: clipId,
  source: { kind: "asset", assetId },
  timelineStart: time(0),
  sourceIn: time(0),
  sourceOut: time(frames),
  transform: {
    positionXPermille: 0,
    positionYPermille: 0,
    scaleXPermille: 1000,
    scaleYPermille: 1000,
    rotationMilliDegrees: 0,
    opacityPermille: 1000,
  },
  gainMilliDecibels: 0,
});
const revision = {
  revision: {
    number: 0,
    id: id(1),
    parentId: null,
    committedAt: "2026-09-28T00:00:00.000Z",
    operationId: id(7),
    stateHash: "a".repeat(64),
  },
  state: {
    assets: [asset(id(2), speechPath, "speech"), asset(id(12), musicPath, "music")],
    activeSequenceId: id(3),
    sequences: [
      {
        id: id(3),
        name: "Mix",
        rate,
        width: 320,
        height: 180,
        audioSampleRate: 48000,
        markers: [],
        ...(lufs === "none"
          ? {}
          : {
              loudnessTarget: {
                integratedLufs: Number(lufs),
                truePeakCeilingDbtp: -1,
                ducking: ducking === "1",
                dialogueCleanup: cleanup === "1",
              },
            }),
        tracks: [
          {
            id: id(4),
            name: "Dialogue",
            kind: "video",
            audioRole: "dialogue",
            clips: [clip(id(5), id(2))],
          },
          {
            id: id(14),
            name: "Music",
            kind: "video",
            audioRole: "music",
            clips: [clip(id(15), id(12))],
          },
        ],
      },
    ],
  },
};
console.log(
  JSON.stringify(
    compileActiveSequenceRenderPlan({
      planId: id(6),
      revision,
      inputPathsByAssetId: { [id(2)]: speechPath, [id(12)]: musicPath },
      outputPath,
    }),
  ),
);
