/**
 * Quantize only at the media-write boundary, never in canonical frame/rational
 * mappings or the realtime clock. Runtimes can truncate currentTime to integer
 * microseconds: an exact frame boundary (e.g. 1.001s) can otherwise decode the
 * preceding frame. Ceil to microseconds and add one guard microsecond to land
 * inside the requested frame even after floating-point conversion/truncation.
 * Preserve zero and clamp to the known media endpoint; metadata may be absent.
 */
export function seekMediaTime(
  media: { currentTime: number; readonly duration: number },
  seconds: number,
): void {
  const insideFrame = seconds <= 0 ? 0 : (Math.ceil(seconds * 1_000_000) + 1) / 1_000_000;
  const end = Number.isFinite(media.duration) ? Math.max(0, media.duration) : Infinity;
  media.currentTime = Math.min(insideFrame, end);
}
