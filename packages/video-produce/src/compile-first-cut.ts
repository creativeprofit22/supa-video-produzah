import {
  type CommandGroupRequest,
  type ProjectCaption,
  type ProjectClip,
  type ProjectCommandV2,
  type ProjectMarker,
  type RationalRate,
  type VideoAsset,
  type VideoSequenceV2,
  commandGroupRequestSchema,
  createRationalTime,
  microsecondsToSourceFrames,
} from "@supa-video/contracts";
import { derivedUuid } from "@supa-video/project";

import type { RankedCandidate } from "./asset-candidate.js";
import { canonicalJson } from "./canonical.js";
import type { BeatProposal, FallbackGraphicSpec, FirstCutProposal } from "./first-cut-proposal.js";
import { beatLabel } from "./narrative-beat.js";
import type { Result } from "./result.js";

/*
 * Compiles a reviewed first-cut proposal into one command group. The group only
 * adds new tracks and markers, so existing clips are never touched and a single
 * undo removes the whole first cut. Tracks are inserted pre-populated to keep
 * large cuts within the command-group size limit.
 */

export const FIRST_CUT_VIDEO_TRACK_NAME = "First cut";
export const FIRST_CUT_TITLE_TRACK_NAME = "First cut titles";

export type BeatOverride =
  { readonly kind: "alternative"; readonly assetId: string } | { readonly kind: "unresolved" };

export type BeatOverrides = Readonly<Record<string, BeatOverride>>;

export type EffectiveBeat =
  | { readonly kind: "footage"; readonly beat: BeatProposal; readonly selected: RankedCandidate }
  | { readonly kind: "a-roll"; readonly beat: BeatProposal }
  | {
      readonly kind: "graphic";
      readonly beat: BeatProposal;
      readonly fallback: FallbackGraphicSpec;
    }
  | {
      readonly kind: "unresolved";
      readonly beat: BeatProposal;
      readonly fallback: FallbackGraphicSpec;
    };

export type CompileFirstCutError =
  | { readonly code: "stale-proposal" }
  | { readonly code: "unknown-sequence" }
  | { readonly code: "unknown-alternative"; readonly beatId: string }
  | { readonly code: "missing-asset"; readonly assetId: string }
  | { readonly code: "candidate-too-short"; readonly beatId: string }
  | { readonly code: "nothing-to-apply" }
  | { readonly code: "too-many-commands"; readonly count: number }
  | { readonly code: "invalid-group"; readonly message: string };

export interface CompileFirstCutInput {
  readonly proposal: FirstCutProposal;
  readonly overrides: BeatOverrides;
  readonly projectId: string;
  readonly revision: number;
  readonly sequence: VideoSequenceV2;
  readonly assets: readonly VideoAsset[];
}

export interface CompiledFirstCut {
  readonly request: CommandGroupRequest;
  readonly videoTrackId: string | null;
  readonly titleTrackId: string | null;
  readonly clipCount: number;
  readonly captionCount: number;
  readonly markerCount: number;
}

const MAX_GROUP_COMMANDS = 100;

/** Applies user overrides; unknown alternatives are reported, not ignored. */
export function effectiveBeats(
  proposal: FirstCutProposal,
  overrides: BeatOverrides,
): Result<EffectiveBeat[], CompileFirstCutError> {
  const beats: EffectiveBeat[] = [];
  for (const item of proposal.beats) {
    const override = overrides[item.beat.id];
    const note: FallbackGraphicSpec = {
      template: "unresolved-note",
      text: `Footage needed: ${item.beat.text}`,
      intentKind: item.beat.intent.kind,
    };
    if (override?.kind === "unresolved") {
      beats.push({
        kind: "unresolved",
        beat: item,
        fallback: item.coverage.kind === "unresolved" ? item.coverage.fallback : note,
      });
      continue;
    }
    if (override?.kind === "alternative") {
      const pool =
        item.coverage.kind === "footage"
          ? [item.coverage.selected, ...item.alternatives]
          : item.alternatives;
      const selected = pool.find((candidate) => candidate.candidate.assetId === override.assetId);
      if (selected === undefined) {
        return { ok: false, error: { code: "unknown-alternative", beatId: item.beat.id } };
      }
      beats.push({ kind: "footage", beat: item, selected });
      continue;
    }
    switch (item.coverage.kind) {
      case "footage":
        beats.push({ kind: "footage", beat: item, selected: item.coverage.selected });
        break;
      case "a-roll":
        beats.push({ kind: "a-roll", beat: item });
        break;
      case "graphic":
        beats.push({ kind: "graphic", beat: item, fallback: item.coverage.fallback });
        break;
      case "unresolved":
        beats.push({ kind: "unresolved", beat: item, fallback: item.coverage.fallback });
        break;
    }
  }
  return { ok: true, value: beats };
}

