import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const fixturePath = "/browser-tests/multitrack-timeline.html";
const wcagTags = ["wcag2a", "wcag2aa", "wcag22aa"];

async function expectContained(inner: Locator, outer: Locator) {
  const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(outerBox!.x + outerBox!.width + 1);
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
}

async function expectReadableAlignedTrackLabels(labels: Locator, rows: Locator) {
  const [labelMetrics, rowHeights] = await Promise.all([
    labels.evaluateAll((elements) =>
      elements.map((label) => {
        const labelRect = label.getBoundingClientRect();
        const content = Array.from(
          label.querySelectorAll<HTMLElement>("span, strong, small, button"),
        );
        const clippedContent = content
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              element.scrollWidth > element.clientWidth + 1 ||
              rect.left < labelRect.left - 1 ||
              rect.right > labelRect.right + 1 ||
              rect.top < labelRect.top - 1 ||
              rect.bottom > labelRect.bottom + 1
            );
          })
          .map((element) => element.textContent?.trim() ?? "");
        return {
          label: label.textContent?.replace(/\s+/g, " ").trim() ?? "",
          height: labelRect.height,
          clippedContent,
          containerClipped: label.scrollHeight > label.clientHeight + 1,
        };
      }),
    ),
    rows.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    ),
  ]);

  expect(
    labelMetrics.flatMap(({ label, clippedContent, containerClipped }) =>
      containerClipped || clippedContent.length > 0 ? [{ label, clippedContent }] : [],
    ),
    "Track label text must fit without clipping or overlap",
  ).toEqual([]);
  expect(
    labelMetrics.map(({ height }) => height),
    "Label and timeline rows must remain vertically aligned",
  ).toEqual(rowHeights);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800, rootFontSize: 16 },
  { name: "mobile", width: 390, height: 844, rootFontSize: 16 },
  { name: "320px with 200% text", width: 320, height: 900, rootFontSize: 32 },
]) {
  test(`renders bounded accessible clip editing at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(fixturePath);
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = `${fontSize}px`;
    }, viewport.rootFontSize);
    await page.evaluate(() => document.fonts.ready);

    const timeline = page.locator(".multitrack-panel");
    const region = page.getByRole("region", { name: "Timeline tracks; scroll horizontally" });
    await expect(timeline).toBeVisible();
    await expect(region).toBeVisible();
    const labels = page.locator(".multitrack-visible-label");
    const rows = page.locator(".multitrack-track-row");
    await expect(labels).toHaveCount(3);
    await expect(rows).toHaveCount(3);
    await expectReadableAlignedTrackLabels(labels, rows);
    if (viewport.width === 320) {
      await expect(rows.first()).toHaveCSS("height", "224px");
      const controls = labels.first().locator(".multitrack-track-controls > button");
      const [muteBox, lockBox] = await Promise.all([
        controls.nth(0).boundingBox(),
        controls.nth(1).boundingBox(),
      ]);
      expect(muteBox).not.toBeNull();
      expect(lockBox).not.toBeNull();
      expect(muteBox!.width).toBeGreaterThanOrEqual(44);
      expect(muteBox!.height).toBeGreaterThanOrEqual(44);
      expect(lockBox!.width).toBeGreaterThanOrEqual(44);
      expect(lockBox!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(lockBox!.x - muteBox!.x)).toBeLessThanOrEqual(1);
      expect(lockBox!.y).toBeGreaterThanOrEqual(muteBox!.y + muteBox!.height);
    }

    const actions = page.locator(".multitrack-actions");
    const split = page.getByRole("button", { name: "Split at playhead" });
    const rippleDelete = page.getByRole("button", { name: "Ripple delete clip" });
    await expect(rippleDelete).toBeDisabled();
    await expect(rippleDelete).toHaveAttribute("aria-keyshortcuts", "Shift+Delete");
    await expectContained(actions, timeline);
    await expectContained(split, timeline);
    await expectContained(rippleDelete, timeline);

    const firstClipBody = page
      .getByRole("button", { name: /Interview A — wide camera\.mp4, frames 0 through 28/ })
      .first();
    await firstClipBody.click();
    await expect(firstClipBody).toHaveAttribute("aria-pressed", "true");
    await expect(rippleDelete).toBeEnabled();

    const selectedClip = page.locator(".multitrack-clip.is-selected");
    await expect(selectedClip).toHaveCount(1);
    await expect(selectedClip).toHaveCSS("border-color", "rgb(215, 245, 106)");
    await expect(selectedClip).not.toHaveCSS("box-shadow", "none");

    await firstClipBody.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(firstClipBody).toBeFocused();
    await expect(firstClipBody).toHaveCSS("outline-style", "solid");
    await expect(firstClipBody).toHaveCSS("outline-width", "2px");

    const trimStart = page.getByRole("button", {
      name: "Trim start of Interview A — wide camera.mp4",
    });
    const trimEnd = page.getByRole("button", {
      name: "Trim end of Interview A — wide camera.mp4",
    });
    await expect(trimStart).toBeVisible();
    await expect(trimEnd).toBeVisible();
    await expectContained(trimStart, selectedClip);
    await expectContained(trimEnd, selectedClip);

    await expect(split).toBeEnabled();

    const draggedClip = page.locator(".multitrack-clip.is-selected");
    const clipBox = await firstClipBody.boundingBox();
    expect(clipBox).not.toBeNull();
    const pointer = {
      pointerId: 1,
      button: 0,
      clientX: clipBox!.x + clipBox!.width / 2,
      clientY: clipBox!.y + clipBox!.height / 2,
    };
    await firstClipBody.dispatchEvent("pointerdown", pointer);
    await firstClipBody.dispatchEvent("pointermove", { ...pointer, clientX: pointer.clientX + 40 });
    await expect(draggedClip).toHaveClass(/is-dragging/);
    await expect(draggedClip).toHaveAttribute("data-drag-mode", "move");
    await expectContained(draggedClip, draggedClip.locator("xpath=ancestor::li[@data-track-id]"));
    await expectContained(draggedClip, page.locator(".multitrack-canvas"));
    await draggedClip.locator(".multitrack-clip-body").dispatchEvent("pointerup", {
      ...pointer,
      clientX: pointer.clientX + 40,
    });
    await expect(draggedClip).not.toHaveClass(/is-dragging/);

    await expect(split).toBeEnabled();
    await split.click();
    await expect(page.locator("[data-clip-id]")).toHaveCount(6);

    const splitSelection = page.locator(".multitrack-clip.is-selected .multitrack-clip-body");
    await splitSelection.focus();
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-clip-id]")).toHaveCount(6);
    await page.keyboard.press("Shift+Delete");
    await expect(page.locator("[data-clip-id]")).toHaveCount(5);
    await expect(splitSelection).toBeFocused();
    await expect(rippleDelete).toBeEnabled();

    const geometry = await page.evaluate(() => ({
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      timelineClientWidth: document.querySelector<HTMLElement>(".multitrack-scroll-region")!
        .clientWidth,
      timelineScrollWidth: document.querySelector<HTMLElement>(".multitrack-scroll-region")!
        .scrollWidth,
    }));
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
    expect(geometry.timelineScrollWidth).toBeGreaterThanOrEqual(geometry.timelineClientWidth);

    const axe = await new AxeBuilder({ page })
      .include(".multitrack-panel")
      .disableRules(["target-size"])
      .withTags(wcagTags)
      .analyze();
    expect(axe.violations, axe.violations.map(({ id }) => id).join(", ")).toEqual([]);

    await timeline.screenshot({
      path: `../../evidence/phase-4/multitrack-timeline-${viewport.name.replaceAll(" ", "-")}.png`,
    });
  });
}

const longPrimaryTrackName =
  "Primäre Kameraausgabe für die außergewöhnlich lange Dokumentarfilmsequenz";

for (const visibilityCase of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "320px with 200% text", width: 320, height: 900, rootFontSize: 32 },
  { name: "forced colors", width: 1280, height: 800, forcedColors: true },
  { name: "RTL", width: 1280, height: 800, direction: "rtl" },
  { name: "a long label", width: 1280, height: 800, longLabel: true },
] as const) {
  test(`updates visual track visibility without losing editing state at ${visibilityCase.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: visibilityCase.width, height: visibilityCase.height });
    if ("forcedColors" in visibilityCase) {
      await page.emulateMedia({ forcedColors: "active" });
    }
    await page.goto(`${fixturePath}${"longLabel" in visibilityCase ? "?long-label=1" : ""}`);
    await page.evaluate(
      ({ direction, rootFontSize }) => {
        document.documentElement.dir = direction ?? "ltr";
        if (rootFontSize !== undefined) {
          document.documentElement.style.fontSize = `${rootFontSize}px`;
        }
      },
      {
        direction: "direction" in visibilityCase ? visibilityCase.direction : undefined,
        rootFontSize: "rootFontSize" in visibilityCase ? visibilityCase.rootFontSize : undefined,
      },
    );
    await page.evaluate(() => document.fonts.ready);

    const primaryTrackName =
      "longLabel" in visibilityCase ? longPrimaryTrackName : "Primary camera";
    const primaryRow = page.locator(`[data-track-id="40000000-0000-4000-8000-000000000010"]`);
    const primaryLabel = page
      .getByRole("group", { name: `${primaryTrackName} track controls` })
      .locator("..");
    const captionLabel = page
      .getByRole("group", { name: "English captions track controls" })
      .locator("..");
    const primaryClip = primaryRow.locator(".multitrack-clip-body").first();
    const primaryClipContainer = primaryClip.locator("..");
    const videoVisibility = page.getByRole("button", {
      name: `${primaryTrackName} video output`,
    });
    const captionVisibility = page.getByRole("button", {
      name: "English captions caption output",
    });
    const split = page.getByRole("button", { name: "Split at playhead" });
    const rippleDelete = page.getByRole("button", { name: "Ripple delete clip" });
    const trimStart = page.getByRole("button", {
      name: "Trim start of Interview A — wide camera.mp4",
    });

    await expect(videoVisibility).toHaveCount(1);
    await expect(captionVisibility).toHaveCount(1);
    const primaryControls = primaryLabel.locator(".multitrack-track-controls > button");
    await expect(primaryControls).toHaveCount(3);
    for (const control of await primaryControls.all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole("button", { name: "Interview dialogue audio output" })).toHaveCount(
      0,
    );
    await expect(videoVisibility).toHaveAttribute("aria-pressed", "true");
    await expect(captionVisibility).toHaveAttribute("aria-pressed", "true");
    await expect(videoVisibility).toHaveAttribute("title", "Hide track output");
    await expect(videoVisibility.locator(".lucide-eye")).toHaveCount(1);
    await expect(videoVisibility).toContainText("Hide");
    await expect(primaryLabel).toContainText("3 clips · Editable · Audible · Shown");
    await expect(captionLabel).toContainText("0 clips · Editable · Shown");
    await expect(primaryRow).toHaveAttribute("data-track-kind", "video");
    await expect(primaryRow).toHaveAttribute("data-track-locked", "false");
    await expect(primaryRow).toHaveAttribute("data-track-muted", "false");
    await expect(primaryRow).toHaveAttribute("data-track-hidden", "false");
    await expect(primaryRow).not.toHaveClass(/is-hidden/);
    await expect(primaryLabel).toHaveAttribute("data-track-hidden", "false");
    await expect(primaryLabel).not.toHaveClass(/is-hidden/);
    await expect(primaryClipContainer).toHaveAttribute("data-track-hidden", "false");
    await expect(primaryClipContainer).not.toHaveClass(/is-hidden/);

    await primaryClip.click();
    await expect(primaryClip).toHaveAttribute("aria-pressed", "true");
    await expect(split).toBeEnabled();
    await expect(rippleDelete).toBeEnabled();
    await expect(trimStart).toBeEnabled();

    await videoVisibility.click();

    await expect(videoVisibility).toHaveCount(1);
    await expect(videoVisibility).toHaveAccessibleName(`${primaryTrackName} video output`);
    await expect(videoVisibility).toHaveAttribute("aria-pressed", "false");
    await expect(videoVisibility).toHaveAttribute("title", "Show track output");
    await expect(videoVisibility.locator(".lucide-eye-off")).toHaveCount(1);
    await expect(videoVisibility).toContainText("Show");
    await expect(primaryLabel).toContainText("3 clips · Editable · Audible · Hidden");
    await expect(primaryRow).toHaveAttribute("data-track-kind", "video");
    await expect(primaryRow).toHaveAttribute("data-track-locked", "false");
    await expect(primaryRow).toHaveAttribute("data-track-muted", "false");
    await expect(primaryRow).toHaveAttribute("data-track-hidden", "true");
    await expect(primaryRow).toHaveClass(/is-hidden/);
    await expect(primaryRow).toHaveAccessibleName(
      new RegExp(`${primaryTrackName}, video track, 3 clips, editable, audible, hidden`),
    );
    await expect(primaryLabel).toHaveAttribute("data-track-hidden", "true");
    await expect(primaryLabel).toHaveClass(/is-hidden/);
    await expect(primaryClipContainer).toHaveAttribute("data-track-hidden", "true");
    await expect(primaryClipContainer).toHaveClass(/is-hidden/);
    await expect(primaryClipContainer).toHaveClass(/is-selected/);
    await expect(primaryClip).toHaveAttribute("aria-pressed", "true");
    await expect(split).toBeEnabled();
    await expect(rippleDelete).toBeEnabled();
    await expect(trimStart).toBeEnabled();

    await captionVisibility.click();
    await expect(captionVisibility).toHaveAccessibleName("English captions caption output");
    await expect(captionVisibility).toHaveAttribute("aria-pressed", "false");
    await expect(captionVisibility).toHaveAttribute("title", "Show track output");
    await expect(captionVisibility.locator(".lucide-eye-off")).toHaveCount(1);
    await expect(captionVisibility).toContainText("Show");
    await expect(captionLabel).toContainText("0 clips · Editable · Hidden");
    await expect(primaryClip).toHaveAttribute("aria-pressed", "true");

    if ("forcedColors" in visibilityCase) {
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      await expect(primaryRow).toHaveCSS("border-left-style", "double");
      await expect(primaryRow).toHaveCSS("border-left-width", "4px");
      await expect(primaryLabel).toHaveCSS("border-left-style", "double");
      await expect(primaryClipContainer).toHaveCSS("border-top-style", "dashed");
      await expect(videoVisibility).toHaveCSS("forced-color-adjust", "none");
    }
    if ("direction" in visibilityCase) {
      await expect(page.locator(".multitrack-panel")).toHaveCSS("direction", "rtl");
    }

    const disabledAxeRules = [
      "target-size",
      ...(visibilityCase.name === "forced colors" ? ["color-contrast"] : []),
    ];
    const axe = await new AxeBuilder({ page })
      .include(".multitrack-panel")
      .disableRules(disabledAxeRules)
      .withTags(wcagTags)
      .analyze();
    expect(axe.violations, axe.violations.map(({ id }) => id).join(", ")).toEqual([]);
  });
}

