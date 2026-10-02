// Synthetic inputs only; native test grants the paths and validates this compiler output.
// Two video tracks: the graphics overlay clip (top, no audio) over a base clip (bottom).
import { compileActiveSequenceRenderPlan } from "../../../packages/video-render/dist/index.js";
import process from "node:process";
import console from "node:console";

const [basePath, overlayPath, outputPath, widthArg, heightArg, framesArg] = process.argv.slice(2);
const width = Number(widthArg);
const height = Number(heightArg);
const frames = Number(framesArg);
if (![width, height, frames].every((value) => Number.isInteger(value) && value > 0))
  throw new Error("width, height and frames must be positive integers");
const id = (n) => `73000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rate = { numerator: 30, denominator: 1 };
const time = (value) => ({ value, rateNumerator: 30, rateDenominator: 1 });
const durationMicroseconds = Math.round((frames / 30) * 1_000_000);
const asset = (index, path, displayName, videoCodecName, audio) => ({
  id: id(index + 10),
  displayName,
  locator: { absolutePath: path },
  probe: {
    durationMicroseconds,
    averageFrameRate: rate,
    realFrameRate: rate,
    variableFrameRate: false,
    width,
    height,
    videoCodecName,
    audio,
    fileSizeBytes: 1000000,
  },
});
const assets = [
  asset(0, overlayPath, "graphics overlay", "qtrle", null),
  asset(1, basePath, "base", "h264", { codecName: "aac", channels: 1, sampleRate: 48000 }),
];
const revision = {
  revision: {
    number: 0,
    id: id(1),
    parentId: null,
    committedAt: "2026-10-02T00:00:00.000Z",
    operationId: id(2),
    stateHash: "a".repeat(64),
  },
  state: {
    assets,
    activeSequenceId: id(3),
    sequences: [
      {
        id: id(3),
        name: "Graphics over base",
        rate,
        width,
        height,
        audioSampleRate: 48000,
        markers: [],
        tracks: assets.map((item, index) => ({
          id: id(20 + index),
          name: item.displayName,
          kind: "video",
          hidden: false,
          muted: false,
          clips: [
            {
              id: id(30 + index),
              source: { kind: "asset", assetId: item.id },
              timelineStart: time(0),
              sourceIn: time(0),
              sourceOut: time(frames),
              speed: { numerator: 1, denominator: 1 },
              transform: {
                positionXPermille: 0,
                positionYPermille: 0,
                scaleXPermille: 1000,
                scaleYPermille: 1000,
                rotationMilliDegrees: 0,
                opacityPermille: 1000,
              },
              gainMilliDecibels: 0,
            },
          ],
        })),
      },
    ],
  },
};
console.log(
  JSON.stringify(
    compileActiveSequenceRenderPlan({
      planId: id(4),
      revision,
      inputPathsByAssetId: { [assets[0].id]: overlayPath, [assets[1].id]: basePath },
      outputPath,
    }),
  ),
);
