// Tool-driven keyboard evidence only: never human or assistive-technology evidence.
export async function exerciseNativeKeyboard({ page, expect, revision, record }) {
  const reach = async (target) => {
    for (let index = 0; index < 100; index++) {
      if (await target.evaluate((element) => element === element.ownerDocument.activeElement))
        return;
      await page.keyboard.press("Tab");
    }
    throw Error("Control not reachable within 100 sequential Tab presses");
  };
  const type = async (target, value) => {
    await reach(target);
    await page.keyboard.press("Control+A");
    await page.keyboard.type(value);
  };
  const activate = async (target) => {
    await reach(target);
    await page.keyboard.press("Space");
  };
  const speed = page.getByRole("spinbutton", { name: "Speed (%)", exact: true });
  const apply = page.getByRole("button", { name: "Apply speed", exact: true });
  const reset = page.getByRole("button", { name: "Reset speed", exact: true });
  await expect(speed).toBeFocused();
  await expect(speed).toHaveAccessibleName("Speed (%)");
  await type(speed, "0");
  await expect(apply).toBeDisabled();
  await revision(5);
  await activate(reset);
  await expect(speed).toHaveValue("100");
  await revision(5);
  record("invalid-and-reset", { revision: 5, draft: 100 });

  await type(speed, "200");
  await activate(apply);
  await revision(6);
  await expect(speed).toBeFocused();
  await expect(speed).toHaveValue("200");
  await activate(page.getByRole("button", { name: "Undo", exact: true }));
  await revision(7);
  await expect(speed).toHaveValue("150");
  record("apply-and-undo", { appliedRevision: 6, undoRevision: 7, restoredSpeed: 150 });

  const select = page.getByRole("button", { name: "Select single-flash-30-1.mp4", exact: true });
  await expect(select).toHaveCount(2);
  await activate(select.nth(1));
  await expect(
    page.getByRole("region", { name: "Multiple clip controls", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("2 clips selected (maximum 100)", { exact: true })).toBeVisible();
  await activate(select.nth(1));
  await expect(speed).toBeVisible();
  await revision(7);
  record("multiselect", { canonicalRevisionUnchanged: 7 });

  const separator = page.getByRole("separator", {
    name: "Program and media / editing controls pane width",
    exact: true,
  });
  await reach(separator);
  const value = async () => Number(await separator.getAttribute("aria-valuenow"));
  const before = await value();
  await page.keyboard.press("ArrowRight");
  await expect.poll(value).toBeGreaterThan(before);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(value).toBeCloseTo(before, 1);
  await page.keyboard.press("Home");
  const minimum = Number(await separator.getAttribute("aria-valuemin"));
  await expect.poll(value).toBeCloseTo(minimum, 1);
  await page.keyboard.press("End");
  const maximum = Number(await separator.getAttribute("aria-valuemax"));
  await expect.poll(value).toBeCloseTo(maximum, 1);
  await expect(separator).toBeFocused();
  await revision(7);
  record("separator", { minimum, maximum, canonicalRevisionUnchanged: 7 });
}
