export interface ClipAudioEdit {
  sequenceId: string;
  trackId: string;
  clipId: string;
  gainMilliDecibels: number;
  fades: { inFrames: number; outFrames: number };
}
export function validClipAudio(
  edit: Pick<ClipAudioEdit, "gainMilliDecibels" | "fades">,
  duration: number,
): boolean {
  return (
    Number.isSafeInteger(edit.gainMilliDecibels) &&
    edit.gainMilliDecibels >= -96000 &&
    edit.gainMilliDecibels <= 24000 &&
    Number.isSafeInteger(edit.fades.inFrames) &&
    Number.isSafeInteger(edit.fades.outFrames) &&
    edit.fades.inFrames >= 0 &&
    edit.fades.outFrames >= 0 &&
    edit.fades.inFrames + edit.fades.outFrames <= duration
  );
}
export function clipAudioAmplitude(
  gain: number,
  fades: { inFrames: number; outFrames: number },
  frame: number,
  duration: number,
): number {
  if (frame < 0 || frame >= duration) return 0;
  return (
    10 ** (gain / 20000) *
    Math.min(
      1,
      fades.inFrames === 0 ? 1 : frame / fades.inFrames,
      fades.outFrames === 0 ? 1 : (duration - frame) / fades.outFrames,
    )
  );
}
