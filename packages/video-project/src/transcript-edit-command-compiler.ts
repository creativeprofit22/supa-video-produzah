import {
  type ProjectClip,
  type ProjectCommandV2,
  type ProjectProjection,
} from "@supa-video/contracts";
import type { TranscriptArtifactV1 } from "@supa-video/media";

import { compareStrings, time, transcriptError } from "./transcript-edit-mapping.js";

export interface TranscriptCommandDeletion {
  readonly clip: ProjectClip;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

class FramedSeedEncoder {
  readonly #parts: Uint8Array[] = [];

  string(value: string): void {
    const bytes = new TextEncoder().encode(value);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.byteLength, true);
    this.#parts.push(length, bytes);
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.#parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

function bytesToUuid(bytes: Uint8Array): string {
  const uuidBytes = bytes.slice(0, 16);
  uuidBytes[6] = ((uuidBytes[6] ?? 0) & 0x0f) | 0x40;
  uuidBytes[8] = ((uuidBytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(uuidBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function derivedUuid(seed: Uint8Array, role: string): Promise<string> {
  const encoder = new FramedSeedEncoder();
  encoder.string("supa-video/transcript-edit-id/v1");
  encoder.string(role);
  encoder.string(Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return bytesToUuid(await sha256(encoder.finish()));
}

export function proposalSeed(
  input: {
    readonly artifact: TranscriptArtifactV1;
    readonly sequenceId: string;
    readonly trackId: string;
  },
  projection: ProjectProjection,
  selectedOccurrenceIds: readonly string[],
): Uint8Array {
  const encoder = new FramedSeedEncoder();
  encoder.string("supa-video/transcript-edit-proposal/v1");
  encoder.string(input.artifact.identity.key);
  encoder.string(input.artifact.identity.sourceIdentity.digest);
  encoder.string(String(input.artifact.identity.sourceIdentity.byteLength));
  encoder.string(projection.projectId);
  encoder.string(JSON.stringify(projection.revision));
  encoder.string(input.sequenceId);
  encoder.string(input.trackId);
  for (const occurrence of selectedOccurrenceIds) encoder.string(occurrence);
  return encoder.finish();
}

type TranscriptProjectCommand = Extract<
  ProjectCommandV2,
  { type: "SplitClip" | "RippleDeleteClip" }
>;
type TranscriptCommandWithoutId = TranscriptProjectCommand extends infer Command
  ? Command extends ProjectCommandV2
    ? Omit<Command, "commandId">
    : never
  : never;

export interface CommandDraft {
  readonly role: string;
  readonly command: TranscriptCommandWithoutId;
  readonly rightClipRole?: string;
}

export function compileCommandDrafts(
  deletions: readonly TranscriptCommandDeletion[],
  sequenceId: string,
  trackId: string,
): readonly CommandDraft[] {
  const byClip = new Map<string, TranscriptCommandDeletion[]>();
  for (const deletion of deletions) {
    const ranges = byClip.get(deletion.clip.id) ?? [];
    ranges.push(deletion);
    byClip.set(deletion.clip.id, ranges);
  }
  const clips = [...byClip.values()].sort(
    (left, right) =>
      right[0]!.clip.timelineStart.value - left[0]!.clip.timelineStart.value ||
      compareStrings(right[0]!.clip.id, left[0]!.clip.id),
  );
  const drafts: CommandDraft[] = [];
  let ordinal = 0;
  for (const clipRanges of clips) {
    const clip = clipRanges[0]!.clip;
    let currentSourceOut = clip.sourceOut.value;
    for (const deletion of [...clipRanges].sort((a, b) => b.sourceStart - a.sourceStart)) {
      const prefix = `${ordinal++}:${clip.id}:${deletion.sourceStart}:${deletion.sourceEnd}`;
      if (deletion.sourceStart === clip.sourceIn.value) {
        if (deletion.sourceEnd < currentSourceOut) {
          drafts.push({
            role: `${prefix}:split-end`,
            rightClipRole: `${prefix}:kept-right`,
            command: {
              type: "SplitClip",
              sequenceId,
              trackId,
              clipId: clip.id,
              splitAt: time(deletion.sourceEnd, clip.sourceIn),
              rightClipId: "",
            },
          });
        }
        drafts.push({
          role: `${prefix}:ripple`,
          command: { type: "RippleDeleteClip", sequenceId, trackId, clipId: clip.id },
        });
        currentSourceOut = deletion.sourceStart;
        continue;
      }

      const deletedClipRole = `${prefix}:deleted-fragment`;
      drafts.push({
        role: `${prefix}:split-start`,
        rightClipRole: deletedClipRole,
        command: {
          type: "SplitClip",
          sequenceId,
          trackId,
          clipId: clip.id,
          splitAt: time(deletion.sourceStart, clip.sourceIn),
          rightClipId: "",
        },
      });
      if (deletion.sourceEnd < currentSourceOut) {
        drafts.push({
          role: `${prefix}:split-end`,
          rightClipRole: `${prefix}:kept-right`,
          command: {
            type: "SplitClip",
            sequenceId,
            trackId,
            clipId: "",
            splitAt: time(deletion.sourceEnd, clip.sourceIn),
            rightClipId: "",
          },
        });
      }
      drafts.push({
        role: `${prefix}:ripple`,
        command: { type: "RippleDeleteClip", sequenceId, trackId, clipId: "" },
        rightClipRole: deletedClipRole,
      });
      currentSourceOut = deletion.sourceStart;
    }
  }
  return drafts;
}

export async function materializeCommands(
  drafts: readonly CommandDraft[],
  seed: Uint8Array,
): Promise<readonly ProjectCommandV2[]> {
  const fragmentIds = new Map<string, string>();
  const fragmentId = async (role: string): Promise<string> => {
    const existing = fragmentIds.get(role);
    if (existing !== undefined) return existing;
    const id = await derivedUuid(seed, `fragment:${role}`);
    fragmentIds.set(role, id);
    return id;
  };
  const commands: ProjectCommandV2[] = [];
  for (const draft of drafts) {
    const commandId = await derivedUuid(seed, `command:${draft.role}`);
    if (draft.command.type === "SplitClip") {
      const rightClipId = await fragmentId(draft.rightClipRole!);
      const clipId =
        draft.command.clipId === ""
          ? await fragmentId(draft.role.replace(":split-end", ":deleted-fragment"))
          : draft.command.clipId;
      commands.push({ ...draft.command, commandId, clipId, rightClipId });
    } else if (draft.command.type === "RippleDeleteClip") {
      commands.push({
        ...draft.command,
        commandId,
        clipId:
          draft.command.clipId === ""
            ? await fragmentId(draft.rightClipRole!)
            : draft.command.clipId,
      });
    } else {
      throw transcriptError(
        "invalid_project",
        "Unexpected transcript command shape",
        "invalid_command_shape",
      );
    }
  }
  return commands;
}
