// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptionsPanel, frameForShape, shapeOfFrame } from "./CaptionsPanel";

afterEach(cleanup);

describe("frame shapes", () => {
  it.each([
    [{ width: 1_280, height: 720 }, "9:16", { width: 720, height: 1_280 }],
    [{ width: 1_280, height: 720 }, "1:1", { width: 720, height: 720 }],
    [{ width: 720, height: 720 }, "16:9", { width: 1_280, height: 720 }],
    [{ width: 1_920, height: 1_080 }, "9:16", { width: 1_080, height: 1_920 }],
  ] as const)("%o as %s is %o", (current, shape, expected) => {
    expect(frameForShape(current, shape)).toEqual(expected);
  });

  it("round-trips 16:9 to 9:16 to 1:1 and back without drift", () => {
    const start = { width: 1_280, height: 720 };
    const back = frameForShape(frameForShape(frameForShape(start, "9:16"), "1:1"), "16:9");
    expect(back).toEqual(start);
  });

  it("recognises the shape of a frame, and none for other sizes", () => {
    expect(shapeOfFrame({ width: 1_280, height: 720 })).toBe("16:9");
    expect(shapeOfFrame({ width: 720, height: 1_280 })).toBe("9:16");
    expect(shapeOfFrame({ width: 720, height: 720 })).toBe("1:1");
    expect(shapeOfFrame({ width: 1_440, height: 1_080 })).toBeNull();
  });
});

describe("CaptionsPanel frame choice", () => {
  const base = {
    projection: null,
    sequenceId: null,
    disabled: false,
    onApply: vi.fn(async () => true),
  };

  it("shows the current shape and changes the frame from the radio group", async () => {
    const onSetFrameSize = vi.fn(async () => true);
    render(
      <CaptionsPanel
        {...base}
        frame={{ width: 1_280, height: 720 }}
        onSetFrameSize={onSetFrameSize}
      />,
    );
    const group = screen.getByRole("group", { name: "Frame" });
    expect(group).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: "Widescreen 16:9" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Vertical 9:16" }));
    await waitFor(() => expect(onSetFrameSize).toHaveBeenCalledWith(720, 1_280));
  });

  it("reports a failed change", async () => {
    render(
      <CaptionsPanel
        {...base}
        frame={{ width: 1_280, height: 720 }}
        onSetFrameSize={vi.fn(async () => false)}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Square 1:1" }));
    expect(await screen.findByText("The frame could not be changed. Try again.")).toBeTruthy();
  });

  it("hides the frame choice when the frame cannot be changed", () => {
    render(<CaptionsPanel {...base} />);
    expect(screen.queryByRole("group", { name: "Frame" })).toBeNull();
  });
});
