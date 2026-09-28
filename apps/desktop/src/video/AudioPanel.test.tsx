// @vitest-environment jsdom

import type { VideoSequenceV2 } from "@supa-video/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioPanel } from "./AudioPanel";

const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const warning =
  "Ducking is on, but no unmuted track is marked Dialogue. Export will fail until you mark one as Dialogue or turn ducking off.";

function sequenceWith(
  track: { readonly audioRole: "dialogue" | "music"; readonly muted?: boolean },
  ducking: boolean,
): VideoSequenceV2 {
  return {
    id: id(1),
    name: "Main",
    rate: { numerator: 30, denominator: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    markers: [],
    loudnessTarget: {
      integratedLufs: -16,
      truePeakCeilingDbtp: -1,
      ducking,
      dialogueCleanup: false,
    },
    tracks: [{ id: id(2), name: "Interview camera", kind: "video", clips: [], ...track }],
  };
}

function renderPanel(sequence: VideoSequenceV2) {
  return render(
    <AudioPanel
      sequence={sequence}
      disabled={false}
      lastReport={null}
      onSetRole={vi.fn(async () => true)}
      onSetTarget={vi.fn(async () => true)}
    />,
  );
}

afterEach(cleanup);

describe("AudioPanel", () => {
  it.each([
    ["the only dialogue track became music", { audioRole: "music" } as const],
    ["the dialogue track is muted", { audioRole: "dialogue", muted: true } as const],
  ])("keeps warning while ducking is on and %s", (_case, track) => {
    renderPanel(sequenceWith(track, true));

    expect(screen.getByText(warning)).toBeTruthy();
    const ducking = screen.getByRole("checkbox", { name: "Lower music while dialogue plays" });
    expect(ducking.getAttribute("aria-describedby")).toBe(screen.getByText(warning).id);
  });

  it.each([
    ["ducking is off", { audioRole: "music" } as const, false],
    ["an unmuted dialogue track exists", { audioRole: "dialogue" } as const, true],
  ])("shows no warning when %s", (_case, track, ducking) => {
    renderPanel(sequenceWith(track, ducking));

    expect(screen.queryByText(warning)).toBeNull();
  });

  it("sends null when the user picks Not normalized or No role", () => {
    const onSetRole = vi.fn(async () => true);
    const onSetTarget = vi.fn(async () => true);
    render(
      <AudioPanel
        sequence={sequenceWith({ audioRole: "dialogue" }, false)}
        disabled={false}
        lastReport={null}
        onSetRole={onSetRole}
        onSetTarget={onSetTarget}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Target" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Interview camera" }), {
      target: { value: "" },
    });

    expect(onSetTarget).toHaveBeenCalledWith(null);
    expect(onSetRole).toHaveBeenCalledWith(id(2), null);
  });
});
