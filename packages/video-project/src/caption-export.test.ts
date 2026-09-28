import { createRationalTime, type CaptionArtifactV1 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import { exportSubtitles, normalizeSubtitleCues, toVtt } from "./caption-export.js";

const rate = { numerator: 30_000, denominator: 1_001 } as const;

function artifact(
  cues: readonly { start: number; end: number; lines: readonly string[] }[],
): CaptionArtifactV1 {
  return {
    style: {
      schemaVersion: 1,
      typography: {
        fontFamily: "Arial",
        fontSizePx: 48,
        fontWeight: 700,
        fontStyle: "normal",
        lineHeightPermille: 1_200,
        foregroundColorRgba: "#ffd700ff",
      },
      alignment: { horizontal: "center", vertical: "bottom" },
    },
    validationProfile: {
      safeArea: { topPermille: 50, rightPermille: 50, bottomPermille: 50, leftPermille: 50 },
    },
    cues: cues.map((cue, index) => ({
      cueId: `cue-${index}`,
      start: createRationalTime(cue.start, rate),
      end: createRationalTime(cue.end, rate),
      lines: [...cue.lines],
    })),
  } as unknown as CaptionArtifactV1;
}

describe("caption export", () => {
  const sample = artifact([
    { start: 60, end: 120, lines: ["Second <b> & more"] },
    { start: 0, end: 45, lines: ["And so, my fellow", "Americans"] },
    { start: 150, end: 150, lines: ["zero-length"] },
    { start: 200, end: 230, lines: ["  ", "\u0007"] },
    { start: 240, end: 270, lines: ["tab\there\u0001{x}\\"] },
  ]);

  it("normalizes to sorted integer-ms cues, drops empty ones and repairs zero length", () => {
    const cues = normalizeSubtitleCues(sample);
    expect(cues).toEqual([
      { startMs: 0, endMs: 1_502, lines: ["And so, my fellow", "Americans"] },
      { startMs: 2_002, endMs: 4_004, lines: ["Second <b> & more"] },
      { startMs: 5_005, endMs: 5_006, lines: ["zero-length"] },
      { startMs: 8_008, endMs: 9_009, lines: ["tab here{x}\\"] },
    ]);
  });

  it("writes golden SRT with comma milliseconds", () => {
    expect(exportSubtitles(sample, "srt", { width: 1920, height: 1080 })).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:01,502",
        "And so, my fellow",
        "Americans",
        "",
        "2",
        "00:00:02,002 --> 00:00:04,004",
        "Second <b> & more",
        "",
        "3",
        "00:00:05,005 --> 00:00:05,006",
        "zero-length",
        "",
        "4",
        "00:00:08,008 --> 00:00:09,009",
        "tab here{x}\\",
        "",
      ].join("\n"),
    );
  });

  it("writes golden VTT with dot milliseconds and escaped markup", () => {
    const vtt = exportSubtitles(sample, "vtt", { width: 1920, height: 1080 });
    expect(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.502\n")).toBe(true);
    expect(vtt).toContain("Second &lt;b&gt; &amp; more");
    expect(toVtt([])).toBe("WEBVTT\n");
  });

  it("writes ASS with the artifact style, safe-area margins and neutralised overrides", () => {
    const ass = exportSubtitles(sample, "ass", { width: 1920, height: 1080 });
    expect(ass).toContain("PlayResX: 1920\nPlayResY: 1080");
    expect(ass).toContain(
      "Style: Default,Arial,48,&H0000D7FF,&H000000FF,&H00000000,&H59000000,-1,0,0,0,100,100,0,0,3,12,0,2,96,96,54,1",
    );
    expect(ass).toContain(
      "Dialogue: 0,0:00:00.00,0:00:01.51,Default,,0,0,0,,And so, my fellow\\NAmericans",
    );
    expect(ass).toContain("Dialogue: 0,0:00:08.00,0:00:09.01,Default,,0,0,0,,tab here\\{x\\}\\\\");
  });

  it("round-trips SRT timings back to the normalized cues", () => {
    const srt = exportSubtitles(sample, "srt", { width: 1920, height: 1080 });
    const parsed = [
      ...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/gu),
    ].map((match) => {
      const ms = (offset: number): number =>
        Number(match[offset]) * 3_600_000 +
        Number(match[offset + 1]) * 60_000 +
        Number(match[offset + 2]) * 1_000 +
        Number(match[offset + 3]);
      return [ms(1), ms(5)];
    });
    expect(parsed).toEqual(normalizeSubtitleCues(sample).map((cue) => [cue.startMs, cue.endMs]));
  });
});
