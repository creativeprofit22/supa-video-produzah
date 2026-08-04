import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const fixturePath = "/browser-tests/multitrack-timeline.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

async function expectContained(inner: Locator, outer: Locator) {
  const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(outerBox!.x + outerBox!.width + 1);
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800, rootFontSize: 16 },
  { name: "mobile", width: 390, height: 844, rootFontSize: 16 },
  { name: "320px with 200% text", width: 320, height: 900, rootFontSize: 32 },
]) {
  test(`renders bounded accessible clip editing at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(fixturePath);
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = `${fontSize}px`;
    }, viewport.rootFontSize);
    await page.evaluate(() => document.fonts.ready);

    const timeline = page.locator(".multitrack-panel");
    const region = page.getByRole("region", { name: "Timeline tracks; scroll horizontally" });
    await expect(timeline).toBeVisible();
    await expect(region).toBeVisible();
    await expect(page.locator(".multitrack-visible-label")).toHaveCount(3);
    await expect(page.locator(".multitrack-track-row")).toHaveCount(3);

    const firstClipBody = page
      .getByRole("button", { name: /Interview A — wide camera\.mp4, frames 0 through 28/ })
      .first();
    await firstClipBody.click();
    await expect(firstClipBody).toHaveAttribute("aria-pressed", "true");

    const selectedClip = page.locator(".multitrack-clip.is-selected");
    await expect(selectedClip).toHaveCount(1);
    await expect(selectedClip).toHaveCSS("border-color", "rgb(215, 245, 106)");
    await expect(selectedClip).not.toHaveCSS("box-shadow", "none");

    await firstClipBody.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(firstClipBody).toBeFocused();
    await expect(firstClipBody).toHaveCSS("outline-style", "solid");
    await expect(firstClipBody).toHaveCSS("outline-width", "2px");

    const trimStart = page.getByRole("button", {
      name: "Trim start of Interview A — wide camera.mp4",
    });
    const trimEnd = page.getByRole("button", {
      name: "Trim end of Interview A — wide camera.mp4",
    });
    await expect(trimStart).toBeVisible();
    await expect(trimEnd).toBeVisible();
    await expectContained(trimStart, selectedClip);
    await expectContained(trimEnd, selectedClip);

    const split = page.getByRole("button", { name: "Split at playhead" });
    await expect(split).toBeEnabled();

    const draggedClip = page.locator(".multitrack-clip.is-selected");
    const clipBox = await firstClipBody.boundingBox();
    expect(clipBox).not.toBeNull();
    const pointer = {
      pointerId: 1,
      button: 0,
      clientX: clipBox!.x + clipBox!.width / 2,
      clientY: clipBox!.y + clipBox!.height / 2,
    };
    await firstClipBody.dispatchEvent("pointerdown", pointer);
    await firstClipBody.dispatchEvent("pointermove", { ...pointer, clientX: pointer.clientX + 40 });
    await expect(draggedClip).toHaveClass(/is-dragging/);
    await expect(draggedClip).toHaveAttribute("data-drag-mode", "move");
    await expectContained(draggedClip, draggedClip.locator("xpath=ancestor::li[@data-track-id]"));
    await expectContained(draggedClip, page.locator(".multitrack-canvas"));
    await draggedClip.locator(".multitrack-clip-body").dispatchEvent("pointerup", {
      ...pointer,
      clientX: pointer.clientX + 40,
    });
    await expect(draggedClip).not.toHaveClass(/is-dragging/);

    await expect(split).toBeEnabled();
    await split.click();
    await expect(page.locator("[data-clip-id]")).toHaveCount(6);

    const geometry = await page.evaluate(() => ({
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      timelineClientWidth: document.querySelector<HTMLElement>(".multitrack-scroll-region")!
        .clientWidth,
      timelineScrollWidth: document.querySelector<HTMLElement>(".multitrack-scroll-region")!
        .scrollWidth,
    }));
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
    expect(geometry.timelineScrollWidth).toBeGreaterThanOrEqual(geometry.timelineClientWidth);

    const axe = await new AxeBuilder({ page })
      .include(".multitrack-panel")
      .disableRules(["target-size"])
      .withTags(wcagTags)
      .analyze();
    expect(axe.violations, axe.violations.map(({ id }) => id).join(", ")).toEqual([]);

    await timeline.screenshot({
      path: `../../evidence/phase-4/multitrack-timeline-${viewport.name.replaceAll(" ", "-")}.png`,
    });
  });
}
