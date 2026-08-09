import {
  DEFAULT_CLIP_TRANSFORM_GEOMETRY,
  type ClipTransform,
  type ProjectRevision,
  type ProjectRevisionDescriptorV2,
  type RationalRate,
  type RationalTime,
  type RenderCaptionInputV2,
  type RenderPlanV1,
  type RenderPlanV2,
  type VideoProjectStateV2,
  VideoDomainError,
  createRationalTime,
  formatMilliDegreesAsDegrees,
  formatPermilleDecimal,
  isTrackHidden,
  isTrackMuted,
  microsecondsToSourceFrames,
  projectRevisionDescriptorV2Schema,
  projectRevisionSchema,
  rationalTimeToMicroseconds,
  renderPlanV1Schema,
  renderPlanV2Schema,
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

export interface CompileActiveSequenceRenderPlanInput {
  readonly planId: string;
  readonly revision: Readonly<RenderableRevisionV2>;
  readonly inputPathsByAssetId: Readonly<Record<string, string>>;
  readonly outputPath: string;
}

interface ValidatedSingleClipRevision {
  readonly revision: ProjectRevision;
  readonly audioSuppressed: boolean;
  readonly videoHidden: boolean;
  readonly captions: readonly RenderCaptionInputV2[];
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

function escapeDrawtextText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\r", "\\n")
    .replaceAll("\n", "\\n");
}

function captionDrawtextFilter(caption: RenderCaptionInputV2): string {
  return `drawtext=text='${escapeDrawtextText(caption.text)}':fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:enable='between(t\\,${formatMicrosecondsAsSeconds(caption.startMicroseconds)}\\,${formatMicrosecondsAsSeconds(caption.endMicroseconds)})'`;
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
  const captions = sequence.tracks.flatMap((candidateTrack) =>
    candidateTrack.kind === "caption" && !isTrackHidden(candidateTrack)
      ? candidateTrack.captions.map((caption) => ({
          trackId: candidateTrack.id,
          captionId: caption.id,
          startMicroseconds: rationalTimeToMicroseconds(caption.start, "nearestTiesAwayFromZero"),
          endMicroseconds: rationalTimeToMicroseconds(caption.end, "nearestTiesAwayFromZero"),
          text: caption.text,
        }))
      : [],
  );
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
    videoHidden: isTrackHidden(track),
    captions,
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
    videoHidden: adapted?.videoHidden ?? false,
    captions: adapted?.captions ?? [],
  };
}

