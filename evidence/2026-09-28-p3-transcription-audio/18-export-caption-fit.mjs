// Step 18: burned-in export captions stay inside the safe area.
//
// Renders one frame per aspect ratio with the bundled FFmpeg using the real
// drawtext filter from @supa-video/render (build it first:
// `pnpm --filter @supa-video/contracts --filter @supa-video/render build`).
// Each case is drawn twice: with the caption fit and with the raw style. The
// caption box is found by pixel and must sit inside the 5% safe area.
//
// Run from the repo root: node evidence/2026-09-28-p3-transcription-audio/18-export-caption-fit.mjs
import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captionDrawtextFilter,
  fitCaptionStyleToSafeArea,
} from "../../packages/video-render/dist/caption-render.js";

const here = dirname(fileURLToPath(import.meta.url));
const ffmpeg = join(
  here,
  "../../apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe",
);
const seconds = (us) => `${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, "0")}`;

const frames = {
  "16x9": { width: 1920, height: 1080 },
  "1x1": { width: 1080, height: 1080 },
  "9x16": { width: 1080, height: 1920 },
};
// Largest authorable style: 256 px at 1080 short side, line height 3000‰ -> 400 px spacing cap.
const cases = {
  "8-lines-max-style": {
    lines: Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? "ÉÅ gjy Hq" : "Wg ÇÖ py")),
    fontSizePx: 256,
    lineSpacingPx: 400,
    fonts: ["segoe-ui-bold", "verdana-regular", "arial-bold", "georgia-regular", "consolas-bold"],
  },
  "2-lines-default": {
    lines: ["Speaker one: the launch window", "opens at dawn."],
    fontSizePx: 48,
    lineSpacingPx: 12,
    fonts: ["segoe-ui-bold"],
  },
};

function render(frame, filter) {
  const { width, height } = frame;
  const graph = `color=c=0x00ff00:s=${width}x${height}:d=1,format=rgb24,${filter}`;
  return execFileSync(
    ffmpeg,
    ["-v", "error", "-f", "lavfi", "-i", graph, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

function pngOf(frame, filter, path) {
  const graph = `color=c=0x00ff00:s=${frame.width}x${frame.height}:d=1,format=rgb24,${filter}`;
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", graph, "-frames:v", "1", path]);
}

/** Bounding box of every pixel that is no longer pure background green. */
function captionBox(raw, { width, height }) {
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      if (raw[i] > 8 || raw[i + 1] < 247 || raw[i + 2] > 8) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return { top, bottom, left, right };
}

const results = [];
for (const [aspect, frame] of Object.entries(frames)) {
  for (const [name, spec] of Object.entries(cases)) {
    for (const font of spec.fonts) {
      const style = {
        font,
        fontSizePx: spec.fontSizePx,
        lineSpacingPx: spec.lineSpacingPx,
        colorRgba: "#ffffffff",
        horizontal: "center",
        vertical: "bottom",
        anchorXPermille: 500,
        anchorYPermille: 950,
        safeTopPermille: 50,
        safeRightPermille: 50,
        safeBottomPermille: 50,
        safeLeftPermille: 50,
      };
      const safe = {
        top: Math.ceil(frame.height * 0.05),
        bottom: Math.floor(frame.height * 0.95) - 1,
      };
      for (const fitted of [true, false]) {
        const used = fitted ? fitCaptionStyleToSafeArea(style, spec.lines.length, frame) : style;
        const filter = captionDrawtextFilter(
          {
            trackId: "t",
            captionId: "t",
            cueId: "cue-0001",
            style: used,
            startMicroseconds: 0,
            endMicroseconds: 10_000_000,
            text: spec.lines.join("\n"),
          },
          seconds,
        );
        const box = captionBox(render(frame, filter), frame);
        const inside = box.top >= safe.top && box.bottom <= safe.bottom;
        results.push({
          aspect,
          case: name,
          font,
          fitted,
          fontSizePx: used.fontSizePx,
          lineSpacingPx: used.lineSpacingPx,
          safe,
          box,
          inside,
        });
        if (font === spec.fonts[0]) {
          pngOf(
            frame,
            filter,
            join(here, `18-export-${aspect}-${name}-${fitted ? "fitted" : "unfitted"}.png`),
          );
        }
      }
    }
  }
}

writeFileSync(join(here, "18-export-caption-fit.json"), `${JSON.stringify(results, null, 2)}\n`);
for (const r of results) {
  console.log(
    `${r.aspect.padEnd(5)} ${r.case.padEnd(18)} ${r.font.padEnd(16)} ${r.fitted ? "fitted  " : "unfitted"} size=${String(r.fontSizePx).padStart(3)} box=${r.box.top}-${r.box.bottom} safe=${r.safe.top}-${r.safe.bottom} ${r.inside ? "INSIDE" : "OUTSIDE"}`,
  );
}
const failures = results.filter((r) => r.fitted && !r.inside);
console.log(failures.length === 0 ? "PASS: every fitted caption is inside the safe area" : `FAIL: ${failures.length}`);
process.exitCode = failures.length === 0 ? 0 : 1;
