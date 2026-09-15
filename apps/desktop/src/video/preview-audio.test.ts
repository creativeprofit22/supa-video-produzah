import { describe, expect, it, vi, afterEach } from "vitest";
import { clipAudioAmplitude, validClipAudio } from "./clip-audio";
import { PreviewAudioGraph } from "./preview-audio";
import type { ProgramMonitorLayer } from "./ProgramMonitor";

afterEach(() => vi.unstubAllGlobals());
describe("clip audio", () => {
  it("uses exact output frames, linear amplitude and independent gain", () => {
    const fades = { inFrames: 10, outFrames: 20 };
    expect(validClipAudio({ gainMilliDecibels: 24000, fades }, 30)).toBe(true);
    expect(validClipAudio({ gainMilliDecibels: 24000, fades }, 29)).toBe(false);
    expect(clipAudioAmplitude(0, fades, 5, 30)).toBe(0.5);
    expect(clipAudioAmplitude(0, fades, 10, 30)).toBe(1);
    expect(clipAudioAmplitude(0, fades, 20, 30)).toBe(0.5);
    expect(clipAudioAmplitude(24000, fades, 10, 30)).toBeCloseTo(15.8489319246);
    expect(clipAudioAmplitude(0, fades, 30, 30)).toBe(0);
  });
  it("owns nodes/listeners/context, schedules output-time ramps and never resumes without a gesture", async () => {
    const param = {
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: param };
    const context = {
      currentTime: 7,
      destination: {},
      createMediaElementSource: vi.fn(() => source),
      createGain: vi.fn(() => gain),
      close: vi.fn(),
      resume: vi.fn(),
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          return context;
        }
      },
    );
    const media = Object.assign(new EventTarget(), {
      currentTime: 0,
      paused: false,
    }) as unknown as HTMLMediaElement;
    Object.defineProperty(media, "paused", { value: false });
    const add = vi.spyOn(media, "addEventListener");
    const remove = vi.spyOn(media, "removeEventListener");
    const layer = {
      gainMilliDecibels: 0,
      fades: { inFrames: 10, outFrames: 20 },
      sourceInFrame: 0,
      sourceOutFrame: 60,
      timelineDurationFrames: 30,
      speed: { numerator: 2, denominator: 1 },
    } as ProgramMonitorLayer;
    const graph = new PreviewAudioGraph();
    graph.sync([{ media, layer }], { numerator: 30, denominator: 1 });
    expect(context.resume).not.toHaveBeenCalled();
    expect(param.setValueAtTime).toHaveBeenCalledWith(0, 7);
    expect(param.linearRampToValueAtTime.mock.calls).toEqual([
      [1, 7 + 10 / 30],
      [0, 8],
    ]);
    graph.sync([{ media, layer }], { numerator: 30, denominator: 1 });
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    await graph.resumeFromGesture();
    expect(context.resume).toHaveBeenCalledTimes(1);
    graph.dispose();
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(gain.disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls).toEqual(add.mock.calls);
  });
  it("reconnects reused neutral nodes and cancels ramps on pause, seek and rate change", () => {
    const param = {
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const context = {
      currentTime: 0,
      destination: {},
      createMediaElementSource: vi.fn(() => source),
      createGain: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: param })),
      close: vi.fn(),
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          return context;
        }
      },
    );
    const media = Object.assign(new EventTarget(), {
      currentTime: 0,
      paused: false,
      seeking: false,
      playbackRate: 1,
    }) as unknown as HTMLMediaElement;
    const layer = {
      gainMilliDecibels: 6000,
      fades: { inFrames: 30, outFrames: 30 },
      sourceInFrame: 0,
      sourceOutFrame: 120,
    } as ProgramMonitorLayer;
    const rate = { numerator: 30, denominator: 1 };
    const graph = new PreviewAudioGraph();
    graph.sync([{ media, layer }], rate);
    param.linearRampToValueAtTime.mockClear();
    Object.assign(media, { paused: true });
    media.dispatchEvent(new Event("pause"));
    expect(param.linearRampToValueAtTime).not.toHaveBeenCalled();
    Object.assign(media, { paused: false, seeking: true });
    media.dispatchEvent(new Event("seeking"));
    expect(param.linearRampToValueAtTime).not.toHaveBeenCalled();
    Object.assign(media, { seeking: false, playbackRate: 2 });
    media.dispatchEvent(new Event("ratechange"));
    expect(param.linearRampToValueAtTime.mock.calls[0]?.[1]).toBe(0.5);
    graph.sync([], rate);
    graph.sync(
      [{ media, layer: { ...layer, gainMilliDecibels: 0, fades: { inFrames: 0, outFrames: 0 } } }],
      rate,
    );
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledTimes(2);
    expect(param.setValueAtTime).toHaveBeenLastCalledWith(0, 2);
    expect(param.setValueAtTime).toHaveBeenCalledWith(1, 0);
    graph.dispose();
  });
  it("fails explicitly when required Web Audio is missing", () => {
    vi.stubGlobal("AudioContext", undefined);
    const graph = new PreviewAudioGraph();
    expect(() =>
      graph.sync(
        [
          {
            media: Object.assign(new EventTarget(), {
              currentTime: 0,
              paused: false,
            }) as unknown as HTMLMediaElement,
            layer: { gainMilliDecibels: 1 } as ProgramMonitorLayer,
          },
        ],
        { numerator: 30, denominator: 1 },
      ),
    ).toThrow("unavailable");
    graph.dispose();
  });
});
