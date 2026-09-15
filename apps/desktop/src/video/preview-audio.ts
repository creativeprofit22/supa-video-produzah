import { clipAudioAmplitude } from "./clip-audio";
import type { ProgramMonitorLayer } from "./ProgramMonitor";
import type { RationalRate } from "@supa-video/contracts";

export class PreviewAudioGraph {
  private context: AudioContext | null = null;
  private nodes = new Map<
    HTMLMediaElement,
    { source: MediaElementAudioSourceNode; gain: GainNode; cleanup: () => void }
  >();
  private bindings = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  sync(
    entries: readonly { media: HTMLMediaElement; layer: ProgramMonitorLayer }[],
    rate: RationalRate,
  ) {
    const active = new Set(entries.map((entry) => entry.media));
    for (const [media, node] of this.nodes)
      if (!active.has(media)) {
        node.cleanup();
        node.source.disconnect();
        node.gain.disconnect();
        this.nodes.delete(media);
      }
    for (const { media, layer } of entries) {
      const required =
        (layer.gainMilliDecibels ?? 0) !== 0 ||
        (layer.fades?.inFrames ?? 0) !== 0 ||
        (layer.fades?.outFrames ?? 0) !== 0;
      if (!required && !this.nodes.has(media) && !this.bindings.has(media)) continue;
      if (!this.context) {
        if (typeof AudioContext === "undefined")
          throw new Error("Clip audio effects require Web Audio, which is unavailable.");
        this.context = new AudioContext();
      }
      let node = this.nodes.get(media);
      if (!node) {
        const source = this.bindings.get(media) ?? this.context.createMediaElementSource(media);
        this.bindings.set(media, source);
        const gain = this.context.createGain();
        source.connect(gain);
        gain.connect(this.context.destination);
        node = { source, gain, cleanup: () => {} };
        this.nodes.set(media, node);
      }
      node.cleanup();
      const context = this.context;
      const gain = node.gain.gain;
      const update = () => {
        const fps = rate.numerator / rate.denominator;
        const sourceRate = layer.sourceRate ?? rate;
        const speed = layer.speed ? layer.speed.numerator / layer.speed.denominator : 1;
        const frame =
          ((media.currentTime -
            (layer.sourceInFrame * sourceRate.denominator) / sourceRate.numerator) *
            fps) /
          speed;
        const duration = layer.timelineDurationFrames ?? layer.sourceOutFrame - layer.sourceInFrame;
        const fades = layer.fades ?? { inFrames: 0, outFrames: 0 };
        const amplitude = (at: number) =>
          clipAudioAmplitude(layer.gainMilliDecibels ?? 0, fades, at, duration);
        gain.cancelScheduledValues(context.currentTime);
        gain.setValueAtTime(amplitude(frame), context.currentTime);
        if (!media.paused && !media.seeking && frame < duration) {
          for (const boundary of [
            ...new Set([fades.inFrames, duration - fades.outFrames, duration]),
          ].sort((a, b) => a - b)) {
            if (boundary <= frame) continue;
            const time =
              context.currentTime +
              (((boundary - frame) / fps) * speed) / (media.playbackRate || speed);
            if (boundary === duration && fades.outFrames === 0) gain.setValueAtTime(0, time);
            else gain.linearRampToValueAtTime(amplitude(boundary), time);
          }
        }
      };
      const events = ["play", "pause", "seeking", "seeked", "ratechange", "loadedmetadata"];
      events.forEach((event) => media.addEventListener(event, update));
      node.cleanup = () => {
        events.forEach((event) => media.removeEventListener(event, update));
        gain.cancelScheduledValues(context.currentTime);
      };
      update();
    }
  }
  resumeFromGesture() {
    return this.context?.resume();
  }
  dispose() {
    for (const node of this.nodes.values()) {
      node.cleanup();
      node.source.disconnect();
      node.gain.disconnect();
    }
    this.nodes.clear();
    void this.context?.close();
    this.context = null;
  }
}
