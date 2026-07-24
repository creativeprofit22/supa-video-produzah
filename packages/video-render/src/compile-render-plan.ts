import {
  type ProjectRevision,
  type RationalRate,
  type RationalTime,
  type RenderPlanV1,
  VideoDomainError,
  createRationalTime,
  microsecondsToSourceFrames,
  projectRevisionSchema,
  rationalTimeToMicroseconds,
  renderPlanV1Schema,
} from "@supa-video/contracts";

export interface CompileSingleClipRenderPlanInput {
  readonly planId: string;
  readonly revision: Readonly<ProjectRevision>;
  readonly inputPath: string;
  readonly outputPath: string;
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

function validateRevision(input: unknown): ProjectRevision {
  const result = projectRevisionSchema.safeParse(input);
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

  return revision;
}

function compileValidatedPlan(
  input: CompileSingleClipRenderPlanInput,
  revision: ProjectRevision,
): RenderPlanV1 {
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
  const hasAudio = asset.probe.audio !== null;
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
  const revision = validateRevision(input.revision);

  try {
    return deepFreeze(compileValidatedPlan(input, revision));
  } catch (error) {
    if (error instanceof VideoDomainError && error.code === "invalid_render_plan") {
      throw error;
    }
    invalidRenderPlan("Render plan compilation failed", {
      cause: error instanceof VideoDomainError ? error.code : "unknown",
    });
  }
}
