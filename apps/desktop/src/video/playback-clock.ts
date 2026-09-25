import { useCallback, useSyncExternalStore } from "react";

/**
 * Live playback position, published on every monitor tick without committing
 * React state. Subscribers select primitives so they re-render only when the
 * value they read changes.
 */
export interface PlaybackClockState {
  readonly playing: boolean;
  /** Composition timeline frame, or null in legacy single-clip mode. */
  readonly timelineFrame: number | null;
  /** Source frame of the preview clip that maps back exactly to the timeline frame. */
  readonly previewSourceFrame: number;
}

export interface PlaybackClock {
  readonly read: () => PlaybackClockState;
  readonly publish: (next: Partial<PlaybackClockState>) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createPlaybackClock(initial: PlaybackClockState): PlaybackClock {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    publish: (next) => {
      const merged: PlaybackClockState = { ...state, ...next };
      if (
        merged.playing === state.playing &&
        merged.timelineFrame === state.timelineFrame &&
        merged.previewSourceFrame === state.previewSourceFrame
      )
        return;
      state = merged;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type PlaybackClockPrimitive = boolean | number | string | null;

export function usePlaybackClockSelector<T extends PlaybackClockPrimitive>(
  clock: PlaybackClock | undefined,
  selector: (state: PlaybackClockState) => T,
  fallback: T,
): T {
  const subscribe = useCallback(
    (listener: () => void) => (clock === undefined ? () => undefined : clock.subscribe(listener)),
    [clock],
  );
  const getSnapshot = (): T => (clock === undefined ? fallback : selector(clock.read()));
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
