/**
 * Pure TypeScript reference for the graphics clip commands. Rust `project/commands.rs` is the
 * executor; this mirror backs the desktop test service and the shared contract fixture
 * (`fixtures/graphics-commands.json`), so both languages are held to the same results.
 */
import { type GraphicsClip, graphicsClipSchema } from "./project-graphics.js";
import type { ProjectCommandV2 } from "./project-commands-v2.js";
import {
  isTrackLocked,
  type ProjectTrack,
  type VideoProjectStateV2,
} from "./project-v2-entities.js";

export type GraphicsCommand = Extract<
  ProjectCommandV2,
  {
    type: "AddGraphicsClip" | "RemoveGraphicsClip" | "MoveGraphicsClip" | "SetGraphicsClipLayers";
  }
>;

export type GraphicsCommandResult =
  | { readonly ok: true; readonly state: VideoProjectStateV2; readonly inverse: GraphicsCommand }
  | { readonly ok: false; readonly category: string };

export function isGraphicsCommand(command: ProjectCommandV2): command is GraphicsCommand {
  return (
    command.type === "AddGraphicsClip" ||
    command.type === "RemoveGraphicsClip" ||
    command.type === "MoveGraphicsClip" ||
    command.type === "SetGraphicsClipLayers"
  );
}

type GraphicsTrack = Extract<ProjectTrack, { kind: "graphics" }>;

function graphicsTrackIn(
  state: VideoProjectStateV2,
  sequenceId: string,
  trackId: string,
): GraphicsTrack | string {
  const sequence = state.sequences.find(({ id }) => id === sequenceId);
  if (sequence === undefined) return "unknown_sequence";
  const track = sequence.tracks.find(({ id }) => id === trackId);
  if (track === undefined) return "unknown_track";
  if (isTrackLocked(track)) return "track_locked";
  if (track.kind !== "graphics") return "non_graphics_track";
  return track;
}

/** Same rule as Rust `inverse_id`: the inverse id is derived from the forward command id. */
export type InverseId = (commandId: string, ordinal: number) => string;

function validClip(clip: GraphicsClip): boolean {
  return graphicsClipSchema.safeParse(clip).success;
}

/**
 * Applies one graphics command to a copy of `state`. Whole-project checks (ordering, overlap,
 * sequence rate, image assets) are the caller's job, as in Rust's `validate_state`.
 */
export function applyGraphicsCommand(
  state: VideoProjectStateV2,
  command: GraphicsCommand,
  inverseId: InverseId,
): GraphicsCommandResult {
  const next = structuredClone(state);
  const track = graphicsTrackIn(next, command.sequenceId, command.trackId);
  if (typeof track === "string") return { ok: false, category: track };
  const target = { sequenceId: command.sequenceId, trackId: command.trackId };
  const commandId = inverseId(command.commandId, 0);

  switch (command.type) {
    case "AddGraphicsClip": {
      if (!validClip(command.graphicsClip)) return { ok: false, category: "graphics_clip" };
      if (track.graphicsClips.some(({ id }) => id === command.graphicsClip.id))
        return { ok: false, category: "duplicate_graphics_clip" };
      if (command.index !== undefined && command.index > track.graphicsClips.length)
        return { ok: false, category: "graphics_clip_index" };
      if (command.index === undefined) {
        track.graphicsClips.push(structuredClone(command.graphicsClip));
        track.graphicsClips.sort(
          (left, right) => left.timelineStart.value - right.timelineStart.value,
        );
      } else {
        track.graphicsClips.splice(command.index, 0, structuredClone(command.graphicsClip));
      }
      return {
        ok: true,
        state: next,
        inverse: {
          type: "RemoveGraphicsClip",
          commandId,
          ...target,
          graphicsClipId: command.graphicsClip.id,
        },
      };
    }
    case "RemoveGraphicsClip": {
      const index = track.graphicsClips.findIndex(({ id }) => id === command.graphicsClipId);
      const [removed] = index < 0 ? [] : track.graphicsClips.splice(index, 1);
      if (removed === undefined) return { ok: false, category: "unknown_graphics_clip" };
      return {
        ok: true,
        state: next,
        inverse: { type: "AddGraphicsClip", commandId, ...target, index, graphicsClip: removed },
      };
    }
    case "MoveGraphicsClip": {
      const clip = track.graphicsClips.find(({ id }) => id === command.graphicsClipId);
      if (clip === undefined) return { ok: false, category: "unknown_graphics_clip" };
      const inverse: GraphicsCommand = {
        type: "MoveGraphicsClip",
        commandId,
        ...target,
        graphicsClipId: clip.id,
        timelineStart: clip.timelineStart,
        duration: clip.duration,
      };
      clip.timelineStart = structuredClone(command.timelineStart);
      clip.duration = structuredClone(command.duration);
      if (!validClip(clip)) return { ok: false, category: "graphics_clip" };
      track.graphicsClips.sort(
        (left, right) => left.timelineStart.value - right.timelineStart.value,
      );
      return { ok: true, state: next, inverse };
    }
    case "SetGraphicsClipLayers": {
      const clip = track.graphicsClips.find(({ id }) => id === command.graphicsClipId);
      if (clip === undefined) return { ok: false, category: "unknown_graphics_clip" };
      const inverse: GraphicsCommand = {
        type: "SetGraphicsClipLayers",
        commandId,
        ...target,
        graphicsClipId: clip.id,
        fontKey: clip.fontKey,
        layers: clip.layers,
      };
      clip.fontKey = command.fontKey;
      clip.layers = structuredClone(command.layers);
      if (!validClip(clip)) return { ok: false, category: "graphics_clip" };
      return { ok: true, state: next, inverse };
    }
  }
}

/**
 * Whole-state graphics rules Rust enforces in `validate_state` after a group: clips on each
 * graphics track use the sequence rate and are ordered without overlap. Returns the category.
 */
export function graphicsStateViolation(state: VideoProjectStateV2): string | null {
  for (const sequence of state.sequences) {
    for (const track of sequence.tracks) {
      if (track.kind !== "graphics") continue;
      let previousEnd = 0;
      for (const clip of track.graphicsClips) {
        if (
          clip.timelineStart.rateNumerator !== sequence.rate.numerator ||
          clip.timelineStart.rateDenominator !== sequence.rate.denominator
        )
          return "graphics_clip_rate";
        if (clip.timelineStart.value < previousEnd) return "graphics_clip_overlap";
        previousEnd = clip.timelineStart.value + clip.duration.value;
      }
    }
  }
  return null;
}

/** Applies a group like Rust `apply_group`: in order, inverses in reverse, then state checks. */
export function applyGraphicsGroup(
  state: VideoProjectStateV2,
  commands: readonly GraphicsCommand[],
  inverseId: InverseId,
):
  | { readonly ok: true; readonly state: VideoProjectStateV2; readonly inverse: GraphicsCommand[] }
  | {
      readonly ok: false;
      readonly code: "invalid_command" | "invalid_project";
      readonly category: string;
    } {
  let current = state;
  const inverse: GraphicsCommand[] = [];
  for (const command of commands) {
    const result = applyGraphicsCommand(current, command, inverseId);
    if (!result.ok) return { ok: false, code: "invalid_command", category: result.category };
    current = result.state;
    inverse.unshift(result.inverse);
  }
  const violation = graphicsStateViolation(current);
  // Like Rust validate_state, whole-state rules fail as invalid_project.
  return violation === null
    ? { ok: true, state: current, inverse }
    : { ok: false, code: "invalid_project", category: violation };
}
