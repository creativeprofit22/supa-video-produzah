import AxeBuilder from "@axe-core/playwright";
import { evidencePath } from "./evidence-path";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/transcript-panel.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];
const evidenceDir = "2026-09-28-p3-transcription-audio";

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

  await expect(page.getByRole("heading", { name: "Speaker 1", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unknown speaker", level: 3 })).toBeVisible();

  // Seek from the keyboard: Tab from a word reaches its seek button.
  await firstWord.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Seek to And at 0:00.00" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Seek to so, at 0:00.40" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fixture-log")).toHaveText("seek:4");
  await expect(page.getByRole("button", { name: "so,", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await firstWord.focus();
  await page.keyboard.press("Space");
  await expect(firstWord).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "so,", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Remove opens a review of the proposed cut; nothing is applied yet.
  const logBefore = await page.getByTestId("fixture-log").textContent();
  await focusAndPress(page, "Remove 2 selected words");
  const review = page.getByRole("dialog", { name: "Review cut" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Removes 2 words");
  await expect(review.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("fixture-log")).toHaveText(logBefore ?? "");
  await expectNoAxeViolations(page);
  // Escape keeps editing and returns focus to the Remove button.
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove 2 selected words" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Apply cut" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fixture-log")).toHaveText("remove:2");
  await expect(review).toBeHidden();

  await focusAndPress(page, "Generate captions");
  await expect(page.getByTestId("fixture-log")).toHaveText("captions");
}

test("transcript panel is fully keyboard operable from setup to captions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixturePath);
  await completeFlowWithKeyboard(page);
  await expectNoAxeViolations(page);
  await page.screenshot({ path: evidencePath(evidenceDir, `transcript-panel-1280x800.png`) });
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
    path: evidencePath(evidenceDir, `transcript-panel-320px-200-percent-text.png`),
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
  await page.screenshot({
    path: evidencePath(evidenceDir, `transcript-license-320px-200-percent-text.png`),
  });
});

async function reachCaptions(page: Page) {
  await focusAndPress(page, "Choose runtime folder");
  await focusAndPress(page, "Review license");
  await focusAndPress(page, "Accept license");
  await focusAndPress(page, "Transcribe");
  await expect(page.getByRole("button", { name: "And", exact: true })).toBeVisible();
  await focusAndPress(page, "Generate captions");
  await expect(page.getByRole("heading", { name: "Caption style" })).toBeVisible();
}

test("captions panel restyles and nudges cues from the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixturePath);
  await reachCaptions(page);

  const size = page.getByLabel("Size (px)");
  await size.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("fixture-log")).toHaveText("caption-edit:50");

  const cues = page.getByRole("list", { name: "Caption cues" }).getByRole("listitem");
  await expect(cues.first()).toBeVisible();
  const laterEnd = cues.first().getByRole("button", { name: /^End one frame later/u });
  await laterEnd.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fixture-log")).toHaveText("caption-edit:50");

  // Pulling the start past the end is rejected with a readable reason.
  const earlierEnd = cues.first().getByRole("button", { name: /^End one frame earlier/u });
  for (let press = 0; press < 80; press += 1) {
    await earlierEnd.press("Enter");
    if (await page.getByRole("alert").isVisible()) break;
  }
  await expect(page.getByRole("alert")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".captions-panel")
    .withTags(wcagTags)
    .analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
});

test("captions panel reflows at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await reachCaptions(page);
  await expectNoHorizontalOverflow(page);
  await page.locator(".captions-panel").screenshot({
    path: evidencePath(evidenceDir, `captions-panel-320px-200-percent-text.png`),
  });
});

test("captions panel exports SRT, VTT and ASS sidecar files", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixturePath);
  await reachCaptions(page);
  for (const [format, header] of [
    ["SRT", "srt:1"],
    ["VTT", "vtt:WEBVTT"],
    ["ASS", "ass:[Script Info]"],
  ] as const) {
    await focusAndPress(page, `Export ${format}`);
    await expect(page.getByTestId("fixture-log")).toHaveText(`subtitles:${header}`);
    await expect(page.locator(".captions-panel").getByRole("status")).toHaveText(
      `Saved ${format} subtitles.`,
    );
  }
});
