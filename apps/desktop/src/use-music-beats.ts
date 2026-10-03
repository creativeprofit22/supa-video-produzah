import {
  musicBeatFramesToMicroseconds,
  musicBeatTimelineTargets,
  type MusicBeatTimelineTarget,
  type ProjectProjection,
  type VideoSequenceV2,
} from "@supa-video/contracts";
import type {
  MediaJobRecord,
  MusicBeatAnalysisV1,
  MusicBeatDetectorKind,
  MusicBeatRuntimeStatus,
} from "@supa-video/media";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { tauriMusicBeatBackend, type MusicBeatBackend } from "./music-beat-ipc";
import type { VideoBackend } from "./video-ipc";

/** Detection state of one music asset, keyed by asset id. */
export type MusicBeatDetectionStatus =
  | { readonly phase: "running"; readonly jobId: string }
  | { readonly phase: "ready"; readonly detector: MusicBeatDetectorKind }
  | { readonly phase: "cancelled" }
  | { readonly phase: "failed"; readonly message: string };

export type MusicBeatJobsBackend = Pick<VideoBackend, "listMediaJobs" | "cancelMediaJob">;

const DEFAULT_POLL_INTERVAL_MS = 750;
const MUSIC_BEAT_JOB_KIND = "music_beat_detection";
const MEDIA_JOB_PAGE_SIZE = 100;
/** Hard cap on pages read per scan; 100 pages covers every retained job. */
const MAX_MEDIA_JOB_PAGES = 100;

/**
 * Reads `projectId`'s media jobs newest first, page by page, until `visit`
 * returns true or the pages run out. Settled jobs stay listed for long after
 * newer proxy and thumbnail jobs push them past the first page.
 */
async function scanProjectJobs(
  backend: MusicBeatJobsBackend,
  projectId: string,
  visit: (job: MediaJobRecord) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  let beforeUpdatedAt: string | null = null;
  let beforeJobId: string | null = null;
  for (let pageIndex = 0; pageIndex < MAX_MEDIA_JOB_PAGES; pageIndex += 1) {
    const page = await backend.listMediaJobs({
      limit: MEDIA_JOB_PAGE_SIZE,
      includeSettled: true,
      projectId,
      beforeUpdatedAt,
      beforeJobId,
    });
    if (signal?.aborted === true) return;
    for (const job of page.jobs) if (visit(job)) return;
    if (page.nextBeforeUpdatedAt === null || page.nextBeforeJobId === null) return;
    if (
      page.jobs.length === 0 ||
      (page.nextBeforeUpdatedAt === beforeUpdatedAt && page.nextBeforeJobId === beforeJobId)
    )
      throw new Error("The desktop service returned a stalled media job page");
    beforeUpdatedAt = page.nextBeforeUpdatedAt;
    beforeJobId = page.nextBeforeJobId;
  }
}

function activeSequence(projection: ProjectProjection | null): VideoSequenceV2 | null {
  if (projection === null) return null;
  return (
    projection.state.sequences.find(({ id }) => id === projection.state.activeSequenceId) ?? null
  );
}

/**
 * Asset ids of clips on music-role audio tracks, sorted. Muted tracks count
 * too, so their analyses are already loaded when the track is unmuted.
 */
export function musicTrackAssetIds(sequence: VideoSequenceV2 | null): readonly string[] {
  if (sequence === null) return [];
  const ids = new Set<string>();
  for (const track of sequence.tracks) {
    if (track.kind !== "audio" || track.audioRole !== "music") continue;
    for (const clip of track.clips) if (clip.source.kind === "asset") ids.add(clip.source.assetId);
  }
  return [...ids].sort();
}

/** Music beat QC input for one projection (see `EditorialInput`). */
export interface MusicBeatQcInput {
  /** Sorted timeline-microsecond music beats of the active sequence's music tracks. */
  readonly musicBeatsUs: readonly number[];
  /** Some of those music beats came from the in-app tempo fallback. */
  readonly musicBeatsFromTempoFallback: boolean;
}

/**
 * Music beats of `projection`'s active sequence in timeline microseconds,
 * plus whether any came from the tempo fallback; the QC input for an export
 * of that exact projection.
 */
export function musicBeatQcInputForProjection(
  projection: ProjectProjection,
  analyses: ReadonlyMap<string, MusicBeatAnalysisV1>,
): MusicBeatQcInput {
  const sequence = activeSequence(projection);
  if (sequence === null || analyses.size === 0)
    return { musicBeatsUs: [], musicBeatsFromTempoFallback: false };
  const assetIdByClipId = new Map<string, string>();
  for (const track of sequence.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips)
      if (clip.source.kind === "asset") assetIdByClipId.set(clip.id, clip.source.assetId);
  }
  // Frames and the fallback flag both come from the music beats actually in
  // use, so a muted track's fallback analysis does not set the flag.
  const frames: number[] = [];
  let fromTempoFallback = false;
  for (const { frame, clipId } of musicBeatTimelineTargets(sequence, analyses)) {
    if (frames.at(-1) !== frame) frames.push(frame);
    if (fromTempoFallback) continue;
    const assetId = assetIdByClipId.get(clipId);
    const analysis = assetId === undefined ? undefined : analyses.get(assetId);
    fromTempoFallback = analysis?.detector.kind === "tempo_fallback";
  }
  return {
    musicBeatsUs: musicBeatFramesToMicroseconds(frames, sequence),
    musicBeatsFromTempoFallback: fromTempoFallback,
  };
}

