import { expect, test } from "@playwright/test";

test("actual decoded low-tone media: gain, continuous fades, pause/seek and node reuse", async ({ page }, info) => {
  await page.goto("/browser-tests/program-monitor-speed.html");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/video/preview-audio.ts";
    const { PreviewAudioGraph } = await import(modulePath);
    // PCM WAV is real decoded HTMLMediaElement input, not an oscillator bypass.
    const sampleRate = 48000, samples = sampleRate * 4;
    const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
    const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(32767 * 0.04 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), true);
    const media = document.createElement("audio"); media.crossOrigin = "anonymous";
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); media.src = url;
    await new Promise<void>((resolve, reject) => { media.onloadedmetadata = () => resolve(); media.onerror = reject; });
    const graph = new PreviewAudioGraph();
    const layer = { sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120, gainMilliDecibels: 6000, fades: { inFrames: 30, outFrames: 30 } };
    const rate = { numerator: 30, denominator: 1 };
    graph.sync([{ media, layer }], rate);
    const context = graph.context as AudioContext;
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    graph.nodes.get(media).gain.connect(analyser);
    await graph.resumeFromGesture(); await media.play();
    const points: { time: number; rms: number }[] = [];
    while (media.currentTime < 3.7) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
      points.push({ time: media.currentTime, rms: Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length) });
    }
    media.pause();
    graph.sync([], rate);
    const neutral = { ...layer, gainMilliDecibels: 0, fades: { inFrames: 0, outFrames: 0 } };
    graph.sync([{ media, layer: neutral }], rate);
    graph.nodes.get(media).gain.connect(analyser);
    media.currentTime = 1.5;
    await new Promise<void>(resolve => { media.onseeked = () => resolve(); });
    await media.play(); await new Promise(resolve => setTimeout(resolve, 200));
    const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
    const neutralRms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
    media.pause(); graph.dispose(); URL.revokeObjectURL(url);
    return { points, neutralRms };
  });
  await info.attach("preview-audio-rms.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.neutralRms).toBeCloseTo(0.04 / Math.sqrt(2), 2);
  for (const point of result.points.filter(p => p.time > 0.2 && p.time < 3.7)) {
    const envelope = Math.min(1, point.time, 4 - point.time);
    expect(Math.abs(point.rms - 0.04 / Math.sqrt(2) * 10 ** (6 / 20) * envelope)).toBeLessThan(0.009);
  }
  expect(result.points.filter(p => p.time > 1.2 && p.time < 2.8).length).toBeGreaterThan(10);
});
