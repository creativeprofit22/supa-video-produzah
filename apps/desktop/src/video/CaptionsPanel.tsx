import type { ProjectProjection } from "@supa-video/contracts";
import type {
  CaptionArtifactV1,
  CaptionStyleV1,
  CaptionValidationIssueV1,
} from "@supa-video/media";
import {
  exportSubtitles,
  findActiveCaptionArtifact,
  restyleCaptionArtifactV1,
  retimeCaptionCueV1,
  type ActiveCaptionArtifact,
  type CaptionCueEdge,
  type CaptionEditResult,
} from "@supa-video/project";
import { Captions } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { pickSubtitlePath, writeSubtitles, type SubtitleFileFormat } from "../asr-ipc";

export interface SubtitleWriter {
  readonly pick: (format: SubtitleFileFormat, defaultName: string) => Promise<string | null>;
  readonly write: (format: SubtitleFileFormat, path: string, contents: string) => Promise<void>;
}

const tauriSubtitleWriter: SubtitleWriter = { pick: pickSubtitlePath, write: writeSubtitles };

interface CaptionsPanelProps {
  readonly projection: ProjectProjection | null;
  readonly sequenceId: string | null;
  readonly disabled: boolean;
  readonly onApply: (
    active: ActiveCaptionArtifact,
    artifact: CaptionArtifactV1,
  ) => Promise<boolean>;
  readonly frame?: { readonly width: number; readonly height: number };
  readonly subtitleWriter?: SubtitleWriter;
}

const issueMessages: Partial<Record<CaptionValidationIssueV1["code"], string>> = {
  CAPTION_CUE_OVERLAP: "That change would make two captions overlap.",
  CAPTION_CUE_TOO_SHORT: "That caption would be too short to read.",
  CAPTION_CUE_TOO_LONG: "That caption would stay on screen too long.",
  CAPTION_CUE_DURATION_NON_POSITIVE: "A caption must end after it starts.",
  CAPTION_CPS_EXCEEDED: "That caption would need reading too fast.",
  CAPTION_LINE_LENGTH_EXCEEDED: "A caption line would be too long.",
  CAPTION_LINE_COUNT_EXCEEDED: "A caption would have too many lines.",
  CAPTION_SAFE_AREA_EXCEEDED: "The caption would leave the safe area.",
  CAPTION_STYLE_INVALID: "That style is not supported.",
};

export function captionIssueMessage(issues: readonly CaptionValidationIssueV1[]): string {
  const first = issues[0];
  return (first && issueMessages[first.code]) ?? "That caption change is not valid.";
}

const fontFamilies = ["Arial", "Segoe UI", "Verdana", "Georgia", "Consolas"] as const;
const horizontal = ["left", "center", "right"] as const;
const vertical = ["top", "center", "bottom"] as const;

