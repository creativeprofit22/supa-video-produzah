interface ClipTrimRangesProps {
  readonly durationFrames: number;
  readonly trimIn: number;
  readonly trimOut: number;
  readonly disabled: boolean;
  readonly onTrimInChange: (frame: number) => void;
  readonly onTrimOutChange: (frame: number) => void;
}

export function ClipTrimRanges({
  durationFrames,
  trimIn,
  trimOut,
  disabled,
  onTrimInChange,
  onTrimOutChange,
}: ClipTrimRangesProps) {
  const safeDuration = Math.max(1, durationFrames);
  return (
    <section className="panel clip-trim-panel" aria-labelledby="clip-trim-ranges-title">
      <div className="panel-heading">
        <div>
          <p className="state-kicker">Quick trim</p>
          <h2 id="clip-trim-ranges-title">Kept source range</h2>
        </div>
        <p className="timeline-range" aria-label={`Kept range frames ${trimIn} through ${trimOut}`}>
          {trimIn}–{trimOut} <span>frames</span>
        </p>
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
