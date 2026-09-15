// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClipSpeedControl } from "./ClipSpeedControl";
const time = (value: number) => ({ value, rateNumerator: 30, rateDenominator: 1 });
const selection = {
  sequenceId: "sequence",
  trackId: "track",
  clipId: "clip",
  sourceIn: time(0),
  sourceOut: time(60),
  sequenceRate: { numerator: 30, denominator: 1 },
};
afterEach(cleanup);
it("keeps drafts local, validates exact duration, applies deliberately and resets as a draft", () => {
  const onCommit = vi.fn();
  render(
    <ClipSpeedControl
      selection={selection}
      disabled={false}
      saving={false}
      error={null}
      onCommit={onCommit}
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "Speed (%)" });
  fireEvent.change(input, { target: { value: "151" } });
  expect(screen.getByRole("alert").textContent).toContain("inexact");
  expect((screen.getByRole("button", { name: "Apply speed" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "200%" }));
  expect(screen.getByRole("status").textContent).toContain("30 sequence frames");
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply speed" }));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(
    {
      sequenceId: "sequence",
      trackId: "track",
      clipId: "clip",
      speed: { numerator: 2, denominator: 1 },
    },
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset speed" }));
  expect((input as HTMLInputElement).value).toBe("100");
  expect(onCommit).toHaveBeenCalledTimes(1);
});
it("retains a failed draft and disables while saving or locked; remount discards stale drafts", () => {
  const onCommit = vi.fn();
  const props = { selection, disabled: false, saving: false, error: null, onCommit };
  const view = render(<ClipSpeedControl key="r1" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "50%" }));
  view.rerender(<ClipSpeedControl key="r1" {...props} error={new Error("Overlap")} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("50");
  expect(screen.getByRole("alert").textContent).toBe("Overlap");
  view.rerender(<ClipSpeedControl key="r1" {...props} saving />);
  expect((screen.getByRole("button", { name: "Apply speed" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  view.rerender(<ClipSpeedControl key="r2" {...props} disabled />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("100");
  expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
});
