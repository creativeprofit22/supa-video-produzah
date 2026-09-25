import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { assertForcedTextContrast, forcedTextContrast } from "./forced-colors-contrast";
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
    path: "../../evidence/2026-09-16-p2-editor-controls-completion/workspace-320-text200.png",
    fullPage: true,
  });
  const bulk = page.getByRole("region", { name: "Multiple clip controls", exact: true });
  expect(await bulk.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await bulk.screenshot({
    path: "../../evidence/2026-09-16-p2-editor-controls-completion/bulk-text-200.png",
  });
});

for (const mode of ["desktop", "text-200", "forced-colors-rtl"] as const) {
  test(`completion keyboard audio/source names, Reset, errors and focus: ${mode}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: mode === "desktop" ? 1440 : 320, height: 1000 });
    if (mode === "forced-colors-rtl")
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await initialize(page);
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
    // Initialization selects synthetic media; all control navigation below is sequential keyboard input.
    const tabTo = async (target: ReturnType<Page["getByRole"]>) => {
      for (let count = 0; count < 100; count++) {
        await page.keyboard.press("Tab");
        if (await target.evaluate((element) => element === document.activeElement)) break;
      }
      await expect(target).toBeFocused();
      const outline = await target.evaluate((element) => getComputedStyle(element).outlineStyle);
      expect(outline).not.toBe("none");
    };
    const type = async (value: string) => {
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(value);
    };
    const audio = page.getByRole("region", { name: "Clip audio inspector", exact: true });
    const gain = audio.getByRole("spinbutton", { name: "Volume (dB)", exact: true });
    const applyAudio = audio.getByRole("button", { name: "Apply audio", exact: true });
    const baseline = await snapshot(page);
    await tabTo(gain);
    await type("25");
    await expect(audio.getByRole("alert")).toContainText("Volume must be");
    await expect(applyAudio).toBeDisabled();
    expect((await snapshot(page)).revision).toBe(baseline.revision);
    await type("-6");
    await page.keyboard.press("Tab");
    await expect(
      audio.getByRole("spinbutton", { name: "Fade in (sequence frames)", exact: true }),
    ).toBeFocused();
    await type("2");
    await page.keyboard.press("Tab");
    await expect(
      audio.getByRole("spinbutton", { name: "Fade out (sequence frames)", exact: true }),
    ).toBeFocused();
    await type("3");
    await tabTo(applyAudio);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await snapshot(page)).revision).toBe(baseline.revision + 1);
    await expect(gain).toBeFocused();
    await tabTo(audio.getByRole("button", { name: "Reset audio", exact: true }));
    await page.keyboard.press("Space");
    await expect(gain).toHaveValue("0");
    expect((await snapshot(page)).revision).toBe(baseline.revision + 1);
    await page.keyboard.press("Tab");
    await expect(applyAudio).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await snapshot(page)).revision).toBe(baseline.revision + 2);
    await expect(gain).toBeFocused();

    const source = page.getByRole("region", { name: "Source range inspector", exact: true });
    const sourceIn = source.getByRole("spinbutton", { name: /^Source in/ });
    const applySource = source.getByRole("button", { name: "Apply source range", exact: true });
    await tabTo(sourceIn);
    await type("-1");
    await expect(sourceIn).toHaveAttribute("aria-invalid", "true");
    await expect(sourceIn).toHaveAttribute("aria-describedby", "source-range-status");
    await expect(source.getByRole("status")).not.toHaveText(
      "Timeline start and later clips stay in place.",
    );
    await expect(applySource).toBeDisabled();
    await type("5");
    await tabTo(source.getByRole("button", { name: "Reset draft", exact: true }));
    await page.keyboard.press("Space");
    await expect(sourceIn).toHaveValue("0");
    expect((await snapshot(page)).revision).toBe(baseline.revision + 2);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(sourceIn).toBeFocused();
    await type("5");
    await tabTo(applySource);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await snapshot(page)).revision).toBe(baseline.revision + 3);
    await expect(sourceIn).toBeFocused();
    await expect(sourceIn).toHaveValue("5");
    await expect(applySource).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const scan = new AxeBuilder({ page }).include('[aria-label="Editing controls"]');
    if (mode === "forced-colors-rtl") {
      // Separately authorized replacement for axe's unforced WebKit fill measurement.
      // All other scanner rules remain active; normal modes retain axe contrast too.
      scan.disableRules(["color-contrast"]);
      await assertForcedTextContrast(page, '[aria-label="Editing controls"]');
      await page.evaluate(() => {
        const control = document.createElement("p");
        control.id = "contrast-negative-control";
        control.textContent = "Deliberately insufficient contrast";
        control.style.cssText =
          "forced-color-adjust:none;color:#eeeeee;background:#ffffff;font-size:16px;font-weight:400";
        document.body.append(control);
      });
      try {
        const bad = await forcedTextContrast(page, "#contrast-negative-control");
        expect(bad).toHaveLength(1);
        expect(bad[0]!.required).toBe(4.5);
        expect(bad[0]!.ratio).toBeLessThan(4.5);
        await expect(
          assertForcedTextContrast(page, "#contrast-negative-control"),
        ).rejects.toThrow();
      } finally {
        await page.locator("#contrast-negative-control").evaluate((element) => element.remove());
      }
    }
    expect((await scan.analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `../../evidence/2026-09-16-p2-editor-controls-completion/controls-${mode}.png`,
      fullPage: true,
      animations: "disabled",
    });
    for (const [name, region] of [
      ["audio", audio],
      ["source", source],
    ] as const) {
      expect(
        await region.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `${name} panel must not clip its contents`,
      ).toBe(true);
      await region.screenshot({
        path: `../../evidence/2026-09-16-p2-editor-controls-completion/${name}-${mode}.png`,
        animations: "disabled",
      });
    }
  });
}
