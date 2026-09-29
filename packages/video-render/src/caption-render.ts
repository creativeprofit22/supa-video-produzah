import {
  RENDER_CAPTION_FONT_FILES,
  rationalTimeToMicroseconds,
  type CaptionArtifactV1,
  type RenderCaptionFontKey,
  type RenderCaptionInputV2,
  type RenderCaptionStyleV1,
} from "@supa-video/contracts";

/** Windows core fonts directory as FFmpeg sees it (forward slashes). */
export const RENDER_CAPTION_FONT_DIRECTORY = "C:/Windows/Fonts";

const fontFamilies: Readonly<Record<string, string>> = {
  arial: "arial",
  "segoe ui": "segoe-ui",
  verdana: "verdana",
  georgia: "georgia",
  consolas: "consolas",
};

export class CaptionRenderStyleError extends Error {
  readonly code = "caption_font_unsupported";
}

/** Resolves family + weight + italic to a fixed font key or fails closed. */
export function captionFontKey(
  family: string,
  fontWeight: number,
  fontStyle: "normal" | "italic",
): RenderCaptionFontKey {
  const base = fontFamilies[family.trim().toLowerCase()];
  if (base === undefined) {
    throw new CaptionRenderStyleError(`Caption font "${family}" cannot be rendered`);
  }
  const bold = fontWeight >= 600;
  const italic = fontStyle === "italic";
  const variant = bold && italic ? "bold-italic" : bold ? "bold" : italic ? "italic" : "regular";
  return `${base}-${variant}` as RenderCaptionFontKey;
}

/** Style sizes are authored against a 1080-pixel short side and scaled to the frame. */
export const CAPTION_REFERENCE_SHORT_SIDE_PX = 1_080;
export const CAPTION_BOX_BORDER_PX = 12;

function scaledPixels(value: number, frame: CaptionFrame): number {
  return Math.round(
    (value * Math.min(frame.width, frame.height)) / CAPTION_REFERENCE_SHORT_SIDE_PX,
  );
}

export interface CaptionFrame {
  readonly width: number;
  readonly height: number;
}

export function renderCaptionStyle(
  artifact: CaptionArtifactV1,
  frame: CaptionFrame,
): RenderCaptionStyleV1 {
  const { typography, alignment } = artifact.style;
  const { safeArea } = artifact.validationProfile;
  const extraLeading = Math.max(
    0,
    Math.round((typography.fontSizePx * (typography.lineHeightPermille - 1_000)) / 1_000),
  );
  return {
    font: captionFontKey(typography.fontFamily, typography.fontWeight, typography.fontStyle),
    fontSizePx: Math.min(400, Math.max(8, scaledPixels(typography.fontSizePx, frame))),
    lineSpacingPx: Math.min(400, scaledPixels(extraLeading, frame)),
    colorRgba: typography.foregroundColorRgba,
    horizontal: alignment.horizontal,
    vertical: alignment.vertical,
    anchorXPermille: 0,
    anchorYPermille: 0,
    safeTopPermille: safeArea.topPermille,
    safeRightPermille: safeArea.rightPermille,
    safeBottomPermille: safeArea.bottomPermille,
    safeLeftPermille: safeArea.leftPermille,
  };
}

/**
 * Upper bound on drawtext's text height, in font-size units: each line after
 * the first adds at most 1.45 em, and the first line at most 1.2 em. Measured
 * with the bundled FFmpeg on all 20 caption font files (tallest is Segoe UI:
 * 1.17 em for one line with accents and descenders, 1.41 em per extra line);
 * see `evidence/2026-09-28-p3-transcription-audio/18-export-caption-fit.mjs`.
 */
const LINE_ADVANCE_EM = 1.45;
const FIRST_LINE_EM = 1.2;
const MIN_CAPTION_FONT_PX = 8;

function estimatedTextHeight(fontSizePx: number, lineSpacingPx: number, lines: number): number {
  return fontSizePx * (FIRST_LINE_EM + LINE_ADVANCE_EM * (lines - 1)) + lineSpacingPx * (lines - 1);
}

/**
 * Shrinks font size and line spacing together so a cue of `lines` lines, with
 * its background box, fits the safe area's height. Styles that already fit are
 * returned unchanged. Below the 8 px minimum the position clamp takes over.
 */
export function fitCaptionStyleToSafeArea(
  style: RenderCaptionStyleV1,
  lines: number,
  frame: CaptionFrame,
): RenderCaptionStyleV1 {
  const safeHeight =
    (frame.height * (1_000 - style.safeTopPermille - style.safeBottomPermille)) / 1_000;
  const available = safeHeight - 2 * CAPTION_BOX_BORDER_PX;
  const needed = estimatedTextHeight(style.fontSizePx, style.lineSpacingPx, lines);
  if (needed <= available) return style;
  const scale = Math.max(0, available) / needed;
  return {
    ...style,
    fontSizePx: Math.max(MIN_CAPTION_FONT_PX, Math.floor(style.fontSizePx * scale)),
    lineSpacingPx: Math.floor(style.lineSpacingPx * scale),
  };
}

