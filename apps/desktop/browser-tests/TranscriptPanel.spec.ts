import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/transcript-panel.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];
const evidence = "../../evidence/2026-09-28-p3-transcription-audio";

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
    return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  });
  expect(result.offenders, JSON.stringify(result.offenders, null, 2)).toEqual([]);
  expect(result.scrollWidth).toBeLessThanOrEqual(result.viewportWidth);
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include(".transcript-panel")
    .withTags(wcagTags)
    .analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

async function focusAndPress(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
}

/** Keyboard-only: runtime → license → transcribe → select words → remove / captions. */
async function completeFlowWithKeyboard(page: Page) {
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Transcribe", exact: true })).toBeDisabled();

  await focusAndPress(page, "Choose runtime folder");
  await focusAndPress(page, "Review license");
  const dialog = page.getByRole("dialog", { name: "Speech model license" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "OpenMDW-1.1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Review license" })).toBeFocused();

  await focusAndPress(page, "Review license");
  await focusAndPress(page, "Accept license");
  await expect(page.getByRole("button", { name: "Withdraw license acceptance" })).toBeVisible();

  await focusAndPress(page, "Transcribe");
  await expect(page.getByRole("button", { name: "Cancel transcription" })).toBeVisible();
  const firstWord = page.getByRole("button", { name: "And", exact: true });
  await expect(firstWord).toBeVisible();

  await firstWord.focus();
  await page.keyboard.press("Space");
  await expect(firstWord).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "so,", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await focusAndPress(page, "Remove 2 selected words");
  await expect(page.getByTestId("fixture-log")).toHaveText("remove:2");

  await focusAndPress(page, "Generate captions");
  await expect(page.getByTestId("fixture-log")).toHaveText("captions");
}

test("transcript panel is fully keyboard operable from setup to captions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixturePath);
  await completeFlowWithKeyboard(page);
  await expectNoAxeViolations(page);
  await page.screenshot({ path: `${evidence}/transcript-panel-1280x800.png` });
});

test("transcript panel reflows at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await page.evaluate(() => document.fonts.ready);

  await expectNoHorizontalOverflow(page);
  await completeFlowWithKeyboard(page);
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
  await page.screenshot({
    path: `${evidence}/transcript-panel-320px-200-percent-text.png`,
    fullPage: true,
  });
});

test("license dialog reflows at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await focusAndPress(page, "Review license");
  await expect(page.getByRole("dialog", { name: "Speech model license" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `${evidence}/transcript-license-320px-200-percent-text.png` });
});
