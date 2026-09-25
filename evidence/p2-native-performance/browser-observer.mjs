// Opt-in diagnostics only. The original native media setter still receives the exact
// app-supplied, frame-quantized value. No test-only seek or playback path is substituted.
export function installObserver({ cap = 20000, leaseMs = 90000 } = {}) {
  const {
    window,
    document,
    performance,
    MutationObserver,
    PerformanceObserver,
    HTMLVideoElement,
    HTMLMediaElement,
    setTimeout,
    clearTimeout,
    structuredClone,
  } = globalThis;
  if (
    !Number.isInteger(cap) ||
    cap < 1 ||
    cap > 100000 ||
    !Number.isFinite(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > 120000
  )
    throw new Error("Invalid observer bounds");
  if (window.__p2Observer) throw new Error("Observer already installed");
  const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  if (!original?.set || !original.configurable)
    throw new Error("Media request instrumentation unavailable");
  const started = performance.now(),
    events = [],
    videos = new Map();
  let omitted = 0,
    stopped = false,
    armed = null,
    nextVideoId = 0,
    videoTrackingCapReached = false;
  const push = (event) => {
    if (events.length < cap) events.push(event);
    else omitted++;
  };
  const quality = (v) => {
    if (typeof v.getVideoPlaybackQuality !== "function") return null;
    const q = v.getVideoPlaybackQuality();
    return {
      total: q.totalVideoFrames,
      dropped: q.droppedVideoFrames,
      corrupted: Number.isFinite(q.corruptedVideoFrames) ? q.corruptedVideoFrames : null,
    };
  };
  function attach(v) {
    if (videos.has(v)) return;
    if (videos.size >= 32) {
      videoTrackingCapReached = true;
      return;
    }
    const e = {
      id: nextVideoId++,
      segment: 0,
      initial: quality(v),
      lastQuality: quality(v),
      last: null,
      callback: null,
      supported: typeof v.requestVideoFrameCallback === "function",
    };
    videos.set(v, e);
    e.reset = () => {
      // emptied can occur after counters reset: retain the last frame observation rather
      // than subtracting reset counters or accidentally joining A -> B -> A.
      push({
        type: "decoder-segment",
        id: e.id,
        segment: e.segment++,
        initial: e.initial,
        final: e.lastQuality,
        reason: "emptied",
        endpointMayBeIncomplete: true,
      });
      e.initial = quality(v);
      e.lastQuality = quality(v);
      e.last = null;
    };
    v.addEventListener("emptied", e.reset);
    function frame(now, metadata) {
      if (stopped) return;
      e.lastQuality = quality(v);
      push({
        type: "frame",
        id: e.id,
        segment: e.segment,
        at: now,
        mediaTime: metadata.mediaTime,
        presentedFrames: metadata.presentedFrames,
        gapMs: e.last === null ? null : now - e.last,
      });
      e.last = now;
      e.callback = v.requestVideoFrameCallback(frame);
    }
    if (e.supported) e.callback = v.requestVideoFrameCallback(frame);
  }
  const scan = () => {
    // Bound live references, not lifetime video count. Preserve retired counters without
    // retaining DOM nodes or callbacks through an entire playback session.
    for (const [v, e] of videos) {
      if (v.isConnected) continue;
      const final = quality(v);
      const reset = final && e.lastQuality && final.total < e.lastQuality.total;
      push({
        type: "decoder-segment",
        id: e.id,
        segment: e.segment,
        initial: e.initial,
        final: reset ? e.lastQuality : final,
        reason: "detached",
        endpointMayBeIncomplete: !!reset,
      });
      v.removeEventListener("emptied", e.reset);
      if (e.callback !== null) v.cancelVideoFrameCallback(e.callback);
      videos.delete(v);
    }
    for (const v of document.querySelectorAll("video")) attach(v);
  };
  scan();
  const mutations = new MutationObserver(scan);
  mutations.observe(document.documentElement, { childList: true, subtree: true });
  let longTasks = null;
  if (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
  ) {
    longTasks = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        push({ type: "longtask", at: e.startTime, duration: e.duration });
    });
    longTasks.observe({ type: "longtask", buffered: false });
  }
  const wrappedSet = function (value) {
    if (
      armed &&
      armed.begin === null &&
      this instanceof HTMLVideoElement &&
      // A departing/removed layer can receive a zero-time write in the same app update.
      // Latch only the connected element for the requested clip, never such a decoy.
      this.isConnected &&
      (armed.clipId === null || this.dataset.clipId === armed.clipId) &&
      this.matches(armed.selector) &&
      Math.abs(value - armed.expectedSeconds) <= armed.toleranceSeconds
    )
      armed.start(this, value);
    return Reflect.apply(original.set, this, [value]);
  };
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    ...original,
    set: wrappedSet,
  });
  const capabilities = {
    longTasks: longTasks !== null,
    physicalDisplayProof: false,
    seekOrigin: "real-media-write-boundary",
  };
  const api = {
    markRequest() {
      if (!armed || armed.begin !== null) throw new Error("Seek must be armed before request");
      armed.requestAt = performance.now();
    },
    armSeek(selector, expectedSeconds, toleranceSeconds, timeoutMs = 5000, { clipId = null } = {}) {
      if (
        stopped ||
        armed ||
        (clipId !== null && (typeof clipId !== "string" || clipId.length === 0)) ||
        !Number.isFinite(expectedSeconds) ||
        expectedSeconds < 0 ||
        !Number.isFinite(toleranceSeconds) ||
        toleranceSeconds <= 0 ||
        toleranceSeconds > 0.1 ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 10000
      )
        throw new Error("Invalid or overlapping seek");
      document.querySelector(selector); // Validate CSS before installing any pending work.
      const sample = {
        type: "seek",
        latencyOrigin: "real-media-write-boundary",
        expectedSeconds,
        requestedClipId: clipId,
        beforeWrite: null,
        armedAt: performance.now(),
        requestedAt: null,
        requestedValue: null,
        status: "pending",
        seekedMs: null,
        presentedMs: null,
      };
      let video = null,
        frameId = null,
        timer,
        finished = false;
      const finish = (status) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        video?.removeEventListener("seeked", onSeeked);
        if (frameId !== null) video.cancelVideoFrameCallback(frameId);
        sample.status = status;
        sample.observedMedia = video
          ? {
              clipId: video.dataset.clipId ?? null,
              connected: video.isConnected,
              active: video.dataset.active ?? null,
              currentTime: video.currentTime,
              readyState: video.readyState,
              networkState: video.networkState,
              seeking: video.seeking,
            }
          : null;
        push(sample);
        armed = null;
      };
      const onSeeked = () => {
        if (Math.abs(video.currentTime - expectedSeconds) > toleranceSeconds) return;
        sample.seekedMs ??= performance.now() - sample.requestedAt;
        if (sample.presentedMs !== null) finish("ok");
      };
      const onFrame = (now, metadata) => {
        if (
          now >= sample.requestedAt &&
          Math.abs(metadata.mediaTime - expectedSeconds) <= toleranceSeconds
        ) {
          sample.presentedMs ??= now - sample.requestedAt;
          if (sample.seekedMs !== null) {
            finish("ok");
            return;
          }
        }
        frameId = video.requestVideoFrameCallback(onFrame);
      };
      // Same displayed frame before and after the write: seeked can fire, but no new frame is
      // composited, so rVFC legitimately never reports it. Classified only at timeout.
      const frameIndex = (seconds) => Math.floor(seconds / toleranceSeconds + 1e-6);
      const sameFrame = () =>
        sample.seekedMs !== null &&
        sample.presentedMs === null &&
        sample.beforeWrite !== null &&
        sample.beforeWrite.readyState >= 2 &&
        !sample.beforeWrite.seeking &&
        frameIndex(sample.beforeWrite.currentTime) === frameIndex(sample.requestedValue);
      armed = {
        selector,
        clipId,
        expectedSeconds,
        toleranceSeconds,
        begin: null,
        cancel: () => finish("cancelled"),
        start(v, value) {
          video = v;
          sample.beforeWrite = {
            currentTime: v.currentTime,
            readyState: v.readyState,
            seeking: v.seeking,
          };
          this.begin = performance.now();
          sample.requestedAt = this.requestAt ?? this.begin;
          sample.mediaWriteAt = this.begin;
          if (this.requestAt !== undefined) sample.latencyOrigin = "real-seek-entry";
          sample.requestedValue = value;
          video.addEventListener("seeked", onSeeked);
          if (typeof video.requestVideoFrameCallback === "function")
            frameId = video.requestVideoFrameCallback(onFrame);
        },
      };
      timer = setTimeout(
        () =>
          finish(
            sample.requestedAt === null
              ? "request-not-observed"
              : typeof video.requestVideoFrameCallback !== "function"
                ? "presentation-unavailable"
                : sameFrame()
                  ? "same-frame-no-new-frame"
                  : "timeout",
          ),
        timeoutMs,
      );
      return { armedAt: sample.armedAt };
    },
    snapshot() {
      return {
        started,
        ended: performance.now(),
        capabilities,
        omitted,
        pendingSeeks: armed ? 1 : 0,
        events: structuredClone(events),
        videos: [...videos].map(([v, e]) => ({
          id: e.id,
          segment: e.segment,
          initial: e.initial,
          final: quality(v),
          presentationCallbacks: e.supported,
        })),
        videoTrackingCapReached,
        videosObserved: nextVideoId,
        domCount: document.getElementsByTagName("*").length,
        materializedRows: document.querySelectorAll(".multitrack-track-row").length,
        visibleRows: [...document.querySelectorAll(".multitrack-track-row")].filter((row) => {
          const r = row.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
        }).length,
        materializedItems: document.querySelectorAll(".multitrack-clip, .multitrack-caption")
          .length,
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(lease);
      mutations.disconnect();
      longTasks?.disconnect();
      armed?.cancel();
      for (const [v, e] of videos) {
        v.removeEventListener("emptied", e.reset);
        if (e.callback !== null) v.cancelVideoFrameCallback(e.callback);
      }
      if (
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime").set ===
        wrappedSet
      )
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", original);
      delete window.__p2Observer;
    },
  };
  const lease = setTimeout(() => api.stop(), leaseMs);
  window.__p2Observer = api;
  return { started, capabilities };
}