/** Render inputs for every cue of an active caption artifact, in cue order. */
export function artifactRenderCaptions(
  trackId: string,
  artifact: CaptionArtifactV1,
  frame: CaptionFrame,
): RenderCaptionInputV2[] {
  const style = renderCaptionStyle(artifact, frame);
  return artifact.cues.map((cue) => ({
    trackId,
    captionId: trackId,
    cueId: cue.cueId,
    style: {
      ...fitCaptionStyleToSafeArea(style, cue.lines.length, frame),
      anchorXPermille: cue.anchor.xPermille,
      anchorYPermille: cue.anchor.yPermille,
    },
    startMicroseconds: rationalTimeToMicroseconds(cue.start, "nearestTiesAwayFromZero"),
    endMicroseconds: rationalTimeToMicroseconds(cue.end, "nearestTiesAwayFromZero"),
    text: cue.lines.join("\n"),
  }));
}

const escapeEach = (text: string, special: ReadonlySet<string>): string =>
  Array.from(text, (character) => (special.has(character) ? `\\${character}` : character)).join("");
const OPTION_SPECIAL = new Set(["\\", "'", ":"]);
const GRAPH_SPECIAL = new Set(["\\", "'", "[", "]", ",", ";"]);

/**
 * Encodes caption text as an UNQUOTED drawtext `text=` value inside a
 * filtergraph. FFmpeg unescapes it three times, so it is escaped innermost
 * first:
 *
 * 1. drawtext text expansion: `\` and `%` are special;
 * 2. the option tokenizer: `\`, `'` and `:` are special, and unescaped
 *    leading/trailing whitespace is trimmed, so edge whitespace is escaped;
 * 3. the filtergraph parser: `\`, `'`, `[`, `]`, `,` and `;` are special.
 *
 * Line breaks stay real newlines (drawtext renders them). Every other
 * character, including `=`, braces, tabs and emoji, passes through. Verified
 * pixel-for-pixel against drawtext's unescaped `textfile` rendering in
 * `evidence/2026-09-28-p3-transcription-audio/13-drawtext-escape-probe.py`.
 * Must stay byte-identical to `escape_drawtext_text` in caption_render.rs.
 */
export function escapeDrawtextText(text: string): string {
  const expanded = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%");
  const core = expanded.replace(/^[ \t\n]+/u, "").replace(/[ \t\n]+$/u, "");
  const start = core.length === 0 ? expanded.length : expanded.indexOf(core);
  const head = expanded.slice(0, start);
  const tail = expanded.slice(start + core.length);
  const option =
    escapeEach(head, new Set(head)) +
    escapeEach(core, OPTION_SPECIAL) +
    escapeEach(tail, new Set(tail));
  return escapeEach(option, GRAPH_SPECIAL);
}

/**
 * Escapes a filter option path. Separate from text escaping: the drive colon
 * must survive as a literal and the path is single-quoted inside the filter.
 */
export function escapeDrawtextPath(path: string): string {
  return path.replaceAll("\\", "/").replaceAll("'", "\\'").replaceAll(":", "\\:");
}

function permille(value: number): string {
  return (value / 1_000).toFixed(3);
}

/**
 * Horizontal/vertical position expressions. The anchor is the cue's anchor,
 * then the text box is clamped inside the safe area so it can never leave it.
 */
function positionExpressions(style: RenderCaptionStyleV1): { x: string; y: string } {
  // The background box extends past the text by its border on every side.
  const border = CAPTION_BOX_BORDER_PX;
  const left = `w*${permille(style.safeLeftPermille)}+${border}`;
  const right = `w*(1-${permille(style.safeRightPermille)})-${border}`;
  const top = `h*${permille(style.safeTopPermille)}+${border}`;
  const bottom = `h*(1-${permille(style.safeBottomPermille)})-${border}`;
  const anchorX = `w*${permille(style.anchorXPermille)}`;
  const anchorY = `h*${permille(style.anchorYPermille)}`;
  const rawX =
    style.horizontal === "left"
      ? anchorX
      : style.horizontal === "right"
        ? `${anchorX}-text_w`
        : `${anchorX}-text_w/2`;
  const rawY =
    style.vertical === "top"
      ? anchorY
      : style.vertical === "bottom"
        ? `${anchorY}-text_h`
        : `${anchorY}-text_h/2`;
  return {
    x: `max(${left}\\,min(${rawX}\\,${right}-text_w))`,
    y: `max(${top}\\,min(${rawY}\\,${bottom}-text_h))`,
  };
}

export function captionDrawtextFilter(
  caption: RenderCaptionInputV2,
  formatSeconds: (microseconds: number) => string,
): string {
  const enable = `enable='gte(t\\,${formatSeconds(caption.startMicroseconds)})*lt(t\\,${formatSeconds(caption.endMicroseconds)})'`;
  const style = caption.style;
  if (style === undefined) {
    return `drawtext=text=${escapeDrawtextText(caption.text)}:fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:${enable}`;
  }
  const fontfile = escapeDrawtextPath(
    `${RENDER_CAPTION_FONT_DIRECTORY}/${RENDER_CAPTION_FONT_FILES[style.font]}`,
  );
  const color = `0x${style.colorRgba.slice(1)}`;
  const { x, y } = positionExpressions(style);
  const text = escapeDrawtextText(caption.text);
  return `drawtext=fontfile='${fontfile}':text=${text}:fontcolor=${color}:fontsize=${style.fontSizePx}:line_spacing=${style.lineSpacingPx}:text_align=${style.horizontal === "center" ? "C" : style.horizontal === "right" ? "R" : "L"}:box=1:boxcolor=black@0.65:boxborderw=${CAPTION_BOX_BORDER_PX}:x=${x}:y=${y}:${enable}`;
}
