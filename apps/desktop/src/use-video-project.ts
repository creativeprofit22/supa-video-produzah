import {
  createRationalTime,
  microsecondsToSourceFrames,
  VideoDomainError,
  type MediaProbe,
  type PreparedVideoAsset,
  type PrepareVideoAssetRequest,
  type RenderPlanV1,
  type VerifiedRenderOutput,
  type VideoProjectFileV1,
} from "@supa-video/contracts";
import { createProject, currentRevision, executeCommand } from "@supa-video/project";
import { compileSingleClipRenderPlan } from "@supa-video/render";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelVideoRender,
  listenVideoRenderEvents,
  pickVideoExportPath,
  prepareVideoAsset,
  startVideoRender,
  type VideoRenderNotification,
} from "./video-ipc";

export type PreparationState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending" }
  | { readonly phase: "error"; readonly error: Error }
  | { readonly phase: "success"; readonly value: PreparedVideoAsset };

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

function hasSingleClipRevision(project: Readonly<VideoProjectFileV1>): boolean {
  const revision = currentRevision(project);
  const { asset, sequence } = revision.state;
  return (
    asset !== null &&
    sequence !== null &&
    sequence.videoTracks.length === 1 &&
    sequence.videoTracks[0]?.clips.length === 1 &&
    sequence.videoTracks[0].clips[0]?.assetId === asset.id
  );
}

function eventMatchesIdentity(event: VideoRenderNotification, identity: RenderIdentity): boolean {
  return (
    event.jobId === identity.jobId &&
    event.planId === identity.planId &&
    event.revisionId === identity.revisionId
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The video export failed unexpectedly");
}

export function useVideoProject() {
  const [state, setState] = useState<VideoProjectControllerState>(() => ({
    project: createEmptyProject(),
    sourcePath: null,
    preparedAsset: null,
    preparation: { phase: "idle" },
  }));
  const [render, setRender] = useState<RenderState>({ phase: "idle" });
  const [destinationPending, setDestinationPending] = useState(false);
  const [destinationError, setDestinationError] = useState<Error | null>(null);
  const stateRef = useRef(state);
  const renderRef = useRef(render);
  const renderListenerRef = useRef<(() => void) | null>(null);
  const renderOperationRef = useRef(0);
  const destinationOperationRef = useRef(0);
  const destinationPendingRef = useRef(false);
  const overwritePlanRef = useRef<Readonly<RenderPlanV1> | null>(null);

  const replaceState = useCallback((nextState: VideoProjectControllerState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

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

  useEffect(
    () => () => {
      renderOperationRef.current += 1;
      destinationOperationRef.current += 1;
      disposeRenderListener();
      const activeRender = renderRef.current;
      if (activeRender.phase === "running") {
        void cancelVideoRender(activeRender.jobId).catch(() => undefined);
      }
    },
    [disposeRenderListener],
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
        const unlisten = await listenVideoRenderEvents((event) => {
          handleRenderEvent(operation, plan, event);
        });
        if (operation !== renderOperationRef.current) {
          unlisten();
          return;
        }
        renderListenerRef.current = unlisten;

        const started = await startVideoRender(plan, overwrite);
        if (operation !== renderOperationRef.current) {
          unlisten();
          void cancelVideoRender(started.jobId).catch(() => undefined);
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
    [disposeRenderListener, handleRenderEvent, replaceRender],
  );

  const prepareImportedSource = useCallback(
    async (path: string, probe: MediaProbe): Promise<void> => {
      const activeRender = renderRef.current;
      if (activeRender.phase === "running") {
        void cancelVideoRender(activeRender.jobId).catch(() => undefined);
      }
      resetRender();
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
            preparation: { phase: "error", error: asError(error) },
          });
        }
      }
    },
    [replaceState, resetRender],
  );

  const exportVideo = useCallback(async (): Promise<void> => {
    if (
      destinationPendingRef.current ||
      renderRef.current.phase === "starting" ||
      renderRef.current.phase === "running" ||
      stateRef.current.preparedAsset === null ||
      stateRef.current.sourcePath === null ||
      !hasSingleClipRevision(stateRef.current.project)
    ) {
      return;
    }

    const destinationOperation = ++destinationOperationRef.current;
    destinationPendingRef.current = true;
    setDestinationPending(true);
    setDestinationError(null);
    try {
      const outputPath = await pickVideoExportPath(exportDisplayName(stateRef.current.project));
      if (destinationOperation !== destinationOperationRef.current || outputPath === null) {
        return;
      }
      const revision = currentRevision(stateRef.current.project);
      const sourcePath = stateRef.current.sourcePath;
      if (sourcePath === null || !hasSingleClipRevision(stateRef.current.project)) {
        throw new Error("The project changed before export could start");
      }
      const plan = compileSingleClipRenderPlan({
        planId: newId(),
        revision,
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
  }, [startRenderPlan]);

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
      await cancelVideoRender(activeRender.jobId);
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
  }, [replaceRender]);

  return {
    project: state.project,
    sourcePath: state.sourcePath,
    preparedAsset: state.preparedAsset,
    preparation: state.preparation,
    render,
    destinationPending,
    destinationError,
    renderReady: state.preparedAsset !== null && hasSingleClipRevision(state.project),
    prepareImportedSource,
    exportVideo,
    confirmOverwrite,
    cancelRender,
  } as const;
}
