import { describe, expect, it } from "vitest";

import { AudioMixPlanError, audioMixFilters, loudnormPlaceholder } from "./audio-mix.js";

const target = {
  integratedLufs: -16,
  truePeakCeilingDbtp: -1,
  ducking: true,
  dialogueCleanup: true,
} as const;

/** Shared with `audio_mix::tests::mix_graph_matches_ts_golden` in Rust. */
export const AUDIO_MIX_GOLDEN = [
  "[a0]highpass=f=80,afftdn=nr=12:nf=-40[c0]",
  "[c0]asplit=2[dmix][dkey0]",
  "[dkey0]apad=whole_dur=12.000000[dkey]",
  "[a1][dkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600[mduck]",
  "[dmix][mduck][a2]amix=inputs=3:duration=longest:normalize=0,loudnorm=I=-16.0:TP=-1.5:LRA=11.0[aout]",
].join(";");

describe("audio mix graph", () => {
  it("keeps legacy mixes byte-identical when no loudness target exists", () => {
    expect(audioMixFilters([{ index: 0, role: undefined }], undefined, "1.000000")).toEqual([
      "[a0]anull[aout]",
    ]);
    expect(
      audioMixFilters(
        [
          { index: 0, role: "dialogue" },
          { index: 2, role: "music" },
        ],
        undefined,
        "1.000000",
      ),
    ).toEqual(["[a0][a2]amix=inputs=2:duration=longest:normalize=0[aout]"]);
  });

  it("builds cleanup, padded-key ducking and the loudnorm placeholder", () => {
    expect(
      audioMixFilters(
        [
          { index: 0, role: "dialogue" },
          { index: 1, role: "music" },
          { index: 2, role: "sfx" },
        ],
        target,
        "12.000000",
      ).join(";"),
    ).toBe(AUDIO_MIX_GOLDEN);
  });

  it("buses several dialogue and music tracks before ducking", () => {
    const parts = audioMixFilters(
      [
        { index: 0, role: "dialogue" },
        { index: 1, role: "dialogue" },
        { index: 2, role: "music" },
        { index: 3, role: "music" },
      ],
      { ...target, dialogueCleanup: false },
      "5.000000",
    );
    expect(parts).toEqual([
      "[a0][a1]amix=inputs=2:duration=longest:normalize=0,asplit=2[dmix][dkey0]",
      "[dkey0]apad=whole_dur=5.000000[dkey]",
      "[a2][a3]amix=inputs=2:duration=longest:normalize=0[mbus]",
      "[mbus][dkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600[mduck]",
      "[dmix][mduck]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-16.0:TP=-1.5:LRA=11.0[aout]",
    ]);
  });

  it("rejects ducking without a dialogue-role track instead of silently skipping it", () => {
    expect(() => audioMixFilters([{ index: 0, role: "music" }], target, "1.000000")).toThrow(
      AudioMixPlanError,
    );
  });

  it("does nothing to duck when there is no music, but still normalizes", () => {
    expect(audioMixFilters([{ index: 0, role: "dialogue" }], target, "1.000000")).toEqual([
      "[a0]highpass=f=80,afftdn=nr=12:nf=-40[c0]",
      "[c0]loudnorm=I=-16.0:TP=-1.5:LRA=11.0[aout]",
    ]);
  });

  it.each([
    [-14, "loudnorm=I=-14.0:TP=-1.5:LRA=11.0"],
    [-23, "loudnorm=I=-23.0:TP=-1.5:LRA=11.0"],
  ] as const)("formats the %d LUFS placeholder", (integratedLufs, expected) => {
    expect(loudnormPlaceholder({ ...target, integratedLufs })).toBe(expected);
  });
});
