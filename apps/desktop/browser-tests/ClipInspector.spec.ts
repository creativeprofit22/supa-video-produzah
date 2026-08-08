import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/browser-tests/clip-inspector.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

const viewports = [
  {
    name: "desktop",
    width: 1280,
    height: 800,
    screenshot: "evidence/phase-4/clip-inspector-desktop-1280x800.png",
    stackedIdentity: false,
  },
  {
    name: "narrow",
    width: 320,
    height: 800,
    screenshot: "evidence/phase-4/clip-inspector-narrow-320x800.png",
    stackedIdentity: true,
  },
] as const;

type FixtureState = "editable" | "locked" | "saving" | "error";

async function openFixture(page: Page, state: FixtureState = "editable") {
  await page.goto(`${fixturePath}?state=${state}`);
  await expect(page.getByRole("heading", { name: "Clip inspector" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) => rect.width > 0 && (rect.left < -0.5 || rect.right > viewportWidth + 0.5),
      )
      .map(({ element, rect }) => ({
        tagName: element.tagName,
        className: element.getAttribute("class"),
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
    .include(".clip-inspector-panel")
    .withTags(wcagTags)
    .analyze();
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

for (const viewport of viewports) {
  test(`renders the editable layout with axe, focus, and overflow coverage at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openFixture(page);

    const slider = page.getByRole("slider", { name: "Opacity" });
    await expect(slider).toHaveAttribute("aria-valuetext", "42.5%");
    await expect(page.locator(".opacity-control-heading output")).toHaveText("42.5%");

    const identityRows = await page.locator(".clip-inspector-identity > div").evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { top: rect.top, left: rect.left };
      }),
    );
    if (viewport.stackedIdentity) {
      expect(identityRows[1]!.top).toBeGreaterThan(identityRows[0]!.top);
    } else {
      expect(Math.abs(identityRows[1]!.top - identityRows[0]!.top)).toBeLessThan(1);
      expect(identityRows[1]!.left).toBeGreaterThan(identityRows[0]!.left);
    }

    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);

    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    const focusStyles = await slider.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        outlineOffset: styles.outlineOffset,
      };
    });
    expect(focusStyles.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(focusStyles.outlineWidth)).toBeGreaterThanOrEqual(2);
    expect(Number.parseFloat(focusStyles.outlineOffset)).toBeGreaterThanOrEqual(2);

    await page.screenshot({ path: viewport.screenshot, animations: "disabled" });
  });

  test(`supports keyboard percentage changes and announcements at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openFixture(page);

    const panel = page.locator(".clip-inspector-panel");
    const slider = page.getByRole("slider", { name: "Opacity" });
    const percentage = page.locator(".opacity-control-heading output");
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue("426");
    await expect(slider).toHaveAttribute("aria-valuetext", "42.6%");
    await expect(percentage).toHaveText("42.6%");

    await page.keyboard.press("Home");
    await expect(slider).toHaveValue("0");
    await expect(slider).toHaveAttribute("aria-valuetext", "0.0%");
    await expect(percentage).toHaveText("0.0%");

    await page.keyboard.press("ArrowUp");
    await expect(slider).toHaveValue("1");
    await expect(slider).toHaveAttribute("aria-valuetext", "0.1%");
    await expect(percentage).toHaveText("0.1%");

    await page.keyboard.press("Enter");
    await expect(panel).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status").filter({ hasText: "Saving opacity" })).toBeVisible();
    await expect(slider).toBeDisabled();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-valuetext", "0.1%");
    await expectNoHorizontalOverflow(page);
  });

  test(`exposes locked, saving, and error states at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await openFixture(page, "locked");
    const lockedSlider = page.getByRole("slider", { name: "Opacity" });
    await expect(lockedSlider).toBeDisabled();
    await expect(lockedSlider).toHaveAttribute("aria-describedby", "clip-opacity-locked");
    await expect(page.getByText("Unlock this track to change clip opacity.")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);

    await openFixture(page, "saving");
    await expect(page.locator(".clip-inspector-panel")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("slider", { name: "Opacity" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Saving opacity" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);

    await openFixture(page, "error");
    const alert = page.getByRole("alert");
    await expect(alert.getByText("Could not save opacity")).toBeVisible();
    await expect(
      alert.getByText("The saved revision changed. Review the current clip and try again."),
    ).toBeVisible();
    await expect(page.getByRole("slider", { name: "Opacity" })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
  });
}
