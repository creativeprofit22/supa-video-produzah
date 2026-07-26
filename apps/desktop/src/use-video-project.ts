import {
  createRationalTime,
  microsecondsToSourceFrames,
  openedVideoProjectSchema,
  VideoDomainError,
  type MediaProbe,
  type PreparedVideoAsset,
  type PrepareVideoAssetRequest,
  type RenderPlanV1,
  type VerifiedRenderOutput,
  type VideoProjectFileV1,
  type VideoSourceRecord,
} from "@supa-video/contracts";
import {
  canRedo as historyCanRedo,
  commit,
  createHistory,
  createProject,
  currentRevision,
  executeCommand,
  redo as redoHistory,
  undo as undoHistory,
  type ProjectHistory,
} from "@supa-video/project";
import { compileSingleClipRenderPlan } from "@supa-video/render";
import { useCallback, useEffect, useRef, useState } from "react";

import { tauriVideoBackend, type VideoBackend, type VideoRenderNotification } from "./video-ipc";

export type PreparationState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending" }
  | { readonly phase: "error"; readonly error: Error }
  | { readonly phase: "success"; readonly value: PreparedVideoAsset };

export type ProjectOperation = "new" | "open" | "import" | "regrant";
export type ProjectOperationState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly operation: ProjectOperation }
  | { readonly phase: "error"; readonly operation: ProjectOperation; readonly error: Error };

export interface TrimDraft {
  readonly inFrame: number;
  readonly outFrame: number;
}

export type EditOperationState =
  | { readonly phase: "idle" }
  | { readonly phase: "saving"; readonly operation: "trim" | "undo" | "redo" }
  | {
      readonly phase: "error";
      readonly operation: "trim" | "undo" | "redo";
      readonly error: Error;
    };

interface RenderIdentity {
  readonly jobId: string;
  readonly planId: string;
  readonly revisionId: string;
}

interface PendingRenderIdentity {
  readonly jobId: string | null;
  readonly planId: string;
  readonly revisionId: string;
  readonly outputPath: string;
}

export type RenderState =
  | { readonly phase: "idle" }
  | ({ readonly phase: "starting" } & PendingRenderIdentity)
  | ({
      readonly phase: "running";
      readonly progress: number;
      readonly cancellationPending: boolean;
      readonly cancellationError: Error | null;
    } & RenderIdentity &
      Pick<PendingRenderIdentity, "outputPath">)
  | ({ readonly phase: "completed"; readonly output: VerifiedRenderOutput } & RenderIdentity)
  | ({
      readonly phase: "completed_with_warning";
      readonly outputPath: string;
      readonly error: VideoDomainError;
    } & RenderIdentity)
  | ({
      readonly phase: "failed";
      readonly error: Error;
      readonly canOverwrite: boolean;
    } & PendingRenderIdentity)
  | ({ readonly phase: "cancelled" } & RenderIdentity & Pick<PendingRenderIdentity, "outputPath">);

interface VideoProjectControllerState {
  readonly projectPath: string | null;
  readonly history: Readonly<ProjectHistory> | null;
  readonly source: VideoSourceRecord | null;
  readonly sourcePath: string | null;
  readonly preparedAsset: PreparedVideoAsset | null;
  readonly preparation: PreparationState;
  readonly projectOperation: ProjectOperationState;
}

const initialControllerState: VideoProjectControllerState = {
  projectPath: null,
  history: null,
  source: null,
  sourcePath: null,
  preparedAsset: null,
  preparation: { phase: "idle" },
  projectOperation: { phase: "idle" },
};

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function projectNameFromPath(path: string): string {
  const fileName = path.split(/[\\/]/).at(-1)?.trim() ?? "";
  const name = fileName.replace(/\.svpvideo$/i, "").trim();
  return (name.length === 0 ? "Untitled project" : name).slice(0, 512);
}

function createEmptyProject(name = "Untitled project"): Readonly<VideoProjectFileV1> {
  const createdAt = new Date().toISOString();
  return createProject({
    projectId: newId(),
    initialRevisionId: newId(),
    name,
    createdAt,
  });
}

