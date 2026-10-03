/**
 * Graphics compiler: turns an agent graphics description (agent- or rule-written text and timing) plus
 * already-resolved style defaults into a graphics proposal of full graphics clips. Nothing is
 * executed; the proposal still needs review. Recipe lookup lives in @supa-video/produce so this
 * package never depends on it (docs/adr/0005-agent-graphics-proposals.md).
 */
import {
  AGENT_GRAPHICS_MAX_TEXT_LENGTH,
  type AgentGraphicsCardRole,
  type AgentGraphicsDescription,
  type AgentGraphicsItem,
  agentGraphicsDescriptionSchema,
  clipTimelineDuration,
  type GraphicsClip,
  type GraphicsKeyframeTrack,
  type GraphicsLayer,
  type GraphicsProjectTrack,
  type GraphicsProposalItem,
  type GraphicsProposalWire,
  type GraphicsTextSplit,
  graphicsProposalV1WireSchema,
  isTrackHidden,
  isTrackLocked,
  MAX_PROPOSAL_BYTES,
  MAX_PROPOSAL_COMMAND_GROUP_BYTES,
  type ProjectCommandV2,
  type ProjectRevisionDescriptorV2,
  type RenderCaptionFontKey,
  type VideoSequenceV2,
} from "@supa-video/contracts";

import {
  type MotionPresetName,
  type MotionPresetResult,
  staggeredEntrance,
  textReveal,
} from "./motion-presets.js";
import type { Result } from "./proposal-producer.js";

/** Plain style values a recipe resolves to; the compiler never sees recipe ids. */
export interface GraphicsStyleDefaults {
  readonly fontKey: RenderCaptionFontKey;
  readonly palette: { readonly fg: string; readonly bg: string; readonly accent: string };
  readonly presetByCardRole: Readonly<Record<AgentGraphicsCardRole, MotionPresetName>>;
  readonly captionReveal: GraphicsTextSplit | null;
  readonly defaultDurationUs: number;
  /** Most graphics on screen at once, counting existing clips on other graphics tracks. */
  readonly maxOverlapping: number;
}

export interface AgentGraphicsIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type AgentGraphicsError =
  | { readonly kind: "invalid_description"; readonly issues: readonly AgentGraphicsIssue[] }
  | {
      readonly kind: "out_of_sequence";
      readonly itemId: string;
      readonly atUs: number;
      readonly sequenceEndUs: number;
    }
  | {
      readonly kind: "overlap_limit";
      readonly itemId: string;
      readonly conflictsWith: string;
      readonly maxOverlapping: number;
    }
  | {
      readonly kind: "text_too_long";
      readonly itemId: string;
      readonly length: number;
      readonly maxLength: number;
    }
  | {
      /** The compiled command group or whole proposal exceeds the native submit byte limit. */
      readonly kind: "too_large";
      readonly bytes: number;
      readonly maxBytes: number;
    };

export interface CompileAgentGraphicsInput {
  /** Untrusted: parsed here with the strict description schema. */
  readonly description: unknown;
  readonly defaults: GraphicsStyleDefaults;
  readonly projectId: string;
  readonly revision: ProjectRevisionDescriptorV2;
  readonly sequence: VideoSequenceV2;
  readonly producer: GraphicsProposalWire["producer"];
  /** Deterministic id source (proposal, group, optional track, then per item clip + command). */
  readonly newId: () => string;
}

export const GRAPHICS_TRACK_NAME = "Graphics";
const STAGGER_US = 80_000;
/**
 * The byte checks below measure `JSON.stringify`, which can differ slightly from the native
 * canonical bytes (native re-serializes the typed command group). The bound is approximate, so
 * keep 1/32 of each limit as headroom.
 */
const BYTE_HEADROOM_DIVISOR = 32;
const TEXT_ADVANCE_EM = 0.55;
const ROLE_LABEL: Readonly<Record<AgentGraphicsItem["kind"] | AgentGraphicsCardRole, string>> = {
  card: "Card",
  caption: "Caption",
  title: "Title",
  lowerThird: "Lower third",
  endCard: "End card",
};

interface FrameSpan {
  readonly start: number;
  readonly end: number;
}

function usToFrames(us: number, sequence: VideoSequenceV2, round: "floor" | "ceil"): number {
  const exact = (us * sequence.rate.numerator) / (1_000_000 * sequence.rate.denominator);
  return round === "floor" ? Math.floor(exact + 1e-9) : Math.ceil(exact - 1e-9);
}

