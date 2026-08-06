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

interface ProgramMonitorProps {
  readonly proxyPath: string | null;
  readonly finalPreviewPath: string | null;
  readonly hasAudio: boolean;
  readonly timelineAudioMuted: boolean;
  readonly timelineVideoHidden: boolean;
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

function shortcutOwnsFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "VIDEO", "A"].includes(target.tagName)
  );
}

export function ProgramMonitor({
  proxyPath,
  finalPreviewPath,
  hasAudio,
  timelineAudioMuted: canonicalTimelineAudioMuted,
  timelineVideoHidden,
  convertCachePath,
  rate,
  trimIn,
  trimOut,
  playhead,
  onPlayheadChange,
}: ProgramMonitorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingVideoFrameRequestRef = useRef<PendingVideoFrameRequest | null>(null);
  const frameObservationGenerationRef = useRef(0);
  const audioSettingsRef = useRef({ volume: 1, muted: false });
  const lastNonZeroVolumeRef = useRef(1);
  const updatePlayheadAtSecondsRef = useRef<(video: HTMLVideoElement, seconds: number) => boolean>(
    () => false,
  );
  const [previewMode, setPreviewMode] = useState<"source" | "final">("source");
  const timelineAudioMuted = previewMode === "source" && canonicalTimelineAudioMuted;
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const selectedPath =
    previewMode === "final" && finalPreviewPath !== null ? finalPreviewPath : proxyPath;
  const mediaUrl = useMemo(
    () => (selectedPath === null ? null : convertCachePath(selectedPath)),
    [convertCachePath, selectedPath],
  );
  const activeIn = previewMode === "source" ? trimIn : 0;
  const activeOut = previewMode === "source" ? trimOut : Number.MAX_SAFE_INTEGER;
  const frameObservationContext = useMemo(
    () => ({ mediaUrl, previewMode }),
    [mediaUrl, previewMode],
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
      setBuffering(false);
      if (videoRef.current !== null) {
        videoRef.current.currentTime = secondsForFrame(boundedFrame, rate);
      }
      onPlayheadChange(boundedFrame);
    },
    [activeIn, activeOut, onPlayheadChange, rate],
  );

  const updatePlayheadAtSeconds = useCallback(
    (video: HTMLVideoElement, seconds: number): boolean => {
      if (video !== videoRef.current) {
        return false;
      }
      const frame = frameForSeconds(seconds, rate);
      if (frame >= activeOut) {
        video.pause();
        seekTo(Math.max(activeIn, activeOut - 1));
        return false;
      }
      onPlayheadChange(Math.max(activeIn, frame));
      return true;
    },
    [activeIn, activeOut, onPlayheadChange, rate, seekTo],
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
    const frame = frameForSeconds(video.currentTime, rate);
    if (frame < activeIn || frame >= activeOut) {
      seekTo(activeIn);
    }
    await video.play().catch(() => {
      cancelFrameObservation();
      setBuffering(false);
      setPlaying(false);
      setMediaError(true);
    });
  }, [activeIn, activeOut, cancelFrameObservation, mediaError, rate, seekTo]);

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
    if (video !== null) {
      applyEffectiveAudioState(video);
    }
  }, [applyEffectiveAudioState, mediaUrl, muted, volume]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    applyEffectiveAudioState(video);
    seekTo(activeIn);
  }, [activeIn, applyEffectiveAudioState, seekTo]);

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

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (shortcutOwnsFocus(event.target) || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        seekTo(playhead + direction * (event.shiftKey ? 10 : 1));
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [playhead, seekTo, togglePlayback]);

  return (
    <section className="panel monitor-panel" aria-labelledby="monitor-title">
      <div className="panel-heading monitor-heading">
        <div>
          <p className="state-kicker">Program monitor</p>
          <h2 id="monitor-title">{previewMode === "final" ? "Final preview" : "Prepared proxy"}</h2>
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
        {mediaUrl !== null && !mediaError ? (
          <>
            <video
              ref={videoRef}
              src={mediaUrl}
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
            {buffering ? (
              <div className="monitor-buffering-status" role="status">
                <span className="spinner monitor-buffering-spinner" aria-hidden />
                <span>Buffering preview. Please wait.</span>
              </div>
            ) : null}
            {timelineVideoHidden ? (
              <div className="monitor-hidden-video" role="status">
                <VideoOff size={28} aria-hidden />
                <strong>Video track hidden</strong>
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
            aria-label="Seek back ten frames"
            onClick={() => seekTo(playhead - 10)}
          >
            <SkipBack size={17} aria-hidden />
            <span>10</span>
          </button>
          <button
            type="button"
            className="transport-play"
            onClick={() => void togglePlayback()}
            disabled={mediaUrl === null || mediaError}
          >
            {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            aria-label="Seek forward ten frames"
            onClick={() => seekTo(playhead + 10)}
          >
            <SkipForward size={17} aria-hidden />
            <span>10</span>
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
