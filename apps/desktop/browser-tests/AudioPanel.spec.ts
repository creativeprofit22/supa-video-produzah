import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/audio-panel.html";
const evidence = "../../evidence/2026-09-28-p3-transcription-audio";

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) => rect.width > 0 && (rect.left < -0.5 || rect.right > viewportWidth + 0.5),
      )
      .map(({ element }) => `${element.tagName}.${element.className}`);
    return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  });
  expect(result.offenders).toEqual([]);
  expect(result.scrollWidth).toBeLessThanOrEqual(result.viewportWidth);
}

async function useKeyboardToSetUpMix(page: Page) {
  const log = page.getByTestId("fixture-log");
  // Ducking needs a dialogue track first; the panel says so instead of failing silently.
  const ducking = page.getByRole("checkbox", { name: "Lower music while dialogue plays" });
  await ducking.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("alert")).toHaveText(
    "Mark a track as Dialogue before turning on ducking.",
  );

  await page.getByRole("combobox", { name: "Interview camera" }).selectOption("dialogue");
  await expect(log).toHaveText("role:dialogue");
  await page.getByRole("combobox", { name: "Soundtrack" }).selectOption("music");
  await expect(log).toHaveText("role:music");
  await expect(page.getByRole("combobox", { name: "Captions" })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Target" }).selectOption("-14");
  await expect(log).toHaveText("target:-14:-:-");
  await ducking.focus();
  await page.keyboard.press("Space");
  await expect(log).toHaveText("target:-14:duck:-");
  const cleanup = page.getByRole("checkbox", { name: "Clean up dialogue (rumble and hiss)" });
  await cleanup.focus();
  await page.keyboard.press("Space");
  await expect(log).toHaveText("target:-14:duck:clean");
}

test("audio panel sets roles, target, ducking and cleanup, and explains a failed export", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixturePath);
  await useKeyboardToSetUpMix(page);

  const report = page.getByRole("region", { name: "Last export loudness" });
  await expect(report.getByRole("status")).toHaveText("Missed the loudness target.");
  await expect(report).toContainText("-17.6 LUFS");
  await expect(report).toContainText("-0.4 dBTP");
  await expect(report).toContainText("Dynamic (range was too wide for even gain)");
  await expect(report).toContainText("The mix already clipped before normalization.");

  const results = await new AxeBuilder({ page })
    .include(".audio-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
});

test("audio panel reflows at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(fixturePath);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expectNoHorizontalOverflow(page);
  await useKeyboardToSetUpMix(page);
  await expectNoHorizontalOverflow(page);
  await page.locator(".audio-panel").screenshot({
    path: `${evidence}/audio-panel-320px-200-percent-text.png`,
  });
});
