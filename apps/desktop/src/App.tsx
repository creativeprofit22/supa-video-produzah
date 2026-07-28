import { VideoDomainError } from "@supa-video/contracts";
import { Film, ListTodo } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./App.css";
import { useDraftDiscardGuard } from "./use-draft-discard-guard";
import { useMediaJobs } from "./use-media-jobs";
import { useVideoProject } from "./use-video-project";
import { getVideoToolStatus } from "./video-ipc";
import { JobCenter } from "./video/JobCenter";
import { type ReadinessState, VideoProjectOpener } from "./video/VideoProjectOpener";
import { VideoWorkspace } from "./video/VideoWorkspace";

function App() {
  const [readiness, setReadiness] = useState<ReadinessState>({ phase: "loading" });
  const [jobCenterOpen, setJobCenterOpen] = useState(false);
  const [jobCenterTarget, setJobCenterTarget] = useState<string | null>(null);
  const readinessRequest = useRef(0);
  const jobsToggleRef = useRef<HTMLButtonElement>(null);

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
  const unsettledJobCount = mediaJobs.jobs.filter(
    (job) => job.parentId === null && !["cancelled", "failed", "complete"].includes(job.state),
  ).length;
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
  const projectError =
    controller.projectOperation.phase === "error" ? controller.projectOperation.error : null;
  const { requestNewProject, requestOpenProject, discardDialog } = useDraftDiscardGuard({
    trimChanged: controller.trimChanged,
    onNewProject: controller.newProject,
    onOpenProject: controller.openProject,
  });
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
          onNewProject={requestNewProject}
          onOpenProject={requestOpenProject}
        />
      ) : (
        <VideoWorkspace
          controller={controller}
          mediaJobs={mediaJobs.jobs}
          project={controller.project}
          readiness={readiness}
          onCheckTools={checkReadiness}
          onOpenJobCenter={openJobCenter}
          onNewProject={requestNewProject}
          onOpenProject={requestOpenProject}
        />
      )}
      {discardDialog}
    </div>
  );
}

export default App;