test("snaps a dragged clip to a visible clip edge and commits on release", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => document.fonts.ready);

  const primaryRow = page.locator(`[data-track-id="40000000-0000-4000-8000-000000000010"]`);
  const draggedClip = primaryRow.locator(".multitrack-clip").first();
  const draggedClipBody = draggedClip.locator(".multitrack-clip-body");
  const targetClip = primaryRow.locator(".multitrack-clip").nth(1);
  await expect(targetClip).toBeVisible();
  await draggedClipBody.click();

  const clipBox = await draggedClipBody.boundingBox();
  expect(clipBox).not.toBeNull();
  const pointer = {
    pointerId: 1,
    button: 0,
    clientX: clipBox!.x + clipBox!.width / 2,
    clientY: clipBox!.y + clipBox!.height / 2,
  };
  await draggedClipBody.dispatchEvent("pointerdown", pointer);
  await expect(draggedClip).toHaveClass(/is-dragging/);
  await draggedClipBody.dispatchEvent("pointermove", {
    ...pointer,
    clientX: pointer.clientX + 2.4,
  });

  const snapGuide = page.locator(".multitrack-snap-guide");
  await expect(snapGuide).toBeVisible();
  await expect(snapGuide).toHaveAttribute("data-snap-frame", "34");
  await expect(snapGuide).toHaveAttribute("data-snap-target-kind", "clip-start");
  await expect(snapGuide).toHaveAttribute("data-moving-edge", "end");
  await expect(draggedClip).toHaveAttribute("data-start-frame", "6");

  await draggedClipBody.dispatchEvent("pointerup", {
    ...pointer,
    clientX: pointer.clientX + 2.4,
  });

  await expect(snapGuide).toHaveCount(0);
  await expect(draggedClip).not.toHaveClass(/is-dragging/);
  await expect(draggedClip).toHaveAttribute("data-start-frame", "6");
});

