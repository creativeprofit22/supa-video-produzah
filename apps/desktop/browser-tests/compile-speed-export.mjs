// Native actual-media regression: stdout is only the production compiler's JSON.
// Requires the workspace contracts/render dist builds; no test argv reconstruction.
import process from "node:process";
import console from "node:console";
import { compileActiveSequenceRenderPlan } from "../../../packages/video-render/dist/index.js";
const [inputPath, outputPath, rn, rd, sn, sd, gain = "0", fadeIn = "0", fadeOut = "0"] =
  process.argv.slice(2);
const rate = { numerator: Number(rn), denominator: Number(rd) };
const speed = { numerator: Number(sn), denominator: Number(sd) };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (value) => ({
  value,
  rateNumerator: rate.numerator,
  rateDenominator: rate.denominator,
});
const asset = {
  id: id(2),
  displayName: "speed parity barcode",
  locator: { absolutePath: inputPath },
  probe: {
    durationMicroseconds: 6000000,
    averageFrameRate: rate,
    realFrameRate: rate,
    variableFrameRate: false,
    width: 320,
    height: 180,
    videoCodecName: "h264",
    audio: { codecName: "aac", channels: 1, sampleRate: 48000 },
    fileSizeBytes: 1000000,
  },
};
const revision = {
  revision: {
    number: 0,
    id: id(1),
    parentId: null,
    committedAt: "2026-09-14T00:00:00.000Z",
    operationId: id(7),
    stateHash: "a".repeat(64),
  },
  state: {
    assets: [asset],
    activeSequenceId: id(3),
    sequences: [
      {
        id: id(3),
        name: "Parity",
        rate,
        width: 320,
        height: 180,
        audioSampleRate: 48000,
        markers: [],
        tracks: [
          {
            id: id(4),
            name: "Video",
            kind: "video",
            clips: [
              {
                id: id(5),
                source: { kind: "asset", assetId: id(2) },
                timelineStart: time(0),
                sourceIn: time(30),
                sourceOut: time(30 + (60 * speed.numerator) / speed.denominator),
                speed,
                transform: {
                  positionXPermille: 0,
                  positionYPermille: 0,
                  scaleXPermille: 1000,
                  scaleYPermille: 1000,
                  rotationMilliDegrees: 0,
                  opacityPermille: 1000,
                },
                gainMilliDecibels: Number(gain),
                ...(Number(fadeIn) !== 0 || Number(fadeOut) !== 0
                  ? { fades: { inFrames: Number(fadeIn), outFrames: Number(fadeOut) } }
                  : {}),
              },
            ],
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
      inputPathsByAssetId: { [id(2)]: inputPath },
      outputPath,
    }),
  ),
);
