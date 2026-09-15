import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function snapshot(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        workspaceEvidence: () => {
          revision: number;
          groups: number;
          invocations: number;
          state: {
            sequences: {
              tracks: {
                kind: string;
                clips: {
                  gainMilliDecibels: number;
                  fades: { inFrames: number; outFrames: number };
                  sourceIn: { value: number };
                  speed?: { numerator: number };
                  timelineStart: { value: number };
                }[];
              }[];
            }[];
          };
        };
      }
    ).workspaceEvidence(),
  );
}
test.afterEach(async ({ page }, info) => {
  await info.attach("final-canonical-evidence", {
    body: JSON.stringify(await snapshot(page), null, 2),
    contentType: "application/json",
  });
});
async function initialize(page: Page) {
  await page.goto("/browser-tests/video-workspace.html");
  await page.getByRole("button", { name: "Initialize workspace fixture" }).click();
  await expect(page.getByRole("heading", { name: "Canonical composition" })).toBeVisible();
  const first = page.getByRole("button", { name: /^Select / }).first();
  if ((await first.getAttribute("aria-pressed")) !== "true") await first.click();
}
test("populated controller controls commit once, discard stale drafts, bulk history and locked selection", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await initialize(page);
  const log: unknown[] = [];
  const checkpoint = async (name: string) => {
    const s = await snapshot(page);
    log.push({ name, ...s });
    return s;
  };
  const base = await checkpoint("import");
  await page.getByRole("spinbutton", { name: "Volume (dB)", exact: true }).fill("-6");
  await page.getByRole("spinbutton", { name: "Fade in (sequence frames)", exact: true }).fill("2");
  await page.getByRole("spinbutton", { name: "Fade out (sequence frames)", exact: true }).fill("3");
  expect((await snapshot(page)).groups).toBe(base.groups);
  await page.getByRole("button", { name: "Apply audio", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(base.revision + 1);
  expect((await snapshot(page)).groups).toBe(base.groups + 1);
  expect((await snapshot(page)).state.sequences[0]!.tracks[0]!.clips[0]).toMatchObject({
    gainMilliDecibels: -6000,
    fades: { inFrames: 2, outFrames: 3 },
  });
  await checkpoint("audio applied");
  await page.getByRole("button", { name: "Reset audio", exact: true }).click();
  expect((await snapshot(page)).groups).toBe(base.groups + 1);
  await page.getByRole("button", { name: "Apply audio", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(base.revision + 2);
  const sourceIn = page.getByRole("spinbutton", { name: /^Source in/ });
  await sourceIn.fill("5");
  await page.getByRole("button", { name: "Apply source range" }).click();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(base.revision + 3);
  await sourceIn.fill("8");
  const stale = await snapshot(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(sourceIn).toHaveValue("0");
  await expect(page.getByRole("button", { name: "Apply source range" })).toBeDisabled();
  expect((await snapshot(page)).groups).toBe(stale.groups);
  await checkpoint("stale source draft discarded by undo");
  await page.getByRole("button", { name: "Split fixture into two clips" }).click();
  const selects = page.getByRole("button", { name: /^Select / });
  await expect(selects).toHaveCount(2);
  if ((await selects.nth(0).getAttribute("aria-pressed")) !== "true")
    await selects.nth(0).click({ modifiers: ["Control"] });
  await selects.nth(1).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { name: "2 media clips selected" })).toBeVisible();
  const bulk = await snapshot(page);
  await page.getByRole("spinbutton", { name: "Common volume (dB)", exact: true }).fill("-3");
  expect((await snapshot(page)).groups).toBe(bulk.groups);
  await page.getByRole("button", { name: "Apply to selected clips" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("spinbutton", { name: "Common volume (dB)", exact: true }),
  ).toBeFocused();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(bulk.revision + 1);
  expect(
    (await snapshot(page)).state.sequences[0]!.tracks.flatMap((t) => t.clips).map(
      (c) => c.gainMilliDecibels,
    ),
  ).toEqual([-3000, -3000]);
  await checkpoint("bulk gain");
  await page.getByRole("spinbutton", { name: "Common speed (%)", exact: true }).fill("200");
  expect((await snapshot(page)).groups).toBe(bulk.groups + 1);
  await page.getByRole("button", { name: "Apply common speed" }).click();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(bulk.revision + 2);
  await page
    .getByRole("spinbutton", { name: "Relative move (sequence frames)", exact: true })
    .fill("5");
  await page.getByRole("button", { name: "Move selected clips" }).click();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(bulk.revision + 3);
  await checkpoint("bulk speed and move");
  await page
    .getByRole("button", { name: /track lock$/ })
    .first()
    .click();
  for (const name of [
    "Common volume (dB)",
    "Common fade in (frames)",
    "Common fade out (frames)",
    "Common speed (%)",
    "Relative move (sequence frames)",
  ]) {
    await expect(page.getByRole("spinbutton", { name, exact: true })).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: "Apply common speed" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply to selected clips" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move selected clips" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete 2 clips (undoable)", exact: true }),
  ).toBeDisabled();
  await checkpoint("locked selection blocks whole edit");
  await page
    .getByRole("button", { name: /track lock$/ })
    .first()
    .click();
  const beforeDelete = await snapshot(page);
  await page.getByRole("button", { name: "Delete 2 clips (undoable)", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(selects).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(selects).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(selects).toHaveCount(0);
  expect((await snapshot(page)).revision).toBe(beforeDelete.revision + 3);
  await checkpoint("delete undo redo");
  await info.attach("canonical-revisions-and-invocations", {
    body: JSON.stringify(log, null, 2),
    contentType: "application/json",
  });
});
test("populated 320px at 200% text, long labels, keyboard focus and scoped axe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await initialize(page);
  await expect(
    page
      .getByRole("region", { name: "Source range inspector", exact: true })
      .getByText(/LongUnbrokenInterviewRecordingName/),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.getByRole("button", { name: "Split fixture into two clips" }).click();
  const selects = page.getByRole("button", { name: /^Select / });
  await expect(selects).toHaveCount(2);
  await selects.nth(1).click({ modifiers: ["Control"] });
  await expect(page.getByRole("heading", { name: "2 media clips selected" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflowing: Array.from(document.querySelectorAll("*"))
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent?.slice(0, 55),
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
      }))
      .filter((rect) => rect.right > innerWidth + 1 || rect.left < -1)
      .slice(0, 40),
  }));
  await test.info().attach("reflow-measurements", {
    body: JSON.stringify(layout, null, 2),
    contentType: "application/json",
  });
  expect(layout.scroll <= layout.width).toBe(true);
  await page.getByRole("spinbutton", { name: "Common volume (dB)", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("spinbutton", { name: "Common fade in (frames)", exact: true }),
  ).toBeFocused();
  const axe = await new AxeBuilder({ page }).include('[aria-label="Editing controls"]').analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: "../../evidence/2026-09-14-p2-editor-controls/workspace-320-text200.png",
    fullPage: true,
  });
});
