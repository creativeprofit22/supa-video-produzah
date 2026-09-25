import { expect, type Page } from "@playwright/test";

// Chromium reports the unforced authored -webkit-text-fill-color even when
// forced colors paints `color`. Axe 4.12 prefers that fill value. Inspect the
// forced computed colors instead, rejecting unsupported compositing rather
// than silently claiming a contrast pass.
export async function forcedTextContrast(page: Page, selector: string) {
  return page.locator(selector).evaluate((root) => {
    if (!matchMedia("(forced-colors: active)").matches)
      throw new Error("Forced colors must be active for this measurement");
    const parse = (color: string) => {
      const values = color
        .match(/^rgba?\(([^)]+)\)$/)?.[1]
        ?.split(/[, /]+/)
        .map(Number);
      if (!values || values.length < 3 || values.some((value) => !Number.isFinite(value)))
        throw new Error(`Unsupported computed color: ${color}`);
      return [values[0]!, values[1]!, values[2]!, values[3] ?? 1];
    };
    const luminance = (color: number[]) =>
      color.slice(0, 3).reduce((sum, value, index) => {
        const channel = value / 255;
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
      }, 0);
    const canvas = document.createElement("span");
    canvas.style.color = "Canvas";
    document.body.append(canvas);
    const canvasColor = parse(getComputedStyle(canvas).color);
    canvas.remove();
    return [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
      const style = getComputedStyle(element);
      const directText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      if (
        (!directText && !element.matches("input,textarea,select")) ||
        element.getClientRects().length === 0 ||
        style.visibility !== "visible" ||
        element.matches(":disabled") ||
        element.closest('[aria-disabled="true"]')
      )
        return [];
      let background = canvasColor;
      const ancestors: Element[] = [];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement)
        ancestors.unshift(ancestor);
      for (const ancestor of ancestors) {
        const computed = getComputedStyle(ancestor);
        if (
          computed.opacity !== "1" ||
          computed.filter !== "none" ||
          computed.mixBlendMode !== "normal" ||
          computed.backgroundImage !== "none"
        )
          throw new Error(`Unsupported contrast compositing on ${ancestor.tagName}`);
        const layer = parse(computed.backgroundColor);
        background = layer
          .slice(0, 3)
          .map((value, index) => value * layer[3]! + background[index]! * (1 - layer[3]!));
      }
      // Opted-out elements retain their authored fill, like normal rendering.
      const foreground = parse(
        style.forcedColorAdjust === "none"
          ? style.getPropertyValue("-webkit-text-fill-color") || style.color
          : style.color,
      );
      const painted = foreground
        .slice(0, 3)
        .map((value, index) => value * foreground[3]! + background[index]! * (1 - foreground[3]!));
      const first = luminance(painted),
        second = luminance(background);
      const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      const size = parseFloat(style.fontSize),
        weight = parseFloat(style.fontWeight);
      const required = size >= 24 || (size >= 18.6667 && weight >= 700) ? 3 : 4.5;
      return [
        {
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 100),
          color: style.color,
          background,
          ratio,
          required,
        },
      ];
    });
  });
}

export async function assertForcedTextContrast(page: Page, selector: string) {
  const rows = await forcedTextContrast(page, selector);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter((row) => row.ratio < row.required)).toEqual([]);
  return rows;
}
