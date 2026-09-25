// Synthetic inputs only; native test grants the paths and validates this compiler output.
import {
  compileActiveSequenceRenderPlan,
  getActiveSequenceRenderEligibility,
} from "../../../packages/video-render/dist/index.js";
import process from "node:process";
import console from "node:console";
const [red, blue, outputPath, mode] = process.argv.slice(2);
if (!["normal", "muted", "hidden", "both", "gap"].includes(mode))
  throw new Error("Unknown fixture mode");
const id = (n) => `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rate = { numerator: 30, denominator: 1 };
const time = (value) => ({ value, rateNumerator: 30, rateDenominator: 1 });
const assets = [red, blue].map((path, index) => ({
  id: id(index + 10),
  displayName: index === 0 ? "red 700 Hz" : "blue 1300 Hz",
  locator: { absolutePath: path },
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
}));
const revision = {
  revision: {
    number: 0,
    id: id(1),
    parentId: null,
    committedAt: "2026-09-16T00:00:00.000Z",
    operationId: id(2),
    stateHash: "a".repeat(64),
  },
  state: {
    assets,
    activeSequenceId: id(3),
    sequences: [
      {
        id: id(3),
        name: "Independent layers",
        rate,
        width: 320,
        height: 180,
        audioSampleRate: 48000,
        markers: [],
        tracks: assets.map((asset, index) => ({
          id: id(20 + index),
          name: asset.displayName,
          kind: "video",
          hidden: index === 0 && ["hidden", "both"].includes(mode),
          muted: index === 0 && ["muted", "both"].includes(mode),
          clips: [
            {
              id: id(30 + index),
              source: { kind: "asset", assetId: asset.id },
              timelineStart: time(mode === "gap" && index === 0 ? 15 : 0),
              sourceIn: time(30),
              sourceOut: time(index === 0 ? 120 : 60),
              speed:
                index === 0 ? { numerator: 3, denominator: 2 } : { numerator: 1, denominator: 2 },
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
if (mode === "gap") console.log(JSON.stringify(getActiveSequenceRenderEligibility(revision)));
else
  console.log(
    JSON.stringify(
      compileActiveSequenceRenderPlan({
        planId: id(4),
        revision,
        inputPathsByAssetId: Object.fromEntries(
          assets.map((asset, index) => [asset.id, [red, blue][index]]),
        ),
        outputPath,
      }),
    ),
  );
