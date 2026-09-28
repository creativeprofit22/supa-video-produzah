import type { RenderCaptionInputV2 } from "@supa-video/contracts";
import { describe, expect, it } from "vitest";

import {
  CaptionRenderStyleError,
  captionDrawtextFilter,
  captionFontKey,
  escapeDrawtextPath,
} from "./caption-render.js";

const seconds = (microseconds: number): string =>
  `${Math.floor(microseconds / 1_000_000)}.${String(microseconds % 1_000_000).padStart(6, "0")}`;

/** Shared with the native validator test `styled_caption_drawtext_matches_ts_golden`. */
export const STYLED_CAPTION_GOLDEN_INPUT: RenderCaptionInputV2 = {
  trackId: "00000000-0000-4000-8000-000000000001",
  captionId: "00000000-0000-4000-8000-000000000001",
  cueId: "cue-0001",
  style: {
    font: "arial-bold",
    fontSizePx: 32,
    lineSpacingPx: 7,
    colorRgba: "#ffd700ff",
    horizontal: "center",
    vertical: "bottom",
    anchorXPermille: 500,
    anchorYPermille: 950,
    safeTopPermille: 50,
    safeRightPermille: 50,
    safeBottomPermille: 50,
    safeLeftPermille: 50,
  },
  startMicroseconds: 250_000,
  endMicroseconds: 1_750_000,
  text: "It's 50%, [ok];\nC:\\path",
};

export const STYLED_CAPTION_GOLDEN =
  "drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='It\\'s 50\\%\\, \\[ok\\]\\;\nC\\:\\\\path':fontcolor=0xffd700ff:fontsize=32:line_spacing=7:text_align=C:box=1:boxcolor=black@0.65:boxborderw=12:x=max(w*0.050+12\\,min(w*0.500-text_w/2\\,w*(1-0.050)-12-text_w)):y=max(h*0.050+12\\,min(h*0.950-text_h\\,h*(1-0.050)-12-text_h)):enable='gte(t\\,0.250000)*lt(t\\,1.750000)'";

describe("caption render", () => {
  it("maps a styled cue to an exact drawtext filter with a fixed fontfile", () => {
    expect(captionDrawtextFilter(STYLED_CAPTION_GOLDEN_INPUT, seconds)).toBe(STYLED_CAPTION_GOLDEN);
  });

  it("keeps the legacy unstyled filter byte-identical", () => {
    const legacy = { ...STYLED_CAPTION_GOLDEN_INPUT, text: "a\nb" };
    delete (legacy as { style?: unknown }).style;
    expect(captionDrawtextFilter(legacy, seconds)).toBe(
      "drawtext=text='a\\nb':fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:enable='gte(t\\,0.250000)*lt(t\\,1.750000)'",
    );
  });

  it("resolves weight and italic to a font file and rejects unknown families", () => {
    expect(captionFontKey("Segoe UI", 700, "italic")).toBe("segoe-ui-bold-italic");
    expect(captionFontKey("arial", 400, "normal")).toBe("arial-regular");
    expect(() => captionFontKey("Comic Sans MS", 400, "normal")).toThrow(CaptionRenderStyleError);
  });

  it("escapes filter paths separately from text", () => {
    expect(escapeDrawtextPath("C:\\Windows\\Fonts\\it's.ttf")).toBe(
      "C\\:/Windows/Fonts/it\\'s.ttf",
    );
  });

  it.each([
    ["left", "top", "w*0.050", "h*0.050"],
    ["right", "center", "w*0.950-text_w", "h*0.500-text_h/2"],
  ] as const)("anchors %s/%s inside the safe area", (horizontal, vertical, rawX, rawY) => {
    const filter = captionDrawtextFilter(
      {
        ...STYLED_CAPTION_GOLDEN_INPUT,
        style: {
          ...STYLED_CAPTION_GOLDEN_INPUT.style!,
          horizontal,
          vertical,
          anchorXPermille: horizontal === "left" ? 50 : 950,
          anchorYPermille: vertical === "top" ? 50 : 500,
        },
      },
      seconds,
    );
    expect(filter).toContain(`x=max(w*0.050+12\\,min(${rawX}\\,w*(1-0.050)-12-text_w))`);
    expect(filter).toContain(`y=max(h*0.050+12\\,min(${rawY}\\,h*(1-0.050)-12-text_h))`);
  });
});
