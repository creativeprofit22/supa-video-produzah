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
      ...style,
      anchorXPermille: cue.anchor.xPermille,
      anchorYPermille: cue.anchor.yPermille,
    },
    startMicroseconds: rationalTimeToMicroseconds(cue.start, "nearestTiesAwayFromZero"),
    endMicroseconds: rationalTimeToMicroseconds(cue.end, "nearestTiesAwayFromZero"),
    text: cue.lines.join("\n"),
  }));
}

export function escapeDrawtextText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\r", "\\n")
    .replaceAll("\n", "\\n");
}

/**
 * Styled captions keep real line breaks: drawtext renders a literal newline,
 * whereas an escaped `\n` reaches it as the letter "n".
 */
export function escapeStyledDrawtextText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
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
    return `drawtext=text='${escapeDrawtextText(caption.text)}':fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:${enable}`;
  }
  const fontfile = escapeDrawtextPath(
    `${RENDER_CAPTION_FONT_DIRECTORY}/${RENDER_CAPTION_FONT_FILES[style.font]}`,
  );
  const color = `0x${style.colorRgba.slice(1)}`;
  const { x, y } = positionExpressions(style);
  const text = escapeStyledDrawtextText(caption.text);
  return `drawtext=fontfile='${fontfile}':text='${text}':fontcolor=${color}:fontsize=${style.fontSizePx}:line_spacing=${style.lineSpacingPx}:text_align=${style.horizontal === "center" ? "C" : style.horizontal === "right" ? "R" : "L"}:box=1:boxcolor=black@0.65:boxborderw=${CAPTION_BOX_BORDER_PX}:x=${x}:y=${y}:${enable}`;
}
