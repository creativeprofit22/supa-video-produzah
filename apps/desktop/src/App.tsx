import { Film } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./App.css";
import { useVideoProject } from "./use-video-project";
import { getVideoToolStatus } from "./video-ipc";
import { type ReadinessState, VideoProjectOpener } from "./video/VideoProjectOpener";
import { VideoWorkspace } from "./video/VideoWorkspace";

function App() {
  const [readiness, setReadiness] = useState<ReadinessState>({ phase: "loading" });
  const readinessRequest = useRef(0);
  const controller = useVideoProject();

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

  useEffect(() => {
    void checkReadiness();
    return () => {
      readinessRequest.current += 1;
    };
  }, [checkReadiness]);

  const toolsReady = readiness.phase === "loaded" && readiness.value.ready;
  const projectPending = controller.projectOperation.phase === "pending";
  const projectError =
    controller.projectOperation.phase === "error" ? controller.projectOperation.error : null;

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
          <span className="phase-label">Phase 1 · Single clip</span>
        </div>
      </header>

      {controller.project === null ? (
        <VideoProjectOpener
          readiness={readiness}
          projectPending={projectPending}
          projectError={projectError}
          onCheckTools={() => void checkReadiness()}
          onNewProject={() => void controller.newProject()}
          onOpenProject={() => void controller.openProject()}
        />
      ) : (
        <VideoWorkspace
          controller={controller}
          project={controller.project}
          toolsReady={toolsReady}
        />
      )}
    </div>
  );
}

export default App;