for (const illegalSnap of [
  { name: "start-to-start", pointerDelta: 13.6, previewStart: "34" },
  { name: "end-to-end", pointerDelta: 19.2, previewStart: "48" },
]) {
  test(`rejects an illegal same-track ${illegalSnap.name} snap`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(fixturePath);
    await page.evaluate(() => document.fonts.ready);

    const primaryRow = page.locator(`[data-track-id="40000000-0000-4000-8000-000000000010"]`);
    const draggedClip = primaryRow.locator(`[data-clip-id="40000000-0000-4000-8000-000000000100"]`);
    const draggedClipBody = draggedClip.locator(".multitrack-clip-body");
    await draggedClipBody.click();
    const clipBox = await draggedClipBody.boundingBox();
    expect(clipBox).not.toBeNull();
    const pointer = {
      pointerId: 1,
      button: 0,
      clientX: clipBox!.x + clipBox!.width / 2,
      clientY: clipBox!.y + clipBox!.height / 2,
    };

    await draggedClipBody.dispatchEvent("pointerdown", pointer);
    await draggedClipBody.dispatchEvent("pointermove", {
      ...pointer,
      clientX: pointer.clientX + illegalSnap.pointerDelta,
    });
    await expect(page.locator(".multitrack-snap-guide")).toHaveCount(0);
    await expect(draggedClip).toHaveAttribute("data-start-frame", illegalSnap.previewStart);

    await draggedClipBody.dispatchEvent("pointerup", {
      ...pointer,
      clientX: pointer.clientX + illegalSnap.pointerDelta,
    });
    await expect(draggedClip).toHaveAttribute("data-start-frame", "0");
    await expect(page.getByRole("alert")).toHaveText("Project command failed its preconditions");
  });
}

