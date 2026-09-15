import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DEFAULT_WORKSPACE_SPLIT,
  loadWorkspaceSplit,
  saveWorkspaceSplit,
  workspaceStorage,
} from "./workspace-preferences";

const resizeKeys = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** Local layout only: never receives a project controller or dispatches project commands. */
export function TwoPaneWorkspace({
  children,
  label,
}: {
  children: [ReactNode, ReactNode];
  label: string;
}) {
  const [split, setSplit] = useState(() => loadWorkspaceSplit(workspaceStorage()));
  const [saveFailed, setSaveFailed] = useState(false);
  const [minimum, setMinimum] = useState(25);
  const effective = (value: number) => Math.max(minimum, Math.min(100 - minimum, value));
  useEffect(() => {
    if (!grid.current || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = grid.current!.getBoundingClientRect().width - 16;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (width > 0 && Number.isFinite(rem))
        setMinimum(Math.min(50, Math.max(25, ((18 * rem) / width) * 100)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(grid.current);
    observer.observe(document.documentElement);
    measure();
    return () => observer.disconnect();
  }, []);
  const grid = useRef<HTMLDivElement>(null);
  const separator = useRef<HTMLDivElement>(null);
  const draft = useRef(split);
  const saved = useRef(split);
  const frame = useRef<number | null>(null);
  const pointer = useRef<{
    id: number;
    start: number;
    effectiveStart: number;
    x: number;
    width: number;
    rtl: boolean;
  } | null>(null);
  const paneId = useId();
  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const update = (value: number) => {
    draft.current = Math.max(25, Math.min(75, value));
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setSplit(draft.current);
      });
  };
  const complete = () => {
    cancelFrame();
    setSplit(draft.current);
    if (saved.current === draft.current) return;
    saved.current = draft.current;
    setSaveFailed(!saveWorkspaceSplit(workspaceStorage(), draft.current));
  };
  const cancelPointer = () => {
    const active = pointer.current;
    if (!active) return;
    pointer.current = null;
    cancelFrame();
    draft.current = active.start;
    setSplit(active.start);
    if (separator.current?.hasPointerCapture(active.id))
      separator.current.releasePointerCapture(active.id);
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      const active = pointer.current;
      if (active && separator.current?.hasPointerCapture(active.id))
        separator.current.releasePointerCapture(active.id);
    },
    [],
  );

  return (
    <div className="workspace-layout">
      <div className="workspace-layout-actions">
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            cancelPointer();
            draft.current = DEFAULT_WORKSPACE_SPLIT;
            // Reset also repairs a corrupt preference even when the default is already active.
            saved.current = DEFAULT_WORKSPACE_SPLIT;
            cancelFrame();
            setSplit(DEFAULT_WORKSPACE_SPLIT);
            setSaveFailed(!saveWorkspaceSplit(workspaceStorage(), DEFAULT_WORKSPACE_SPLIT));
          }}
        >
          Reset layout
        </button>
        {saveFailed ? <span role="status">Layout is available for this session only.</span> : null}
      </div>
      <div
        ref={grid}
        className="workbench-grid"
        style={{ "--workspace-split": split } as CSSProperties}
      >
        <div id={paneId} className="workspace-pane">
          {children[0]}
        </div>
        <div
          ref={separator}
          className="workspace-separator"
          role="separator"
          tabIndex={0}
          aria-label={label}
          aria-controls={paneId}
          aria-orientation="vertical"
          aria-valuemin={Math.round(minimum * 10) / 10}
          aria-valuemax={Math.round((100 - minimum) * 10) / 10}
          aria-valuenow={Math.round(effective(split) * 10) / 10}
          onPointerDown={(event) => {
            if (event.button !== 0 || pointer.current) return;
            complete();
            const rect = grid.current!.getBoundingClientRect();
            if (rect.width <= 16) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer.current = {
              id: event.pointerId,
              start: draft.current,
              effectiveStart: effective(draft.current),
              x: event.clientX,
              width: rect.width - 16,
              rtl: getComputedStyle(event.currentTarget).direction === "rtl",
            };
          }}
          onPointerMove={(event) => {
            const active = pointer.current;
            if (active?.id !== event.pointerId) return;
            update(
              active.effectiveStart +
                ((event.clientX - active.x) / active.width) * 100 * (active.rtl ? -1 : 1),
            );
          }}
          onPointerUp={(event) => {
            if (pointer.current?.id !== event.pointerId) return;
            pointer.current = null;
            complete();
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancelPointer}
          onLostPointerCapture={cancelPointer}
          onKeyDown={(event) => {
            if (!resizeKeys.has(event.key) || pointer.current) return;
            event.preventDefault();
            const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
            update(
              event.key === "Home"
                ? 25
                : event.key === "End"
                  ? 75
                  : effective(draft.current) +
                    (event.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1),
            );
          }}
          onKeyUp={(event) => {
            if (resizeKeys.has(event.key)) complete();
          }}
          onBlur={() => {
            cancelPointer();
            complete();
          }}
        />
        <div className="workspace-pane">{children[1]}</div>
      </div>
    </div>
  );
}
