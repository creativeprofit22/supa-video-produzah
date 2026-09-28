import type { SequenceLoudnessTarget, TrackAudioRole } from "@supa-video/contracts";

/**
 * Final audio mix graph shared (string-for-string) with the native validator
 * in `apps/desktop/src-tauri/src/video/audio_mix.rs`.
 *
 * Patterns from veedstudio/open-edit mix-audio.ts and calesthio/OpenMontage
 * audio_mixer.py: the dialogue bus is `asplit` (a label is consumable once),
 * the sidechain key is padded to the sequence length with a bounded
 * `apad=whole_dur` (an unpadded key cuts music after the last word), and
 * `amix normalize=0` keeps levels deterministic. Gain and cleanup run before
 * the key because the compressor threshold is absolute.
 */
export interface AudibleInput {
  readonly index: number;
  readonly role: TrackAudioRole | undefined;
}

export const DIALOGUE_CLEANUP_FILTER = "highpass=f=80,afftdn=nr=12:nf=-40";
export const DUCKING_FILTER = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600";
export const LOUDNESS_RANGE_TARGET_LU = 11;
/**
 * loudnorm aims this far below the delivery ceiling so AAC encoding overshoot
 * cannot push the measured true peak above the ceiling.
 */
export const TRUE_PEAK_HEADROOM_DB = 0.5;

export class AudioMixPlanError extends Error {
  readonly code = "ducking_without_dialogue";
}

function oneDecimal(value: number): string {
  return value.toFixed(1);
}

/** Single-pass placeholder; the native executor substitutes the pass-2 node. */
export function loudnormPlaceholder(mix: SequenceLoudnessTarget): string {
  return `loudnorm=I=${oneDecimal(mix.integratedLufs)}:TP=${oneDecimal(mix.truePeakCeilingDbtp - TRUE_PEAK_HEADROOM_DB)}:LRA=${oneDecimal(LOUDNESS_RANGE_TARGET_LU)}`;
}

function mixOf(labels: readonly string[], output: string, tail = ""): string {
  if (labels.length === 1) return `[${labels[0]}]${tail === "" ? "anull" : tail}[${output}]`;
  return `${labels.map((label) => `[${label}]`).join("")}amix=inputs=${labels.length}:duration=longest:normalize=0${tail === "" ? "" : `,${tail}`}[${output}]`;
}

export function audioMixFilters(
  audible: readonly AudibleInput[],
  mix: SequenceLoudnessTarget | undefined,
  duration: string,
): string[] {
  if (audible.length === 0) return [];
  const parts: string[] = [];
  const labels = new Map<number, string>();
  for (const { index, role } of audible) {
    if (mix?.dialogueCleanup === true && role === "dialogue") {
      parts.push(`[a${index}]${DIALOGUE_CLEANUP_FILTER}[c${index}]`);
      labels.set(index, `c${index}`);
    } else {
      labels.set(index, `a${index}`);
    }
  }
  const label = (index: number): string => labels.get(index) ?? `a${index}`;

  let finalLabels = audible.map(({ index }) => label(index));
  if (mix?.ducking === true) {
    const dialogue = audible.filter(({ role }) => role === "dialogue").map(({ index }) => index);
    const music = audible.filter(({ role }) => role === "music").map(({ index }) => index);
    if (dialogue.length === 0) {
      throw new AudioMixPlanError(
        "Ducking needs at least one audible track with the dialogue role",
      );
    }
    if (music.length > 0) {
      const dialogueLabels = dialogue.map(label);
      parts.push(
        dialogueLabels.length === 1
          ? `[${dialogueLabels[0]}]asplit=2[dmix][dkey0]`
          : `${dialogueLabels.map((value) => `[${value}]`).join("")}amix=inputs=${dialogueLabels.length}:duration=longest:normalize=0,asplit=2[dmix][dkey0]`,
      );
      parts.push(`[dkey0]apad=whole_dur=${duration}[dkey]`);
      let musicBus = label(music[0]!);
      if (music.length > 1) {
        parts.push(mixOf(music.map(label), "mbus"));
        musicBus = "mbus";
      }
      parts.push(`[${musicBus}][dkey]${DUCKING_FILTER}[mduck]`);
      const ducked = new Set([...dialogue, ...music]);
      finalLabels = [
        "dmix",
        "mduck",
        ...audible.filter(({ index }) => !ducked.has(index)).map(({ index }) => label(index)),
      ];
    }
  }
  parts.push(mixOf(finalLabels, "aout", mix === undefined ? "" : loudnormPlaceholder(mix)));
  return parts;
}
