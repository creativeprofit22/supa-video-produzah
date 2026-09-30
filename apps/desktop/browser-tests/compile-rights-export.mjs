// Native end-to-end regression for rights-gated export. stdout is only the
// production compiler's JSON (packages/video-render dist). The acquired asset
// carries its receipt as `origin`, exactly as the app imports it.
import process from "node:process";
import console from "node:console";
import { compileActiveSequenceRenderPlan } from "../../../packages/video-render/dist/index.js";

const [sourcePath, outputPath, receiptId, intendedUse, stripOrigin] = process.argv.slice(2);
const rate = { numerator: 25, denominator: 1 };
const frames = 50;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (value) => ({ value, rateNumerator: 25, rateDenominator: 1 });
const revision = {
  revision: {
    number: 0,
    id: id(1),
    parentId: null,
    committedAt: "2026-09-29T00:00:00.000Z",
    operationId: id(7),
    stateHash: "a".repeat(64),
  },
  state: {
    assets: [
      {
        id: id(2),
        displayName: "Clip",
        locator: { absolutePath: sourcePath },
        probe: {
          durationMicroseconds: 2_000_000,
          averageFrameRate: rate,
          realFrameRate: rate,
          variableFrameRate: false,
          width: 320,
          height: 180,
          videoCodecName: "vp9",
          audio: null,
          fileSizeBytes: 1000,
        },
        ...(stripOrigin === "1"
          ? {}
          : { origin: { kind: "acquired", acquisitionReceiptId: receiptId } }),
      },
    ],
    activeSequenceId: id(3),
    sequences: [
      {
        id: id(3),
        name: "Rights",
        rate,
        width: 320,
        height: 180,
        audioSampleRate: 48000,
        markers: [],
        tracks: [
          {
            id: id(4),
            name: "V1",
            kind: "video",
            clips: [
              {
                id: id(5),
                source: { kind: "asset", assetId: id(2) },
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
      inputPathsByAssetId: { [id(2)]: sourcePath },
      outputPath,
      ...(intendedUse === "none" ? {} : { intendedUse }),
    }),
  ),
);
