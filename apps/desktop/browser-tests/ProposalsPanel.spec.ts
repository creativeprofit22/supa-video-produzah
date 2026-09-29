import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/proposals-panel.html";
const evidence = "../../evidence/2026-09-29-p3-agent-proposals";

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

/** Uses only the keyboard: find filler words, untick the first cut, apply. */
async function reviewWithKeyboard(page: Page) {
  const find = page.getByRole("button", { name: "Find filler words" });
  await expect(find).toBeEnabled();
  await find.focus();
  await page.keyboard.press("Enter");
  const group = page.getByRole("group", { name: "Filler words: 2 cuts" });
  await expect(group).toBeVisible();
  await expect(page.getByTestId("fixture-ranges")).toHaveText("5-9:y 15-19:y");

  const first = group.getByRole("checkbox", { name: /"um"/ });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).not.toBeChecked();
  await expect(page.getByTestId("fixture-ranges")).toHaveText("5-9:n 15-19:y");
  return group;
}

test("proposal review works by keyboard and passes axe", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixturePath);
  const group = await reviewWithKeyboard(page);

  const results = await new AxeBuilder({ page })
    .include(".proposals-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
  await page.locator(".proposals-panel").screenshot({ path: `${evidence}/proposals-review.png` });

  const apply = group.getByRole("button", { name: "Apply 1 of 2" });
  await apply.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".proposals-panel").getByRole("status")).toContainText(
    "Proposal applied",
  );
  await expect(page.getByTestId("fixture-log")).toHaveText("edit:1");
  const restore = page.getByRole("button", { name: "Restore to before" });
  await restore.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".proposals-panel").getByRole("status")).toContainText(
    "Restored to before this proposal",
  );
});

test("proposal review reflows at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(fixturePath);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expectNoHorizontalOverflow(page);
  await reviewWithKeyboard(page);
  await expectNoHorizontalOverflow(page);
  await page.locator(".proposals-panel").screenshot({
    path: `${evidence}/proposals-320px-200-percent-text.png`,
  });
});