function formatTime(value: number, rate: CaptionArtifactV1["timelineRate"]): string {
  const seconds = (value * rate.denominator) / rate.numerator;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

export function CaptionsPanel({
  projection,
  sequenceId,
  disabled,
  onApply,
  frame = { width: 1920, height: 1080 },
  subtitleWriter = tauriSubtitleWriter,
}: CaptionsPanelProps) {
  const headingId = useId();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useMemo(
    () =>
      projection === null || sequenceId === null
        ? null
        : findActiveCaptionArtifact(projection, sequenceId),
    [projection, sequenceId],
  );

  const submit = async (build: () => CaptionEditResult) => {
    if (active === null || projection === null) return;
    const result = build();
    if (!result.ok) {
      setMessage(captionIssueMessage(result.issues));
      return;
    }
    setMessage(null);
    setPending(true);
    try {
      if (!(await onApply(active, result.artifact)))
        setMessage("The caption change could not be saved. Try again.");
    } finally {
      setPending(false);
    }
  };

  const restyle = (style: CaptionStyleV1) =>
    submit(() => {
      if (active === null || projection === null) throw new Error("No captions");
      return restyleCaptionArtifactV1(active.artifact, style, projection);
    });
  const nudge = (cueId: string, edge: CaptionCueEdge, delta: number) =>
    submit(() => {
      if (active === null || projection === null) throw new Error("No captions");
      return retimeCaptionCueV1(active.artifact, cueId, edge, delta, projection);
    });

  const exportFile = async (format: SubtitleFileFormat) => {
    if (active === null) return;
    setPending(true);
    setMessage(null);
    try {
      const path = await subtitleWriter.pick(format, `captions.${format}`);
      if (path === null) return;
      await subtitleWriter.write(format, path, exportSubtitles(active.artifact, format, frame));
      setMessage(`Saved ${format.toUpperCase()} subtitles.`);
    } catch {
      setMessage("The subtitle file could not be saved. Try again.");
    } finally {
      setPending(false);
    }
  };

  const busy = disabled || pending;
  const artifact = active?.artifact;
  const typography = artifact?.style.typography;

  return (
    <section className="export-panel captions-panel" aria-labelledby={headingId}>
      <div className="export-panel-header">
        <div>
          <p className="eyebrow">Captions</p>
          <h3 id={headingId}>Caption style</h3>
        </div>
      </div>
      {artifact === undefined || typography === undefined ? (
        <p className="muted-copy">Generate captions from a transcript to style and time them.</p>
      ) : (
        <>
          <div className="captions-style-grid">
            <label>
              Font
              <select
                value={typography.fontFamily}
                disabled={busy}
                onChange={(event) =>
                  void restyle({
                    ...artifact.style,
                    typography: { ...typography, fontFamily: event.target.value },
                  })
                }
              >
                {fontFamilies.map((family) => (
                  <option key={family}>{family}</option>
                ))}
              </select>
            </label>
            <label>
              Size (px)
              <input
                type="number"
                min={12}
                max={200}
                step={2}
                value={typography.fontSizePx}
                disabled={busy}
                onChange={(event) => {
                  const fontSizePx = Number(event.target.value);
                  if (Number.isInteger(fontSizePx) && fontSizePx >= 12 && fontSizePx <= 200)
                    void restyle({ ...artifact.style, typography: { ...typography, fontSizePx } });
                }}
              />
            </label>
            <label>
              Colour
              <input
                type="color"
                value={typography.foregroundColorRgba.slice(0, 7)}
                disabled={busy}
                onChange={(event) =>
                  void restyle({
                    ...artifact.style,
                    typography: {
                      ...typography,
                      foregroundColorRgba: `${event.target.value}${typography.foregroundColorRgba.slice(7)}`,
                    },
                  })
                }
              />
            </label>
            <label className="captions-checkbox">
              <input
                type="checkbox"
                checked={typography.fontWeight >= 600}
                disabled={busy}
                onChange={(event) =>
                  void restyle({
                    ...artifact.style,
                    typography: { ...typography, fontWeight: event.target.checked ? 700 : 400 },
                  })
                }
              />
              Bold
            </label>
            <label>
              Horizontal
              <select
                value={artifact.style.alignment.horizontal}
                disabled={busy}
                onChange={(event) => {
                  const value = horizontal.find((option) => option === event.target.value);
                  if (value)
                    void restyle({
                      ...artifact.style,
                      alignment: { ...artifact.style.alignment, horizontal: value },
                    });
                }}
              >
                {horizontal.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              Vertical
              <select
                value={artifact.style.alignment.vertical}
                disabled={busy}
                onChange={(event) => {
                  const value = vertical.find((option) => option === event.target.value);
                  if (value)
                    void restyle({
                      ...artifact.style,
                      alignment: { ...artifact.style.alignment, vertical: value },
                    });
                }}
              >
                {vertical.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
          <h4 className="captions-subheading">Timing</h4>
          <ol className="captions-cues" aria-label="Caption cues">
            {artifact.cues.map((cue) => {
              const text = cue.lines.join(" ");
              return (
                <li key={cue.cueId} className="captions-cue">
                  <p className="captions-cue-text">{text}</p>
                  <p className="muted-copy">
                    {formatTime(cue.start.value, artifact.timelineRate)} –{" "}
                    {formatTime(cue.end.value, artifact.timelineRate)}
                  </p>
                  <div
                    className="transcript-actions"
                    role="group"
                    aria-label={`Timing for “${text}”`}
                  >
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={busy}
                      aria-label={`Start one frame earlier: ${text}`}
                      onClick={() => void nudge(cue.cueId, "start", -1)}
                    >
                      Start −1f
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={busy}
                      aria-label={`Start one frame later: ${text}`}
                      onClick={() => void nudge(cue.cueId, "start", 1)}
                    >
                      Start +1f
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={busy}
                      aria-label={`End one frame earlier: ${text}`}
                      onClick={() => void nudge(cue.cueId, "end", -1)}
                    >
                      End −1f
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={busy}
                      aria-label={`End one frame later: ${text}`}
                      onClick={() => void nudge(cue.cueId, "end", 1)}
                    >
                      End +1f
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <h4 className="captions-subheading">Subtitle files</h4>
          <div className="transcript-actions">
            {(["srt", "vtt", "ass"] as const).map((format) => (
              <button
                key={format}
                className="secondary-button compact-button"
                type="button"
                disabled={busy}
                onClick={() => void exportFile(format)}
              >
                Export {format.toUpperCase()}
              </button>
            ))}
          </div>
        </>
      )}
      {message === null ? null : (
        <p
          className={message.startsWith("Saved") ? "muted-copy" : "inline-error"}
          role={message.startsWith("Saved") ? "status" : "alert"}
        >
          <Captions aria-hidden="true" size={14} /> {message}
        </p>
      )}
    </section>
  );
}
