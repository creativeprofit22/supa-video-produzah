import { VideoDomainError, type ProjectProjection } from "@supa-video/contracts";
import type { CaptionArtifactV1, TranscriptArtifactV1 } from "@supa-video/media";
import { describe, expect, it, vi } from "vitest";

import {
  resolveManagedTranscriptArtifacts,
  selectAffectedCaptionReferences,
  type AffectedCaptionReference,
} from "./managed-transcript-resolution";
import type { VideoBackend } from "./video-ipc";

const identityA = {
  schemaVersion: 1,
  algorithm: "sha256",
  digest: "a".repeat(64),
  byteLength: 100,
} as const;
const identityB = { ...identityA, digest: "b".repeat(64) } as const;
const identityC = { ...identityA, digest: "c".repeat(64) } as const;
const keyA = "1".repeat(64);
const keyB = "2".repeat(64);

function captionArtifact(
  captionTrackId: string,
  transcriptArtifactIdentityKey: string,
  sourceIdentity = identityA,
): CaptionArtifactV1 {
  return {
    transcriptArtifactIdentityKey,
    sourceIdentity,
    trackLink: { captionTrackId },
  } as unknown as CaptionArtifactV1;
}

function projectionFixture(): ProjectProjection {
  return {
    state: {
      assets: [
        { id: "asset-a", contentIdentity: identityA },
        { id: "asset-b", contentIdentity: identityB },
      ],
      sequences: [
        {
          id: "sequence",
          tracks: [
            {
              id: "video",
              kind: "video",
              clips: [
                { id: "before", source: { kind: "asset", assetId: "asset-a" } },
                { id: "target", source: { kind: "asset", assetId: "asset-a" } },
                { id: "suffix", source: { kind: "asset", assetId: "asset-b" } },
              ],
            },
            {
              id: "caption-a-1",
              kind: "caption",
              activeCaptionArtifact: captionArtifact("caption-a-1", keyA),
            },
            {
              id: "caption-c",
              kind: "caption",
              activeCaptionArtifact: captionArtifact("caption-c", "3".repeat(64), identityC),
            },
            {
              id: "caption-a-2",
              kind: "caption",
              activeCaptionArtifact: captionArtifact("caption-a-2", keyA),
            },
            {
              id: "caption-b",
              kind: "caption",
              activeCaptionArtifact: captionArtifact("caption-b", keyB, identityB),
            },
          ],
        },
      ],
    },
  } as unknown as ProjectProjection;
}

function references(
  ...artifacts: readonly CaptionArtifactV1[]
): readonly AffectedCaptionReference[] {
  return artifacts.map((activeCaptionArtifact, index) => ({
    sequenceId: "sequence",
    captionTrackId: `caption-${index}`,
    activeCaptionArtifact,
  }));
}

function transcript(key: string): TranscriptArtifactV1 {
  return { identity: { key } } as unknown as TranscriptArtifactV1;
}

describe("managed transcript resolution", () => {
  it("selects every active caption in track order for split, move, and trim", () => {
    const projection = projectionFixture();

    for (const type of ["split", "move", "trim"] as const) {
      expect(
        selectAffectedCaptionReferences(projection, { type, sequenceId: "sequence" }).map(
          ({ captionTrackId }) => captionTrackId,
        ),
      ).toEqual(["caption-a-1", "caption-c", "caption-a-2", "caption-b"]);
    }
  });

  it("selects only ripple captions whose source occurs in the target suffix", () => {
    const selected = selectAffectedCaptionReferences(projectionFixture(), {
      type: "ripple-delete",
      sequenceId: "sequence",
      trackId: "video",
      clipId: "target",
    });

    expect(selected.map(({ captionTrackId }) => captionTrackId)).toEqual([
      "caption-a-1",
      "caption-a-2",
      "caption-b",
    ]);
  });

  it("loads each exact key once in deterministic first-reference order", async () => {
    const load = vi.fn<VideoBackend["loadManagedTranscriptArtifact"]>(async (key) =>
      transcript(key),
    );
    const selected = references(
      captionArtifact("caption-a-1", keyA),
      captionArtifact("caption-a-2", keyA),
      captionArtifact("caption-b", keyB, identityB),
    );

    const resolved = await resolveManagedTranscriptArtifacts(selected, load);

    expect(load.mock.calls.map(([key]) => key)).toEqual([keyA, keyB]);
    expect(resolved.map(({ key }) => key)).toEqual([keyA, keyB]);
  });

  it("sanitizes failed exact-key reads", async () => {
    const load = vi.fn<VideoBackend["loadManagedTranscriptArtifact"]>(async () => {
      throw new VideoDomainError("project_io", "C:\\private\\transcript.json", {
        category: "cache_miss",
        path: "C:\\private\\transcript.json",
      });
    });

    let failure: VideoDomainError | undefined;
    try {
      await resolveManagedTranscriptArtifacts(references(captionArtifact("caption", keyA)), load);
    } catch (error) {
      failure = error as VideoDomainError;
    }

    expect(failure).toMatchObject({
      code: "invalid_project",
      details: {
        reason: "managed_transcript_artifact_missing",
        transcriptArtifactIdentityKey: keyA,
        backendCode: "project_io",
        backendCategory: "cache_miss",
      },
    });
    expect(failure?.message).not.toContain("private");
    expect(failure?.details).not.toHaveProperty("path");
  });

  it("rejects a returned artifact whose exact key does not match", async () => {
    const load = vi.fn<VideoBackend["loadManagedTranscriptArtifact"]>(async () => transcript(keyB));

    await expect(
      resolveManagedTranscriptArtifacts(references(captionArtifact("caption", keyA)), load),
    ).rejects.toMatchObject({
      code: "invalid_project",
      details: {
        reason: "managed_transcript_artifact_key_mismatch",
        transcriptArtifactIdentityKey: keyA,
        returnedTranscriptArtifactIdentityKey: keyB,
      },
    });
  });
});
