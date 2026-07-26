import { VideoDomainError } from "@supa-video/contracts";
import { Film } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./App.css";
import { useDraftDiscardGuard } from "./use-draft-discard-guard";
import { useVideoProject } from "./use-video-project";
import { getVideoToolStatus } from "./video-ipc";
import { type ReadinessState, VideoProjectOpener } from "./video/VideoProjectOpener";
import { VideoWorkspace } from "./video/VideoWorkspace";

function App() {
  const [readiness, setReadiness] = useState<ReadinessState>({ phase: "loading" });
  const readinessRequest = useRef(0);

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
          <span className="phase-label">Phase 2 · Canonical history</span>
        </div>
      </header>

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
          project={controller.project}
          readiness={readiness}
          onCheckTools={checkReadiness}
          onNewProject={requestNewProject}
          onOpenProject={requestOpenProject}
        />
      )}
      {discardDialog}
    </div>
  );
}

export default App;