function sourceDisplayName(path: string): string {
  const candidate = path.split(/[\\/]/).at(-1)?.trim();
  return candidate === undefined || candidate.length === 0
    ? "Selected video"
    : candidate.slice(0, 512);
}

function exportDisplayName(project: Readonly<VideoProjectFileV1>): string {
  const displayName = currentRevision(project).state.asset?.displayName ?? "export";
  const stem = displayName.replace(/\.[^.]+$/, "").trim();
  return `${stem.length === 0 ? "export" : stem}-export.mp4`;
}

function importSource(
  currentProject: Readonly<VideoProjectFileV1>,
  path: string,
  probe: MediaProbe,
): {
  readonly project: Readonly<VideoProjectFileV1>;
  readonly request: PrepareVideoAssetRequest;
} {
  if (currentRevision(currentProject).state.asset !== null) {
    throw new VideoDomainError(
      "phase1_limit",
      "Phase 1 projects can contain exactly one source video",
    );
  }
  const assetId = newId();
  const importedAt = new Date().toISOString();
  const withAsset = executeCommand(currentProject, {
    type: "ImportAsset",
    commandId: newId(),
    baseRevisionId: currentProject.currentRevisionId,
    issuedAt: importedAt,
    asset: {
      id: assetId,
      displayName: sourceDisplayName(path),
      locator: { absolutePath: path },
      probe,
    },
  });
  return {
    project: withAsset,
    request: {
      projectId: withAsset.id,
      assetId,
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

  const sequenceId = newId();
  const trackId = newId();
  const rate = state.asset.probe.averageFrameRate;
  const withSequence = executeCommand(project, {
    type: "CreateSequence",
    commandId: newId(),
    baseRevisionId: project.currentRevisionId,
    issuedAt: new Date().toISOString(),
    sequence: {
      id: sequenceId,
      rate,
      width: preparedAsset.proxyProbe.width,
      height: preparedAsset.proxyProbe.height,
      audioSampleRate: 48_000,
      videoTracks: [{ id: trackId, clips: [] }],
    },
  });

  return executeCommand(withSequence, {
    type: "InsertClip",
    commandId: newId(),
    baseRevisionId: withSequence.currentRevisionId,
    issuedAt: new Date().toISOString(),
    sequenceId,
    trackId,
    clip: {
      id: newId(),
      assetId: state.asset.id,
      timelineStart: createRationalTime(0, rate),
      sourceIn: createRationalTime(0, rate),
      sourceOut: microsecondsToSourceFrames(state.asset.probe.durationMicroseconds, rate),
    },
  });
}

function preparationRequestForOpenedProject(
  project: Readonly<VideoProjectFileV1>,
  source: VideoSourceRecord,
): PrepareVideoAssetRequest | null {
  const asset = currentRevision(project).state.asset;
  if (asset === null || source.status !== "resolved") {
    return null;
  }
  return {
    projectId: project.id,
    assetId: asset.id,
    path: source.resolvedPath,
    sequenceRate: asset.probe.averageFrameRate,
  };
}

function hasSingleClipRevision(project: Readonly<VideoProjectFileV1>): boolean {
  const { asset, sequence } = currentRevision(project).state;
  return (
    asset !== null &&
    sequence !== null &&
    sequence.videoTracks.length === 1 &&
    sequence.videoTracks[0]?.clips.length === 1 &&
    sequence.videoTracks[0].clips[0]?.assetId === asset.id
  );
}

function trimDraftForProject(project: Readonly<VideoProjectFileV1>): TrimDraft | null {
  const clip = currentRevision(project).state.sequence?.videoTracks[0]?.clips[0];
  return clip === undefined
    ? null
    : { inFrame: clip.sourceIn.value, outFrame: clip.sourceOut.value };
}

function sourceDurationFrames(project: Readonly<VideoProjectFileV1>): number | null {
  const asset = currentRevision(project).state.asset;
  if (asset === null) {
    return null;
  }
  return microsecondsToSourceFrames(asset.probe.durationMicroseconds, asset.probe.averageFrameRate)
    .value;
}

function editBaseline(history: ProjectHistory): number {
  const baseline = history.document.revisions.findIndex((revision) => {
    const { asset, sequence } = revision.state;
    return (
      asset !== null &&
      sequence?.videoTracks[0]?.clips.length === 1 &&
      sequence.videoTracks[0].clips[0]?.assetId === asset.id
    );
  });
  return baseline < 0 ? history.cursor : baseline;
}

function eventMatchesIdentity(event: VideoRenderNotification, identity: RenderIdentity): boolean {
  return (
    event.jobId === identity.jobId &&
    event.planId === identity.planId &&
    event.revisionId === identity.revisionId
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The desktop operation failed unexpectedly");
}

export function useVideoProject(backend: VideoBackend = tauriVideoBackend) {
  const [state, setState] = useState<VideoProjectControllerState>(initialControllerState);
  const [render, setRender] = useState<RenderState>({ phase: "idle" });
  const [destinationPending, setDestinationPending] = useState(false);
  const [destinationError, setDestinationError] = useState<Error | null>(null);
  const [trimDraft, setTrimDraft] = useState<TrimDraft | null>(null);
  const [editOperation, setEditOperation] = useState<EditOperationState>({ phase: "idle" });
  const stateRef = useRef(state);
  const renderRef = useRef(render);
  const renderListenerRef = useRef<(() => void) | null>(null);
  const projectOperationRef = useRef(0);
  const editOperationRef = useRef(0);
  const renderOperationRef = useRef(0);
  const destinationOperationRef = useRef(0);
  const destinationPendingRef = useRef(false);
  const overwritePlanRef = useRef<Readonly<RenderPlanV1> | null>(null);

  const replaceState = useCallback((nextState: VideoProjectControllerState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const patchState = useCallback(
    (patch: Partial<VideoProjectControllerState>) => {
      replaceState({ ...stateRef.current, ...patch });
    },
    [replaceState],
  );

  const replaceRender = useCallback((nextState: RenderState) => {
    renderRef.current = nextState;
    setRender(nextState);
  }, []);

  const disposeRenderListener = useCallback(() => {
    renderListenerRef.current?.();
    renderListenerRef.current = null;
  }, []);

  const resetRender = useCallback(() => {
    renderOperationRef.current += 1;
    destinationOperationRef.current += 1;
    disposeRenderListener();
    overwritePlanRef.current = null;
    destinationPendingRef.current = false;
    setDestinationPending(false);
    setDestinationError(null);
    replaceRender({ phase: "idle" });
  }, [disposeRenderListener, replaceRender]);

  const cancelRenderForProjectSwitch = useCallback(() => {
    const activeRender = renderRef.current;
    if (activeRender.phase === "running") {
      void backend.cancelVideoRender(activeRender.jobId).catch(() => undefined);
    }
    resetRender();
  }, [backend, resetRender]);

  const activateProject = useCallback(
    (nextState: VideoProjectControllerState) => {
      cancelRenderForProjectSwitch();
      editOperationRef.current += 1;
      setEditOperation({ phase: "idle" });
      setTrimDraft(
        nextState.history === null ? null : trimDraftForProject(nextState.history.document),
      );
      replaceState(nextState);
    },
    [cancelRenderForProjectSwitch, replaceState],
  );

  useEffect(
    () => () => {
      projectOperationRef.current += 1;
      editOperationRef.current += 1;
      renderOperationRef.current += 1;
      destinationOperationRef.current += 1;
      disposeRenderListener();
      const activeRender = renderRef.current;
      if (activeRender.phase === "running") {
        void backend.cancelVideoRender(activeRender.jobId).catch(() => undefined);
      }
    },
    [backend, disposeRenderListener],
  );

  const handleRenderEvent = useCallback(
    (operation: number, plan: Readonly<RenderPlanV1>, event: VideoRenderNotification): void => {
      if (operation !== renderOperationRef.current) {
        return;
      }
      const activeRender = renderRef.current;
      if (event.planId !== plan.planId || event.revisionId !== plan.revisionId) {
        return;
      }

      if (event.type === "started") {
        if (activeRender.phase !== "starting" || activeRender.jobId !== null) {
          return;
        }
        replaceRender({
          phase: "running",
          jobId: event.jobId,
          planId: event.planId,
          revisionId: event.revisionId,
          outputPath: activeRender.outputPath,
          progress: 0,
          cancellationPending: false,
          cancellationError: null,
        });
        return;
      }

      if (activeRender.phase !== "running" || !eventMatchesIdentity(event, activeRender)) {
        return;
      }

      if (event.type === "progress") {
        const nextProgress = Math.min(
          100,
          Math.floor((event.completedMicroseconds / event.durationMicroseconds) * 100),
        );
        if (nextProgress > activeRender.progress) {
          replaceRender({ ...activeRender, progress: nextProgress });
        }
        return;
      }

      disposeRenderListener();
      if (event.type === "completed") {
        overwritePlanRef.current = null;
        replaceRender({
          phase: "completed",
          jobId: event.jobId,
          planId: event.planId,
          revisionId: event.revisionId,
          output: event.output,
        });
      } else if (event.type === "failed") {
        const previewFailedAfterSave =
          event.error.code === "project_io" && event.error.details.outputExists === true;
        if (previewFailedAfterSave) {
          overwritePlanRef.current = null;
          replaceRender({
            phase: "completed_with_warning",
            jobId: event.jobId,
            planId: event.planId,
            revisionId: event.revisionId,
            outputPath: activeRender.outputPath,
            error: event.error,
          });
          return;
        }

        const canOverwrite = event.error.code === "output_exists";
        overwritePlanRef.current = canOverwrite ? plan : null;
        replaceRender({
          phase: "failed",
          jobId: event.jobId,
          planId: event.planId,
          revisionId: event.revisionId,
          outputPath: activeRender.outputPath,
          error: event.error,
          canOverwrite,
        });
      } else if (event.type === "cancelled") {
        overwritePlanRef.current = null;
        replaceRender({
          phase: "cancelled",
          jobId: event.jobId,
          planId: event.planId,
          revisionId: event.revisionId,
          outputPath: activeRender.outputPath,
        });
      }
    },
    [disposeRenderListener, replaceRender],
  );

  const startRenderPlan = useCallback(
    async (plan: Readonly<RenderPlanV1>, overwrite: boolean): Promise<void> => {
      const operation = ++renderOperationRef.current;
      disposeRenderListener();
      overwritePlanRef.current = null;
      replaceRender({
        phase: "starting",
        jobId: null,
        planId: plan.planId,
        revisionId: plan.revisionId,
        outputPath: plan.outputPath,
      });

      try {
        const unlisten = await backend.listenVideoRenderEvents((event) => {
          handleRenderEvent(operation, plan, event);
        });
        if (operation !== renderOperationRef.current) {
          unlisten();
          return;
        }
        renderListenerRef.current = unlisten;

        const started = await backend.startVideoRender(plan, overwrite);
        if (operation !== renderOperationRef.current) {
          unlisten();
          void backend.cancelVideoRender(started.jobId).catch(() => undefined);
          return;
        }
        if (started.planId !== plan.planId || started.revisionId !== plan.revisionId) {
          throw new Error("The desktop service returned a mismatched export job");
        }

        const activeRender = renderRef.current;
        if (activeRender.phase === "starting") {
          replaceRender({
            phase: "running",
            ...started,
            outputPath: plan.outputPath,
            progress: 0,
            cancellationPending: false,
            cancellationError: null,
          });
        } else if ("jobId" in activeRender && activeRender.jobId !== started.jobId) {
          throw new Error("The desktop service returned a mismatched export job");
        }
      } catch (error) {
        if (operation !== renderOperationRef.current) {
          return;
        }
        disposeRenderListener();
        const normalizedError = asError(error);
        const canOverwrite =
          normalizedError instanceof VideoDomainError && normalizedError.code === "output_exists";
        overwritePlanRef.current = canOverwrite ? plan : null;
        replaceRender({
          phase: "failed",
          jobId: null,
          planId: plan.planId,
          revisionId: plan.revisionId,
          outputPath: plan.outputPath,
          error: normalizedError,
          canOverwrite,
        });
      }
    },
    [backend, disposeRenderListener, handleRenderEvent, replaceRender],
  );

  const prepareOpenedSource = useCallback(
    async (operation: number, request: PrepareVideoAssetRequest): Promise<void> => {
      patchState({ preparation: { phase: "pending" }, preparedAsset: null });
      try {
        const preparedAsset = await backend.prepareVideoAsset(request);
        if (operation !== projectOperationRef.current) {
          return;
        }
        const activeProject = stateRef.current.history?.document;
        const source = stateRef.current.source;
        if (
          activeProject?.id !== request.projectId ||
          source?.status !== "resolved" ||
          source.assetId !== request.assetId ||
          source.resolvedPath !== request.path
        ) {
          return;
        }
        patchState({
          preparedAsset,
          preparation: { phase: "success", value: preparedAsset },
        });
      } catch (error) {
        if (operation === projectOperationRef.current) {
          patchState({
            preparedAsset: null,
            preparation: { phase: "error", error: asError(error) },
          });
        }
      }
    },
    [backend, patchState],
  );

  const newProject = useCallback(async (): Promise<void> => {
    const operation = ++projectOperationRef.current;
    const previousState = stateRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "new" } });
    try {
      const path = await backend.pickNewVideoProjectPath("Untitled.svpvideo");
      if (operation !== projectOperationRef.current) {
        return;
      }
      if (path === null) {
        replaceState({ ...previousState, projectOperation: { phase: "idle" } });
        return;
      }
      const project = createEmptyProject(projectNameFromPath(path));
      await backend.saveVideoProject(path, project);
      if (operation !== projectOperationRef.current) {
        return;
      }
      activateProject({
        projectPath: path,
        history: createHistory(project),
        source: null,
        sourcePath: null,
        preparedAsset: null,
        preparation: { phase: "idle" },
        projectOperation: { phase: "idle" },
      });
    } catch (error) {
      if (operation === projectOperationRef.current) {
        replaceState({
          ...previousState,
          projectOperation: { phase: "error", operation: "new", error: asError(error) },
        });
      }
    }
  }, [activateProject, backend, patchState, replaceState]);

  const openProject = useCallback(async (): Promise<void> => {
    const operation = ++projectOperationRef.current;
    const previousState = stateRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "open" } });
    try {
      const nativeResult = await backend.openVideoProject();
      if (operation !== projectOperationRef.current) {
        return;
      }
      if (nativeResult === null) {
        replaceState({ ...previousState, projectOperation: { phase: "idle" } });
        return;
      }
      const opened = openedVideoProjectSchema.parse(nativeResult);
      const source = opened.sources[0] ?? null;
      const sourcePath = source?.status === "resolved" ? source.resolvedPath : null;
      activateProject({
        projectPath: opened.path,
        history: createHistory(opened.document),
        source,
        sourcePath,
        preparedAsset: null,
        preparation: { phase: "idle" },
        projectOperation: { phase: "idle" },
      });
      const request =
        source === null ? null : preparationRequestForOpenedProject(opened.document, source);
      if (request !== null) {
        await prepareOpenedSource(operation, request);
      }
    } catch (error) {
      if (operation === projectOperationRef.current) {
        replaceState({
          ...previousState,
          projectOperation: { phase: "error", operation: "open", error: asError(error) },
        });
      }
    }
  }, [activateProject, backend, patchState, prepareOpenedSource, replaceState]);

  const persistImportedSource = useCallback(
    async (
      operation: number,
      previousState: VideoProjectControllerState,
      path: string,
      probe: MediaProbe,
    ): Promise<void> => {
      const projectPath = previousState.projectPath;
      const project = previousState.history?.document;
      if (projectPath === null || project === undefined) {
        if (operation === projectOperationRef.current) {
          replaceState({
            ...previousState,
            projectOperation: {
              phase: "error",
              operation: "import",
              error: new Error("Create or open a project before choosing a source video"),
            },
          });
        }
        return;
      }

      try {
        const imported = importSource(project, path, probe);
        const preparedAsset = await backend.prepareVideoAsset(imported.request);
        if (operation !== projectOperationRef.current) {
          return;
        }
        const finalProject = createPreparedSequence(imported.project, preparedAsset);
        await backend.saveVideoProject(projectPath, finalProject);
        if (operation !== projectOperationRef.current) {
          return;
        }
        activateProject({
          projectPath,
          history: createHistory(finalProject),
          source: {
            assetId: imported.request.assetId,
            status: "resolved",
            resolvedPath: path,
          },
          sourcePath: path,
          preparedAsset,
          preparation: { phase: "success", value: preparedAsset },
          projectOperation: { phase: "idle" },
        });
      } catch (error) {
        if (operation === projectOperationRef.current) {
          replaceState({
            ...previousState,
            preparation: { phase: "error", error: asError(error) },
            projectOperation: { phase: "error", operation: "import", error: asError(error) },
          });
        }
      }
    },
    [activateProject, backend, replaceState],
  );

  const prepareImportedSource = useCallback(
    async (path: string, probe: MediaProbe): Promise<void> => {
      const operation = ++projectOperationRef.current;
      const previousState = stateRef.current;
      patchState({
        projectOperation: { phase: "pending", operation: "import" },
        preparation: { phase: "pending" },
      });
      await persistImportedSource(operation, previousState, path, probe);
    },
    [patchState, persistImportedSource],
  );

  const chooseSource = useCallback(async (): Promise<void> => {
    const operation = ++projectOperationRef.current;
    const previousState = stateRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "import" } });
    try {
      const path = await backend.pickVideoSource();
      if (operation !== projectOperationRef.current) {
        return;
      }
      if (path === null) {
        replaceState({ ...previousState, projectOperation: { phase: "idle" } });
        return;
      }
      const probe = await backend.probeVideoSource(path);
      if (operation !== projectOperationRef.current) {
        return;
      }
      patchState({ preparation: { phase: "pending" } });
      await persistImportedSource(operation, previousState, path, probe);
    } catch (error) {
      if (operation === projectOperationRef.current) {
        replaceState({
          ...previousState,
          projectOperation: { phase: "error", operation: "import", error: asError(error) },
        });
      }
    }
  }, [backend, patchState, persistImportedSource, replaceState]);

  const regrantSourceAccess = useCallback(async (): Promise<void> => {
    const initialState = stateRef.current;
    const initialProject = initialState.history?.document;
    const initialSource = initialState.source;
    if (
      initialState.projectPath === null ||
      initialProject === undefined ||
      initialSource?.status !== "relink_required" ||
      currentRevision(initialProject).state.asset?.id !== initialSource.assetId
    ) {
      return;
    }

    const operation = ++projectOperationRef.current;
    patchState({ projectOperation: { phase: "pending", operation: "regrant" } });
    try {
      const resolvedSource = await backend.regrantVideoProjectSource({
        projectPath: initialState.projectPath,
        assetId: initialSource.assetId,
      });
      if (operation !== projectOperationRef.current) {
        return;
      }
      if (resolvedSource === null) {
        patchState({ projectOperation: { phase: "idle" } });
        return;
      }

      const activeState = stateRef.current;
      const activeProject = activeState.history?.document;
      const activeSource = activeState.source;
      if (
        activeState.projectPath !== initialState.projectPath ||
        activeProject === undefined ||
        activeSource?.status !== "relink_required" ||
        activeSource.assetId !== resolvedSource.assetId ||
        currentRevision(activeProject).state.asset?.id !== resolvedSource.assetId
      ) {
        throw new Error("The active project source changed before access was restored");
      }
      const request = preparationRequestForOpenedProject(activeProject, resolvedSource);
      if (request === null) {
        throw new Error("The restored source could not be prepared");
      }

      patchState({
        source: resolvedSource,
        sourcePath: resolvedSource.resolvedPath,
        preparedAsset: null,
        preparation: { phase: "idle" },
        projectOperation: { phase: "idle" },
      });
      await prepareOpenedSource(operation, request);
    } catch (error) {
      if (operation === projectOperationRef.current) {
        patchState({
          projectOperation: { phase: "error", operation: "regrant", error: asError(error) },
        });
      }
    }
  }, [backend, patchState, prepareOpenedSource]);

  const retryPreparation = useCallback(async (): Promise<void> => {
    const project = stateRef.current.history?.document;
    const source = stateRef.current.source;
    if (project === undefined || source === null) {
      return;
    }
    const request = preparationRequestForOpenedProject(project, source);
    if (request === null) {
      return;
    }
    const operation = ++projectOperationRef.current;
    await prepareOpenedSource(operation, request);
  }, [prepareOpenedSource]);

  const updateTrimDraft = useCallback((patch: Partial<TrimDraft>) => {
    setTrimDraft((current) => (current === null ? null : { ...current, ...patch }));
    setEditOperation({ phase: "idle" });
  }, []);

  const persistEdit = useCallback(
    async (
      operationName: "trim" | "undo" | "redo",
      baseHistory: Readonly<ProjectHistory>,
      candidate: Readonly<ProjectHistory>,
    ): Promise<void> => {
      const path = stateRef.current.projectPath;
      if (path === null) {
        return;
      }
      const operation = ++editOperationRef.current;
      setEditOperation({ phase: "saving", operation: operationName });
      try {
        await backend.saveVideoProject(path, candidate.document);
        if (
          operation !== editOperationRef.current ||
          stateRef.current.history !== baseHistory ||
          stateRef.current.projectPath !== path
        ) {
          return;
        }
        cancelRenderForProjectSwitch();
        replaceState({ ...stateRef.current, history: candidate });
        setTrimDraft(trimDraftForProject(candidate.document));
        setEditOperation({ phase: "idle" });
      } catch (error) {
        if (operation === editOperationRef.current) {
          setEditOperation({
            phase: "error",
            operation: operationName,
            error: asError(error),
          });
        }
      }
    },
    [backend, cancelRenderForProjectSwitch, replaceState],
  );

  const applyTrim = useCallback(async (): Promise<void> => {
    const history = stateRef.current.history;
    const draft = trimDraft;
    if (history === null || draft === null || editOperation.phase === "saving") {
      return;
    }
    const revision = currentRevision(history.document);
    const sequence = revision.state.sequence;
    const track = sequence?.videoTracks[0];
    const clip = track?.clips[0];
    const duration = sourceDurationFrames(history.document);
    if (
      sequence === null ||
      sequence === undefined ||
      track === undefined ||
      clip === undefined ||
      duration === null ||
      !Number.isSafeInteger(draft.inFrame) ||
      !Number.isSafeInteger(draft.outFrame) ||
      draft.inFrame < 0 ||
      draft.inFrame >= draft.outFrame ||
      draft.outFrame > duration ||
      (draft.inFrame === clip.sourceIn.value && draft.outFrame === clip.sourceOut.value)
    ) {
      return;
    }
    const candidate = commit(history, {
      type: "TrimClip",
      commandId: newId(),
      baseRevisionId: history.document.currentRevisionId,
      issuedAt: new Date().toISOString(),
      sequenceId: sequence.id,
      trackId: track.id,
      clipId: clip.id,
      sourceIn: createRationalTime(draft.inFrame, sequence.rate),
      sourceOut: createRationalTime(draft.outFrame, sequence.rate),
    });
    await persistEdit("trim", history, candidate);
  }, [editOperation.phase, persistEdit, trimDraft]);

  const undoEdit = useCallback(async (): Promise<void> => {
    const history = stateRef.current.history;
    if (
      history === null ||
      editOperation.phase === "saving" ||
      history.cursor <= editBaseline(history)
    ) {
      return;
    }
    await persistEdit("undo", history, undoHistory(history));
  }, [editOperation.phase, persistEdit]);

  const redoEdit = useCallback(async (): Promise<void> => {
    const history = stateRef.current.history;
    if (history === null || editOperation.phase === "saving" || !historyCanRedo(history)) {
      return;
    }
    await persistEdit("redo", history, redoHistory(history));
  }, [editOperation.phase, persistEdit]);

  const exportVideo = useCallback(async (): Promise<void> => {
    const project = stateRef.current.history?.document;
    if (
      project === undefined ||
      destinationPendingRef.current ||
      renderRef.current.phase === "starting" ||
      renderRef.current.phase === "running" ||
      stateRef.current.preparedAsset === null ||
      stateRef.current.sourcePath === null ||
      !hasSingleClipRevision(project)
    ) {
      return;
    }

    const destinationOperation = ++destinationOperationRef.current;
    destinationPendingRef.current = true;
    setDestinationPending(true);
    setDestinationError(null);
    try {
      const outputPath = await backend.pickVideoExportPath(exportDisplayName(project));
      if (destinationOperation !== destinationOperationRef.current || outputPath === null) {
        return;
      }
      const activeProject = stateRef.current.history?.document;
      const sourcePath = stateRef.current.sourcePath;
      if (
        activeProject === undefined ||
        sourcePath === null ||
        !hasSingleClipRevision(activeProject)
      ) {
        throw new Error("The project changed before export could start");
      }
      const plan = compileSingleClipRenderPlan({
        planId: newId(),
        revision: currentRevision(activeProject),
        inputPath: sourcePath,
        outputPath,
      });
      await startRenderPlan(plan, false);
    } catch (error) {
      if (destinationOperation === destinationOperationRef.current) {
        setDestinationError(asError(error));
      }
    } finally {
      if (destinationOperation === destinationOperationRef.current) {
        destinationPendingRef.current = false;
        setDestinationPending(false);
      }
    }
  }, [backend, startRenderPlan]);

  const confirmOverwrite = useCallback(async (): Promise<void> => {
    const plan = overwritePlanRef.current;
    if (plan === null || renderRef.current.phase !== "failed") {
      return;
    }
    await startRenderPlan(plan, true);
  }, [startRenderPlan]);

  const cancelRender = useCallback(async (): Promise<void> => {
    const activeRender = renderRef.current;
    if (activeRender.phase !== "running" || activeRender.cancellationPending) {
      return;
    }
    replaceRender({
      ...activeRender,
      cancellationPending: true,
      cancellationError: null,
    });
    try {
      await backend.cancelVideoRender(activeRender.jobId);
    } catch (error) {
      if (
        renderRef.current.phase === "running" &&
        renderRef.current.jobId === activeRender.jobId &&
        renderRef.current.planId === activeRender.planId &&
        renderRef.current.revisionId === activeRender.revisionId
      ) {
        replaceRender({
          ...renderRef.current,
          cancellationPending: false,
          cancellationError: asError(error),
        });
      }
    }
  }, [backend, replaceRender]);

  const project = state.history?.document ?? null;
  const committedTrim = project === null ? null : trimDraftForProject(project);
  const sourceFrameCount = project === null ? null : sourceDurationFrames(project);
  const trimValid =
    trimDraft !== null &&
    committedTrim !== null &&
    sourceFrameCount !== null &&
    Number.isSafeInteger(trimDraft.inFrame) &&
    Number.isSafeInteger(trimDraft.outFrame) &&
    trimDraft.inFrame >= 0 &&
    trimDraft.inFrame < trimDraft.outFrame &&
    trimDraft.outFrame <= sourceFrameCount;
  const trimChanged =
    trimDraft !== null &&
    committedTrim !== null &&
    (trimDraft.inFrame !== committedTrim.inFrame || trimDraft.outFrame !== committedTrim.outFrame);
  return {
    projectPath: state.projectPath,
    history: state.history,
    project,
    source: state.source,
    sourcePath: state.sourcePath,
    preparedAsset: state.preparedAsset,
    preparation: state.preparation,
    projectOperation: state.projectOperation,
    render,
    destinationPending,
    destinationError,
    trimDraft,
    committedTrim,
    sourceFrameCount,
    trimValid,
    trimChanged,
    editOperation,
    canUndo: state.history !== null && state.history.cursor > editBaseline(state.history),
    canRedo: state.history !== null && historyCanRedo(state.history),
    renderReady: project !== null && state.preparedAsset !== null && hasSingleClipRevision(project),
    newProject,
    openProject,
    chooseSource,
    prepareImportedSource,
    regrantSourceAccess,
    retryPreparation,
    updateTrimDraft,
    applyTrim,
    undoEdit,
    redoEdit,
    convertCachePath: backend.convertFileSrc,
    exportVideo,
    confirmOverwrite,
    cancelRender,
  } as const;
}
