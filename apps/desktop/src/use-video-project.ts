import type {
  MediaProbe,
  PreparedVideoAsset,
  PrepareVideoAssetRequest,
  VideoProjectFileV1,
} from "@supa-video/contracts";
import { createProject, currentRevision, executeCommand } from "@supa-video/project";
import { useCallback, useRef, useState } from "react";

import { prepareVideoAsset } from "./video-ipc";

export type PreparationState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending" }
  | { readonly phase: "error"; readonly error: Error }
  | { readonly phase: "success"; readonly value: PreparedVideoAsset };

interface VideoProjectControllerState {
  readonly project: Readonly<VideoProjectFileV1>;
  readonly sourcePath: string | null;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly preparation: PreparationState;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function createEmptyProject(): Readonly<VideoProjectFileV1> {
  const createdAt = new Date().toISOString();
  return createProject({
    projectId: newId(),
    initialRevisionId: newId(),
    name: "Untitled project",
    createdAt,
  });
}

function sourceDisplayName(path: string): string {
  const candidate = path.split(/[\\/]/).at(-1)?.trim();
  return candidate === undefined || candidate.length === 0
    ? "Selected video"
    : candidate.slice(0, 512);
}

function importSource(
  currentProject: Readonly<VideoProjectFileV1>,
  path: string,
  probe: MediaProbe,
): {
  readonly project: Readonly<VideoProjectFileV1>;
  readonly request: PrepareVideoAssetRequest;
} {
  const currentState = currentRevision(currentProject).state;
  const project = currentState.asset === null ? currentProject : createEmptyProject();
  const assetId = newId();
  const importedAt = new Date().toISOString();
  const withAsset = executeCommand(project, {
    type: "ImportAsset",
    commandId: newId(),
    baseRevisionId: project.currentRevisionId,
    issuedAt: importedAt,
    asset: {
      id: assetId,
      displayName: sourceDisplayName(path),
      locator: { absolutePath: path },
      probe,
    },
  });
  const importedState = currentRevision(withAsset).state;
  if (importedState.asset === null) {
    throw new Error("The imported project state is incomplete");
  }
  return {
    project: withAsset,
    request: {
      projectId: withAsset.id,
      assetId: importedState.asset.id,
      path,
      sequenceRate: probe.averageFrameRate,
    },
  };
}

function createPreparedSequence(
  project: Readonly<VideoProjectFileV1>,
  preparedAsset: PreparedVideoAsset,
): Readonly<VideoProjectFileV1> {
  const state = currentRevision(project).state;
  if (state.asset === null || state.sequence !== null) {
    throw new Error("The imported project state cannot accept a prepared sequence");
  }
  return executeCommand(project, {
    type: "CreateSequence",
    commandId: newId(),
    baseRevisionId: project.currentRevisionId,
    issuedAt: new Date().toISOString(),
    sequence: {
      id: newId(),
      rate: state.asset.probe.averageFrameRate,
      width: preparedAsset.proxyProbe.width,
      height: preparedAsset.proxyProbe.height,
      audioSampleRate: 48_000,
      videoTracks: [{ id: newId(), clips: [] }],
    },
  });
}

function requestMatchesState(
  state: VideoProjectControllerState,
  request: PrepareVideoAssetRequest,
): boolean {
  const projectState = currentRevision(state.project).state;
  return (
    state.project.id === request.projectId &&
    state.sourcePath === request.path &&
    projectState.asset?.id === request.assetId &&
    projectState.asset.probe.averageFrameRate.numerator === request.sequenceRate.numerator &&
    projectState.asset.probe.averageFrameRate.denominator === request.sequenceRate.denominator
  );
}

export function useVideoProject() {
  const [state, setState] = useState<VideoProjectControllerState>(() => ({
    project: createEmptyProject(),
    sourcePath: null,
    preparedAsset: null,
    preparation: { phase: "idle" },
  }));
  const stateRef = useRef(state);

  const replaceState = useCallback((nextState: VideoProjectControllerState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const prepareImportedSource = useCallback(
    async (path: string, probe: MediaProbe): Promise<void> => {
      const imported = importSource(stateRef.current.project, path, probe);
      replaceState({
        project: imported.project,
        sourcePath: path,
        preparedAsset: null,
        preparation: { phase: "pending" },
      });
      try {
        const preparedAsset = await prepareVideoAsset(imported.request);
        if (requestMatchesState(stateRef.current, imported.request)) {
          const project = createPreparedSequence(stateRef.current.project, preparedAsset);
          replaceState({
            ...stateRef.current,
            project,
            preparedAsset,
            preparation: { phase: "success", value: preparedAsset },
          });
        }
      } catch (error) {
        if (requestMatchesState(stateRef.current, imported.request)) {
          replaceState({
            ...stateRef.current,
            preparedAsset: null,
            preparation: { phase: "error", error: error instanceof Error ? error : new Error() },
          });
        }
      }
    },
    [replaceState],
  );

  return {
    project: state.project,
    sourcePath: state.sourcePath,
    preparedAsset: state.preparedAsset,
    preparation: state.preparation,
    prepareImportedSource,
  } as const;
}
