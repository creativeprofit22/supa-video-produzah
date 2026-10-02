import { z } from "zod";

/**
 * Caption and graphics fonts the exporter can render. Each key maps to a fixed Windows
 * core-font file in both render compilers; no user-supplied path reaches FFmpeg or the
 * graphics renderer.
 */
export const RENDER_CAPTION_FONT_FILES = {
  "arial-regular": "arial.ttf",
  "arial-bold": "arialbd.ttf",
  "arial-italic": "ariali.ttf",
  "arial-bold-italic": "arialbi.ttf",
  "segoe-ui-regular": "segoeui.ttf",
  "segoe-ui-bold": "segoeuib.ttf",
  "segoe-ui-italic": "segoeuii.ttf",
  "segoe-ui-bold-italic": "segoeuiz.ttf",
  "verdana-regular": "verdana.ttf",
  "verdana-bold": "verdanab.ttf",
  "verdana-italic": "verdanai.ttf",
  "verdana-bold-italic": "verdanaz.ttf",
  "georgia-regular": "georgia.ttf",
  "georgia-bold": "georgiab.ttf",
  "georgia-italic": "georgiai.ttf",
  "georgia-bold-italic": "georgiaz.ttf",
  "consolas-regular": "consola.ttf",
  "consolas-bold": "consolab.ttf",
  "consolas-italic": "consolai.ttf",
  "consolas-bold-italic": "consolaz.ttf",
} as const;
export type RenderCaptionFontKey = keyof typeof RENDER_CAPTION_FONT_FILES;

export const renderCaptionFontKeySchema = z.enum([
  "arial-regular",
  "arial-bold",
  "arial-italic",
  "arial-bold-italic",
  "segoe-ui-regular",
  "segoe-ui-bold",
  "segoe-ui-italic",
  "segoe-ui-bold-italic",
  "verdana-regular",
  "verdana-bold",
  "verdana-italic",
  "verdana-bold-italic",
  "georgia-regular",
  "georgia-bold",
  "georgia-italic",
  "georgia-bold-italic",
  "consolas-regular",
  "consolas-bold",
  "consolas-italic",
  "consolas-bold-italic",
] as const satisfies readonly RenderCaptionFontKey[]);
