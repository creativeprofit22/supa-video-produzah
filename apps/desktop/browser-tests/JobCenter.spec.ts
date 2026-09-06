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

test("blocked final export exposes a keyboard-operable destination reauthorization action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto(fixturePath);
  const action = page.getByRole("button", { name: "Choose destination and retry" });
  await action.scrollIntoViewIfNeeded();
  await action.focus();
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
  const finalExport = page.getByRole("article", { name: "Export current saved revision" });
  await expect(finalExport.getByText("Queued", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
});

test("older-page loading preserves focus, merges equal timestamps once, and announces the count", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install({ time: new Date("2026-09-05T00:00:00Z") });
  await page.goto(`${fixturePath}?pagination=pending`);
  const loadOlder = page.getByRole("button", { name: "Load older jobs" });
  await loadOlder.focus();
  await expect(loadOlder).toBeFocused();
  await page.clock.pauseAt(new Date("2026-09-05T01:00:00Z"));
  await page.keyboard.press("Enter");
  const pending = page.getByRole("button", { name: "Loading older jobs" });
  // Regression: observer latency must not consume the fixture's 300ms loading window.
  await new Promise((resolve) => setTimeout(resolve, 350));
  await expect(pending).toBeDisabled();
  await page.screenshot({
    path: "evidence/phase-3/job-center-pagination-pending-1280x800.png",
    animations: "disabled",
  });
  await page.clock.runFor(300);
  const complete = page.getByRole("button", { name: "All jobs loaded" });
  await expect(complete).toBeVisible();
  await expect(complete).toBeDisabled();
  await expect(page.getByText("All available jobs are shown.", { exact: true })).toBeFocused();
  await expect(page.getByText("1 older job loaded. All available jobs are shown.")).toBeAttached();

  const parentTitleIds = await page
    .locator(".job-list > .job-item article")
    .evaluateAll((articles) => articles.map((article) => article.getAttribute("aria-labelledby")));
  expect(parentTitleIds).toEqual([
    "job-70000000-0000-4000-8000-000000000084-title",
    "job-70000000-0000-4000-8000-000000000080-title",
    "job-70000000-0000-4000-8000-000000000079-title",
  ]);
  expect(new Set(parentTitleIds).size).toBe(parentTitleIds.length);
  await page.clock.resume();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
});

test("older-page failure keeps the ledger and retries at 480x360", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto(`${fixturePath}?pagination=failure`);
  await expect(page.locator(".job-list > .job-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Load older jobs" }).click();
  await expect(page.getByText("Older jobs could not be loaded.")).toBeVisible();
  await expect(page.locator(".job-list > .job-item")).toHaveCount(2);
  await page.screenshot({
    path: "evidence/phase-3/job-center-pagination-failure-480x360.png",
    animations: "disabled",
  });
  const retry = page.getByRole("button", { name: "Retry loading older jobs" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "All jobs loaded" })).toBeVisible();
  await expect(page.locator(".job-list > .job-item")).toHaveCount(3);
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
});

test("child-only pages keep older parent jobs keyboard-reachable at 320px and 200% text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${fixturePath}?pagination=children-only`);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await page.evaluate(() => document.fonts.ready);

  await expect(page.getByText("No media jobs yet")).toHaveCount(0);
  await expect(page.getByText("Parent jobs are not loaded yet")).toBeVisible();
  const loadParentJobs = page.getByRole("button", {
    name: "Load older work to show parent jobs",
  });
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
  await loadParentJobs.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "evidence/phase-3/job-center-child-only-pagination-320px-200-percent-text.png",
    animations: "disabled",
  });

  await loadParentJobs.focus();
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("heading", { name: /Prepare preview for launch-film/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "All jobs loaded" })).toBeDisabled();
  await expect(page.getByText("All available jobs are shown.", { exact: true })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
});

test("empty and no-more pagination states remain explicit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixturePath}?pagination=empty`);
  await expect(page.getByText("No media jobs yet")).toBeVisible();
  await expect(page.getByRole("button", { name: /older jobs|All jobs loaded/ })).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${fixturePath}?pagination=no-more`);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(page.getByRole("button", { name: "All jobs loaded" })).toBeDisabled();
  await expect(page.getByText("All available jobs are shown.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
  await page.screenshot({
    path: "evidence/phase-3/job-center-pagination-no-more-320px-200-percent-text.png",
    animations: "disabled",
  });
});

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
