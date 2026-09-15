import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const evidence = "../../evidence/2026-09-14-p2-speed";
async function open(page: Page, state = "editable") {
  await page.goto(`/browser-tests/clip-inspector.html?speed=1&state=${state}`);
  await expect(page.getByRole("group", { name: "Speed", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
const input = (page: Page) => page.getByRole("spinbutton", { name: "Speed (%)" });
const apply = (page: Page) => page.getByRole("button", { name: "Apply speed", exact: true });
async function revision(page: Page, value: number, commits: number) {
  await expect(page.getByTestId("speed-revision")).toHaveText(`Revision: ${value}`);
  await expect(page.getByTestId("speed-commits")).toHaveText(`Commits: ${commits}`);
}

test("S9-01 keyboard draft, one Apply, reset and fixture undo", async ({ page }) => {
  await open(page);
  await expect(apply(page)).toBeDisabled();
  // Reach the real input through sequential keyboard navigation (no pointer).
  for (let count = 0; count < 30; count++) {
    await page.keyboard.press("Tab");
    if (await input(page).evaluate((element) => element === document.activeElement)) break;
  }
  await expect(input(page)).toBeFocused();
  const focus = await input(page).evaluate((element) => ({
    style: getComputedStyle(element).outlineStyle,
    width: parseFloat(getComputedStyle(element).outlineWidth),
  }));
  expect(focus.style).not.toBe("none");
  expect(focus.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("150");
  await expect(
    page.getByText("Resulting duration: 200 sequence frames", { exact: true }),
  ).toBeVisible();
  await revision(page, 0, 0);
  // Four preset buttons precede Apply.
  for (let count = 0; count < 5; count++) await page.keyboard.press("Tab");
  await expect(apply(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await revision(page, 1, 1);
  await expect(apply(page)).toBeDisabled();
  await expect(input(page)).toHaveValue("150");
  await expect(input(page)).toBeFocused();
  // Apply is disabled after adoption; four presets then Reset follow the input.
  for (let count = 0; count < 5; count++) await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Reset speed" })).toBeFocused();
  await page.keyboard.press("Space");
  await revision(page, 1, 1);
  await expect(input(page)).toHaveValue("100");
  await page.keyboard.press("Shift+Tab");
  await expect(apply(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await revision(page, 2, 2);
  await expect(input(page)).toBeFocused();
  await page.getByRole("button", { name: "Fixture undo", exact: true }).click();
  await revision(page, 3, 2);
  await expect(input(page)).toHaveValue("150");
});

test("S9-02 invalid, inexact, locked, pending and save-error states", async ({ page }) => {
  await open(page);
  for (const value of ["49", "201", "100.5", "101", ""]) {
    await input(page).fill(value);
    await expect(input(page)).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#clip-speed-error").getByRole("alert")).toBeVisible();
    await expect(apply(page)).toBeDisabled();
    await revision(page, 0, 0);
  }
  await open(page, "locked");
  await expect(input(page)).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
  await open(page, "saving");
  await expect(input(page)).toBeDisabled();
  await expect(page.getByRole("group", { name: "Speed", exact: true })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.getByText("Saving clip speed", { exact: true })).toBeVisible();
  await open(page, "error");
  await input(page).fill("150");
  for (let count = 0; count < 5; count++) await page.keyboard.press("Tab");
  await expect(apply(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input(page)).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("150");
  await expect(page.locator("#clip-speed-error")).toContainText("The saved revision changed");
  await revision(page, 0, 1);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("200");
  await expect(input(page)).toHaveValue("200");
  await expect(apply(page)).toBeEnabled();
});

test("S9-03 selection and external revision discard stale drafts", async ({ page }) => {
  await open(page);
  await input(page).fill("150");
  await page.getByRole("button", { name: "Fixture select next clip" }).click();
  await expect(page.getByRole("button", { name: "Fixture select next clip" })).toBeFocused();
  await expect(input(page)).not.toBeFocused();
  await expect(input(page)).toHaveValue("100");
  await input(page).fill("200");
  await page.getByRole("button", { name: "Fixture external revision" }).click();
  await expect(input(page)).toHaveValue("100");
  await revision(page, 1, 0);
  await expect(page.getByRole("button", { name: "Fixture external revision" })).toBeFocused();

  // A pending keyboard request must not follow a different selection.
  await input(page).fill("150");
  for (let count = 0; count < 5; count++) await page.keyboard.press("Tab");
  await expect(apply(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input(page)).toBeDisabled();
  await page.getByRole("button", { name: "Fixture select next clip" }).click();
  await revision(page, 2, 1);
  await expect(input(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Fixture select next clip" })).toBeFocused();

  // Pointer Apply must not leave a keyboard restoration request behind.
  await input(page).fill("200");
  await apply(page).click();
  await revision(page, 3, 2);
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).not.toBeFocused();
  await expect(apply(page)).not.toBeFocused();
  await page.getByRole("button", { name: "Fixture external revision" }).click();
  await expect(page.getByRole("button", { name: "Fixture external revision" })).toBeFocused();
  await expect(input(page)).not.toBeFocused();
});

for (const mode of ["desktop", "narrow", "text-200", "forced-colors-rtl"] as const) {
  test(`S9-04 rendered speed accessibility and overflow: ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: mode === "desktop" ? 1280 : 320, height: 800 });
    if (mode === "forced-colors-rtl")
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await open(page);
    if (mode === "text-200")
      await page.evaluate(() => {
        const elements = [
          document.documentElement,
          ...document.querySelectorAll<HTMLElement>("body *"),
        ];
        const sizes = elements.map((element) => parseFloat(getComputedStyle(element).fontSize));
        elements.forEach((element, index) => {
          element.style.fontSize = `${sizes[index]! * 2}px`;
        });
      });
    if (mode === "forced-colors-rtl")
      await page.evaluate(() => {
        document.documentElement.dir = "rtl";
      });
    await input(page).fill("150");
    await expect(apply(page)).toBeEnabled();
    await input(page).scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [
        ...document.querySelectorAll<HTMLElement>(".clip-inspector-panel, .clip-inspector-panel *"),
      ]
        .filter((element) => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && (r.left < -0.5 || r.right > width + 0.5);
        })
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          text: element.textContent?.slice(0, 80),
        }));
    });
    expect(overflow).toEqual([]);
    const axe = await new AxeBuilder({ page })
      .include(".clip-inspector-panel")
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({
      path: `${evidence}/step-9-${mode}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}
