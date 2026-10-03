import { describe, expect, it } from "vitest";

import {
  createRationalTime,
  DELIVERY_PRESETS,
  type ProjectProjection,
} from "@supa-video/contracts";

import { musicBeatQcInputForProjection } from "../use-music-beats";
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
      evaluatorVersion: "editorial-v3",
    });
    for (const finding of evaluation.findings) expect(finding.source).toBe("editorial");
  });

  it("feeds music beats of music tracks into the export evaluation", async () => {
    const base = withOneClip(projectionFor(explainer));
    const sequence = base.state.sequences.find(({ id }) => id === base.state.activeSequenceId);
    const video = sequence?.tracks[0];
    const asset = base.state.assets[0];
    if (sequence === undefined || video?.kind !== "video" || asset === undefined)
      throw new Error("fixture needs a video track");
    const musicClip = video.clips[0];
    if (musicClip === undefined) throw new Error("fixture needs a clip");
    const projection: ProjectProjection = {
      ...base,
      state: {
        ...base.state,
        sequences: base.state.sequences.map((item) =>
          item.id !== sequence.id
            ? item
            : {
                ...item,
                tracks: [
                  ...item.tracks,
                  {
                    id: "0f000000-0000-4000-8000-0000000000c1",
                    name: "Music",
                    kind: "audio",
                    audioRole: "music",
                    clips: [{ ...musicClip, id: "0f000000-0000-4000-8000-0000000000c2" }],
                  },
                ],
              },
        ),
      },
    };
    const analyses = new Map([
      [
        asset.id,
        {
          schemaVersion: 1 as const,
          detector: {
            kind: "tempo_fallback" as const,
            version: "tempo-fallback-v1",
            checkpointSha256: null,
          },
          durationUs: 2_000_000,
          tempoBpm: 120,
          beatsUs: [0, 500_000, 1_000_000],
          downbeatsUs: [0],
          onsetsUs: [],
        },
      ],
    ]);
    const musicBeats = musicBeatQcInputForProjection(projection, analyses);
    expect(musicBeats.musicBeatsFromTempoFallback).toBe(true);
    expect(musicBeats.musicBeatsUs.length).toBeGreaterThan(0);

    const evaluation = await editorialEvaluationFor(projection, [], musicBeats);
    const fit = evaluation.findings.find((finding) => finding.kind === "music_fit");
    expect(fit?.severity).toBe("info");
    expect(fit?.message).toContain("in-app tempo fallback");
    const without = await editorialEvaluationFor(projection);
    expect(without.findings.some((finding) => finding.kind === "music_fit")).toBe(false);
  });

  it("ignores tempo fallback analyses of muted music tracks", async () => {
    const base = withOneClip(projectionFor(explainer));
    const sequence = base.state.sequences.find(({ id }) => id === base.state.activeSequenceId);
    const video = sequence?.tracks[0];
    const asset = base.state.assets[0];
    if (sequence === undefined || video?.kind !== "video" || asset === undefined)
      throw new Error("fixture needs a video track");
    const musicClip = video.clips[0];
    if (musicClip === undefined) throw new Error("fixture needs a clip");
    const mutedAssetId = "0f000000-0000-4000-8000-0000000000d0";
    const projection: ProjectProjection = {
      ...base,
      state: {
        ...base.state,
        sequences: base.state.sequences.map((item) =>
          item.id !== sequence.id
            ? item
            : {
                ...item,
                tracks: [
                  ...item.tracks,
                  {
                    id: "0f000000-0000-4000-8000-0000000000d1",
                    name: "Muted music",
                    kind: "audio",
                    audioRole: "music",
                    muted: true,
                    clips: [
                      {
                        ...musicClip,
                        id: "0f000000-0000-4000-8000-0000000000d2",
                        source: { kind: "asset", assetId: mutedAssetId },
                      },
                    ],
                  },
                  {
                    id: "0f000000-0000-4000-8000-0000000000d3",
                    name: "Music",
                    kind: "audio",
                    audioRole: "music",
                    clips: [{ ...musicClip, id: "0f000000-0000-4000-8000-0000000000d4" }],
                  },
                ],
              },
        ),
      },
    };
    const analysis = {
      schemaVersion: 1 as const,
      durationUs: 2_000_000,
      tempoBpm: 120,
      beatsUs: [0, 500_000, 1_000_000],
      downbeatsUs: [0],
      onsetsUs: [],
    };
    const analyses = new Map([
      [
        mutedAssetId,
        {
          ...analysis,
          detector: {
            kind: "tempo_fallback" as const,
            version: "tempo-fallback-v1",
            checkpointSha256: null,
          },
        },
      ],
      [
        asset.id,
        {
          ...analysis,
          detector: {
            kind: "beat_this" as const,
            version: "1.0.0",
            checkpointSha256: "a".repeat(64),
          },
        },
      ],
    ]);
    const musicBeats = musicBeatQcInputForProjection(projection, analyses);
    expect(musicBeats.musicBeatsUs.length).toBeGreaterThan(0);
    expect(musicBeats.musicBeatsFromTempoFallback).toBe(false);

    const evaluation = await editorialEvaluationFor(projection, [], musicBeats);
    for (const finding of evaluation.findings)
      expect(finding.message).not.toContain("in-app tempo fallback");
  });
});
