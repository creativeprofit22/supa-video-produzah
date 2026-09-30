import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { VideoProjectStateV2 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { planBeatsForARollClip, planBeatsForARollClips } from "./a-roll-beats.js";
import { type FirstCutFixture, firstCutFixtureSchema } from "./first-cut-fixture.js";
import { planFirstCut } from "./first-cut-proposal.js";
import { buildAssetIndex } from "./asset-index.js";
import { DEFAULT_RANKING_CONFIG } from "./ranking-config.js";

const SECOND_CLIP_ID = "000000d1-0000-4000-8000-0000000000f2";

function podcastFixture(): FirstCutFixture {
  const path = fileURLToPath(new URL("../fixtures/v1/podcast.json", import.meta.url));
  return firstCutFixtureSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function aRollClipId(fixture: FirstCutFixture): string {
  if (fixture.source.workflow !== "podcast") throw new Error("podcast fixture");
  return fixture.source.aRollClipId;
}

/**
 * Splits the A-roll clip at `splitFrame` (source and timeline), as a transcript
 * SplitClip would; `gapFrames` shifts the second half later on the timeline.
 */
function splitARoll(
  fixture: FirstCutFixture,
  splitFrame: number,
  gapFrames = 0,
): VideoProjectStateV2 {
  const clipId = aRollClipId(fixture);
  return {
    ...fixture.state,
    sequences: fixture.state.sequences.map((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => {
        if (track.kind === "caption") return track;
        return {
          ...track,
          clips: track.clips.flatMap((clip) => {
            if (clip.id !== clipId) return [clip];
            const offset = splitFrame - clip.sourceIn.value;
            const second = {
              ...clip,
              id: SECOND_CLIP_ID,
              sourceIn: { ...clip.sourceIn, value: splitFrame },
              timelineStart: {
                ...clip.timelineStart,
                value: clip.timelineStart.value + offset + gapFrames,
              },
            };
            return [second, { ...clip, sourceOut: { ...clip.sourceOut, value: splitFrame } }];
          }),
        };
      }),
    })),
  } as VideoProjectStateV2;
}

function transcript(fixture: FirstCutFixture) {
  const item = fixture.transcripts[0];
  if (item === undefined) throw new Error("podcast transcript");
  return item;
}

describe("planBeatsForARollClips", () => {
  it("plans every fragment of a split A-roll as one contiguous plan", async () => {
    const fixture = podcastFixture();
    const { words, language } = transcript(fixture);
    const firstId = aRollClipId(fixture);
    const whole = planBeatsForARollClip(fixture.state, firstId, words, language);
    if (!whole.ok) throw new Error(whole.error.code);
    const state = splitARoll(fixture, 210);

    // Clip ids arrive out of timeline order; the planner orders them itself.
    const result = planBeatsForARollClips(state, [SECOND_CLIP_ID, firstId], words, language);

    if (!result.ok) throw new Error(result.error.code);
    const beats = result.value;
    expect(beats.map((beat) => beat.order)).toEqual(beats.map((_beat, index) => index));
    for (const [index, beat] of beats.entries()) {
      if (index > 0) expect(beat.startUs).toBe(beats[index - 1]?.endUs);
    }
    const firstClipEndUs = 7_000_000;
    const secondClipEndUs = 18_200_000;
    expect(beats[0]?.startUs).toBe(0);
    expect(beats.at(-1)?.endUs).toBe(secondClipEndUs);
    const total = beats.reduce((sum, beat) => sum + beat.endUs - beat.startUs, 0);
    expect(total).toBe(7_000_000 + 11_200_000); // first clip + second clip durations
    const clipOf = (beat: (typeof beats)[number]) =>
      beat.intent.kind === "a-roll" ? beat.intent.clipId : null;
    expect(beats.filter((beat) => beat.endUs <= firstClipEndUs).map(clipOf)).toEqual(
      beats.filter((beat) => beat.endUs <= firstClipEndUs).map(() => firstId),
    );
    expect(beats.filter((beat) => beat.startUs >= firstClipEndUs).map(clipOf)).toEqual(
      beats.filter((beat) => beat.startUs >= firstClipEndUs).map(() => SECOND_CLIP_ID),
    );
    expect(beats.map((beat) => beat.text)).toEqual(whole.value.map((beat) => beat.text));
    expect(new Set(beats.map((beat) => beat.id)).size).toBe(beats.length);

    const proposal = await planFirstCut({
      projectId: fixture.projectId,
      projectRevision: fixture.projectRevision,
      workflow: "podcast",
      beats,
      index: buildAssetIndex({
        assets: state.assets,
        receipts: fixture.receipts,
        tags: fixture.tags,
        transcripts: fixture.transcripts,
      }),
      receipts: fixture.receipts,
      intendedUse: fixture.intendedUse,
      nowMs: fixture.nowMs,
      config: DEFAULT_RANKING_CONFIG,
    });
    if (!proposal.ok) throw new Error(proposal.error.code);
    expect(proposal.value.endUs).toBe(secondClipEndUs);
  });

  it("returns the single-clip plan unchanged for one clip", () => {
    const fixture = podcastFixture();
    const { words, language } = transcript(fixture);
    const clipId = aRollClipId(fixture);

    const many = planBeatsForARollClips(fixture.state, [clipId], words, language);

    expect(many).toEqual(planBeatsForARollClip(fixture.state, clipId, words, language));
  });

  it("refuses A-roll clips separated by a timeline gap", () => {
    const fixture = podcastFixture();
    const { words, language } = transcript(fixture);
    const state = splitARoll(fixture, 210, 30);

    const result = planBeatsForARollClips(
      state,
      [aRollClipId(fixture), SECOND_CLIP_ID],
      words,
      language,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "clips-not-contiguous", clipId: SECOND_CLIP_ID },
    });
  });

  it("refuses an empty clip list", () => {
    const fixture = podcastFixture();
    const { words, language } = transcript(fixture);

    expect(planBeatsForARollClips(fixture.state, [], words, language)).toEqual({
      ok: false,
      error: { code: "no-clips" },
    });
  });
});