async function findProjectJob(
  backend: MusicBeatJobsBackend,
  projectId: string,
  jobId: string,
  signal: AbortSignal,
): Promise<MediaJobRecord | undefined> {
  const found = new Map<string, MediaJobRecord>();
  await scanProjectJobs(
    backend,
    projectId,
    (job) => {
      if (job.id === jobId) found.set(jobId, job);
      return found.has(jobId);
    },
    signal,
  );
  return found.get(jobId);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function settledStatus(job: MediaJobRecord): MusicBeatDetectionStatus | null {
  switch (job.state) {
    case "cancelled":
      return { phase: "cancelled" };
    case "failed":
      return { phase: "failed", message: job.error?.message ?? "Music beat detection failed." };
    // Restart recovery blocks an interrupted detection and never re-queues it,
    // so it would poll forever. Detecting again restarts the blocked job.
    case "blocked":
      return {
        phase: "failed",
        message: job.error?.message ?? "Music beat detection stopped. Detect again to restart.",
      };
    default:
      return null;
  }
}

const RUNTIME_CHECK_FAILED = "The Beat This! runtime could not be checked. Try again.";
const RUNTIME_SAVE_FAILED = "The Beat This! folder could not be saved. Try again.";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Music beat detection failed.";
}

/**
 * Music beat analyses of the open project's music assets, their detection
 * jobs, and the derived timeline music beats used for snapping and QC.
 * Completed analyses are found again through the durable media job records
 * when a project opens, so detection does not rerun.
 */