function framesToUs(frames: number, sequence: VideoSequenceV2): number {
  return Math.round((frames * 1_000_000 * sequence.rate.denominator) / sequence.rate.numerator);
}

/** End of the last media clip, in sequence frames; graphics never extend a sequence. */
export function sequenceEndFrames(sequence: VideoSequenceV2): number {
  let end = 0;
  for (const track of sequence.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    for (const clip of track.clips) {
      const duration = clipTimelineDuration(
        { in: clip.sourceIn, out: clip.sourceOut },
        sequence.rate,
        clip.speed,
      );
      end = Math.max(end, clip.timelineStart.value + duration.value);
    }
  }
  return end;
}

const still = (value: number): GraphicsKeyframeTrack => [{ timeMicroseconds: 0, value }];

function placed(x: number, y: number) {
  return {
    x: still(Math.round(x)),
    y: still(Math.round(y)),
    scale: still(1),
    rotation: still(0),
    opacity: still(1),
  };
}

/** Largest font (≤ `preferred`) whose estimated line width fits `maxWidth`. */
function fittedFontSize(text: string, preferred: number, maxWidth: number): number {
  const characters = Math.max(1, Array.from(text).length);
  return Math.max(1, Math.min(preferred, Math.floor(maxWidth / (characters * TEXT_ADVANCE_EM))));
}

function textWidth(text: string, fontSize: number): number {
  return Array.from(text).length * TEXT_ADVANCE_EM * fontSize;
}

function cardLayers(
  role: AgentGraphicsCardRole,
  text: string,
  colour: string,
  defaults: GraphicsStyleDefaults,
  { width, height }: VideoSequenceV2,
): GraphicsLayer[] {
  const { bg, accent } = defaults.palette;
  switch (role) {
    case "title": {
      const fontSize = fittedFontSize(text, Math.round(height * 0.09), width * 0.84);
      const textX = (width - textWidth(text, fontSize)) / 2;
      const textY = (height - fontSize) / 2;
      const barWidth = Math.max(8, Math.round(width * 0.12));
      return [
        {
          kind: "text",
          text,
          fontSize,
          fill: colour,
          ...placed(textX, textY),
        },
        {
          kind: "rect",
          width: barWidth,
          height: Math.max(4, Math.round(fontSize * 0.12)),
          cornerRadius: 0,
          fill: accent,
          ...placed((width - barWidth) / 2, textY + fontSize * 1.25),
        },
      ];
    }
    case "lowerThird": {
      const fontSize = fittedFontSize(text, Math.round(height * 0.05), width * 0.7);
      const padding = Math.round(fontSize * 0.5);
      const boxWidth = Math.min(width * 0.9, textWidth(text, fontSize) + padding * 2);
      const boxHeight = Math.round(fontSize * 1.6);
      const boxX = width * 0.05;
      const boxY = height * 0.78;
      const stripe = Math.max(4, Math.round(fontSize * 0.15));
      return [
        {
          kind: "rect",
          width: Math.round(boxWidth),
          height: boxHeight,
          cornerRadius: 0,
          fill: bg,
          ...placed(boxX, boxY),
        },
        {
          kind: "rect",
          width: stripe,
          height: boxHeight,
          cornerRadius: 0,
          fill: accent,
          ...placed(boxX, boxY),
        },
        {
          kind: "text",
          text,
          fontSize,
          fill: colour,
          ...placed(boxX + padding, boxY + (boxHeight - fontSize) / 2),
        },
      ];
    }
    case "endCard": {
      const fontSize = fittedFontSize(text, Math.round(height * 0.07), width * 0.8);
      const bandHeight = Math.round(fontSize * 2.4);
      const bandY = (height - bandHeight) / 2;
      return [
        {
          kind: "rect",
          width,
          height: bandHeight,
          cornerRadius: 0,
          fill: bg,
          ...placed(0, bandY),
        },
        {
          kind: "text",
          text,
          fontSize,
          fill: colour,
          ...placed((width - textWidth(text, fontSize)) / 2, bandY + (bandHeight - fontSize) / 2),
        },
      ];
    }
  }
}

function captionLayers(
  text: string,
  colour: string,
  { width, height }: VideoSequenceV2,
): GraphicsLayer[] {
  const fontSize = fittedFontSize(text, Math.round(height * 0.055), width * 0.9);
  return [
    {
      kind: "text",
      text,
      fontSize,
      fill: colour,
      ...placed((width - textWidth(text, fontSize)) / 2, height * 0.66),
    },
  ];
}

