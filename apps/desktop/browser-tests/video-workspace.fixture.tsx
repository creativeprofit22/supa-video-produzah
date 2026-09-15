/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import type { CommandGroupRequest } from "@supa-video/contracts";
import { mockIPC, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { CommandProvider } from "../src/commands/CommandProvider";
import { createMockVideoService } from "../src/test-video-service";
import { useVideoProject } from "../src/use-video-project";
import { VideoWorkspace } from "../src/video/VideoWorkspace";
import "../src/App.css";
const longName = "LongUnbrokenInterviewRecordingName".repeat(5) + ".mp4";
const service = createMockVideoService({ sourcePath: `C:\\Neutral\\Media\\${longName}` });
const calls: string[] = [];
mockConvertFileSrc("asset");
mockIPC(
  (command, args) => {
    calls.push(command);
    return service.invoke(command, args);
  },
  { shouldMockEvents: true },
);
Object.assign(window, {
  workspaceEvidence: () => ({
    revision: service.projection.revision.number,
    groups: calls.filter((c) => c === "video_execute_project_group").length,
    invocations: calls.length,
    calls: [...calls],
    state: service.projection.state,
  }),
});
function Fixture() {
  const controller = useVideoProject();
  const track = controller.projection?.state.sequences[0]?.tracks.find((t) => t.kind === "video");
  const clip = track?.kind === "video" ? track.clips[0] : undefined;
  const distribute = async () => {
    const projection = controller.projection;
    const sequence = projection?.state.sequences[0];
    if (!projection || !sequence || track?.kind !== "video" || track.clips.length !== 2) return;
    const moved = structuredClone(track.clips[1]!);
    const request: CommandGroupRequest = {
      groupId: crypto.randomUUID(),
      projectId: projection.projectId,
      baseRevision: projection.revision.number,
      commands: [
        {
          type: "RemoveClip",
          commandId: crypto.randomUUID(),
          sequenceId: sequence.id,
          trackId: track.id,
          clipId: moved.id,
        },
        {
          type: "InsertTrack",
          commandId: crypto.randomUUID(),
          sequenceId: sequence.id,
          index: sequence.tracks.length,
          track: { kind: "video", id: crypto.randomUUID(), name: "Second video", clips: [moved] },
        },
      ],
    };
    await invoke("video_execute_project_group", { request });
    await controller.openProject();
  };
  return (
    <div className="shared-rail">
      <h1 style={{ overflowWrap: "anywhere" }}>Populated workspace verification</h1>
      <p>
        Mock backend; real controller and components. No rendered audio or native media parity
        claim.
      </p>
      <button
        onClick={() =>
          void controller
            .newProject()
            .then(() => controller.prepareImportedSource(service.sourcePath))
        }
      >
        Initialize workspace fixture
      </button>
      <button
        disabled={!clip}
        onClick={() =>
          clip && void controller.splitTimelineClip({ clipId: clip.id, sourceFrame: 50 })
        }
      >
        Split fixture into two clips
      </button>
      <button
        disabled={track?.kind !== "video" || track.clips.length !== 2}
        onClick={() => void distribute()}
      >
        Place second clip on another track
      </button>
      <output aria-label="Canonical revision">{controller.projection?.revision.number ?? 0}</output>
      {controller.project && (
        <VideoWorkspace
          controller={controller}
          project={controller.project}
          mediaJobs={[]}
          readiness={{
            phase: "loaded",
            value: {
              source: "bundled",
              toolchainId: "ffmpeg-test-v1",
              ffmpeg: { available: true, version: "test" },
              ffprobe: { available: true, version: "test" },
              ready: true,
            },
          }}
          onCheckTools={() => undefined}
          onOpenJobCenter={() => undefined}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <CommandProvider>
    <Fixture />
  </CommandProvider>,
);
