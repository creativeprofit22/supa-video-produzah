import { useLayoutEffect, useRef, type ReactElement } from "react";

export interface MonitorCaption {
  readonly captionId: string;
  readonly text: string;
}

/** Smallest text scale the fit may use, so captions never become unreadably tiny. */
const MIN_CAPTION_FIT = 0.2;
const MAX_FIT_PASSES = 8;

/**
 * Shrinks the caption text until the whole block fits the overlay's safe area.
 * Text re-wraps as it shrinks, so this measures again after each step. The
 * burned-in export applies the same rule (`fitCaptionStyleToSafeArea`).
 */
function fitCaptionsToSafeArea(overlay: HTMLElement, lines: HTMLElement): void {
  let fit = 1;
  overlay.style.setProperty("--caption-fit", "1");
  for (let pass = 0; pass < MAX_FIT_PASSES; pass += 1) {
    const available = overlay.clientHeight;
    const needed = lines.offsetHeight;
    if (available <= 0 || needed <= available || fit <= MIN_CAPTION_FIT) return;
    fit = Math.max(MIN_CAPTION_FIT, fit * Math.min(0.95, available / needed));
    overlay.style.setProperty("--caption-fit", String(fit));
  }
}

export function MonitorCaptionOverlay({
  captions,
}: {
  readonly captions: readonly MonitorCaption[];
}): ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const textKey = captions.map((caption) => caption.text).join("\n");

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const lines = linesRef.current;
    if (overlay === null || lines === null) return undefined;
    fitCaptionsToSafeArea(overlay, lines);
    if (typeof ResizeObserver === "undefined") return undefined;
    // Refit when the preview resizes or the text size changes (UI zoom, text scaling).
    const observer = new ResizeObserver(() => fitCaptionsToSafeArea(overlay, lines));
    observer.observe(overlay);
    observer.observe(lines);
    return () => observer.disconnect();
  }, [textKey]);

  return (
    <div
      ref={overlayRef}
      className="monitor-caption-overlay"
      aria-label="Active captions"
      aria-live="polite"
    >
      <div ref={linesRef} className="monitor-caption-lines">
        {captions.map((caption) => (
          <p key={caption.captionId} data-caption-id={caption.captionId}>
            {caption.text}
          </p>
        ))}
      </div>
    </div>
  );
}