function animate(
  item: AgentGraphicsItem,
  layers: GraphicsLayer[],
  defaults: GraphicsStyleDefaults,
  clipDurationMicroseconds: number,
): MotionPresetResult<GraphicsLayer[]> {
  if (item.kind === "card")
    return staggeredEntrance(layers, item.preset ?? defaults.presetByCardRole[item.role], {
      clipDurationMicroseconds,
      staggerMicroseconds: STAGGER_US,
    });
  const split = item.reveal ?? defaults.captionReveal;
  if (split === null) return { ok: true, value: layers };
  const [layer] = layers;
  if (layer === undefined) return { ok: true, value: layers };
  const revealed = textReveal(layer, { clipDurationMicroseconds, split });
  return revealed.ok ? { ok: true, value: [revealed.value] } : revealed;
}

function itemLabel(item: AgentGraphicsItem): string {
  const role = item.kind === "card" ? ROLE_LABEL[item.role] : ROLE_LABEL.caption;
  return `${role} · ${item.text}`;
}

function overlaps(left: FrameSpan, right: FrameSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function clipSpan(clip: GraphicsClip): FrameSpan {
  return { start: clip.timelineStart.value, end: clip.timelineStart.value + clip.duration.value };
}

/** The first graphics track that is neither locked nor hidden (export skips hidden tracks). */
function targetTrack(sequence: VideoSequenceV2): GraphicsProjectTrack | undefined {
  return sequence.tracks.find(
    (track): track is GraphicsProjectTrack =>
      track.kind === "graphics" && !isTrackLocked(track) && !isTrackHidden(track),
  );
}

interface PlannedItem {
  readonly item: AgentGraphicsItem;
  readonly span: FrameSpan;
}

function planItems(
  description: AgentGraphicsDescription,
  input: CompileAgentGraphicsInput,
  track: GraphicsProjectTrack | undefined,
): Result<PlannedItem[], AgentGraphicsError> {
  const { sequence, defaults } = input;
  const endFrames = sequenceEndFrames(sequence);
  const sequenceEndUs = framesToUs(endFrames, sequence);
  const ordered = [...description.items].sort(
    (left, right) => left.atUs - right.atUs || (left.id < right.id ? -1 : 1),
  );
  const planned: PlannedItem[] = [];
  for (const item of ordered) {
    const length = Array.from(item.text).length;
    if (length > AGENT_GRAPHICS_MAX_TEXT_LENGTH)
      return {
        ok: false,
        error: {
          kind: "text_too_long",
          itemId: item.id,
          length,
          maxLength: AGENT_GRAPHICS_MAX_TEXT_LENGTH,
        },
      };
    const start = usToFrames(item.atUs, sequence, "floor");
    if (start >= endFrames)
      return {
        ok: false,
        error: { kind: "out_of_sequence", itemId: item.id, atUs: item.atUs, sequenceEndUs },
      };
    const durationUs = item.durationUs ?? defaults.defaultDurationUs;
    const end = Math.min(
      endFrames,
      Math.max(start + 1, usToFrames(item.atUs + durationUs, sequence, "ceil")),
    );
    planned.push({ item, span: { start, end } });
  }
  const existingOnTrack = (track?.graphicsClips ?? []).map((clip) => ({
    id: clip.id,
    span: clipSpan(clip),
  }));
  const otherTracks = sequence.tracks.flatMap((other) =>
    other.kind === "graphics" && other.id !== track?.id && !isTrackHidden(other)
      ? other.graphicsClips.map((clip) => ({ id: clip.id, span: clipSpan(clip) }))
      : [],
  );
  for (const [index, { item, span }] of planned.entries()) {
    const previous = planned[index - 1];
    const sameTrack = [
      ...(previous === undefined ? [] : [{ id: previous.item.id, span: previous.span }]),
      ...existingOnTrack,
    ].find((other) => overlaps(span, other.span));
    const stacked = otherTracks.filter((other) => overlaps(span, other.span));
    const limitHit = stacked.length + 1 > defaults.maxOverlapping;
    const conflict = sameTrack ?? (limitHit ? stacked[0] : undefined);
    if (conflict !== undefined)
      return {
        ok: false,
        error: {
          kind: "overlap_limit",
          itemId: item.id,
          conflictsWith: conflict.id,
          maxOverlapping: defaults.maxOverlapping,
        },
      };
  }
  return { ok: true, value: planned };
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function byteBudget(limit: number): number {
  return limit - Math.ceil(limit / BYTE_HEADROOM_DIVISOR);
}

/** The first byte limit the proposal breaks, checked against the native submit limits. */
function sizeError(proposal: GraphicsProposalWire): AgentGraphicsError | undefined {
  const checks = [
    { value: proposal.commandGroup, limit: MAX_PROPOSAL_COMMAND_GROUP_BYTES },
    { value: proposal, limit: MAX_PROPOSAL_BYTES },
  ];
  for (const { value, limit } of checks) {
    const bytes = jsonBytes(value);
    const maxBytes = byteBudget(limit);
    if (bytes > maxBytes) return { kind: "too_large", bytes, maxBytes };
  }
  return undefined;
}

function invalid(issues: readonly AgentGraphicsIssue[]): Result<never, AgentGraphicsError> {
  return { ok: false, error: { kind: "invalid_description", issues } };
}

/** Compiles a description into a reviewable graphics proposal; deterministic for a given `newId`. */
export function compileAgentGraphics(
  input: CompileAgentGraphicsInput,
): Result<GraphicsProposalWire, AgentGraphicsError> {
  const parsed = agentGraphicsDescriptionSchema.safeParse(input.description);
  if (!parsed.success)
    return invalid(
      parsed.error.issues.map(({ path, message }) => ({
        path: path.map((part) => (typeof part === "symbol" ? String(part) : part)),
        message,
      })),
    );
  const description = parsed.data;
  const { sequence, defaults, newId } = input;
  const existing = targetTrack(sequence);
  const plan = planItems(description, input, existing);
  if (!plan.ok) return plan;

  const proposalId = newId();
  const groupId = newId();
  const commands: ProjectCommandV2[] = [];
  let trackId: string;
  if (existing === undefined) {
    trackId = newId();
    commands.push({
      type: "InsertTrack",
      commandId: newId(),
      sequenceId: sequence.id,
      index: 0,
      track: { id: trackId, name: GRAPHICS_TRACK_NAME, kind: "graphics", graphicsClips: [] },
    });
  } else {
    trackId = existing.id;
  }

  const items: GraphicsProposalItem[] = [];
  for (const { item, span } of plan.value) {
    const colour = item.colour ?? defaults.palette.fg;
    const base =
      item.kind === "card"
        ? cardLayers(item.role, item.text, colour, defaults, sequence)
        : captionLayers(item.text, colour, sequence);
    const clipDurationMicroseconds = Math.max(
      1,
      framesToUs(span.end, sequence) - framesToUs(span.start, sequence),
    );
    const layers = animate(item, base, defaults, clipDurationMicroseconds);
    if (!layers.ok)
      return invalid([
        {
          path: [
            "items",
            description.items.indexOf(item),
            item.kind === "card" ? "preset" : "reveal",
          ],
          message: layers.error.message,
        },
      ]);
    const rate = {
      rateNumerator: sequence.rate.numerator,
      rateDenominator: sequence.rate.denominator,
    };
    const graphicsClip: GraphicsClip = {
      graphicsVersion: 1,
      id: newId(),
      timelineStart: { value: span.start, ...rate },
      duration: { value: span.end - span.start, ...rate },
      fontKey: item.fontKey ?? defaults.fontKey,
      layers: layers.value,
    };
    commands.push({
      type: "AddGraphicsClip",
      commandId: newId(),
      sequenceId: sequence.id,
      trackId,
      graphicsClip,
    });
    items.push({ itemId: item.id, label: itemLabel(item), graphicsClipId: graphicsClip.id });
  }

  const proposal = graphicsProposalV1WireSchema.safeParse({
    schemaVersion: 1,
    proposalKind: "graphics",
    proposalId,
    projectId: input.projectId,
    projectRevision: input.revision,
    sequenceId: sequence.id,
    trackId,
    producer: input.producer,
    description,
    items,
    commandGroup: {
      groupId,
      projectId: input.projectId,
      baseRevision: input.revision.number,
      commands,
    },
  });
  if (!proposal.success)
    return invalid(
      proposal.error.issues.map(({ path, message }) => ({
        path: ["proposal", ...path.map((part) => (typeof part === "symbol" ? String(part) : part))],
        message,
      })),
    );
  const tooLarge = sizeError(proposal.data);
  if (tooLarge !== undefined) return { ok: false, error: tooLarge };
  return { ok: true, value: proposal.data };
}
