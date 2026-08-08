import {
  createRationalTime,
  createTimelineViewport,
  type CaptionArtifactV1,
  type CommandGroupRequest,
  type CommandResult,
  type OpenedProjectV2,
  type ProjectCommandV2,
  type ProjectProjection,
} from "@supa-video/contracts";
import { deriveActiveTimelineRange, projectVisibleTimeline } from "@supa-video/project";
import { describe, expect, it } from "vitest";

import { createMockVideoService, testProbe, testSourceIdentity } from "./test-video-service";

const id = (value: number): string =>
  `70000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const rate = testProbe.averageFrameRate;
const sequenceId = id(10);
const lockedTrackId = id(11);
const unaffectedTrackId = id(12);
const lockedClipId = id(13);
const unaffectedClipId = id(14);
const assetId = id(15);
const siblingClipId = id(16);
const unrelatedSiblingClipId = id(9);
const transform = {
  positionXPermille: 0,
  positionYPermille: 0,
  scaleXPermille: 1_000,
  scaleYPermille: 1_000,
  rotationMilliDegrees: 0,
  opacityPermille: 1_000,
} as const;

function clip(clipId: string) {
  return {
    id: clipId,
    source: { kind: "asset" as const, assetId },
    timelineStart: createRationalTime(0, rate),
    sourceIn: createRationalTime(0, rate),
    sourceOut: createRationalTime(20, rate),
    transform,
    gainMilliDecibels: 0,
  };
}

function setupCommands(): ProjectCommandV2[] {
  return [
    {
      type: "ImportAsset",
      commandId: id(101),
      asset: {
        id: assetId,
        displayName: "clip.mp4",
        locator: { absolutePath: "C:\\Neutral\\Media\\clip.mp4" },
        probe: testProbe,
        contentIdentity: testSourceIdentity,
      },
    },
    {
      type: "CreateSequence",
      commandId: id(102),
      sequence: {
        id: sequenceId,
        name: "Main sequence",
        rate,
        width: testProbe.width,
        height: testProbe.height,
        audioSampleRate: 48_000,
        tracks: [
          { id: lockedTrackId, name: "Video 1", kind: "video", clips: [clip(lockedClipId)] },
          {
            id: unaffectedTrackId,
            name: "Video 2",
            kind: "video",
            clips: [clip(unaffectedClipId)],
          },
        ],
        markers: [],
      },
    },
  ];
}

function track(projection: ProjectProjection, trackId: string) {
  const value = projection.state.sequences[0]?.tracks.find(
    ({ id: candidateId }) => candidateId === trackId,
  );
  if (value === undefined) throw new Error("Expected track fixture");
  return value;
}

const captionTrackId = id(17);
const wrongKindTrackId = id(18);
const legacyCaptionId = id(19);
const transcriptArtifactIdentityKey = "ab".repeat(32);

function captionSetupCommand(): ProjectCommandV2 {
  return {
    type: "CreateSequence",
    commandId: id(601),
    sequence: {
      id: sequenceId,
      name: "Caption sequence",
      rate,
      width: testProbe.width,
      height: testProbe.height,
      audioSampleRate: 48_000,
      tracks: [
        {
          id: captionTrackId,
          name: "Captions",
          kind: "caption",
          captions: [
            {
              id: legacyCaptionId,
              start: createRationalTime(0, rate),
              end: createRationalTime(25, rate),
              text: "Legacy caption",
              language: "en-US",
            },
          ],
        },
        { id: wrongKindTrackId, name: "Video", kind: "video", clips: [] },
      ],
      markers: [],
    },
  };
}

function captionArtifact(
  projection: ProjectProjection,
  language: string,
  targetSequenceId = sequenceId,
  targetTrackId = captionTrackId,
): CaptionArtifactV1 {
  return {
    schemaVersion: 1,
    trackLink: {
      schemaVersion: 1,
      projectId: projection.projectId,
      projectRevision: structuredClone(projection.revision),
      sequenceId: targetSequenceId,
      captionTrackId: targetTrackId,
    },
    sourceIdentity: testSourceIdentity,
    transcriptArtifactIdentityKey,
    language,
    timelineRate: rate,
    style: {
      schemaVersion: 1,
      typography: {
        fontFamily: "Inter",
        fontSizePx: 48,
        fontWeight: 600,
        fontStyle: "normal",
        lineHeightPermille: 1_200,
        foregroundColorRgba: "#ffffffff",
      },
      alignment: { horizontal: "center", vertical: "bottom" },
    },
    validationProfile: {
      schemaVersion: 1,
      maxLinesPerCue: 2,
      maxCharactersPerLine: 42,
      maxCharactersPerSecond: 20,
      minimumCueDuration: createRationalTime(1, rate),
      maximumCueDuration: createRationalTime(100, rate),
      safeArea: {
        topPermille: 50,
        rightPermille: 50,
        bottomPermille: 100,
        leftPermille: 50,
      },
    },
    cues: [],
  };
}

function activeCaptionTrack(projection: ProjectProjection) {
  const value = track(projection, captionTrackId);
  if (value.kind !== "caption") throw new Error("Expected caption track fixture");
  return value;
}

describe("mock project track locking", () => {
  it("persists projected lock state, keeps history readable, and isolates locked mutations", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    let groupNumber = 200;
    const execute = async (commands: ProjectCommandV2[]): Promise<CommandResult> => {
      const request: CommandGroupRequest = {
        groupId: id(groupNumber++),
        projectId: service.projection.projectId,
        baseRevision: service.projection.revision.number,
        commands,
      };
      return (await service.invoke("video_execute_project_group", { request })) as CommandResult;
    };

    await execute(setupCommands());
    const lock = await execute([
      {
        type: "SetTrackLocked",
        commandId: id(103),
        sequenceId,
        trackId: lockedTrackId,
        locked: true,
      },
    ]);
    expect(lock.newRevision.number - lock.priorRevision.number).toBe(1);
    expect(lock.projection.lastCommand?.summary).toBe("Locked track");

    const opened = (await service.invoke("video_open_project")) as OpenedProjectV2;
    const timelineRange = deriveActiveTimelineRange(opened.projection);
    const timeline = projectVisibleTimeline(
      opened.projection,
      createTimelineViewport({
        frameRate: rate,
        zoomScale: rate,
        scrollOrigin: createRationalTime(0, rate),
        viewportWidthPixels: 20,
        overscanPixels: 0,
        timelineRange: {
          start: timelineRange.startFrame,
          endExclusive: timelineRange.endFrameExclusive,
        },
      }),
    );
    expect(timeline?.tracks.find(({ trackId }) => trackId === lockedTrackId)?.locked).toBe(true);

    const undone = (await service.invoke("video_undo_project", {
      operationId: id(300),
    })) as CommandResult;
    expect(undone.projection.lastCommand?.summary).toBe("Undid Locked track");
    expect(track(undone.projection, lockedTrackId).locked ?? false).toBe(false);

    const redone = (await service.invoke("video_redo_project", {
      operationId: id(301),
    })) as CommandResult;
    expect(redone.projection.lastCommand?.summary).toBe("Redid Locked track");
    expect(track(redone.projection, lockedTrackId).locked).toBe(true);

    const revisionBeforeRejectedMove = service.projection.revision.number;
    await expect(
      execute([
        {
          type: "MoveClip",
          commandId: id(104),
          sequenceId,
          trackId: lockedTrackId,
          clipId: lockedClipId,
          timelineStart: createRationalTime(5, rate),
        },
      ]),
    ).rejects.toThrow("Track is locked");
    expect(service.projection.revision.number).toBe(revisionBeforeRejectedMove);

    const moved = await execute([
      {
        type: "MoveClip",
        commandId: id(105),
        sequenceId,
        trackId: unaffectedTrackId,
        clipId: unaffectedClipId,
        timelineStart: createRationalTime(5, rate),
      },
    ]);
    const unaffectedTrack = track(moved.projection, unaffectedTrackId);
    expect(
      unaffectedTrack.kind === "caption" ? null : unaffectedTrack.clips[0]?.timelineStart.value,
    ).toBe(5);
    expect(track(moved.projection, lockedTrackId).locked).toBe(true);

    const unlock = await execute([
      {
        type: "SetTrackLocked",
        commandId: id(106),
        sequenceId,
        trackId: lockedTrackId,
        locked: false,
      },
    ]);
    expect(unlock.newRevision.number - unlock.priorRevision.number).toBe(1);
    expect(unlock.projection.lastCommand?.summary).toBe("Unlocked track");
    expect(track(unlock.projection, lockedTrackId).locked).toBe(false);
  });
});

describe("mock caption artifact application", () => {
  it("applies and replaces exact artifacts, then restores them through undo and redo", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    let groupNumber = 610;
    const execute = async (commands: ProjectCommandV2[]): Promise<CommandResult> => {
      const request: CommandGroupRequest = {
        groupId: id(groupNumber++),
        projectId: service.projection.projectId,
        baseRevision: service.projection.revision.number,
        commands,
      };
      return (await service.invoke("video_execute_project_group", { request })) as CommandResult;
    };

    await execute([captionSetupCommand()]);
    const legacyCaptions = structuredClone(activeCaptionTrack(service.projection).captions);
    const artifactA = captionArtifact(service.projection, "en");
    const appliedA = await execute([
      {
        type: "ApplyCaptionArtifact",
        commandId: id(602),
        sequenceId,
        trackId: captionTrackId,
        artifact: artifactA,
      },
    ]);

    expect(appliedA.projection.lastCommand?.summary).toBe("Apply caption artifact");
    expect(appliedA.cacheInvalidations).toEqual(["captions", "render_plan"]);
    expect(appliedA.affectedRanges).toEqual([]);
    expect(activeCaptionTrack(appliedA.projection).activeCaptionArtifact).toEqual(artifactA);
    expect(activeCaptionTrack(appliedA.projection).activeCaptionArtifact).not.toBe(artifactA);
    expect(activeCaptionTrack(appliedA.projection).captions).toEqual(legacyCaptions);

    const artifactB = captionArtifact(appliedA.projection, "fr-FR");
    expect(artifactB.trackLink.projectRevision).toEqual(appliedA.newRevision);
    const expectedB = structuredClone(artifactB);
    const appliedB = await execute([
      {
        type: "ApplyCaptionArtifact",
        commandId: id(603),
        sequenceId,
        trackId: captionTrackId,
        artifact: artifactB,
      },
    ]);
    artifactB.language = "de-DE";

    expect(appliedB.projection.lastCommand?.summary).toBe("Apply caption artifact");
    expect(appliedB.cacheInvalidations).toEqual(["captions", "render_plan"]);
    expect(activeCaptionTrack(service.projection).activeCaptionArtifact).toEqual(expectedB);
    expect(activeCaptionTrack(service.projection).captions).toEqual(legacyCaptions);

    const undone = (await service.invoke("video_undo_project", {
      operationId: id(604),
    })) as CommandResult;
    expect(undone.projection.lastCommand?.summary).toBe("Undid Apply caption artifact");
    expect(undone.cacheInvalidations).toEqual(["captions", "render_plan"]);
    expect(activeCaptionTrack(undone.projection).activeCaptionArtifact).toEqual(artifactA);
    expect(activeCaptionTrack(undone.projection).captions).toEqual(legacyCaptions);

    const redone = (await service.invoke("video_redo_project", {
      operationId: id(605),
    })) as CommandResult;
    expect(redone.projection.lastCommand?.summary).toBe("Redid Apply caption artifact");
    expect(redone.cacheInvalidations).toEqual(["captions", "render_plan"]);
    expect(activeCaptionTrack(redone.projection).activeCaptionArtifact).toEqual(expectedB);
    expect(activeCaptionTrack(redone.projection).captions).toEqual(legacyCaptions);
  });

  it("rejects stale, mislinked, invalid-target, wrong-rate, private, and locked requests atomically", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    let groupNumber = 700;
    const execute = async (
      commands: ProjectCommandV2[],
      baseRevision = service.projection.revision.number,
    ): Promise<CommandResult> => {
      const request: CommandGroupRequest = {
        groupId: id(groupNumber++),
        projectId: service.projection.projectId,
        baseRevision,
        commands,
      };
      return (await service.invoke("video_execute_project_group", { request })) as CommandResult;
    };
    const expectAtomicRejection = async (
      command: ProjectCommandV2,
      expected: { code: string; details: { operation: string; category: string } },
      baseRevision = service.projection.revision.number,
    ) => {
      const before = structuredClone(service.projection);
      await expect(execute([command], baseRevision)).rejects.toMatchObject(expected);
      expect(service.projection).toEqual(before);
    };
    const applyCommand = (
      artifact: CaptionArtifactV1,
      targetSequenceId = sequenceId,
      targetTrackId = captionTrackId,
    ): ProjectCommandV2 => ({
      type: "ApplyCaptionArtifact",
      commandId: id(groupNumber + 100),
      sequenceId: targetSequenceId,
      trackId: targetTrackId,
      artifact,
    });

    await execute([captionSetupCommand()]);
    await execute([applyCommand(captionArtifact(service.projection, "en"))]);

    await expectAtomicRejection(
      applyCommand(captionArtifact(service.projection, "fr-FR")),
      {
        code: "stale_revision",
        details: { operation: "project_history", category: "base_revision" },
      },
      service.projection.revision.number - 1,
    );

    const wrongProject = captionArtifact(service.projection, "fr-FR");
    wrongProject.trackLink.projectId = id(998);
    await expectAtomicRejection(applyCommand(wrongProject), {
      code: "invalid_command",
      details: { operation: "project_history", category: "caption_artifact_track_link" },
    });

    const wrongRevision = captionArtifact(service.projection, "fr-FR");
    wrongRevision.trackLink.projectRevision.id = id(997);
    await expectAtomicRejection(applyCommand(wrongRevision), {
      code: "invalid_command",
      details: { operation: "project_history", category: "caption_artifact_track_link" },
    });

    const wrongLink = captionArtifact(service.projection, "fr-FR");
    wrongLink.trackLink.sequenceId = id(996);
    await expectAtomicRejection(applyCommand(wrongLink), {
      code: "invalid_command",
      details: { operation: "project_history", category: "caption_artifact_track_link" },
    });

    const wrongRate = captionArtifact(service.projection, "fr-FR");
    wrongRate.timelineRate = { numerator: 24, denominator: 1 };
    await expectAtomicRejection(applyCommand(wrongRate), {
      code: "invalid_command",
      details: { operation: "execute_project_command", category: "caption_artifact_rate" },
    });

    const missingSequenceId = id(995);
    await expectAtomicRejection(
      applyCommand(
        captionArtifact(service.projection, "fr-FR", missingSequenceId),
        missingSequenceId,
      ),
      {
        code: "invalid_command",
        details: { operation: "execute_project_command", category: "unknown_sequence" },
      },
    );

    const missingTrackId = id(994);
    await expectAtomicRejection(
      applyCommand(
        captionArtifact(service.projection, "fr-FR", sequenceId, missingTrackId),
        sequenceId,
        missingTrackId,
      ),
      {
        code: "invalid_command",
        details: { operation: "execute_project_command", category: "unknown_track" },
      },
    );

    await expectAtomicRejection(
      applyCommand(
        captionArtifact(service.projection, "fr-FR", sequenceId, wrongKindTrackId),
        sequenceId,
        wrongKindTrackId,
      ),
      {
        code: "invalid_command",
        details: { operation: "execute_project_command", category: "non_caption_track" },
      },
    );

    await expectAtomicRejection(
      {
        type: "RestoreActiveCaptionArtifact",
        commandId: id(993),
        sequenceId,
        trackId: captionTrackId,
        artifact: captionArtifact(service.projection, "fr-FR"),
      },
      {
        code: "invalid_command",
        details: { operation: "project_history", category: "private_inverse" },
      },
    );

    await execute([
      {
        type: "SetTrackLocked",
        commandId: id(606),
        sequenceId,
        trackId: captionTrackId,
        locked: true,
      },
    ]);
    await expectAtomicRejection(applyCommand(captionArtifact(service.projection, "fr-FR")), {
      code: "invalid_command",
      details: { operation: "execute_project_command", category: "track_locked" },
    });
  });
});

describe("mock clip moves", () => {
  it("sorts only the affected track after a clip moves across a sibling", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    let groupNumber = 400;
    const execute = async (commands: ProjectCommandV2[]): Promise<CommandResult> => {
      const request: CommandGroupRequest = {
        groupId: id(groupNumber++),
        projectId: service.projection.projectId,
        baseRevision: service.projection.revision.number,
        commands,
      };
      return (await service.invoke("video_execute_project_group", { request })) as CommandResult;
    };

    await execute(setupCommands());
    const sibling = clip(siblingClipId);
    sibling.timelineStart = createRationalTime(30, rate);
    const unrelatedSibling = clip(unrelatedSiblingClipId);
    unrelatedSibling.timelineStart = createRationalTime(20, rate);
    await execute([
      {
        type: "InsertClip",
        commandId: id(401),
        sequenceId,
        trackId: unaffectedTrackId,
        clip: sibling,
      },
      {
        type: "InsertClip",
        commandId: id(403),
        sequenceId,
        trackId: lockedTrackId,
        clip: unrelatedSibling,
      },
    ]);

    const moved = await execute([
      {
        type: "MoveClip",
        commandId: id(402),
        sequenceId,
        trackId: unaffectedTrackId,
        clipId: unaffectedClipId,
        timelineStart: createRationalTime(50, rate),
      },
    ]);
    const affectedTrack = track(moved.projection, unaffectedTrackId);
    if (affectedTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(affectedTrack.clips.map(({ id: clipId }) => clipId)).toEqual([
      siblingClipId,
      unaffectedClipId,
    ]);
    expect(affectedTrack.clips.map(({ timelineStart }) => timelineStart.value)).toEqual([30, 50]);

    const unrelatedTrack = track(moved.projection, lockedTrackId);
    if (unrelatedTrack.kind === "caption") throw new Error("Expected mock clip track");
    expect(unrelatedTrack.clips.map(({ id: clipId }) => clipId)).toEqual([
      lockedClipId,
      unrelatedSiblingClipId,
    ]);
  });

  it("rejects same-track overlap with the native clip_overlap error and preserves revision", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    let groupNumber = 500;
    const execute = async (commands: ProjectCommandV2[]): Promise<CommandResult> => {
      const request: CommandGroupRequest = {
        groupId: id(groupNumber++),
        projectId: service.projection.projectId,
        baseRevision: service.projection.revision.number,
        commands,
      };
      return (await service.invoke("video_execute_project_group", { request })) as CommandResult;
    };

    await execute(setupCommands());
    const sibling = clip(siblingClipId);
    sibling.timelineStart = createRationalTime(30, rate);
    await execute([
      {
        type: "InsertClip",
        commandId: id(501),
        sequenceId,
        trackId: unaffectedTrackId,
        clip: sibling,
      },
    ]);
    const revisionBeforeMove = service.projection.revision.number;

    await expect(
      execute([
        {
          type: "MoveClip",
          commandId: id(502),
          sequenceId,
          trackId: unaffectedTrackId,
          clipId: unaffectedClipId,
          timelineStart: createRationalTime(30, rate),
        },
      ]),
    ).rejects.toMatchObject({
      code: "invalid_command",
      details: { operation: "execute_project_command", category: "clip_overlap" },
    });
    expect(service.projection.revision.number).toBe(revisionBeforeMove);
    const unchangedTrack = track(service.projection, unaffectedTrackId);
    if (unchangedTrack.kind === "caption") throw new Error("Expected video track fixture");
    const unchangedClip = unchangedTrack.clips.find(
      ({ id: clipId }) => clipId === unaffectedClipId,
    );
    expect(unchangedClip?.timelineStart.value).toBe(0);
  });
});
