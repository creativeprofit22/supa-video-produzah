import type { RationalRate } from "@supa-video/contracts";
import {
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCommand, useCommandHandler } from "../commands/CommandProvider";

export interface ProgramMonitorLayer {
  readonly clipId: string;
  readonly path: string;
  readonly canonicalTrackIndex: number;
  readonly timelineStartFrame: number;
  readonly sourceInFrame: number;
  readonly sourceOutFrame: number;
  readonly hidden: boolean;
  readonly muted: boolean;
  readonly hasAudio: boolean;
}

export interface ProgramMonitorCaption {
  readonly captionId: string;
  readonly text: string;
}

interface ProgramMonitorProps {
  readonly proxyPath: string | null;
  readonly finalPreviewPath: string | null;
  readonly hasAudio: boolean;
  readonly timelineAudioMuted: boolean;
  readonly timelineVideoHidden: boolean;
  readonly sourceLayers?: readonly ProgramMonitorLayer[];
  readonly activeCaptions?: readonly ProgramMonitorCaption[];
  readonly convertCachePath: (path: string) => string;
  readonly rate: RationalRate;
  readonly trimIn: number;
  readonly trimOut: number;
  readonly playhead: number;
  readonly onPlayheadChange: (frame: number) => void;
}

function secondsForFrame(frame: number, rate: RationalRate): number {
  return (frame * rate.denominator) / rate.numerator;
}

function frameForSeconds(seconds: number, rate: RationalRate): number {
  return Math.max(0, Math.floor((seconds * rate.numerator) / rate.denominator));
}

function timelineEndFrame(layer: ProgramMonitorLayer): number {
  return layer.timelineStartFrame + layer.sourceOutFrame - layer.sourceInFrame;
}

function layerIsActiveAtTimelineFrame(layer: ProgramMonitorLayer, frame: number): boolean {
  return layer.timelineStartFrame <= frame && frame < timelineEndFrame(layer);
}

function clockLayerAtTimelineFrame(
  layers: readonly ProgramMonitorLayer[],
  frame: number,
): ProgramMonitorLayer | null {
  const visibleLayers = layers.filter((layer) => !layer.hidden);
  return (
    visibleLayers.find((layer) => layerIsActiveAtTimelineFrame(layer, frame)) ??
    visibleLayers.find((layer) => layer.timelineStartFrame >= frame) ??
    visibleLayers.at(-1) ??
    null
  );
}

function supportsVideoFrameCallbacks(video: HTMLVideoElement): boolean {
  return (
    typeof video.requestVideoFrameCallback === "function" &&
    typeof video.cancelVideoFrameCallback === "function"
  );
}

interface PendingVideoFrameRequest {
  readonly video: HTMLVideoElement;
  readonly id: number;
}

