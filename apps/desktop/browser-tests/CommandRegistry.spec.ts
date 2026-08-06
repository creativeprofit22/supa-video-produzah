import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/command-registry.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

function shortcutRow(page: Page, label: string) {
  return page.locator(".shortcut-row").filter({ has: page.locator("strong", { hasText: label }) });
}

test("remaps, rejects collisions, clears, restores focus, and persists", async ({ page }) => {
  await page.goto(fixturePath);
  const trigger = page.getByRole("button", { name: "Keyboard shortcuts" });
  const selectedClip = page.getByRole("button", { name: /Selected clip target/ });
  await trigger.focus();
  await page.keyboard.press("Control+,");

  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();

  const splitRow = shortcutRow(page, "Split selected clip at playhead");
  await splitRow
    .getByRole("button", {
      name: "Change shortcut for Split selected clip at playhead",
    })
    .click();
  await expect(
    splitRow.getByRole("button", {
      name: "Record shortcut for Split selected clip at playhead",
    }),
  ).toBeFocused();
  await page.keyboard.press("Control+Alt+K");
  await expect(splitRow.locator("kbd")).toHaveText("Ctrl+Alt+K");
  await expect(selectedClip).toHaveAttribute("aria-keyshortcuts", "Control+Alt+K");

  await page.getByRole("button", { name: "Close" }).click();
  await expect(trigger).toBeFocused();
  await selectedClip.focus();
  await page.keyboard.press("Control+Alt+K");
  await expect(page.getByText("Executed 1 times")).toBeVisible();
  await page.keyboard.press("S");
  await expect(page.getByText("Executed 1 times")).toBeVisible();

  await trigger.click();
  await splitRow
    .getByRole("button", {
      name: "Change shortcut for Split selected clip at playhead",
    })
    .click();
  await page.keyboard.press("Control+Z");
  await expect(
    splitRow.getByText(
      "Split selected clip at playhead conflicts with Undo last edit. The current shortcut was not changed.",
    ),
  ).toBeVisible();
  await expect(
    splitRow.getByRole("button", {
      name: "Record shortcut for Split selected clip at playhead",
    }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await splitRow
    .getByRole("button", {
      name: "Clear shortcut for Split selected clip at playhead",
    })
    .click();
  await expect(splitRow.getByText("Off", { exact: true })).toBeVisible();
  await expect(selectedClip).not.toHaveAttribute("aria-keyshortcuts");
  await page.getByRole("button", { name: "Close" }).click();
  await selectedClip.focus();
  await page.keyboard.press("Control+Alt+K");
  await expect(page.getByText("Executed 1 times")).toBeVisible();

  await trigger.click();
  await splitRow
    .getByRole("button", {
      name: "Reset shortcut for Split selected clip at playhead",
    })
    .click();
  await expect(splitRow.locator("kbd")).toHaveText("S");
  await splitRow
    .getByRole("button", {
      name: "Change shortcut for Split selected clip at playhead",
    })
    .click();
  await page.keyboard.press("Control+Alt+K");
  await page.getByRole("button", { name: "Close" }).click();

  await page.reload();
  await expect(selectedClip).toHaveAttribute("aria-keyshortcuts", "Control+Alt+K");
  await selectedClip.focus();
  await page.keyboard.press("Control+Alt+K");
  await expect(page.getByText("Executed 1 times")).toBeVisible();
});

for (const visualCase of [
  { name: "320px with 200% text", width: 320, height: 900, rootFontSize: 32 },
  { name: "forced colors", width: 1280, height: 800, forcedColors: true },
  { name: "RTL and long labels", width: 760, height: 900, direction: "rtl", longLabel: true },
  { name: "reduced motion", width: 1280, height: 800, reducedMotion: true },
] as const) {
  test(`keeps the shortcut editor accessible at ${visualCase.name}`, async ({ page }) => {
    await page.setViewportSize({ width: visualCase.width, height: visualCase.height });
    if ("forcedColors" in visualCase) await page.emulateMedia({ forcedColors: "active" });
    if ("reducedMotion" in visualCase) await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixturePath);
    await page.evaluate(
      ({ direction, rootFontSize }) => {
        document.documentElement.dir = direction ?? "ltr";
        if (rootFontSize !== undefined)
          document.documentElement.style.fontSize = `${rootFontSize}px`;
      },
      {
        direction: "direction" in visualCase ? visualCase.direction : undefined,
        rootFontSize: "rootFontSize" in visualCase ? visualCase.rootFontSize : undefined,
      },
    );
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();

    if ("longLabel" in visualCase) {
      await page
        .locator(".shortcut-row strong")
        .first()
        .evaluate((element) => {
          element.textContent =
            "Extrem lange lokalisierte Bezeichnung für die Anwendungseinstellungen und Tastaturkurzbefehle";
        });
    }
    await expectNoDocumentOverflow(page);
    const dialogGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(dialogGeometry.left).toBeGreaterThanOrEqual(0);
    expect(dialogGeometry.right).toBeLessThanOrEqual(dialogGeometry.viewportWidth);
    expect(dialogGeometry.scrollWidth).toBeLessThanOrEqual(dialogGeometry.clientWidth);

    let axeBuilder = new AxeBuilder({ page }).include(".shortcut-dialog").withTags(wcagTags);
    if ("forcedColors" in visualCase) axeBuilder = axeBuilder.disableRules(["color-contrast"]);
    const axe = await axeBuilder.analyze();
    expect(axe.violations, axe.violations.map(({ id }) => id).join(", ")).toEqual([]);
  });
}