function compileValidatedPlan(
  input: CompileSingleClipRenderPlanInput,
  validatedRevision: ValidatedSingleClipRevision,
): RenderPlanV1 {
  const { revision, audioSuppressed, videoHidden, captions } = validatedRevision;
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
    ...(videoHidden ? ["drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill"] : []),
    `fps=${sequence.rate.numerator}/${sequence.rate.denominator}`,
    ...captions.map(captionDrawtextFilter),
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
    captions,
    outputPath: input.outputPath,
    expected: {
      durationFrames,
      rate: sequence.rate,
      width: sequence.width,
      height: sequence.height,
      audio: hasAudio,
      ...(videoHidden ? { videoHidden: true } : {}),
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

type V2Sequence = VideoProjectStateV2["sequences"][number];
type V2Asset = VideoProjectStateV2["assets"][number];
type V2VideoTrack = Extract<V2Sequence["tracks"][number], { kind: "video" }>;
type V2Clip = V2VideoTrack["clips"][number];

interface ValidatedActiveSequenceRevision {
  readonly descriptor: ProjectRevisionDescriptorV2;
  readonly sequence: V2Sequence;
  readonly clips: readonly {
    readonly track: V2VideoTrack;
    readonly clip: V2Clip & {
      readonly source: { readonly kind: "asset"; readonly assetId: string };
    };
    readonly asset: V2Asset;
  }[];
  readonly durationFrames: number;
}

export type ActiveSequenceRenderEligibility =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

function hasDefaultGeometry(transform: ClipTransform): boolean {
  return (
    transform.positionXPermille === DEFAULT_CLIP_TRANSFORM_GEOMETRY.positionXPermille &&
    transform.positionYPermille === DEFAULT_CLIP_TRANSFORM_GEOMETRY.positionYPermille &&
    transform.scaleXPermille === DEFAULT_CLIP_TRANSFORM_GEOMETRY.scaleXPermille &&
    transform.scaleYPermille === DEFAULT_CLIP_TRANSFORM_GEOMETRY.scaleYPermille &&
    transform.rotationMilliDegrees === DEFAULT_CLIP_TRANSFORM_GEOMETRY.rotationMilliDegrees
  );
}

function transformedClipFilter(inputIndex: number, clip: V2Clip, sequence: V2Sequence): string {
  const { transform } = clip;
  const frameRate = `${sequence.rate.numerator}/${sequence.rate.denominator}`;
  const contain = `scale=${sequence.width}:${sequence.height}:force_original_aspect_ratio=decrease:flags=lanczos`;
  if (hasDefaultGeometry(transform)) {
    return `[${inputIndex}:v:0]setpts=PTS-STARTPTS,${contain},format=rgba,colorchannelmixer=aa=${formatPermilleDecimal(transform.opacityPermille)},pad=${sequence.width}:${sequence.height}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=${frameRate}[v${inputIndex}]`;
  }

  const filters = [
    "setpts=PTS-STARTPTS",
    contain,
    "format=rgba",
    `pad=${sequence.width}:${sequence.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
  ];
  if (
    transform.scaleXPermille !== DEFAULT_CLIP_TRANSFORM_GEOMETRY.scaleXPermille ||
    transform.scaleYPermille !== DEFAULT_CLIP_TRANSFORM_GEOMETRY.scaleYPermille
  ) {
    filters.push(
      `scale=w='max(1\\,round(iw*${formatPermilleDecimal(transform.scaleXPermille)}))':h='max(1\\,round(ih*${formatPermilleDecimal(transform.scaleYPermille)}))':flags=lanczos`,
    );
  }
  if (transform.rotationMilliDegrees !== DEFAULT_CLIP_TRANSFORM_GEOMETRY.rotationMilliDegrees) {
    filters.push(
      `rotate=angle=${formatMilliDegreesAsDegrees(transform.rotationMilliDegrees)}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0`,
    );
  }
  filters.push(
    `colorchannelmixer=aa=${formatPermilleDecimal(transform.opacityPermille)}`,
    `fps=${frameRate}`,
  );
  return `[${inputIndex}:v:0]${filters.join(",")}[v${inputIndex}]`;
}

function overlayCoordinate(axis: "x" | "y", positionPermille: number): string {
  const mainSize = axis === "x" ? "main_w" : "main_h";
  const overlaySize = axis === "x" ? "overlay_w" : "overlay_h";
  const centered = `(${mainSize}-${overlaySize})/2`;
  if (positionPermille === 0) return centered;
  const operator = positionPermille < 0 ? "-" : "+";
  return `${centered}${operator}${mainSize}*${formatPermilleDecimal(Math.abs(positionPermille))}`;
}

function transformedOverlayFilter(transform: ClipTransform): string {
  if (hasDefaultGeometry(transform)) return "overlay=0:0:format=auto";
  return `overlay=x='${overlayCoordinate("x", transform.positionXPermille)}':y='${overlayCoordinate("y", transform.positionYPermille)}':format=auto`;
}

function hasSupportedGain(clip: V2Clip): boolean {
  return clip.gainMilliDecibels === 0;
}

function validateActiveSequenceRevision(input: unknown): ValidatedActiveSequenceRevision {
  if (typeof input !== "object" || input === null) {
    invalidRenderPlan("A render requires a canonical project revision");
  }
  const candidate = input as { readonly revision?: unknown; readonly state?: unknown };
  const descriptor = projectRevisionDescriptorV2Schema.safeParse(candidate.revision);
  const stateResult = videoProjectStateV2Schema.safeParse(candidate.state);
  if (!descriptor.success || !stateResult.success) {
    invalidRenderPlan("Renderable V2 revision failed strict validation");
  }

  const state = stateResult.data;
  const sequence = state.sequences.find((item) => item.id === state.activeSequenceId);
  if (sequence === undefined) invalidRenderPlan("A render requires an active sequence");
  if (sequence.audioSampleRate !== 48_000) {
    invalidRenderPlan("Canonical export requires a 48,000 Hz sequence audio rate");
  }
  const populatedAudioTrack = sequence.tracks.find(
    (track) => track.kind === "audio" && track.clips.length > 0,
  );
  if (populatedAudioTrack !== undefined) {
    invalidRenderPlan(
      "Dedicated audio tracks containing clips cannot be exported yet; remove those clips before exporting",
      { trackId: populatedAudioTrack.id, trackName: populatedAudioTrack.name },
    );
  }
  const tracks = sequence.tracks.filter((track): track is V2VideoTrack => track.kind === "video");
  if (tracks.length === 0) invalidRenderPlan("A render requires at least one video track");

  let durationFrames: number | undefined;
  const clips = tracks.map((track, trackIndex) => {
    const clip = track.clips[0];
    if (track.clips.length !== 1 || clip === undefined || clip.source.kind !== "asset") {
      invalidRenderPlan("Each video track must contain exactly one direct-asset clip to export", {
        trackIndex,
      });
    }
    const directClip = clip as V2Clip & {
      readonly source: { readonly kind: "asset"; readonly assetId: string };
    };
    if (
      directClip.timelineStart.value !== 0 ||
      !timeUsesRate(directClip.timelineStart, sequence.rate) ||
      !timeUsesRate(directClip.sourceIn, sequence.rate) ||
      !timeUsesRate(directClip.sourceOut, sequence.rate)
    ) {
      invalidRenderPlan("Every clip must start at timeline zero and use the sequence rate", {
        trackIndex,
      });
    }
    if (!hasSupportedGain(directClip)) {
      invalidRenderPlan("Canonical multi-track export requires default gain", { trackIndex });
    }
    const clipDuration = directClip.sourceOut.value - directClip.sourceIn.value;
    if (clipDuration <= 0 || (durationFrames !== undefined && clipDuration !== durationFrames)) {
      invalidRenderPlan("Every video track must have one common positive duration", { trackIndex });
    }
    durationFrames ??= clipDuration;
    const asset = state.assets.find((item) => item.id === directClip.source.assetId);
    if (asset === undefined || !ratesMatch(sequence.rate, asset.probe.averageFrameRate)) {
      invalidRenderPlan("Every clip asset must resolve and match the sequence rate", {
        trackIndex,
      });
    }
    const sourceDuration = microsecondsToSourceFrames(
      asset.probe.durationMicroseconds,
      sequence.rate,
    );
    if (directClip.sourceOut.value > sourceDuration.value) {
      invalidRenderPlan("A clip source range exceeds its probed asset duration", { trackIndex });
    }
    return { track, clip: directClip, asset };
  });
  if (durationFrames === undefined) invalidRenderPlan("A render requires a duration");

  return { descriptor: descriptor.data, sequence, clips, durationFrames };
}

/** Returns whether the active V2 composition exactly matches the compiler's supported shape. */
export function getActiveSequenceRenderEligibility(
  revision: unknown,
): ActiveSequenceRenderEligibility {
  try {
    validateActiveSequenceRevision(revision);
    return { eligible: true };
  } catch (error) {
    return {
      eligible: false,
      reason:
        error instanceof VideoDomainError
          ? error.message
          : "The active composition cannot be exported",
    };
  }
}

/** Compiles all canonical video tracks in the active V2 sequence into one deterministic plan. */
export function compileActiveSequenceRenderPlan(
  input: CompileActiveSequenceRenderPlanInput,
): Readonly<RenderPlanV2> {
  if (typeof input !== "object" || input === null) {
    invalidRenderPlan("Render compiler input must be an object");
  }
  try {
    const {
      descriptor,
      sequence,
      clips: validatedClips,
      durationFrames,
    } = validateActiveSequenceRevision(input.revision);
    const clips = validatedClips.map(({ track, clip, asset }) => {
      const inputPath = input.inputPathsByAssetId?.[asset.id];
      if (typeof inputPath !== "string") {
        invalidRenderPlan("Every canonical track asset requires an input path", {
          assetId: asset.id,
        });
      }
      return { track, clip, asset, inputPath };
    });

    const duration = toBoundarySeconds(createRationalTime(durationFrames, sequence.rate));
    const inputPathsByAssetId = Object.fromEntries(
      [
        ...new Map(clips.map(({ asset, inputPath }) => [asset.id, inputPath] as const)).entries(),
      ].sort(([left], [right]) => left.localeCompare(right)),
    );
    const videoInputs = clips.map(({ track, clip, asset, inputPath }) => ({
      assetId: asset.id,
      path: inputPath,
      sourceInMicroseconds: rationalTimeToMicroseconds(clip.sourceIn, "nearestTiesAwayFromZero"),
      positionXPermille: clip.transform.positionXPermille,
      positionYPermille: clip.transform.positionYPermille,
      scaleXPermille: clip.transform.scaleXPermille,
      scaleYPermille: clip.transform.scaleYPermille,
      rotationMilliDegrees: clip.transform.rotationMilliDegrees,
      opacityPermille: clip.transform.opacityPermille,
      hidden: isTrackHidden(track),
      muted: isTrackMuted(track),
      hasAudio: asset.probe.audio !== null,
    }));
    const captions = sequence.tracks.flatMap((track) =>
      track.kind === "caption" && !isTrackHidden(track)
        ? track.captions.map((caption) => ({
            trackId: track.id,
            captionId: caption.id,
            startMicroseconds: rationalTimeToMicroseconds(caption.start, "nearestTiesAwayFromZero"),
            endMicroseconds: rationalTimeToMicroseconds(caption.end, "nearestTiesAwayFromZero"),
            text: caption.text,
          }))
        : [],
    );
    const filterParts = [
      `color=c=black:s=${sequence.width}x${sequence.height}:r=${sequence.rate.numerator}/${sequence.rate.denominator}:d=${duration}[base]`,
    ];
    const visibleTrackIndices: number[] = [];
    const audibleTrackIndices: number[] = [];
    clips.forEach(({ track, clip, asset }, trackIndex) => {
      if (!isTrackHidden(track)) {
        filterParts.push(transformedClipFilter(trackIndex, clip, sequence));
        visibleTrackIndices.push(trackIndex);
      }
      if (!isTrackMuted(track) && asset.probe.audio !== null) {
        filterParts.push(`[${trackIndex}:a:0]asetpts=PTS-STARTPTS[a${trackIndex}]`);
        audibleTrackIndices.push(trackIndex);
      }
    });

    let baseLabel = "base";
    [...visibleTrackIndices].reverse().forEach((trackIndex, stackIndex) => {
      const outputLabel = `stack${stackIndex}`;
      const transform = clips[trackIndex]!.clip.transform;
      filterParts.push(
        `[${baseLabel}][v${trackIndex}]${transformedOverlayFilter(transform)}[${outputLabel}]`,
      );
      baseLabel = outputLabel;
    });
    captions.forEach((caption, captionIndex) => {
      const outputLabel = `caption${captionIndex}`;
      filterParts.push(`[${baseLabel}]${captionDrawtextFilter(caption)}[${outputLabel}]`);
      baseLabel = outputLabel;
    });
    filterParts.push(`[${baseLabel}]null[vout]`);

    if (audibleTrackIndices.length === 1) {
      filterParts.push(`[a${audibleTrackIndices[0]}]anull[aout]`);
    } else if (audibleTrackIndices.length > 1) {
      filterParts.push(
        `${audibleTrackIndices.map((index) => `[a${index}]`).join("")}amix=inputs=${audibleTrackIndices.length}:duration=longest:normalize=0[aout]`,
      );
    }

    const argv = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "warning",
      "-progress",
      "pipe:1",
      "-nostats",
      ...clips.flatMap(({ clip, inputPath }) => [
        "-ss",
        toBoundarySeconds(clip.sourceIn),
        "-t",
        duration,
        "-i",
        inputPath,
      ]),
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[vout]",
      ...(audibleTrackIndices.length > 0 ? ["-map", "[aout]"] : ["-an"]),
      "-t",
      duration,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      ...(audibleTrackIndices.length > 0 ? ["-c:a", "aac", "-ar", "48000"] : []),
      "-movflags",
      "+faststart",
      input.outputPath,
    ];
    const result = renderPlanV2Schema.safeParse({
      schemaVersion: 2,
      planId: input.planId,
      revisionId: descriptor.id,
      executable: "ffmpeg",
      inputPathsByAssetId,
      videoInputs,
      captions,
      outputPath: input.outputPath,
      expected: {
        durationFrames,
        rate: sequence.rate,
        width: sequence.width,
        height: sequence.height,
        audio: audibleTrackIndices.length > 0,
      },
      argv,
    });
    if (!result.success) {
      invalidRenderPlan("Compiled multi-track render plan failed strict validation", {
        issues: result.error.issues,
      });
    }
    return deepFreeze(result.data);
  } catch (error) {
    if (error instanceof VideoDomainError && error.code === "invalid_render_plan") throw error;
    invalidRenderPlan("Multi-track render plan compilation failed", {
      cause: error instanceof VideoDomainError ? error.code : "unknown",
    });
  }
}
