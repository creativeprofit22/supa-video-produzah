import { expect, test } from "@playwright/test";

test("locking one of two canonical tracks blocks the whole selected edit", async ({ page }) => {
  await page.goto("/browser-tests/video-workspace.html");
  await page.getByRole("button", { name: "Initialize workspace fixture" }).click();
  await expect(page.getByRole("heading", { name: "Canonical composition" })).toBeVisible();
  await page.getByRole("button", { name: "Split fixture into two clips" }).click();
  await page.getByRole("button", { name: "Place second clip on another track" }).click();
  await expect(page.getByRole("button", { name: /track lock$/ })).toHaveCount(2);
  const clips = page.getByRole("button", { name: /^Select / });
  await expect(clips).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    if ((await clips.nth(index).getAttribute("aria-pressed")) !== "true") {
      await clips.nth(index).focus();
      await page.keyboard.press("Space");
    }
  }
  await expect(page.getByRole("heading", { name: "2 media clips selected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply to selected clips" })).toBeEnabled();
  const read = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          workspaceEvidence: () => {
            groups: number;
            state: {
              sequences: {
                tracks: { locked?: boolean; clips: { gainMilliDecibels: number }[] }[];
              }[];
            };
          };
        }
      ).workspaceEvidence(),
    );
  const before = await read();
  await page.getByRole("button", { name: "Second video track lock", exact: true }).click();
  for (const name of [
    "Common volume (dB)",
    "Common fade in (frames)",
    "Common fade out (frames)",
    "Common speed (%)",
    "Relative move (sequence frames)",
  ]) {
    await expect(page.getByRole("spinbutton", { name, exact: true })).toBeDisabled();
  }
  for (const name of [
    "Apply to selected clips",
    "Apply common speed",
    "Move selected clips",
    "Delete 2 clips (undoable)",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  const locked = await read();
  expect(locked.state.sequences[0]!.tracks.map((t) => t.locked ?? false)).toEqual([false, true]);
  expect(locked.state.sequences[0]!.tracks.flatMap((t) => t.clips)).toEqual(
    before.state.sequences[0]!.tracks.flatMap((t) => t.clips),
  );
  expect(locked.groups).toBe(before.groups + 1); // Only the explicit track-lock command.
});
