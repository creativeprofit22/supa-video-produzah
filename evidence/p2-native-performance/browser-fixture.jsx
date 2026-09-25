import { createRoot } from "react-dom/client";
import { CommandProvider } from "../../apps/desktop/src/commands/CommandProvider";
import { VideoWorkspace } from "../../apps/desktop/src/video/VideoWorkspace";
import { useVideoProject } from "../../apps/desktop/src/use-video-project";
import { tauriVideoBackend } from "../../apps/desktop/src/video-ipc";
import { mockIPC } from "../../apps/desktop/node_modules/@tauri-apps/api/mocks.js";
import { createMockVideoService } from "../../apps/desktop/src/test-video-service";
import { projectProjectionSchema } from "../../packages/video-contracts/src/index";
import { preparedVideoAssetSchema } from "../../packages/video-media/src/index";
import "../../apps/desktop/src/App.css";

const fixture = globalThis.__p2Fixture;
if (!fixture) throw new Error("Explicit pinned fixture required");
const projection = projectProjectionSchema.parse(fixture.projection);
const mock = createMockVideoService();
const created = await mock.invoke("video_create_project", { name: "P2 browser reference" });
await mock.invoke("video_execute_project_group", {
  request: {
    projectId: created.projectId,
    baseRevision: created.revision.number,
    groupId: globalThis.crypto.randomUUID(),
    commands: [
      ...projection.state.assets.map((asset) => ({
        type: "ImportAsset",
        commandId: globalThis.crypto.randomUUID(),
        asset,
      })),
      {
        type: "CreateSequence",
        commandId: globalThis.crypto.randomUUID(),
        sequence: projection.state.sequences[0],
        activeSequenceId: projection.state.activeSequenceId,
      },
    ],
  },
});
mockIPC(mock.invoke, { shouldMockEvents: true });
let renderListener = null,
  renderTimer = null;
const backend = {
  ...tauriVideoBackend,
  openVideoProject: async () => mock.invoke("video_open_project"),
  closeVideoProject: async () => {},
  getVideoProjectInspector: async () => mock.invoke("video_project_inspector"),
  prepareVideoAsset: async (request) =>
    preparedVideoAssetSchema.parse(fixture.prepared[request.assetId]),
  convertFileSrc: (path) => {
    if (!fixture.urls[path]) throw new Error("Unmapped fixture media");
    return fixture.urls[path];
  },
  pickVideoExportPath: async () => {
    if (!fixture.finalOutput) throw new Error("No native-rendered Final fixture");
    return fixture.finalOutput.outputPath;
  },
  startVideoRender: async (plan) => {
    if (!fixture.finalOutput || !renderListener) throw new Error("Final fixture unavailable");
    const identity = {
      jobId: globalThis.crypto.randomUUID(),
      planId: plan.planId,
      revisionId: plan.revisionId,
    };
    renderTimer = globalThis.setTimeout(
      () => renderListener?.({ type: "completed", ...identity, output: fixture.finalOutput }),
      50,
    );
    return identity;
  },
  listenVideoRenderEvents: async (listener) => {
    renderListener = listener;
    return () => {
      renderListener = null;
      globalThis.clearTimeout(renderTimer);
    };
  },
  listenMediaJobEvents: async () => () => {},
  listMediaJobs: async () => ({ schemaVersion: 1, jobs: [], recovery: null }),
};
function Fixture() {
  const controller = useVideoProject(backend);
  return (
    <>
      <button onClick={() => void controller.openProject()}>Open pinned P2 fixture</button>
      {controller.project && (
        <VideoWorkspace
          controller={controller}
          project={controller.project}
          mediaJobs={[]}
          readiness={{
            phase: "loaded",
            value: {
              source: "bundled",
              toolchainId: "browser-fixture-only",
              ffmpeg: { available: true, version: "fixture" },
              ffprobe: { available: true, version: "fixture" },
              ready: true,
            },
          }}
          onCheckTools={() => {}}
          onOpenJobCenter={() => {}}
        />
      )}
    </>
  );
}
createRoot(globalThis.document.getElementById("root")).render(
  <CommandProvider>
    <Fixture />
  </CommandProvider>,
);
