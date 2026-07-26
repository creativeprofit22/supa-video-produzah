import type { RationalRate } from "@supa-video/contracts";
import { Pause, Play, RotateCcw, SkipBack, SkipForward, VideoOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ProgramMonitorProps {
  readonly proxyPath: string | null;
  readonly finalPreviewPath: string | null;
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
  convertCachePath,
  rate,
  trimIn,
  trimOut,
  playhead,
  onPlayheadChange,
}: ProgramMonitorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewMode, setPreviewMode] = useState<"source" | "final">("source");
  const [playing, setPlaying] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const selectedPath =
    previewMode === "final" && finalPreviewPath !== null ? finalPreviewPath : proxyPath;
  const mediaUrl = useMemo(
    () => (selectedPath === null ? null : convertCachePath(selectedPath)),
    [convertCachePath, selectedPath],
  );
  const activeIn = previewMode === "source" ? trimIn : 0;
  const activeOut = previewMode === "source" ? trimOut : Number.MAX_SAFE_INTEGER;

  useEffect(() => {
    setMediaError(false);
    setPlaying(false);
  }, [mediaUrl]);

  useEffect(() => {
    if (finalPreviewPath === null) {
      setPreviewMode("source");
    }
  }, [finalPreviewPath]);

  const seekTo = useCallback(
    (frame: number) => {
      const boundedFrame = Math.max(activeIn, Math.min(frame, activeOut - 1));
      if (videoRef.current !== null) {
        videoRef.current.currentTime = secondsForFrame(boundedFrame, rate);
      }
      onPlayheadChange(boundedFrame);
    },
    [activeIn, activeOut, onPlayheadChange, rate],
  );

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current;
    if (video === null || mediaError) {
      return;
    }
    if (!video.paused) {
      video.pause();
      return;
    }
    const frame = frameForSeconds(video.currentTime, rate);
    if (frame < activeIn || frame >= activeOut) {
      seekTo(activeIn);
    }
    await video.play().catch(() => setMediaError(true));
  }, [activeIn, activeOut, mediaError, rate, seekTo]);

  const updatePlayhead = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const frame = frameForSeconds(video.currentTime, rate);
    if (frame >= activeOut) {
      video.pause();
      seekTo(Math.max(activeIn, activeOut - 1));
      return;
    }
    onPlayheadChange(Math.max(activeIn, frame));
  }, [activeIn, activeOut, onPlayheadChange, rate, seekTo]);

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
          <video
            ref={videoRef}
            src={mediaUrl}
            preload="metadata"
            playsInline
            aria-label={
              previewMode === "final" ? "Verified final video preview" : "Prepared source proxy"
            }
            onLoadedMetadata={() => seekTo(activeIn)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={updatePlayhead}
            onError={() => setMediaError(true)}
          />
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
        <output className="frame-readout" aria-live="off">
          Frame {playhead}
        </output>
      </div>
    </section>
  );
}
