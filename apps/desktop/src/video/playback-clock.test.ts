import { describe, expect, it, vi } from "vitest";
import { createPlaybackClock } from "./playback-clock";

const initial = { playing: false, timelineFrame: 0, previewSourceFrame: 0 } as const;

describe("playback clock", () => {
  it("notifies subscribers only when the published state changes", () => {
    const clock = createPlaybackClock(initial);
    const listener = vi.fn();
    clock.subscribe(listener);

    clock.publish({ timelineFrame: 0 });
    clock.publish({ playing: false, previewSourceFrame: 0 });
    expect(listener).not.toHaveBeenCalled();

    clock.publish({ timelineFrame: 5, previewSourceFrame: 7 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clock.read()).toEqual({ playing: false, timelineFrame: 5, previewSourceFrame: 7 });

    clock.publish({ playing: true });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(clock.read().playing).toBe(true);
  });

  it("stops notifying after unsubscribe and keeps separate instances isolated", () => {
    const clock = createPlaybackClock(initial);
    const other = createPlaybackClock(initial);
    const listener = vi.fn();
    const unsubscribe = clock.subscribe(listener);

    other.publish({ timelineFrame: 9 });
    expect(listener).not.toHaveBeenCalled();
    expect(clock.read().timelineFrame).toBe(0);

    unsubscribe();
    clock.publish({ timelineFrame: 3 });
    expect(listener).not.toHaveBeenCalled();
    expect(clock.read().timelineFrame).toBe(3);
  });
});