test("moves a clip across its sibling and renders native canonical order", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => document.fonts.ready);

  const firstClipId = "40000000-0000-4000-8000-000000000100";
  const secondClipId = "40000000-0000-4000-8000-000000000101";
  const thirdClipId = "40000000-0000-4000-8000-000000000102";
  const primaryRow = page.locator(`[data-track-id="40000000-0000-4000-8000-000000000010"]`);
  const firstClip = primaryRow.locator(`[data-clip-id="${firstClipId}"]`);
  const firstClipBody = firstClip.locator(".multitrack-clip-body");
  await firstClipBody.click();
  await expect(firstClipBody).toHaveAttribute("aria-pressed", "true");

  const clipBox = await firstClipBody.boundingBox();
  expect(clipBox).not.toBeNull();
  const pointer = {
    pointerId: 1,
    button: 0,
    clientX: clipBox!.x + clipBox!.width / 2,
    clientY: clipBox!.y + clipBox!.height / 2,
  };
  await firstClipBody.dispatchEvent("pointerdown", pointer);
  await expect(firstClip).toHaveClass(/is-dragging/);
  await firstClipBody.dispatchEvent("pointermove", { ...pointer, clientX: pointer.clientX + 63.2 });
  await firstClipBody.dispatchEvent("pointerup", { ...pointer, clientX: pointer.clientX + 63.2 });

  const renderedClips = primaryRow.locator(".multitrack-clip");
  await expect(renderedClips.nth(0)).toHaveAttribute("data-clip-id", secondClipId);
  await expect(renderedClips.nth(1)).toHaveAttribute("data-clip-id", thirdClipId);
  await expect(renderedClips.nth(2)).toHaveAttribute("data-clip-id", firstClipId);
  const renderedStarts = await renderedClips.evaluateAll((clips) =>
    clips.map((clip) => Number((clip as HTMLElement).dataset.startFrame)),
  );
  expect(renderedStarts).toEqual([...renderedStarts].sort((left, right) => left - right));
  expect(renderedStarts[2]).toBe(158);
});

