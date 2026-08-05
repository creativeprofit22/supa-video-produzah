import {
  type ProjectRevision,
  type ProjectRevisionDescriptorV2,
  type RationalRate,
  type RationalTime,
  type RenderPlanV1,
  type VideoProjectStateV2,
  VideoDomainError,
  createRationalTime,
  isTrackMuted,
  microsecondsToSourceFrames,
  projectRevisionDescriptorV2Schema,
  projectRevisionSchema,
  rationalTimeToMicroseconds,
  renderPlanV1Schema,
  videoProjectStateV2Schema,
} from "@supa-video/contracts";

export interface RenderableRevisionV2 {
  readonly revision: Readonly<ProjectRevisionDescriptorV2>;
  readonly state: Readonly<VideoProjectStateV2>;
}

export interface CompileSingleClipRenderPlanInput {
  readonly planId: string;
  readonly revision: Readonly<ProjectRevision> | Readonly<RenderableRevisionV2>;
  readonly inputPath: string;
  readonly outputPath: string;
}

interface ValidatedSingleClipRevision {
  readonly revision: ProjectRevision;
  readonly audioSuppressed: boolean;
}

function invalidRenderPlan(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new VideoDomainError("invalid_render_plan", message, details);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }
  return Object.freeze(value);
}

function ratesMatch(left: RationalRate, right: RationalRate): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

function timeUsesRate(time: RationalTime, rate: RationalRate): boolean {
  return time.rateNumerator === rate.numerator && time.rateDenominator === rate.denominator;
}

function formatMicrosecondsAsSeconds(microseconds: number): string {
  const wholeSeconds = Math.floor(microseconds / 1_000_000);
  const fractionalMicroseconds = microseconds % 1_000_000;
  return `${wholeSeconds}.${fractionalMicroseconds.toString().padStart(6, "0")}`;
}

function toBoundarySeconds(time: RationalTime): string {
  try {
    return formatMicrosecondsAsSeconds(rationalTimeToMicroseconds(time, "nearestTiesAwayFromZero"));
  } catch (error) {
    invalidRenderPlan("Render time cannot be represented as integer microseconds", {
      value: time.value,
      rateNumerator: time.rateNumerator,
      rateDenominator: time.rateDenominator,
      cause: error instanceof VideoDomainError ? error.code : "unknown",
    });
  }
}

function adaptV2Revision(input: unknown): ValidatedSingleClipRevision | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("revision" in input) ||
    !("state" in input)
  ) {
    return null;
  }
  const descriptor = projectRevisionDescriptorV2Schema.safeParse(
    (input as { revision?: unknown }).revision,
  );
  const state = videoProjectStateV2Schema.safeParse((input as { state?: unknown }).state);
  if (!descriptor.success || !state.success) {
    invalidRenderPlan("Renderable V2 revision failed strict validation");
  }
  const sequence = state.data.sequences.find(
    (candidate) => candidate.id === state.data.activeSequenceId,
  );
  const tracks = sequence?.tracks.filter((track) => track.kind === "video") ?? [];
  const track = tracks[0];
  const clip = track?.clips[0];
  if (
    sequence === undefined ||
    tracks.length !== 1 ||
    track === undefined ||
    clip === undefined ||
    track.clips.length !== 1
  ) {
    invalidRenderPlan("A V2 render requires one active sequence, video track, and clip");
  }
  if (clip.source.kind !== "asset") {
    invalidRenderPlan("Nested sequences are not renderable by the single-clip compiler");
  }
  const assetId = clip.source.assetId;
  const asset = state.data.assets.find((candidate) => candidate.id === assetId);
  if (asset === undefined) invalidRenderPlan("The render clip asset is missing");
  const transform = clip.transform;
  if (
    transform.positionXPermille !== 0 ||
    transform.positionYPermille !== 0 ||
    transform.scaleXPermille !== 1_000 ||
    transform.scaleYPermille !== 1_000 ||
    transform.rotationMilliDegrees !== 0 ||
    transform.opacityPermille !== 1_000 ||
    clip.gainMilliDecibels !== 0
  ) {
    invalidRenderPlan("The Phase 2 single-clip exporter requires default transform and gain");
  }
  return {
    revision: projectRevisionSchema.parse({
      id: descriptor.data.id,
      parentRevisionId: descriptor.data.parentId,
      sequenceNumber: descriptor.data.number,
      committedAt: descriptor.data.committedAt,
      commandSummary: "Canonical render revision",
      state: {
        asset,
        sequence: {
          id: sequence.id,
          rate: sequence.rate,
          width: sequence.width,
          height: sequence.height,
          audioSampleRate: 48_000,
          videoTracks: [
            {
              id: track.id,
              clips: [
                {
                  id: clip.id,
                  assetId,
                  timelineStart: clip.timelineStart,
                  sourceIn: clip.sourceIn,
                  sourceOut: clip.sourceOut,
                },
              ],
            },
          ],
        },
      },
    }),
    audioSuppressed: isTrackMuted(track),
  };
}