export function useMusicBeats(
  projection: ProjectProjection | null,
  jobsBackend: MusicBeatJobsBackend,
  musicBeatBackend: MusicBeatBackend = tauriMusicBeatBackend,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
) {
  const [analyses, setAnalyses] = useState<ReadonlyMap<string, MusicBeatAnalysisV1>>(new Map());
  const [detection, setDetection] = useState<ReadonlyMap<string, MusicBeatDetectionStatus>>(
    new Map(),
  );
  const [runtimeStatus, setRuntimeStatus] = useState<MusicBeatRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const pollsRef = useRef(new Map<string, AbortController>());
  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;
  const projectId = projection?.projectId ?? null;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const sequence = activeSequence(projection);
  const musicAssetKey = musicTrackAssetIds(sequence).join(",");

  // Which detector the next detection will use; checked once on mount.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const next = await musicBeatBackend.getMusicBeatRuntimeStatus();
        if (current) setRuntimeStatus(next);
      } catch {
        if (current) setRuntimeError(RUNTIME_CHECK_FAILED);
      }
    })();
    return () => {
      current = false;
    };
  }, [musicBeatBackend]);

  const refreshMusicBeatRuntimeStatus = useCallback(async (): Promise<void> => {
    try {
      setRuntimeStatus(await musicBeatBackend.getMusicBeatRuntimeStatus());
      setRuntimeError(null);
    } catch {
      setRuntimeError(RUNTIME_CHECK_FAILED);
    }
  }, [musicBeatBackend]);

  /** Opens the native folder picker; a cancelled pick keeps the current status. */
  const chooseMusicBeatRuntimeFolder = useCallback(async (): Promise<void> => {
    try {
      const next = await musicBeatBackend.chooseMusicBeatRuntimeFolder();
      setRuntimeError(null);
      if (next !== null) setRuntimeStatus(next);
    } catch {
      setRuntimeError(RUNTIME_SAVE_FAILED);
    }
  }, [musicBeatBackend]);

  const setStatus = useCallback((assetId: string, status: MusicBeatDetectionStatus | null) => {
    setDetection((current) => {
      const next = new Map(current);
      if (status === null) next.delete(assetId);
      else next.set(assetId, status);
      return next;
    });
  }, []);

  const loadResult = useCallback(
    async (assetId: string, jobId: string, forProject: string): Promise<void> => {
      const result = await musicBeatBackend.getMusicBeatDetectionResult(jobId);
      const analysis = await musicBeatBackend.loadMusicBeatAnalysis(result.analysisKey);
      if (projectIdRef.current !== forProject) return;
      setAnalyses((current) => new Map(current).set(assetId, analysis));
      setStatus(assetId, { phase: "ready", detector: analysis.detector.kind });
    },
    [musicBeatBackend, setStatus],
  );

  const pollJob = useCallback(
    async (assetId: string, jobId: string, forProject: string): Promise<void> => {
      pollsRef.current.get(assetId)?.abort();
      const controller = new AbortController();
      pollsRef.current.set(assetId, controller);
      setStatus(assetId, { phase: "running", jobId });
      try {
        while (!controller.signal.aborted) {
          const job = await findProjectJob(jobsBackend, forProject, jobId, controller.signal);
          if (controller.signal.aborted) return;
          if (job?.state === "complete") {
            await loadResult(assetId, jobId, forProject);
            return;
          }
          const settled = job === undefined ? null : settledStatus(job);
          if (settled !== null) {
            setStatus(assetId, settled);
            return;
          }
          await sleep(pollIntervalMs, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setStatus(assetId, { phase: "failed", message: errorMessage(error) });
      } finally {
        if (pollsRef.current.get(assetId) === controller) pollsRef.current.delete(assetId);
      }
    },
    [jobsBackend, loadResult, pollIntervalMs, setStatus],
  );

  // On project open (and when music clips change), recover analyses and
  // running jobs from the durable media job records.
  useEffect(() => {
    const polls = pollsRef.current;
    if (projectId === null || musicAssetKey === "") return;
    const wanted = new Set(musicAssetKey.split(","));
    let cancelled = false;
    void (async () => {
      try {
        // Newest first, so the first job seen per asset is its latest.
        const latest = new Map<string, MediaJobRecord>();
        await scanProjectJobs(jobsBackend, projectId, (job) => {
          if (job.kind !== MUSIC_BEAT_JOB_KIND || job.assetId === null) return false;
          if (!wanted.has(job.assetId) || latest.has(job.assetId)) return false;
          latest.set(job.assetId, job);
          return latest.size === wanted.size;
        });
        if (cancelled) return;
        for (const [assetId, job] of latest) {
          if (cancelled) return;
          // Read through a ref: a new analysis must not re-list jobs.
          if (analysesRef.current.has(assetId) || polls.has(assetId)) continue;
          if (job.state === "complete") await loadResult(assetId, job.id, projectId);
          // A detection a restart interrupted says why, unlike one that settled.
          else if (job.state === "blocked") setStatus(assetId, settledStatus(job));
          else if (settledStatus(job) === null) void pollJob(assetId, job.id, projectId);
        }
      } catch {
        // Recovery is best effort; the user can start detection again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobsBackend, loadResult, musicAssetKey, pollJob, projectId, setStatus]);

  // A different project starts empty and stops polling the old one.
  useEffect(() => {
    const polls = pollsRef.current;
    setAnalyses(new Map());
    setDetection(new Map());
    return () => {
      for (const controller of polls.values()) controller.abort();
      polls.clear();
    };
  }, [projectId]);

  const detectMusicBeats = useCallback(
    async (assetId: string): Promise<boolean> => {
      const forProject = projectIdRef.current;
      const source = projection?.sources.find((candidate) => candidate.assetId === assetId);
      if (forProject === null || source?.status !== "resolved") {
        setStatus(assetId, { phase: "failed", message: "The music file is not available." });
        return false;
      }
      try {
        const started = await musicBeatBackend.startMusicBeatDetection({
          projectId: forProject,
          assetId,
          sourcePath: source.resolvedPath,
        });
        if (started.state === "complete") await loadResult(assetId, started.jobId, forProject);
        else await pollJob(assetId, started.jobId, forProject);
        return true;
      } catch (error) {
        setStatus(assetId, { phase: "failed", message: errorMessage(error) });
        return false;
      }
    },
    [loadResult, musicBeatBackend, pollJob, projection, setStatus],
  );

  const cancelMusicBeatDetection = useCallback(
    async (assetId: string): Promise<void> => {
      const status = detection.get(assetId);
      if (status?.phase !== "running") return;
      try {
        await jobsBackend.cancelMediaJob({ jobId: status.jobId });
      } catch (error) {
        setStatus(assetId, { phase: "failed", message: errorMessage(error) });
      }
    },
    [detection, jobsBackend, setStatus],
  );

  const musicBeatTargets = useMemo<readonly MusicBeatTimelineTarget[]>(
    () => (sequence === null ? [] : musicBeatTimelineTargets(sequence, analyses)),
    [analyses, sequence],
  );
  const musicBeatTimelineUs = useMemo<readonly number[]>(
    () =>
      projection === null ? [] : musicBeatQcInputForProjection(projection, analyses).musicBeatsUs,
    [analyses, projection],
  );

  return {
    musicBeatAnalyses: analyses,
    musicBeatDetection: detection,
    musicBeatTargets,
    musicBeatTimelineUs,
    detectMusicBeats,
    cancelMusicBeatDetection,
    musicBeatRuntimeStatus: runtimeStatus,
    musicBeatRuntimeError: runtimeError,
    refreshMusicBeatRuntimeStatus,
    chooseMusicBeatRuntimeFolder,
  } as const;
}