test("mutes an audio-bearing track while its clip remains selectable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => document.fonts.ready);

  const primaryTrackId = "40000000-0000-4000-8000-000000000010";
  const primaryRow = page.locator(`[data-track-id="${primaryTrackId}"]`);
  const primaryClip = primaryRow.locator(".multitrack-clip-body").first();
  const primaryMute = page.getByRole("button", { name: "Primary camera track mute" });

  await expect(primaryMute).toHaveAttribute("aria-pressed", "false");
  await expect(primaryRow).toHaveAccessibleName(/Primary camera.*audible/);
  await expect(primaryRow).toHaveAttribute("data-track-muted", "false");

  await primaryMute.click();

  const pressedMute = page.getByRole("button", { name: "Primary camera track unmute" });
  await expect(pressedMute).toHaveAttribute("aria-pressed", "true");
  await expect(primaryRow).toHaveAccessibleName(/Primary camera.*muted/);
  await expect(primaryRow).toHaveAttribute("data-track-muted", "true");

  await primaryClip.click();
  await expect(primaryClip).toHaveAttribute("aria-pressed", "true");

  const primaryLock = page.getByRole("button", { name: "Primary camera track lock" });
  await primaryLock.click();
  await expect(primaryLock).toHaveAttribute("aria-pressed", "true");
  const [muteAccent, lockAccent] = await Promise.all([
    pressedMute.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderColor, style.color, style.backgroundColor];
    }),
    primaryLock.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderColor, style.color, style.backgroundColor];
    }),
  ]);
  expect(muteAccent).not.toEqual(lockAccent);
});