export function ProgramMonitor({
  proxyPath,
  finalPreviewPath,
  hasAudio,
  timelineAudioMuted: canonicalTimelineAudioMuted,
  timelineVideoHidden,
  sourceLayers = [],
  activeCaptions = [],
  convertCachePath,
  rate,
  trimIn,
  trimOut,
  playhead,
  onPlayheadChange,
}: ProgramMonitorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const layerVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const pendingVideoFrameRequestRef = useRef<PendingVideoFrameRequest | null>(null);
  const frameObservationGenerationRef = useRef(0);
  const audioSettingsRef = useRef({ volume: 1, muted: false });
  const lastNonZeroVolumeRef = useRef(1);
  const updatePlayheadAtSecondsRef = useRef<(video: HTMLVideoElement, seconds: number) => boolean>(
    () => false,
  );
  const [previewMode, setPreviewMode] = useState<"source" | "final">("source");
  const compositionActive = previewMode === "source" && sourceLayers.length > 0;
  const primaryLayer = compositionActive ? clockLayerAtTimelineFrame(sourceLayers, playhead) : null;
  const timelineAudioMuted =
    previewMode === "source" &&
    (compositionActive
      ? !sourceLayers.some((layer) => layer.hasAudio && !layer.muted)
      : canonicalTimelineAudioMuted);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const selectedPath =
    previewMode === "final" && finalPreviewPath !== null
      ? finalPreviewPath
      : compositionActive
        ? (primaryLayer?.path ?? null)
        : proxyPath;
  const mediaUrl = useMemo(
    () => (selectedPath === null ? null : convertCachePath(selectedPath)),
    [convertCachePath, selectedPath],
  );
  const visibleLayers = sourceLayers.filter((layer) => !layer.hidden);
  const visibleVideoTrackIndices = [
    ...new Set(visibleLayers.map((layer) => layer.canonicalTrackIndex)),
  ].sort((left, right) => left - right);
  const activeIn =
    previewMode !== "source"
      ? 0
      : compositionActive
        ? Math.min(...visibleLayers.map((layer) => layer.timelineStartFrame))
        : trimIn;
  const activeOut =
    previewMode !== "source"
      ? Number.MAX_SAFE_INTEGER
      : compositionActive
        ? Math.max(...visibleLayers.map(timelineEndFrame))
        : trimOut;
  const frameObservationContext = useMemo(
    () => ({ mediaUrl, previewMode, clockClipId: primaryLayer?.clipId ?? null }),
    [mediaUrl, previewMode, primaryLayer?.clipId],
  );
  const frameObservationContextRef = useRef(frameObservationContext);
  frameObservationContextRef.current = frameObservationContext;

  const cancelFrameObservation = useCallback(() => {
    frameObservationGenerationRef.current += 1;
    const pendingRequest = pendingVideoFrameRequestRef.current;
    pendingVideoFrameRequestRef.current = null;
    if (pendingRequest !== null) {
      pendingRequest.video.cancelVideoFrameCallback(pendingRequest.id);
    }
  }, []);

  useEffect(() => {
    cancelFrameObservation();
    setBuffering(false);
    setMediaError(false);
    setPlaying(false);
    return cancelFrameObservation;
  }, [cancelFrameObservation, frameObservationContext]);

  useEffect(() => {
    if (finalPreviewPath === null) {
      setPreviewMode("source");
    }
  }, [finalPreviewPath]);

  const seekTo = useCallback(
    (frame: number) => {
      const boundedFrame = Math.max(activeIn, Math.min(frame, activeOut - 1));
      playheadRef.current = boundedFrame;
      setBuffering(false);
      if (compositionActive) {
        for (const layer of sourceLayers) {
          const video = layerVideoRefs.current.get(layer.clipId);
          if (video !== undefined) {
            const sourceFrame = Math.max(
              layer.sourceInFrame,
              Math.min(
                layer.sourceInFrame + boundedFrame - layer.timelineStartFrame,
                layer.sourceOutFrame - 1,
              ),
            );
            video.currentTime = secondsForFrame(sourceFrame, rate);
          }
        }
      } else if (videoRef.current !== null) {
        videoRef.current.currentTime = secondsForFrame(boundedFrame, rate);
      }
      onPlayheadChange(boundedFrame);
    },
    [activeIn, activeOut, compositionActive, onPlayheadChange, rate, sourceLayers],
  );
  const seekRelative = useCallback(
    (deltaFrames: number) => seekTo(playheadRef.current + deltaFrames),
    [seekTo],
  );

  const updatePlayheadAtSeconds = useCallback(
    (video: HTMLVideoElement, seconds: number): boolean => {
      if (video !== videoRef.current) {
        return false;
      }
      const sourceFrame = frameForSeconds(seconds, rate);
      const frame =
        compositionActive && primaryLayer !== null
          ? primaryLayer.timelineStartFrame + sourceFrame - primaryLayer.sourceInFrame
          : sourceFrame;
      const primaryLayerEnded =
        compositionActive && primaryLayer !== null && frame >= timelineEndFrame(primaryLayer);
      if (
        frame >= activeOut ||
        (primaryLayerEnded && clockLayerAtTimelineFrame(sourceLayers, frame) === null)
      ) {
        video.pause();
        seekTo(Math.max(activeIn, activeOut - 1));
        return false;
      }
      const boundedFrame = Math.max(activeIn, frame);
      playheadRef.current = boundedFrame;
      onPlayheadChange(boundedFrame);
      return !primaryLayerEnded;
    },
    [
      activeIn,
      activeOut,
      compositionActive,
      onPlayheadChange,
      primaryLayer,
      rate,
      seekTo,
      sourceLayers,
    ],
  );
  updatePlayheadAtSecondsRef.current = updatePlayheadAtSeconds;

  const startFrameObservation = useCallback(
    (video: HTMLVideoElement) => {
      cancelFrameObservation();
      if (!supportsVideoFrameCallbacks(video)) {
        return;
      }

      const generation = frameObservationGenerationRef.current;
      const context = frameObservationContext;
      const requestNextFrame = () => {
        const id = video.requestVideoFrameCallback((_now, metadata) => {
          if (
            generation !== frameObservationGenerationRef.current ||
            context !== frameObservationContextRef.current ||
            video !== videoRef.current
          ) {
            return;
          }
          pendingVideoFrameRequestRef.current = null;
          const mediaTime = Number.isFinite(metadata.mediaTime)
            ? metadata.mediaTime
            : video.currentTime;
          if (
            !updatePlayheadAtSecondsRef.current(video, mediaTime) ||
            video.paused ||
            generation !== frameObservationGenerationRef.current
          ) {
            return;
          }
          requestNextFrame();
        });
        pendingVideoFrameRequestRef.current = { video, id };
      };

      requestNextFrame();
    },
    [cancelFrameObservation, frameObservationContext],
  );

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current;
    if (video === null || mediaError) {
      return;
    }
    if (!video.paused) {
      cancelFrameObservation();
      setBuffering(false);
      video.pause();
      return;
    }
    const sourceFrame = frameForSeconds(video.currentTime, rate);
    const frame =
      compositionActive && primaryLayer !== null
        ? primaryLayer.timelineStartFrame + sourceFrame - primaryLayer.sourceInFrame
        : sourceFrame;
    if (frame < activeIn || frame >= activeOut) {
      seekTo(activeIn);
    }
    await video.play().catch(() => {
      cancelFrameObservation();
      setBuffering(false);
      setPlaying(false);
      setMediaError(true);
    });
    if (compositionActive && !video.paused) {
      for (const layer of sourceLayers) {
        const layerVideo = layerVideoRefs.current.get(layer.clipId);
        if (
          layerVideo !== undefined &&
          layerVideo !== video &&
          layerIsActiveAtTimelineFrame(layer, playheadRef.current)
        ) {
          void layerVideo.play().catch(() => undefined);
        }
      }
    }
  }, [
    activeIn,
    activeOut,
    cancelFrameObservation,
    compositionActive,
    mediaError,
    primaryLayer,
    rate,
    seekTo,
    sourceLayers,
  ]);

  const updatePlayheadFromTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (video === null || supportsVideoFrameCallbacks(video)) {
      return;
    }
    updatePlayheadAtSeconds(video, video.currentTime);
  }, [updatePlayheadAtSeconds]);

  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    setPlaying(true);
    startFrameObservation(video);
  }, [startFrameObservation]);

  const handlePlaybackStopped = useCallback(() => {
    cancelFrameObservation();
    for (const layerVideo of layerVideoRefs.current.values()) layerVideo.pause();
    setBuffering(false);
    setPlaying(false);
  }, [cancelFrameObservation]);

  const handleMediaBuffering = useCallback(() => {
    setBuffering(true);
  }, []);

  const handlePlaybackRecovered = useCallback(() => {
    setBuffering(false);
  }, []);

  const handleMediaError = useCallback(() => {
    cancelFrameObservation();
    setBuffering(false);
    setPlaying(false);
    setMediaError(true);
  }, [cancelFrameObservation]);

  const syncUserAudioStateFromMedia = useCallback(
    (video: HTMLVideoElement) => {
      const nextVolume = Math.max(0, Math.min(video.volume, 1));
      if (nextVolume > 0) {
        lastNonZeroVolumeRef.current = nextVolume;
      }
      const nextMuted = timelineAudioMuted ? audioSettingsRef.current.muted : video.muted;
      audioSettingsRef.current = { volume: nextVolume, muted: nextMuted };
      setVolume(nextVolume);
      setMuted(nextMuted);
      if (timelineAudioMuted && !video.muted) {
        video.muted = true;
      }
    },
    [timelineAudioMuted],
  );

  const applyEffectiveAudioState = useCallback(
    (video: HTMLVideoElement) => {
      const audioSettings = audioSettingsRef.current;
      if (video.volume !== audioSettings.volume) {
        video.volume = audioSettings.volume;
      }
      const effectiveMuted = timelineAudioMuted || audioSettings.muted;
      if (video.muted !== effectiveMuted) {
        video.muted = effectiveMuted;
      }
    },
    [timelineAudioMuted],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (video !== null) applyEffectiveAudioState(video);
    if (compositionActive) {
      for (const layer of sourceLayers) {
        const layerVideo = layerVideoRefs.current.get(layer.clipId);
        if (layerVideo !== undefined) {
          layerVideo.volume = volume;
          layerVideo.muted = muted || layer.muted || !layer.hasAudio;
        }
      }
    }
  }, [applyEffectiveAudioState, compositionActive, mediaUrl, muted, sourceLayers, volume]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    applyEffectiveAudioState(video);
    seekTo(playheadRef.current);
  }, [applyEffectiveAudioState, seekTo]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video === null || !hasAudio || timelineAudioMuted) {
      return;
    }
    const audioSettings = audioSettingsRef.current;
    let nextVolume = audioSettings.volume;
    let nextMuted = audioSettings.muted;
    if (nextMuted || nextVolume === 0) {
      if (nextVolume === 0) {
        nextVolume = lastNonZeroVolumeRef.current;
      }
      nextMuted = false;
    } else {
      nextMuted = true;
    }
    audioSettingsRef.current = { volume: nextVolume, muted: nextMuted };
    setVolume(nextVolume);
    setMuted(nextMuted);
    applyEffectiveAudioState(video);
  }, [applyEffectiveAudioState, hasAudio, timelineAudioMuted]);

  const changeVolume = useCallback(
    (nextVolume: number) => {
      const video = videoRef.current;
      if (video === null || !hasAudio || timelineAudioMuted) {
        return;
      }
      const boundedVolume = Math.max(0, Math.min(nextVolume, 1));
      if (boundedVolume > 0) {
        lastNonZeroVolumeRef.current = boundedVolume;
      }
      const nextMuted = boundedVolume === 0;
      audioSettingsRef.current = { volume: boundedVolume, muted: nextMuted };
      setVolume(boundedVolume);
      setMuted(nextMuted);
      applyEffectiveAudioState(video);
    },
    [applyEffectiveAudioState, hasAudio, timelineAudioMuted],
  );

  const transportReady =
    mediaUrl !== null &&
    !mediaError &&
    Number.isFinite(activeOut - activeIn) &&
    activeOut > activeIn;
  useCommandHandler("playback.toggle", {
    canExecute: transportReady,
    execute: togglePlayback,
  });
  useCommandHandler("playback.stepBackward", {
    canExecute: transportReady,
    execute: () => seekRelative(-1),
  });
  useCommandHandler("playback.stepForward", {
    canExecute: transportReady,
    execute: () => seekRelative(1),
  });
  useCommandHandler("playback.jumpBackward", {
    canExecute: transportReady,
    execute: () => seekRelative(-5),
  });
  useCommandHandler("playback.jumpForward", {
    canExecute: transportReady,
    execute: () => seekRelative(5),
  });
  const toggleCommand = useCommand("playback.toggle");
  const stepBackwardCommand = useCommand("playback.stepBackward");
  const stepForwardCommand = useCommand("playback.stepForward");
  const jumpBackwardCommand = useCommand("playback.jumpBackward");
  const jumpForwardCommand = useCommand("playback.jumpForward");

  return (
    <section className="panel monitor-panel" aria-labelledby="monitor-title">
      <div className="panel-heading monitor-heading">
        <div>
          <p className="state-kicker">Program monitor</p>
          <h2 id="monitor-title">
            {previewMode === "final"
              ? "Final preview"
              : compositionActive
                ? "Canonical composition"
                : "Prepared proxy"}
          </h2>
        </div>
        {finalPreviewPath !== null ? (
          <div className="segmented-control" aria-label="Monitor source">
            <button
              type="button"
              aria-pressed={previewMode === "source"}
              onClick={() => setPreviewMode("source")}
            >
              Source
            </button>
            <button
              type="button"
              aria-pressed={previewMode === "final"}
              onClick={() => setPreviewMode("final")}
            >
              Final
            </button>
          </div>
        ) : null}
      </div>

      <div className="monitor-stage">
        {(mediaUrl !== null || (compositionActive && sourceLayers.length > 0)) && !mediaError ? (
          <>
            {compositionActive ? (
              sourceLayers.map((layer) => {
                const isClockLayer = layer.clipId === primaryLayer?.clipId;
                const isActiveLayer =
                  !layer.hidden && layerIsActiveAtTimelineFrame(layer, playhead);
                const denseVisibleTrackIndex = visibleVideoTrackIndices.indexOf(
                  layer.canonicalTrackIndex,
                );
                const zIndex =
                  denseVisibleTrackIndex < 0
                    ? 0
                    : visibleVideoTrackIndices.length - denseVisibleTrackIndex;
                return (
                  <video
                    key={layer.clipId}
                    ref={(element) => {
                      if (element === null) {
                        layerVideoRefs.current.delete(layer.clipId);
                      } else {
                        layerVideoRefs.current.set(layer.clipId, element);
                      }
                      if (isClockLayer) videoRef.current = element;
                    }}
                    src={convertCachePath(layer.path)}
                    preload="metadata"
                    playsInline
                    aria-label={`Canonical video layer ${layer.canonicalTrackIndex + 1}`}
                    data-clip-id={layer.clipId}
                    data-track-index={layer.canonicalTrackIndex}
                    data-hidden={layer.hidden ? "true" : "false"}
                    data-active={isActiveLayer ? "true" : "false"}
                    style={{
                      visibility: isActiveLayer ? "visible" : "hidden",
                      zIndex,
                    }}
                    onLoadStart={isClockLayer ? handlePlaybackRecovered : undefined}
                    onLoadedMetadata={isClockLayer ? handleLoadedMetadata : undefined}
                    onPlay={isClockLayer ? handlePlay : undefined}
                    onPlaying={isClockLayer ? handlePlaybackRecovered : undefined}
                    onPause={isClockLayer ? handlePlaybackStopped : undefined}
                    onEnded={isClockLayer ? handlePlaybackStopped : undefined}
                    onWaiting={isClockLayer ? handleMediaBuffering : undefined}
                    onStalled={isClockLayer ? handleMediaBuffering : undefined}
                    onCanPlay={isClockLayer ? handlePlaybackRecovered : undefined}
                    onCanPlayThrough={isClockLayer ? handlePlaybackRecovered : undefined}
                    onSeeked={isClockLayer ? handlePlaybackRecovered : undefined}
                    onTimeUpdate={isClockLayer ? updatePlayheadFromTimeUpdate : undefined}
                    onVolumeChange={
                      isClockLayer && !layer.muted
                        ? (event) => syncUserAudioStateFromMedia(event.currentTarget)
                        : undefined
                    }
                    onError={isClockLayer ? handleMediaError : undefined}
                  />
                );
              })
            ) : (
              <video
                ref={videoRef}
                src={mediaUrl ?? undefined}
                preload="metadata"
                playsInline
                aria-label={
                  previewMode === "final" ? "Verified final video preview" : "Prepared source proxy"
                }
                onLoadStart={handlePlaybackRecovered}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={handlePlay}
                onPlaying={handlePlaybackRecovered}
                onPause={handlePlaybackStopped}
                onEnded={handlePlaybackStopped}
                onWaiting={handleMediaBuffering}
                onStalled={handleMediaBuffering}
                onCanPlay={handlePlaybackRecovered}
                onCanPlayThrough={handlePlaybackRecovered}
                onSeeked={handlePlaybackRecovered}
                onTimeUpdate={updatePlayheadFromTimeUpdate}
                onVolumeChange={(event) => syncUserAudioStateFromMedia(event.currentTarget)}
                onError={handleMediaError}
              />
            )}
            {buffering ? (
              <div className="monitor-buffering-status" role="status">
                <span className="spinner monitor-buffering-spinner" aria-hidden />
                <span>Buffering preview. Please wait.</span>
              </div>
            ) : null}
            {(
              compositionActive
                ? sourceLayers.every((layer) => layer.hidden)
                : previewMode === "source" && timelineVideoHidden
            ) ? (
              <div className="monitor-hidden-video" role="status">
                <VideoOff size={28} aria-hidden />
                <strong>Video track hidden</strong>
              </div>
            ) : null}
            {previewMode === "source" &&
            (!compositionActive || primaryLayer !== null) &&
            activeCaptions.length > 0 ? (
              <div
                className="monitor-caption-overlay"
                aria-label="Active captions"
                aria-live="polite"
              >
                {activeCaptions.map((caption) => (
                  <p key={caption.captionId} data-caption-id={caption.captionId}>
                    {caption.text}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="monitor-fallback" role={mediaError ? "alert" : "status"}>
            <VideoOff size={28} aria-hidden />
            <strong>{mediaError ? "Preview could not be loaded" : "Preview not prepared"}</strong>
            <p>Exact trim controls remain available even when media playback is unavailable.</p>
            {mediaError ? (
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => setMediaError(false)}
              >
                <RotateCcw size={16} aria-hidden />
                Try media again
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div className="transport" aria-label="Playback controls">
        <div className="transport-playback">
          <button
            type="button"
            aria-label="Step backward five frames"
            disabled={!jumpBackwardCommand.canExecute}
            aria-keyshortcuts={jumpBackwardCommand.ariaKeyShortcuts}
            onClick={jumpBackwardCommand.execute}
          >
            <SkipBack size={17} aria-hidden />
            <span>5</span>
            {jumpBackwardCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {jumpBackwardCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
          <button
            type="button"
            aria-label="Step backward one frame"
            disabled={!stepBackwardCommand.canExecute}
            aria-keyshortcuts={stepBackwardCommand.ariaKeyShortcuts}
            onClick={stepBackwardCommand.execute}
          >
            <span aria-hidden>−1</span>
            {stepBackwardCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {stepBackwardCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
          <button
            type="button"
            className="transport-play"
            aria-keyshortcuts={toggleCommand.ariaKeyShortcuts}
            onClick={toggleCommand.execute}
            disabled={!toggleCommand.canExecute}
          >
            {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
            {playing ? "Pause" : "Play"}
            {toggleCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {toggleCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
          <button
            type="button"
            aria-label="Step forward one frame"
            disabled={!stepForwardCommand.canExecute}
            aria-keyshortcuts={stepForwardCommand.ariaKeyShortcuts}
            onClick={stepForwardCommand.execute}
          >
            <span aria-hidden>+1</span>
            {stepForwardCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {stepForwardCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
          <button
            type="button"
            aria-label="Step forward five frames"
            disabled={!jumpForwardCommand.canExecute}
            aria-keyshortcuts={jumpForwardCommand.ariaKeyShortcuts}
            onClick={jumpForwardCommand.execute}
          >
            <SkipForward size={17} aria-hidden />
            <span>5</span>
            {jumpForwardCommand.shortcutLabel !== null ? (
              <kbd className="command-shortcut-hint" aria-hidden="true">
                {jumpForwardCommand.shortcutLabel}
              </kbd>
            ) : null}
          </button>
        </div>
        {hasAudio ? (
          <div className="transport-audio">
            <button
              className="transport-mute"
              type="button"
              aria-label={
                timelineAudioMuted
                  ? "Audio muted by timeline track"
                  : muted || volume === 0
                    ? "Unmute audio"
                    : "Mute audio"
              }
              aria-pressed={timelineAudioMuted || muted || volume === 0}
              disabled={mediaUrl === null || mediaError || timelineAudioMuted}
              onClick={toggleMute}
            >
              {timelineAudioMuted || muted || volume === 0 ? (
                <VolumeX size={18} aria-hidden />
              ) : (
                <Volume2 size={18} aria-hidden />
              )}
            </button>
            <input
              className="transport-volume"
              type="range"
              aria-label="Volume"
              aria-valuetext={`${Math.round(volume * 100)}%`}
              min="0"
              max="1"
              step="0.05"
              value={volume}
              disabled={mediaUrl === null || mediaError || timelineAudioMuted}
              onChange={(event) => changeVolume(Number(event.currentTarget.value))}
            />
            <output className="volume-readout" aria-hidden>
              {Math.round(volume * 100)}%
            </output>
            {timelineAudioMuted ? (
              <span className="sr-only" role="status">
                Audio muted by timeline track
              </span>
            ) : null}
          </div>
        ) : null}
        <output className="frame-readout" aria-live="off">
          Frame {playhead}
        </output>
      </div>
    </section>
  );
}
