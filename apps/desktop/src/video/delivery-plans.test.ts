import { describe, expect, it } from "vitest";

import {
  createRationalTime,
  DELIVERY_PRESETS,
  type ProjectProjection,
} from "@supa-video/contracts";

import { editorialEvaluationFor } from "./editorial-evaluation";
import { compileDeliveryPlan, deliveryFileName } from "./delivery-plans";
import { explainer, projectionFor } from "./produce-panel-fixtures";

function withOneClip(projection: ProjectProjection): ProjectProjection {
  const asset = projection.state.assets.find((candidate) => candidate.probe.width > 0);
  if (asset === undefined) throw new Error("fixture needs a video asset");
  const rate = asset.probe.averageFrameRate;
  return {
    ...projection,
    state: {
      ...projection.state,
      sequences: projection.state.sequences.map((sequence) =>
        sequence.id !== projection.state.activeSequenceId
          ? sequence
          : {
              ...sequence,
              rate,
              tracks: [
                {
                  id: "0f000000-0000-4000-8000-0000000000b1",
                  name: "V1",
                  kind: "video",
                  clips: [
                    {
                      id: "0f000000-0000-4000-8000-0000000000b2",
                      source: { kind: "asset", assetId: asset.id },
                      timelineStart: createRationalTime(0, rate),
                      sourceIn: createRationalTime(0, rate),
                      sourceOut: createRationalTime(30, rate),
                      transform: {
                        positionXPermille: 0,
                        positionYPermille: 0,
                        scaleXPermille: 1_000,
                        scaleYPermille: 1_000,
                        rotationMilliDegrees: 0,
                        opacityPermille: 1_000,
                      },
                      gainMilliDecibels: 0,
                    },
                  ],
                },
              ],
            },
      ),
    },
  };
}

describe("delivery plans", () => {
  it.each(DELIVERY_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s keeps the reviewed revision and only changes frame size",
    (_id, preset) => {
      const projection = withOneClip(projectionFor(explainer));
      const inputPathsByAssetId = Object.fromEntries(
        projection.state.assets.map((asset) => [asset.id, `C:\\media\\${asset.id}.mp4`]),
      );
      const plan = compileDeliveryPlan({
        planId: "0f000000-0000-4000-8000-0000000000aa",
        projection,
        preset,
        inputPathsByAssetId,
        outputPath: "C:\\out\\clip.mp4",
      });
      expect(plan.revisionId).toBe(projection.revision.id);
      expect(plan.expected).toMatchObject({ width: preset.width, height: preset.height });
    },
  );

  it("names preset files beside the reviewed export", () => {
    expect(deliveryFileName("talk.mp4", "portrait_9x16_1080p")).toBe("talk-9x16.mp4");
    expect(deliveryFileName("", "square_1x1_1080p")).toBe("export-1x1.mp4");
  });

  it("binds the editorial evaluation to the open revision", async () => {
    const projection = projectionFor(explainer);
    const evaluation = await editorialEvaluationFor(projection);
    expect(evaluation).toMatchObject({
      revisionId: projection.revision.id,
      revisionStateHash: projection.revision.stateHash,
      evaluatorVersion: "editorial-v2",
    });
    for (const finding of evaluation.findings) expect(finding.source).toBe("editorial");
  });
});
