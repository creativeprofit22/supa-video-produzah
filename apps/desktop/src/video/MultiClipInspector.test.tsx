// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultiClipInspector, type BulkAudioTarget } from "./MultiClipInspector";
afterEach(cleanup);
const targets: BulkAudioTarget[] = [0, 1000].map((gain, i) => ({
  sequenceId: "s",
  trackId: `t${i}`,
  duration: 50,
  clipId: String(i),
  gainMilliDecibels: gain,
  fades: { inFrames: 0, outFrames: 0 },
  locked: false,
  hasAudio: true,
}));
it("shows mixed gain rather than the primary and applies once preserving unchanged values", () => {
  const onApply = vi.fn();
  render(<MultiClipInspector targets={targets} disabled={false} error={null} onApply={onApply} />);
  expect((screen.getByLabelText("Common volume (dB)") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Common fade in (frames)"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply to selected clips" }));
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0]![0].map((t: BulkAudioTarget) => t.gainMilliDecibels)).toEqual([
    0, 1000,
  ]);
  expect(onApply.mock.calls[0]![0].map((t: BulkAudioTarget) => t.fades.inFrames)).toEqual([3, 3]);
});
it("blocks the entire selection when one target is locked", () => {
  const onApply = vi.fn();
  render(
    <MultiClipInspector
      targets={[targets[0]!, { ...targets[1]!, locked: true }]}
      disabled={false}
      error={null}
      onApply={onApply}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply to selected clips" }));
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Unlock");
  expect(
    (screen.getByLabelText("Common volume (dB)") as HTMLInputElement).matches(":disabled"),
  ).toBe(true);
});
