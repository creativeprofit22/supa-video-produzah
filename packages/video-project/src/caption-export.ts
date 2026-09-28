import { rationalTimeToMicroseconds, type CaptionArtifactV1 } from "@supa-video/contracts";

/**
 * Sidecar subtitle export from the active caption artifact.
 *
 * Cue rules (after CapSoftware/Cap captions-export): integer milliseconds;
 * drop empty or non-finite cues; after rounding force `end >= start + 1 ms`;
 * strip control characters; stable sort by start then end. SRT uses `,` and
 * VTT `.` as the decimal separator; VTT escapes `& < >`; an empty VTT file is
 * exactly `WEBVTT\n`.
 */
export type SubtitleFormat = "srt" | "vtt" | "ass";

export interface SubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly lines: readonly string[];
}

/** C0/C1 controls; tab becomes a space and newlines are split beforehand. */
function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function cleanLine(line: string): string {
  return [...line.replaceAll("\t", " ")]
    .filter((character) => !isControlCharacter(character))
    .join("")
    .trim();
}

export function normalizeSubtitleCues(artifact: CaptionArtifactV1): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const cue of artifact.cues) {
    const startUs = rationalTimeToMicroseconds(cue.start, "nearestTiesAwayFromZero");
    const endUs = rationalTimeToMicroseconds(cue.end, "nearestTiesAwayFromZero");
    if (!Number.isFinite(startUs) || !Number.isFinite(endUs)) continue;
    const lines = cue.lines
      .flatMap((line) => line.split(/\r\n|\r|\n/u))
      .map(cleanLine)
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const startMs = Math.max(0, Math.round(startUs / 1_000));
    const endMs = Math.max(startMs + 1, Math.round(endUs / 1_000));
    cues.push({ startMs, endMs, lines });
  }
  return cues
    .map((cue, index) => ({ cue, index }))
    .sort(
      (left, right) =>
        left.cue.startMs - right.cue.startMs ||
        left.cue.endMs - right.cue.endMs ||
        left.index - right.index,
    )
    .map(({ cue }) => cue);
}

function clock(ms: number, separator: "," | "."): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

export function toSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${clock(cue.startMs, ",")} --> ${clock(cue.endMs, ",")}\n${cue.lines.join("\n")}\n`,
    )
    .join("\n");
}

function escapeVtt(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function toVtt(cues: readonly SubtitleCue[]): string {
  if (cues.length === 0) return "WEBVTT\n";
  const body = cues
    .map(
      (cue) =>
        `${clock(cue.startMs, ".")} --> ${clock(cue.endMs, ".")}\n${cue.lines.map(escapeVtt).join("\n")}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/** ASS centiseconds: `H:MM:SS.cc`, start floored and end ceiled so no cue shrinks. */
function assClock(ms: number, round: "floor" | "ceil"): string {
  const centis = round === "floor" ? Math.floor(ms / 10) : Math.ceil(ms / 10);
  const hours = Math.floor(centis / 360_000);
  const minutes = Math.floor((centis % 360_000) / 6_000);
  const seconds = Math.floor((centis % 6_000) / 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`;
}

/** ASS override-sensitive characters are neutralised; `\N` is a hard line break. */
function escapeAss(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function assColor(rgba: string): string {
  // `#rrggbbaa` → `&HAABBGGRR` with ASS alpha (00 = opaque).
  const red = rgba.slice(1, 3);
  const green = rgba.slice(3, 5);
  const blue = rgba.slice(5, 7);
  const alpha = (255 - Number.parseInt(rgba.slice(7, 9), 16)).toString(16).padStart(2, "0");
  return `&H${alpha}${blue}${green}${red}`.toUpperCase();
}

const assAlignment = {
  bottom: { left: 1, center: 2, right: 3 },
  center: { left: 4, center: 5, right: 6 },
  top: { left: 7, center: 8, right: 9 },
} as const;

export interface AssFrame {
  readonly width: number;
  readonly height: number;
}

export function toAss(
  artifact: CaptionArtifactV1,
  cues: readonly SubtitleCue[],
  frame: AssFrame,
): string {
  const { typography, alignment } = artifact.style;
  const { safeArea } = artifact.validationProfile;
  const marginL = Math.round((frame.width * safeArea.leftPermille) / 1_000);
  const marginR = Math.round((frame.width * safeArea.rightPermille) / 1_000);
  const marginV = Math.round(
    (frame.height *
      (alignment.vertical === "top" ? safeArea.topPermille : safeArea.bottomPermille)) /
      1_000,
  );
  const fontName = typography.fontFamily.replaceAll(",", " ");
  const bold = typography.fontWeight >= 600 ? -1 : 0;
  const italic = typography.fontStyle === "italic" ? -1 : 0;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${typography.fontSizePx},${assColor(typography.foregroundColorRgba)},&H000000FF,&H00000000,&H59000000,${bold},${italic},0,0,100,100,0,0,3,12,0,${assAlignment[alignment.vertical][alignment.horizontal]},${marginL},${marginR},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${assClock(cue.startMs, "floor")},${assClock(cue.endMs, "ceil")},Default,,0,0,0,,${cue.lines.map(escapeAss).join("\\N")}`,
  );
  return `${[...header, ...events].join("\n")}\n`;
}

export function exportSubtitles(
  artifact: CaptionArtifactV1,
  format: SubtitleFormat,
  frame: AssFrame,
): string {
  const cues = normalizeSubtitleCues(artifact);
  if (format === "srt") return toSrt(cues);
  if (format === "vtt") return toVtt(cues);
  return toAss(artifact, cues, frame);
}
