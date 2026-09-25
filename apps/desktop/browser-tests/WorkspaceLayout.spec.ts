import { expect, test } from "@playwright/test";

test("LAYOUT-B01 keyboard persistence and narrow/text reflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/browser-tests/workspace-layout.html");
  const separator = page.getByRole("separator", { name: "Workspace pane width" });
  await separator.focus();
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "25");
  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", "25");
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(separator).toHaveAttribute("aria-valuenow", "68.5");
  // Just above the 60rem container threshold: 25% is narrower than 18rem.
  await page.locator(".workspace-layout").evaluate((el) => {
    (el as HTMLElement).style.width = "961px";
  });
  await separator.focus();
  await page.keyboard.press("Home");
  const geometry = async () =>
    page.locator(".workbench-grid").evaluate((el) => {
      const pane = el.firstElementChild!.getBoundingClientRect();
      return (pane.width / (el.getBoundingClientRect().width - 16)) * 100;
    });
  await expect
    .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
    .toBeCloseTo((288 / 945) * 100, 1);
  expect(Number(await separator.getAttribute("aria-valuenow"))).toBeCloseTo(await geometry(), 1);
  const beforeArrow = await geometry();
  await page.keyboard.press("ArrowRight");
  await expect.poll(geometry).toBeCloseTo(beforeArrow + 1, 1);
  await page.locator(".workspace-layout").evaluate((el) => {
    (el as HTMLElement).style.width = "";
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(separator).toBeHidden();
  await expect(page.getByRole("button", { name: "Choose source" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Reset layout" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeFocused();
  await page.screenshot({
    path: "../../evidence/2026-09-16-p2-editor-controls-completion/layout-320-text200.png",
    fullPage: true,
  });
});
