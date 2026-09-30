import { expect, test, type Page } from "@playwright/test";
import { evidencePath } from "./evidence-path";

const fixturePath = "/browser-tests/monitor-captions.html";
const evidence = "../../evidence/2026-09-28-p3-transcription-audio";

// 200% browser zoom on a 1280×800 window = a 640×400 CSS-pixel page drawn at
// twice the pixel density.
test.use({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

async function overlayGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const stage = document.querySelector(".monitor-stage");
    const overlay = document.querySelector(".monitor-caption-overlay");
    if (stage === null || overlay === null) return null;
    const lines = [...overlay.querySelectorAll("p")];
    return {
      stage: box(stage),
      safeArea: box(overlay),
      fontSizePx: lines[0] ? Number.parseFloat(getComputedStyle(lines[0]).fontSize) : 0,
      lines: lines.map((line) => ({
        box: box(line),
        clipped: line.scrollWidth > line.clientWidth + 1,
      })),
      pageWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });
}

const cases = [
  { aspect: "16x9", text: "100" },
  { aspect: "1x1", text: "100" },
  { aspect: "9x16", text: "100" },
  { aspect: "16x9", text: "200" },
  { aspect: "1x1", text: "200" },
  { aspect: "9x16", text: "200" },
] as const;

for (const { aspect, text } of cases) {
  const label = text === "200" ? "200% zoom and 200% text" : "200% zoom";
  test(`caption overlay stays inside the ${aspect} preview at ${label}`, async ({ page }) => {
    await page.goto(`${fixturePath}?aspect=${aspect}`);
    if (text === "200") {
      // 200% text scaling: every rem-based size doubles.
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
    }
    await page.evaluate(() => document.fonts.ready);

    const overlay = page.getByLabel("Active captions");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("[data-caption-id]")).toHaveText([
      "Speaker one: the launch window opens at dawn,",
      "so every checklist item must close before then.",
    ]);

    const geometry = await overlayGeometry(page);
    expect(geometry).not.toBeNull();
    if (geometry === null) return;
    expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageWidth);
    const { safeArea, stage } = geometry;
    expect(safeArea.top).toBeGreaterThanOrEqual(stage.top - 0.5);
    expect(safeArea.bottom).toBeLessThanOrEqual(stage.bottom + 0.5);
    expect(geometry.lines).toHaveLength(2);
    for (const line of geometry.lines) {
      expect(line.clipped).toBe(false);
      expect(line.box.left).toBeGreaterThanOrEqual(safeArea.left - 0.5);
      expect(line.box.right).toBeLessThanOrEqual(safeArea.right + 0.5);
      expect(line.box.top).toBeGreaterThanOrEqual(safeArea.top - 0.5);
      expect(line.box.bottom).toBeLessThanOrEqual(safeArea.bottom + 0.5);
    }
    const [first, second] = geometry.lines;
    expect(first && second && first.box.bottom <= second.box.top + 0.5).toBe(true);
    // Shrinking stops at 20% of the normal size, so text stays legible.
    expect(geometry.fontSizePx).toBeGreaterThanOrEqual(8);

    const suffix = text === "200" ? "zoom200-text200" : "zoom200";
    await page.locator(".monitor-stage").screenshot({
      path: evidencePath(`${evidence}/17-monitor-captions-${aspect}-${suffix}.png`),
    });
  });
}