test("locks one track without blocking selection or edits on other tracks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixturePath);
  await page.evaluate(() => document.fonts.ready);

  const primaryLock = page.getByRole("button", { name: "Primary camera track lock" });
  const primaryRow = page.locator(`[data-track-id="40000000-0000-4000-8000-000000000010"]`);
  const primaryClip = primaryRow.locator(".multitrack-clip-body").first();
  await expect(primaryLock).toHaveAttribute("aria-pressed", "false");
  await primaryClip.click();
  await primaryLock.click();
  await expect(primaryLock).toHaveAttribute("aria-pressed", "true");
  await expect(primaryLock).toContainText("Unlock");
  await expect(primaryRow).toHaveAttribute("data-track-locked", "true");
  await expect(primaryRow).toHaveAccessibleName(/Primary camera.*locked/);
  await expect(primaryClip).toHaveAttribute("aria-pressed", "true");

  const split = page.getByRole("button", { name: "Split at playhead" });
  const rippleDelete = page.getByRole("button", { name: "Ripple delete clip" });
  const trimStart = page.getByRole("button", {
    name: "Trim start of Interview A — wide camera.mp4",
  });
  await expect(split).toBeDisabled();
  await expect(rippleDelete).toBeDisabled();
  await expect(trimStart).toBeDisabled();
  const primaryClipElement = primaryRow.locator(".multitrack-clip").first();
  const primaryStart = await primaryClipElement.getAttribute("data-start-frame");
  const primaryBox = await primaryClip.boundingBox();
  expect(primaryBox).not.toBeNull();
  const lockedPointer = {
    pointerId: 8,
    button: 0,
    clientX: primaryBox!.x + primaryBox!.width / 2,
    clientY: primaryBox!.y + primaryBox!.height / 2,
  };
  await primaryClip.dispatchEvent("pointerdown", lockedPointer);
  await primaryClip.dispatchEvent("pointermove", {
    ...lockedPointer,
    clientX: lockedPointer.clientX + 40,
  });
  await primaryClip.dispatchEvent("pointerup", {
    ...lockedPointer,
    clientX: lockedPointer.clientX + 40,
  });
  await primaryClip.press("s");
  await primaryClip.press("Shift+Delete");
  await expect(primaryClipElement).toHaveAttribute("data-start-frame", primaryStart!);
  await expect(page.locator("[data-clip-id]")).toHaveCount(5);

  const audioRow = page.locator(`[data-track-id="40000000-0000-4000-8000-000000000011"]`);
  const audioClip = audioRow.locator(".multitrack-clip-body").first();
  await audioClip.click();
  await expect(audioClip).toHaveAttribute("aria-pressed", "true");
  await expect(split).toBeEnabled();
  await audioClip.press("s");
  await expect(page.locator("[data-clip-id]")).toHaveCount(6);
  await expect(primaryRow).toHaveAttribute("data-track-locked", "true");

  await page.emulateMedia({ forcedColors: "active" });
  expect(await page.evaluate(() => window.matchMedia("(forced-colors: active)").matches)).toBe(
    true,
  );
  await expect(primaryLock).toHaveAttribute("aria-pressed", "true");
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  await page.locator(".multitrack-panel").screenshot({
    path: "../../evidence/phase-4/multitrack-timeline-forced-colors-locked.png",
  });
});
