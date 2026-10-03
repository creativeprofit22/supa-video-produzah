import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DeliveryPresetId,
  ProjectProjection,
  QcFinding,
  UsePolicyProfile,
  VerifiedRenderOutput,
} from "@supa-video/contracts";
import type { MusicBeatAnalysisV1 } from "@supa-video/media";
import type { ReviewDecisionRequest, ReviewState } from "@supa-video/qc";

import type {
  DeliveryPresetJob,
  VideoRenderNotification,
  pickVideoExportPath,
  readReviewState,
  recordReviewDecision,
  startVideoDelivery,
  listenVideoRenderEvents,
} from "../video-ipc";
import type { DeliveryOutputStatus } from "./DeliverPanel";
import { compileDeliveryPlan, deliveryFileName, presetById } from "./delivery-plans";
import { musicBeatQcInputForProjection } from "../use-music-beats";
import { editorialEvaluationFor } from "./editorial-evaluation";

export interface ReviewDeliverBackend {
  readonly readReviewState: typeof readReviewState;
  readonly recordReviewDecision: typeof recordReviewDecision;
  readonly startVideoDelivery: typeof startVideoDelivery;
  readonly pickVideoExportPath: typeof pickVideoExportPath;
  readonly listenVideoRenderEvents: typeof listenVideoRenderEvents;
}

export interface ReviewDeliverInput {
  readonly backend: ReviewDeliverBackend;
  /** Completed QC-checked review export, or null. */
  readonly reviewed: VerifiedRenderOutput | null;
  readonly projection: ProjectProjection | null;
  readonly inputPathsByAssetId: Readonly<Record<string, string>> | null;
  readonly intendedUse: UsePolicyProfile | null;
  readonly newId: () => string;
  /** Music beat analyses by asset id; their music beats feed the pacing QC. */
  readonly musicBeatAnalyses?: ReadonlyMap<string, MusicBeatAnalysisV1>;
}

const noMusicBeatAnalyses: ReadonlyMap<string, MusicBeatAnalysisV1> = new Map();

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export function useReviewDeliver({
  backend,
  reviewed,
  projection,
  inputPathsByAssetId,
  intendedUse,
  newId,
  musicBeatAnalyses = noMusicBeatAnalyses,
}: ReviewDeliverInput) {
  const outputPath = reviewed?.qc === undefined ? null : reviewed.outputPath;
  const [review, setReview] = useState<ReviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly DeliveryPresetId[]>([
    "landscape_16x9_1080p",
    "portrait_9x16_1080p",
    "square_1x1_1080p",
  ]);
  const [outputs, setOutputs] = useState<
    Readonly<Partial<Record<DeliveryPresetId, DeliveryOutputStatus>>>
  >({});
  const [deliverError, setDeliverError] = useState<string | null>(null);
  const jobsRef = useRef(new Map<string, DeliveryPresetId>());

  useEffect(() => {
    let active = true;
    setReview(null);
    setOutputs({});
    if (outputPath === null) return undefined;
    setLoading(true);
    void (async () => {
      try {
        const state = await backend.readReviewState(outputPath);
        if (active) {
          setReview(state);
          setError(null);
        }
      } catch (caught) {
        if (active) setError(message(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [backend, outputPath]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const handle = (event: VideoRenderNotification) => {
      const presetId = jobsRef.current.get(event.jobId);
      if (presetId === undefined) return;
      setOutputs((current) => {
        if (event.type === "progress" || event.type === "started")
          return { ...current, [presetId]: { phase: "running" } };
        if (event.type === "completed") {
          return {
            ...current,
            [presetId]: {
              phase: "done",
              outputPath: event.output.outputPath,
              manifestPath: event.output.qc?.manifestPath ?? "",
            },
          };
        }
        if (event.type === "failed")
          return { ...current, [presetId]: { phase: "failed", message: event.error.message } };
        if (event.type === "cancelled")
          return { ...current, [presetId]: { phase: "failed", message: "Cancelled" } };
        return current;
      });
    };
    void (async () => {
      try {
        const stop = await backend.listenVideoRenderEvents(handle);
        if (disposed) stop();
        else unlisten = stop;
      } catch (caught) {
        // Without progress events Deliver still starts; show why status is missing.
        if (!disposed) setDeliverError(`Delivery progress is unavailable: ${message(caught)}`);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [backend]);

  const decide = useCallback(
    async (decision: ReviewDecisionRequest) => {
      if (outputPath === null) return;
      setPending(true);
      try {
        setReview(await backend.recordReviewDecision(outputPath, decision));
        setError(null);
      } catch (caught) {
        setError(message(caught));
      } finally {
        setPending(false);
      }
    },
    [backend, outputPath],
  );

  const accept = useCallback(
    (findingId: string, reason: string) =>
      void decide({ type: "accept_anyway", findingId, reason }),
    [decide],
  );
  const stopRepair = useCallback(
    (findingId: string) => void decide({ type: "repair_stopped", findingId }),
    [decide],
  );
  /** Records the repair attempt; the proposal itself goes through Suggested cuts. */
  const recordRepair = useCallback(
    (finding: QcFinding, proposalId: string) =>
      void decide({
        type: "repair_attempt",
        findingId: finding.findingId,
        proposalId,
        outcome: "proposed",
      }),
    [decide],
  );

  const toggle = useCallback((presetId: DeliveryPresetId, on: boolean) => {
    setSelected((current) =>
      on ? [...new Set([...current, presetId])] : current.filter((id) => id !== presetId),
    );
  }, []);

  const deliver = useCallback(async () => {
    if (
      outputPath === null ||
      review?.release.status !== "releasable" ||
      projection === null ||
      inputPathsByAssetId === null
    )
      return;
    setPending(true);
    setDeliverError(null);
    try {
      // Content identity: an undo back to the reviewed state is still deliverable.
      if (projection.revision.stateHash !== review.manifest.project.revisionStateHash) {
        throw new Error("The project changed since review. Export and review it again.");
      }
      const baseName = outputPath.split(/[\\/]/u).pop() ?? "export.mp4";
      const editorial = await editorialEvaluationFor(
        projection,
        [],
        musicBeatQcInputForProjection(projection, musicBeatAnalyses),
      );
      const jobs: DeliveryPresetJob[] = [];
      for (const presetId of selected) {
        const target = await backend.pickVideoExportPath(deliveryFileName(baseName, presetId));
        if (target === null) return;
        jobs.push({
          presetId,
          editorial,
          plan: compileDeliveryPlan({
            planId: newId(),
            projection,
            preset: presetById(presetId),
            inputPathsByAssetId,
            outputPath: target,
            ...(intendedUse === null ? {} : { intendedUse }),
          }),
        });
      }
      const started = await backend.startVideoDelivery(outputPath, jobs);
      const next: Partial<Record<DeliveryPresetId, DeliveryOutputStatus>> = {};
      started.forEach((job, index) => {
        const presetId = jobs[index]?.presetId;
        if (presetId === undefined) return;
        jobsRef.current.set(job.jobId, presetId);
        next[presetId] = { phase: "queued" };
      });
      setOutputs(next);
    } catch (caught) {
      setDeliverError(message(caught));
    } finally {
      setPending(false);
    }
  }, [
    backend,
    inputPathsByAssetId,
    intendedUse,
    musicBeatAnalyses,
    newId,
    outputPath,
    projection,
    review,
    selected,
  ]);

  return {
    review,
    loading,
    pending,
    error,
    accept,
    stopRepair,
    recordRepair,
    selected,
    outputs,
    deliverError,
    toggle,
    deliver,
  };
}
