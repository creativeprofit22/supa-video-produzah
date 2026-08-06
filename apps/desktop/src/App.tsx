import { VideoDomainError } from "@supa-video/contracts";
import { Film, Keyboard, ListTodo } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./App.css";
import { CommandProvider, useCommand, useCommandHandler } from "./commands/CommandProvider";
import { ShortcutSettings } from "./commands/ShortcutSettings";
import { useDraftDiscardGuard } from "./use-draft-discard-guard";
import { useMediaJobs } from "./use-media-jobs";
import { useVideoProject } from "./use-video-project";
import { getVideoToolStatus } from "./video-ipc";
import { JobCenter } from "./video/JobCenter";
import { type ReadinessState, VideoProjectOpener } from "./video/VideoProjectOpener";
import { VideoWorkspace } from "./video/VideoWorkspace";

export function AppContent() {
  const [readiness, setReadiness] = useState<ReadinessState>({ phase: "loading" });
  const [jobCenterOpen, setJobCenterOpen] = useState(false);
  const [jobCenterTarget, setJobCenterTarget] = useState<string | null>(null);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const readinessRequest = useRef(0);
  const jobsToggleRef = useRef<HTMLButtonElement>(null);
  const shortcutSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const shortcutSettingsReturnFocusRef = useRef<HTMLElement | null>(null);

  const checkReadiness = useCallback(async () => {
    const request = ++readinessRequest.current;
    setReadiness({ phase: "loading" });
    try {
      const value = await getVideoToolStatus();
      if (request === readinessRequest.current) setReadiness({ phase: "loaded", value });
    } catch {
      if (request === readinessRequest.current) setReadiness({ phase: "error" });
    }
  }, []);

  const controller = useVideoProject();
  const mediaJobs = useMediaJobs();
  const unsettledJobCount = mediaJobs.unsettledParentCount;
  const toolUnavailableFailure = [
    controller.projectOperation.phase === "error" ? controller.projectOperation.error : null,
    controller.preparation.phase === "error" ? controller.preparation.error : null,
    controller.render.phase === "failed" ? controller.render.error : null,
  ].find((error) => error instanceof VideoDomainError && error.code === "tool_unavailable");

  useEffect(() => {
    void checkReadiness();
    return () => {
      readinessRequest.current += 1;
    };
  }, [checkReadiness]);

  useEffect(() => {
    if (toolUnavailableFailure !== undefined) void checkReadiness();
  }, [checkReadiness, toolUnavailableFailure]);

  const projectPending = controller.projectOperation.phase === "pending";
  const editPending = controller.editOperation.phase === "saving";
  const projectError =
    controller.projectOperation.phase === "error" ? controller.projectOperation.error : null;
  const { requestNewProject, requestOpenProject, discardDialog } = useDraftDiscardGuard({
    trimChanged: controller.trimChanged,
    onNewProject: controller.newProject,
    onOpenProject: controller.openProject,
  });
  useCommandHandler("project.new", {
    canExecute: !projectPending && !editPending,
    execute: requestNewProject,
  });
  useCommandHandler("project.open", {
    canExecute: !projectPending && !editPending,
    execute: requestOpenProject,
  });
  useCommandHandler("app.openShortcutSettings", {
    canExecute: !shortcutSettingsOpen,
    execute: (source) => {
      shortcutSettingsReturnFocusRef.current =
        source === "button"
          ? shortcutSettingsButtonRef.current
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      setShortcutSettingsOpen(true);
    },
  });
  const shortcutSettingsCommand = useCommand("app.openShortcutSettings");
  const closeJobCenter = useCallback(() => {
    setJobCenterOpen(false);
    setJobCenterTarget(null);
    queueMicrotask(() => jobsToggleRef.current?.focus());
  }, []);
  const openJobCenter = useCallback((jobId: string) => {
    setJobCenterTarget(jobId);
    setJobCenterOpen(true);
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner shared-rail">
          <a className="brand" href="#workspace" aria-label="Supa Video Producer home">
            <span className="brand-mark" aria-hidden>
              <Film size={18} strokeWidth={2} />
            </span>
            <span>Supa Video Producer</span>
          </a>
          <div className="app-header-actions">
            <span className="phase-label">Phase 3B · Durable media jobs</span>
            <button
              ref={shortcutSettingsButtonRef}
              className="jobs-toggle shortcut-settings-toggle"
              type="button"
              disabled={!shortcutSettingsCommand.canExecute}
              aria-keyshortcuts={shortcutSettingsCommand.ariaKeyShortcuts}
              onClick={shortcutSettingsCommand.execute}
            >
              <Keyboard size={17} aria-hidden />
              <span>Shortcuts</span>
            </button>
            <button
              ref={jobsToggleRef}
              className="jobs-toggle"
              type="button"
              aria-expanded={jobCenterOpen}
              aria-controls="job-center"
              onClick={() => {
                setJobCenterTarget(null);
                setJobCenterOpen((open) => !open);
              }}
            >
              <ListTodo size={17} aria-hidden />
              <span>Jobs</span>
              {unsettledJobCount > 0 ? (
                <>
                  <span className="jobs-count" aria-hidden>
                    {unsettledJobCount}
                  </span>
                  <span className="sr-only">{unsettledJobCount} unsettled jobs</span>
                </>
              ) : null}
            </button>
          </div>
        </div>
      </header>

      {jobCenterOpen ? (
        <JobCenter controller={mediaJobs} focusJobId={jobCenterTarget} onClose={closeJobCenter} />
      ) : null}

      {controller.project === null ? (
        <VideoProjectOpener
          readiness={readiness}
          projectPending={projectPending}
          projectError={projectError}
          onCheckTools={() => void checkReadiness()}
        />
      ) : (
        <VideoWorkspace
          controller={controller}
          mediaJobs={mediaJobs.jobs}
          project={controller.project}
          readiness={readiness}
          onCheckTools={checkReadiness}
          onOpenJobCenter={openJobCenter}
        />
      )}
      {discardDialog}
      <ShortcutSettings
        open={shortcutSettingsOpen}
        onClose={() => setShortcutSettingsOpen(false)}
        returnFocusRef={shortcutSettingsReturnFocusRef}
      />
    </div>
  );
}

export function AppRoot() {
  return (
    <CommandProvider>
      <AppContent />
    </CommandProvider>
  );
}

export default AppRoot;
