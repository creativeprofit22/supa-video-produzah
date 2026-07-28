import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/job-center.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => !(element instanceof HTMLDialogElement) || element.open)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) => rect.width > 0 && (rect.left < -0.5 || rect.right > viewportWidth + 0.5),
      )
      .map(({ element, rect }) => ({
        className: element.className,
        tagName: element.tagName,
        left: rect.left,
        right: rect.right,
      }));
    return {
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
  expect(result.offenders, JSON.stringify(result.offenders, null, 2)).toEqual([]);
  expect(result.scrollWidth).toBeLessThanOrEqual(result.viewportWidth);
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include(".job-center")
    .withTags(wcagTags)
    .analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

for (const viewport of [
  {
    name: "1280x800",
    width: 1280,
    height: 800,
    rootFontSize: 16,
    screenshot: "evidence/phase-3/job-center-1280x800.png",
  },
  {
    name: "480x360",
    width: 480,
    height: 360,
    rootFontSize: 16,
    screenshot: "evidence/phase-3/job-center-480x360.png",
  },
  {
    name: "320px-200-percent-text",
    width: 320,
    height: 800,
    rootFontSize: 32,
    screenshot: "evidence/phase-3/job-center-320px-200-percent-text.png",
  },
]) {
  test(`Job Center reflows without overflow at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(fixturePath);
    await expect(page.getByRole("heading", { name: "Job Center" })).toBeVisible();
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = `${fontSize}px`;
    }, viewport.rootFontSize);
    await page.evaluate(() => document.fonts.ready);

    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({ path: viewport.screenshot, animations: "disabled" });
  });
}

test("legacy cleanup keeps safe dialog focus and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto(fixturePath);
  const trigger = page.getByRole("button", { name: "Clear legacy preview cache" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Clear legacy preview cache?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep legacy cache" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("button", { name: "Clear legacy cache", exact: true }).click();
  await expect(page.getByRole("button", { name: "Legacy cache empty" })).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "Clear legacy preview cache?" })).toBeHidden();
  await expectNoHorizontalOverflow(page);
});

test("forced colors and reduced motion preserve state and layout", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto(fixturePath);
  await expectNoAxeViolations(page);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await expect(page.getByText("Pinned pressure")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const styles = await page.evaluate(() => {
    const job = document.querySelector<HTMLElement>(".job-state-blocked")!;
    const toggle = document.querySelector<HTMLElement>(".jobs-toggle")!;
    const spinner = document.querySelector<HTMLElement>(".spinner");
    return {
      jobBorder: getComputedStyle(job).borderInlineStartColor,
      toggleBackground: getComputedStyle(toggle).backgroundColor,
      toggleTransition: getComputedStyle(toggle).transitionDuration,
      spinnerAnimation: spinner === null ? "none" : getComputedStyle(spinner).animationName,
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
  expect(styles.forcedColors).toBe(true);
  expect(styles.reducedMotion).toBe(true);
  expect(styles.toggleTransition).toBe("0s");
  expect(styles.spinnerAnimation).toBe("none");
  expect(styles.jobBorder).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.toggleBackground).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: "evidence/phase-3/job-center-forced-colors-reduced-motion.png",
    animations: "disabled",
  });
});
