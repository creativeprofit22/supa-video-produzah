import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/video-project-opener.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

async function setRootFontSize(page: Page, pixels: number) {
  await page.evaluate((fontSize) => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, pixels);
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).include(".opener").withTags(wcagTags).analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

for (const viewport of [
  { name: "320px with 200% text", width: 320, height: 900, rootFontSize: 32 },
  { name: "desktop", width: 1280, height: 900, rootFontSize: 16 },
]) {
  test(`ready state preserves layout and accessibility at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${fixturePath}?state=ready`);
    await expect(page.getByRole("heading", { name: "Ready for video work" })).toBeVisible();
    await setRootFontSize(page, viewport.rootFontSize);

    await expectNoDocumentOverflow(page);

    const identity = page.locator(".toolchain-identity code");
    await expect(identity).toHaveText(/^ffmpeg-x{121}$/);
    const geometry = await identity.evaluate((element) => {
      const identityRect = element.getBoundingClientRect();
      const panelRect = element.closest(".tool-panel")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        identityLeft: identityRect.left,
        identityRight: identityRect.right,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        renderedLineCount: range.getClientRects().length,
        overflowWrap: getComputedStyle(element).overflowWrap,
      };
    });
    expect(geometry.identityLeft).toBeGreaterThanOrEqual(geometry.panelLeft);
    expect(geometry.identityRight).toBeLessThanOrEqual(geometry.panelRight);
    expect(geometry.overflowWrap).toBe("anywhere");
    if (viewport.width === 320) expect(geometry.renderedLineCount).toBeGreaterThan(1);

    await expectNoAxeViolations(page);
  });
}

test("failure state applies forced colors and keeps keyboard focus order", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${fixturePath}?state=failure`);
  await expect(
    page.getByRole("heading", { name: "Bundled media tools are damaged" }),
  ).toBeVisible();
  await setRootFontSize(page, 32);

  await expectNoAxeViolations(page);
  await page.emulateMedia({ forcedColors: "active" });
  await expectNoDocumentOverflow(page);
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

  const newProject = page.getByRole("button", { name: "New project" });
  const openProject = page.getByRole("button", { name: "Open project" });
  const retry = page.getByRole("button", { name: "Check again" });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await expect(newProject).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(openProject).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();

  const forcedColorStyles = await page.evaluate(() => {
    const primaryButton = document.querySelector<HTMLElement>(".primary-button")!;
    const retryButton = document.querySelector<HTMLElement>(".tool-panel .secondary-button")!;
    const panel = document.querySelector<HTMLElement>(".tool-panel")!;
    const primaryStyle = getComputedStyle(primaryButton);
    const retryStyle = getComputedStyle(retryButton);
    const panelStyle = getComputedStyle(panel);
    return {
      primaryAdjustment: primaryStyle.forcedColorAdjust,
      retryOutlineStyle: retryStyle.outlineStyle,
      retryOutlineWidth: retryStyle.outlineWidth,
      panelBorderStyle: panelStyle.borderTopStyle,
      panelBorderWidth: panelStyle.borderTopWidth,
    };
  });
  expect(forcedColorStyles.primaryAdjustment).toBe("none");
  expect(forcedColorStyles.retryOutlineStyle).not.toBe("none");
  expect(forcedColorStyles.retryOutlineWidth).not.toBe("0px");
  expect(forcedColorStyles.panelBorderStyle).toBe("solid");
  expect(forcedColorStyles.panelBorderWidth).not.toBe("0px");
});
