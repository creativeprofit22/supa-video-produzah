// Browser-side bounded observation. A remembered currentSrc is recorded, not used as a buffer gauge.
export function captureMediaForUnload() {
  if (globalThis.__p2UnloadProbe) throw new Error("Previous unload probe was not disposed");
  const videos = [...globalThis.document.querySelectorAll(".monitor-stage video")];
  if (videos.length > 7) throw new Error("Unexpected media window size");
  const state = (video) => ({
    clipId: video.dataset.clipId,
    connected: video.isConnected,
    paused: video.paused,
    src: video.getAttribute("src"),
    hasSourceObject: video.srcObject !== null,
    sourceChildren: video.querySelectorAll("source").length,
    currentSrc: video.currentSrc,
    readyState: video.readyState,
    networkState: video.networkState,
    buffered: video.buffered.length,
    seekable: video.seekable.length,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  });
  globalThis.__p2UnloadProbe = videos.map((video) => {
    const events = [];
    let omitted = 0;
    const listener = (event) => {
      if (events.length < 32)
        events.push({ type: event.type, at: globalThis.performance.now(), state: state(video) });
      else omitted++;
    };
    const types = ["abort", "emptied", "loadstart", "loadeddata", "error"];
    for (const type of types) video.addEventListener(type, listener);
    return {
      video,
      before: state(video),
      state,
      events,
      omitted: () => omitted,
      dispose: () => {
        for (const type of types) video.removeEventListener(type, listener);
      },
    };
  });
}

export async function inspectMediaUnload() {
  const records = globalThis.__p2UnloadProbe;
  if (!records) throw new Error("Missing unload probe");
  try {
    const immediate = records.map((record) => record.state(record.video));
    // Observe a later task as well as the immediate state; never reload or otherwise repair the element here.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
    return records
      .filter((record) => !record.video.isConnected)
      .map((record) => ({
        before: record.before,
        immediate: immediate[records.indexOf(record)],
        settled: record.state(record.video),
        events: record.events,
        omitted: record.omitted(),
      }));
  } finally {
    for (const record of records) record.dispose();
    delete globalThis.__p2UnloadProbe;
  }
}

export function mediaIsUnloaded(state) {
  return (
    !state.connected &&
    state.paused &&
    state.src === null &&
    !state.hasSourceObject &&
    state.sourceChildren === 0 &&
    state.readyState === 0 &&
    state.networkState === 0 &&
    state.buffered === 0 &&
    state.seekable === 0 &&
    state.videoWidth === 0 &&
    state.videoHeight === 0
  );
}