function validateRevision(input: unknown): ValidatedSingleClipRevision {
  const adapted = adaptV2Revision(input);
  const result = projectRevisionSchema.safeParse(adapted?.revision ?? input);
  if (!result.success) {
    invalidRenderPlan("Revision failed strict render validation", {
      issues: result.error.issues,
    });
  }

  const revision = result.data;
  const { asset, sequence } = revision.state;
  if (asset === null) {
    invalidRenderPlan("A render plan requires one asset", { revisionId: revision.id });
  }
  if (sequence === null) {
    invalidRenderPlan("A render plan requires one sequence", { revisionId: revision.id });
  }

  const track = sequence.videoTracks[0];
  if (track === undefined) {
    invalidRenderPlan("A render plan requires one video track", {
      revisionId: revision.id,
      sequenceId: sequence.id,
    });
  }
  const clip = track.clips[0];
  if (track.clips.length !== 1 || clip === undefined) {
    invalidRenderPlan("A render plan requires exactly one clip", {
      revisionId: revision.id,
      trackId: track.id,
      clipCount: track.clips.length,
    });
  }
  if (clip.assetId !== asset.id) {
    invalidRenderPlan("Clip asset identity does not match the project asset", {
      assetId: asset.id,
      clipAssetId: clip.assetId,
      clipId: clip.id,
    });
  }
  if (
    !timeUsesRate(clip.timelineStart, sequence.rate) ||
    !timeUsesRate(clip.sourceIn, sequence.rate) ||
    !timeUsesRate(clip.sourceOut, sequence.rate)
  ) {
    invalidRenderPlan("Sequence and clip rates must match exactly", {
      sequenceId: sequence.id,
      clipId: clip.id,
    });
  }
  if (!ratesMatch(sequence.rate, asset.probe.averageFrameRate)) {
    invalidRenderPlan("Sequence rate must match the asset average rate", {
      sequenceId: sequence.id,
      assetId: asset.id,
    });
  }
  if (clip.sourceOut.value <= clip.sourceIn.value) {
    invalidRenderPlan("Clip source range must contain at least one frame", {
      sourceIn: clip.sourceIn.value,
      sourceOut: clip.sourceOut.value,
    });
  }
  const sourceDuration = microsecondsToSourceFrames(
    asset.probe.durationMicroseconds,
    sequence.rate,
  );
  if (clip.sourceOut.value > sourceDuration.value) {
    invalidRenderPlan("Clip source range exceeds the probed source duration", {
      sourceOut: clip.sourceOut.value,
      sourceDuration: sourceDuration.value,
    });
  }

  return {
    revision,
    audioSuppressed: adapted?.audioSuppressed ?? false,
  };
}

function compileValidatedPlan(
  input: CompileSingleClipRenderPlanInput,
  validatedRevision: ValidatedSingleClipRevision,
): RenderPlanV1 {
  const { revision, audioSuppressed } = validatedRevision;
  const asset = revision.state.asset;
  const sequence = revision.state.sequence;
  if (asset === null || sequence === null) {
    return invalidRenderPlan("Validated revision lost required render state");
  }
  const clip = sequence.videoTracks[0].clips[0];
  if (clip === undefined) {
    return invalidRenderPlan("Validated revision lost its required clip");
  }

  const durationFrames = clip.sourceOut.value - clip.sourceIn.value;
  const duration = createRationalTime(durationFrames, sequence.rate);
  const hasAudio = asset.probe.audio !== null && !audioSuppressed;
  const videoFilter = [
    `scale=${sequence.width}:${sequence.height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${sequence.width}:${sequence.height}:(ow-iw)/2:(oh-ih)/2:black`,
    `fps=${sequence.rate.numerator}/${sequence.rate.denominator}`,
  ].join(",");
  const argv = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    "-progress",
    "pipe:1",
    "-nostats",
    "-i",
    input.inputPath,
    "-ss",
    toBoundarySeconds(clip.sourceIn),
    "-t",
    toBoundarySeconds(duration),
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : ["-an"]),
    "-vf",
    videoFilter,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    ...(hasAudio ? ["-c:a", "aac", "-ar", "48000"] : []),
    "-movflags",
    "+faststart",
    input.outputPath,
  ];

  const result = renderPlanV1Schema.safeParse({
    schemaVersion: 1,
    planId: input.planId,
    revisionId: revision.id,
    executable: "ffmpeg",
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    expected: {
      durationFrames,
      rate: sequence.rate,
      width: sequence.width,
      height: sequence.height,
      audio: hasAudio,
    },
    argv,
  });
  if (!result.success) {
    invalidRenderPlan("Compiled render plan failed strict validation", {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function compileSingleClipRenderPlan(
  input: CompileSingleClipRenderPlanInput,
): Readonly<RenderPlanV1> {
  if (typeof input !== "object" || input === null) {
    invalidRenderPlan("Render compiler input must be an object");
  }
  const validatedRevision = validateRevision(input.revision);

  try {
    return deepFreeze(compileValidatedPlan(input, validatedRevision));
  } catch (error) {
    if (error instanceof VideoDomainError && error.code === "invalid_render_plan") {
      throw error;
    }
    invalidRenderPlan("Render plan compilation failed", {
      cause: error instanceof VideoDomainError ? error.code : "unknown",
    });
  }
}
