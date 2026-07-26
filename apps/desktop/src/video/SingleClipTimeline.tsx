import { ImageOff } from "lucide-react";
import { useMemo, useRef, useState } from "react";

interface SingleClipTimelineProps {
  readonly thumbnailPath: string | null;
  readonly convertCachePath: (path: string) => string;
  readonly durationFrames: number;
  readonly trimIn: number;
  readonly trimOut: number;
  readonly playhead: number;
  readonly disabled: boolean;
  readonly onTrimInChange: (frame: number) => void;
  readonly onTrimOutChange: (frame: number) => void;
  readonly onSeek: (frame: number) => void;
}

export function SingleClipTimeline({
  thumbnailPath,
  convertCachePath,
  durationFrames,
  trimIn,
  trimOut,
  playhead,
  disabled,
  onTrimInChange,
  onTrimOutChange,
  onSeek,
}: SingleClipTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumbnailError, setThumbnailError] = useState(false);
  const thumbnailUrl = useMemo(
    () => (thumbnailPath === null ? null : convertCachePath(thumbnailPath)),
    [convertCachePath, thumbnailPath],
  );
  const safeDuration = Math.max(1, durationFrames);
  const inPercent = (Math.max(0, Math.min(trimIn, safeDuration)) / safeDuration) * 100;
  const outPercent = (Math.max(0, Math.min(trimOut, safeDuration)) / safeDuration) * 100;
  const playheadPercent = (Math.max(0, Math.min(playhead, safeDuration)) / safeDuration) * 100;

  const seekFromPointer = (clientX: number) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width <= 0) {
      return;
    }
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    onSeek(Math.round(ratio * safeDuration));
  };

  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Timeline</p>
          <h2 id="timeline-title">Video track</h2>
        </div>
        <p className="timeline-range" aria-label={`Kept range frames ${trimIn} through ${trimOut}`}>
          {trimIn}–{trimOut} <span>frames</span>
        </p>
      </div>

      <div className="timeline-ruler" aria-hidden>
        <span>0</span>
        <span>{Math.round(safeDuration / 2)}</span>
        <span>{safeDuration}</span>
      </div>
      <div
        ref={trackRef}
        className="timeline-track"
        onPointerDown={(event) => {
          if (!disabled) seekFromPointer(event.clientX);
        }}
      >
        {thumbnailUrl !== null && !thumbnailError ? (
          <img
            src={thumbnailUrl}
            alt=""
            onError={() => setThumbnailError(true)}
            draggable={false}
          />
        ) : (
          <div className="timeline-missing-media" aria-label="Timeline thumbnail unavailable">
            <ImageOff size={18} aria-hidden />
            <span>Thumbnail unavailable</span>
          </div>
        )}
        <div
          className="timeline-kept-range"
          style={{ insetInlineStart: `${inPercent}%`, insetInlineEnd: `${100 - outPercent}%` }}
          aria-hidden
        />
        <div
          className="timeline-playhead"
          style={{ insetInlineStart: `${playheadPercent}%` }}
          aria-hidden
        />
      </div>

      <div className="timeline-ranges">
        <label>
          <span>Trim in</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, trimOut - 1)}
            value={Math.min(trimIn, Math.max(0, trimOut - 1))}
            disabled={disabled}
            onChange={(event) => onTrimInChange(event.currentTarget.valueAsNumber)}
          />
        </label>
        <label>
          <span>Trim out</span>
          <input
            type="range"
            min={Math.min(safeDuration, trimIn + 1)}
            max={safeDuration}
            value={Math.max(Math.min(trimOut, safeDuration), Math.min(safeDuration, trimIn + 1))}
            disabled={disabled}
            onChange={(event) => onTrimOutChange(event.currentTarget.valueAsNumber)}
          />
        </label>
      </div>
    </section>
  );
}
