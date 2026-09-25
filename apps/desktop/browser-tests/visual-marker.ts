// Missing callbacks are not evidence of when the target frame was displayed.
export function findVisualMarker<T extends { id: number; display: number }>(
  frames: readonly T[],
  markerId: number,
): T | null {
  return frames.find((frame) => frame.id === markerId) ?? null;
}
