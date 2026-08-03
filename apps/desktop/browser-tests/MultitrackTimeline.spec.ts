import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const fixturePath = "/browser-tests/multitrack-timeline.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

for (const viewport of [
  { name: "desktop", width: 1280, height: 800, rootFontSize: 16 },
  { name: "mobile", width: 390, height: 844, rootFontSize: 16 },
  { name: "320px with 200% text", width: 320, height: 900, rootFontSize: 32 },
]) {
  test(`renders bounded accessible tracks at ${viewport.name}`, async ({ page }) => {
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

    const geometry = await page.evaluate(() => ({
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      timelineClientWidth: document.querySelector<HTMLElement>(".multitrack-scroll-region")!
        .clientWidth,
      timelineScrollWidth: document.querySelector<HTMLElement>(".multitrack-scroll-region")!
        .scrollWidth,
    }));
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
    expect(geometry.timelineScrollWidth).toBeGreaterThan(geometry.timelineClientWidth);

    const axe = await new AxeBuilder({ page })
      .include(".multitrack-panel")
      .withTags(wcagTags)
      .analyze();
    expect(axe.violations, axe.violations.map(({ id }) => id).join(", ")).toEqual([]);

    await timeline.screenshot({
      path: `../../evidence/phase-4/multitrack-timeline-${viewport.name.replaceAll(" ", "-")}.png`,
    });
  });
}