function frames(microseconds: number, rate: RationalRate): number {
  return microsecondsToSourceFrames(microseconds, rate).value;
}

export async function compileFirstCut(
  input: CompileFirstCutInput,
): Promise<Result<CompiledFirstCut, CompileFirstCutError>> {
  const { proposal, sequence } = input;
  if (input.projectId !== proposal.projectId || input.revision !== proposal.projectRevision) {
    return { ok: false, error: { code: "stale-proposal" } };
  }
  const effective = effectiveBeats(proposal, input.overrides);
  if (!effective.ok) return effective;
  const seed = new TextEncoder().encode(
    canonicalJson({
      proposalId: proposal.proposalId,
      overrides: input.overrides,
      sequenceId: sequence.id,
    }),
  );
  const id = (role: string): Promise<string> => derivedUuid(seed, `first-cut:${role}`);
  const rate = sequence.rate;
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));

  const clips: ProjectClip[] = [];
  const captions: ProjectCaption[] = [];
  const markers: ProjectMarker[] = [];
  for (const item of effective.value) {
    const beat = item.beat.beat;
    const startFrame = frames(beat.startUs, rate);
    const endFrame = frames(beat.endUs, rate);
    if (endFrame <= startFrame) continue;
    if (item.kind === "footage") {
      const candidate = item.selected.candidate;
      const asset = assets.get(candidate.assetId);
      if (asset === undefined) {
        return { ok: false, error: { code: "missing-asset", assetId: candidate.assetId } };
      }
      const length = endFrame - startFrame;
      const available = frames(asset.probe.durationMicroseconds, rate);
      const sourceIn = Math.min(frames(candidate.sourceInUs, rate), available - length);
      if (sourceIn < 0)
        return { ok: false, error: { code: "candidate-too-short", beatId: beat.id } };
      clips.push({
        id: await id(`clip:${beat.id}`),
        source: { kind: "asset", assetId: candidate.assetId },
        timelineStart: createRationalTime(startFrame, rate),
        sourceIn: createRationalTime(sourceIn, rate),
        sourceOut: createRationalTime(sourceIn + length, rate),
        transform: {
          positionXPermille: 0,
          positionYPermille: 0,
          scaleXPermille: 1_000,
          scaleYPermille: 1_000,
          rotationMilliDegrees: 0,
          opacityPermille: 1_000,
        },
        gainMilliDecibels: 0,
      });
    } else if (item.kind === "graphic" || item.kind === "unresolved") {
      captions.push({
        id: await id(`caption:${beat.id}`),
        start: createRationalTime(startFrame, rate),
        end: createRationalTime(endFrame, rate),
        text: item.fallback.text,
        language: beat.language,
      });
      if (item.kind === "unresolved") {
        markers.push({
          id: await id(`marker:${beat.id}`),
          time: createRationalTime(startFrame, rate),
          label: `Unresolved · ${beatLabel(beat)}`,
          color: "orange",
        });
      }
    }
  }

  const commands: ProjectCommandV2[] = [];
  let trackIndex = sequence.tracks.length;
  const videoTrackId = clips.length > 0 ? await id("track:video") : null;
  if (videoTrackId !== null) {
    commands.push({
      type: "InsertTrack",
      commandId: await id("command:track:video"),
      sequenceId: sequence.id,
      index: trackIndex,
      track: { id: videoTrackId, name: FIRST_CUT_VIDEO_TRACK_NAME, kind: "video", clips },
    });
    trackIndex += 1;
  }
  const titleTrackId = captions.length > 0 ? await id("track:titles") : null;
  if (titleTrackId !== null) {
    commands.push({
      type: "InsertTrack",
      commandId: await id("command:track:titles"),
      sequenceId: sequence.id,
      index: trackIndex,
      track: { id: titleTrackId, name: FIRST_CUT_TITLE_TRACK_NAME, kind: "caption", captions },
    });
  }
  for (const [index, marker] of markers.entries()) {
    commands.push({
      type: "AddMarker",
      commandId: await id(`command:marker:${index}`),
      sequenceId: sequence.id,
      index: sequence.markers.length + index,
      marker,
    });
  }
  if (commands.length === 0) return { ok: false, error: { code: "nothing-to-apply" } };
  if (commands.length > MAX_GROUP_COMMANDS) {
    return { ok: false, error: { code: "too-many-commands", count: commands.length } };
  }
  const request = commandGroupRequestSchema.safeParse({
    groupId: await id("group"),
    projectId: input.projectId,
    baseRevision: input.revision,
    commands,
  });
  if (!request.success) {
    const message = request.error.issues[0]?.message ?? "Invalid command group";
    return { ok: false, error: { code: "invalid-group", message } };
  }
  return {
    ok: true,
    value: {
      request: request.data,
      videoTrackId,
      titleTrackId,
      clipCount: clips.length,
      captionCount: captions.length,
      markerCount: markers.length,
    },
  };
}
