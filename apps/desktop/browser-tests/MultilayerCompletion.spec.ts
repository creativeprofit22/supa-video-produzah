import { expect, test, type Page } from "@playwright/test";

async function centerPixel(page: Page) {
  const image = await page.locator(".monitor-stage").screenshot({ animations: "disabled" });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [
      ...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data,
    ];
  }, image.toString("base64"));
}
async function expectColor(page: Page, color: "red" | "blue" | "black") {
  await expect
    .poll(async () => {
      const [r, g, b] = await centerPixel(page);
      return color === "red"
        ? r! > 200 && b! < 30
        : color === "blue"
          ? b! > 200 && r! < 30
          : Math.max(r!, g!, b!) < 30;
    })
    .toBe(true);
}
async function ready(page: Page) {
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluateAll((elements) =>
          elements.every(
            (element) =>
              (element as HTMLVideoElement).readyState >= 2 &&
              !(element as HTMLVideoElement).seeking,
          ),
        ),
    )
    .toBe(true);
}
for (const mode of ["normal", "muted", "hidden", "both"]) {
  test(`production-compiled layers independently ${mode}: seeks, preview/final and 1x audition`, async ({
    page,
  }) => {
    await page.goto(`/browser-tests/multilayer-completion.html?mode=${mode}`);
    await ready(page);
    const hidden = mode === "hidden" || mode === "both";
    const muted = mode === "muted" || mode === "both";
    for (const frame of [0, 15, 45, 59]) {
      await page.getByRole("spinbutton", { name: "Seek frame", exact: true }).fill(String(frame));
      await ready(page);
      await expectColor(page, hidden ? "blue" : "red");
      const sources = await page.locator("video").evaluateAll((elements) =>
        elements.map((element) => {
          const video = element as HTMLVideoElement;
          return { time: video.currentTime, speed: video.playbackRate, muted: video.muted };
        }),
      );
      expect(Math.abs(sources[0]!.time - (1 + (frame / 30) * 1.5))).toBeLessThanOrEqual(1 / 30);
      expect(Math.abs(sources[1]!.time - (1 + (frame / 30) * 0.5))).toBeLessThanOrEqual(1 / 30);
      expect(sources.map((source) => source.speed)).toEqual([1.5, 0.5]);
      expect(sources.map((source) => source.muted)).toEqual([muted, false]);
    }
    await page.getByRole("button", { name: "Final", exact: true }).click();
    await ready(page);
    await expectColor(page, hidden ? "blue" : "red");
    const final = page.getByLabel("Verified final video preview", { exact: true });
    expect(await final.evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1);
    await page.getByRole("spinbutton", { name: "Seek frame", exact: true }).fill("45");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => page.getByTestId("program-frame").textContent()).toBe("59");
    await expect.poll(() => final.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    await expectColor(page, hidden ? "blue" : "red");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("button", { name: "Toggle raw audition", exact: true }).click();
    await ready(page);
    expect(
      await page.locator("video").evaluate((video: HTMLVideoElement) => video.playbackRate),
    ).toBe(1);
    await expectColor(page, "red");
  });
}
test("real preview switches decoded layers across a gap, pauses and resumes", async ({ page }) => {
  await page.goto("/browser-tests/multilayer-completion.html?mode=gap");
  await ready(page);
  for (const [frame, color] of [
    [0, "red"],
    [14, "red"],
    [15, "black"],
    [29, "black"],
    [30, "blue"],
    [44, "blue"],
  ] as const) {
    await page.getByRole("spinbutton", { name: "Seek frame", exact: true }).fill(String(frame));
    await ready(page);
    await expectColor(page, color);
  }
  await page.getByRole("spinbutton", { name: "Seek frame", exact: true }).fill("0");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => Number(await page.getByTestId("program-frame").textContent()), {
      intervals: [16],
    })
    .toBeGreaterThanOrEqual(30);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expectColor(page, "blue");
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluateAll((elements) => elements.every((v) => (v as HTMLVideoElement).paused)),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => Number(await page.getByTestId("program-frame").textContent()))
    .toBe(44);
  await expectColor(page, "blue");
});
