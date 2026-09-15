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
import { planBulkClipEdit, type BulkClipAction } from "./video/bulk-clip-edit";

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

it("bulk plans one snapshot, applies actual speed/move/delete and audio with atomic undo/redo", async () => {
  const service = createMockVideoService();
  await service.invoke("video_create_project");
  let serial = 2000;
  const newId = () => id(serial++);
  const execute = (
    commands: ProjectCommandV2[],
    baseRevision = service.projection.revision.number,
  ) =>
    service.invoke("video_execute_project_group", {
      request: {
        groupId: newId(),
        projectId: service.projection.projectId,
        baseRevision,
        commands,
      },
    });
  await execute(setupCommands());
  await execute([
    {
      type: "InsertClip",
      commandId: newId(),
      sequenceId,
      trackId: unaffectedTrackId,
      clip: { ...clip(siblingClipId), timelineStart: createRationalTime(20, rate) },
    },
  ]);
  const targets = [unaffectedClipId, siblingClipId].map((clipId) => ({
    sequenceId,
    trackId: unaffectedTrackId,
    clipId,
  }));
  const actions: BulkClipAction[] = [
    { type: "move", deltaFrames: 10 },
    { type: "speed", speed: { numerator: 2, denominator: 1 } },
    { type: "delete" },
  ];
  for (const action of actions) {
    const before = structuredClone(service.projection.state);
    const commands = planBulkClipEdit(service.projection.state, targets, action, newId);
    expect(service.projection.state).toEqual(before);
    expect(commands).toHaveLength(2);
    await execute(commands);
    const after = structuredClone(service.projection.state);
    const changedTrack = track(service.projection, unaffectedTrackId);
    if (changedTrack.kind !== "video") throw new Error("fixture");
    if (action.type === "move")
      expect(changedTrack.clips.map((c) => c.timelineStart.value)).toEqual([10, 30]);
    if (action.type === "speed")
      expect(changedTrack.clips.map((c) => c.speed)).toEqual([action.speed, action.speed]);
    if (action.type === "delete") expect(changedTrack.clips).toHaveLength(0);
    await service.invoke("video_undo_project", { operationId: newId() });
    expect(service.projection.state).toEqual(before);
    await service.invoke("video_redo_project", { operationId: newId() });
    expect(service.projection.state).toEqual(after);
    if (action.type === "delete")
      await service.invoke("video_undo_project", { operationId: newId() });
  }
  const beforeAudio = structuredClone(service.projection.state);
  await execute(
    targets.flatMap((target) => [
      { type: "SetClipGain" as const, commandId: newId(), ...target, gainMilliDecibels: -6000 },
      {
        type: "SetClipFades" as const,
        commandId: newId(),
        ...target,
        fades: { inFrames: 2, outFrames: 3 },
      },
    ]),
  );
  const audioTrack = track(service.projection, unaffectedTrackId);
  if (audioTrack.kind !== "video") throw new Error("fixture");
  expect(
    audioTrack.clips.every(
      (c) => c.gainMilliDecibels === -6000 && c.fades?.inFrames === 2 && c.fades.outFrames === 3,
    ),
  ).toBe(true);
  const afterAudio = structuredClone(service.projection.state);
  await service.invoke("video_undo_project", { operationId: newId() });
  expect(service.projection.state).toEqual(beforeAudio);
  await service.invoke("video_redo_project", { operationId: newId() });
  expect(service.projection.state).toEqual(afterAudio);
  expect(() =>
    planBulkClipEdit(service.projection.state, targets, { type: "move", deltaFrames: -11 }, newId),
  ).toThrow(/negative/);
  expect(() =>
    planBulkClipEdit(
      service.projection.state,
      [targets[0]!, { ...targets[1]!, clipId: id(9999) }],
      { type: "delete" },
      newId,
    ),
  ).toThrow(/stale/);
  const stale = service.projection.revision.number;
  await execute([
    {
      type: "SetTrackLocked",
      commandId: newId(),
      sequenceId,
      trackId: lockedTrackId,
      locked: true,
    },
  ]);
  const lockedTargets = [targets[0]!, { sequenceId, trackId: lockedTrackId, clipId: lockedClipId }];
  const lockedState = structuredClone(service.projection.state);
  expect(() =>
    planBulkClipEdit(service.projection.state, lockedTargets, { type: "delete" }, newId),
  ).toThrow(/unlocked/);
  await expect(
    execute(
      targets.map((target) => ({ type: "RemoveClip", commandId: newId(), ...target })),
      stale,
    ),
  ).rejects.toMatchObject({ code: "stale_revision" });
  expect(service.projection.state).toEqual(lockedState);
});

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

describe("mock speed command admission", () => {
  it.each(["audio", "nested", "managed captions"] as const)(
    "rejects %s speed contexts atomically",
    async (context) => {
      const service = createMockVideoService();
      await service.invoke("video_create_project");
      const commands = setupCommands();
      const setup = commands[1]!;
      if (setup.type !== "CreateSequence") throw new Error("Expected sequence");
      const target = setup.sequence.tracks[1]!;
      if (target.kind !== "video") throw new Error("Expected video");
      if (context === "audio") setup.sequence.tracks[1] = { ...target, kind: "audio" };
      if (context === "nested")
        commands.push({
          type: "CreateSequence",
          commandId: id(970),
          sequence: {
            ...structuredClone(setup.sequence),
            id: id(971),
            tracks: [
              {
                id: id(972),
                name: "Parent",
                kind: "video",
                clips: [{ ...clip(id(973)), source: { kind: "sequence", sequenceId } }],
              },
            ],
          },
        });
      if (context === "managed captions")
        setup.sequence.tracks.push({
          id: captionTrackId,
          name: "Captions",
          kind: "caption",
          captions: [],
          activeCaptionArtifact: captionArtifact(service.projection, "en-US"),
        });
      await service.invoke("video_execute_project_group", {
        request: {
          groupId: id(974),
          projectId: service.projection.projectId,
          baseRevision: 0,
          commands,
        },
      });
      const before = structuredClone(service.projection);
      await expect(
        service.invoke("video_execute_project_group", {
          request: {
            groupId: id(975),
            projectId: before.projectId,
            baseRevision: before.revision.number,
            commands: [
              {
                type: "SetClipSpeed",
                commandId: id(976),
                sequenceId,
                trackId: unaffectedTrackId,
                clipId: unaffectedClipId,
                speed: { numerator: 2, denominator: 1 },
              },
            ],
          },
        }),
      ).rejects.toThrow(
        context === "audio"
          ? "direct-asset"
          : context === "nested"
            ? "child sequences"
            : "managed captions",
      );
      expect(service.projection).toEqual(before);
    },
  );

  it("keeps overlap, lock and stale edits atomic and permits exact adjacency", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    let serial = 950;
    const execute = (
      commands: ProjectCommandV2[],
      baseRevision = service.projection.revision.number,
    ) =>
      service.invoke("video_execute_project_group", {
        request: {
          groupId: id(serial++),
          projectId: service.projection.projectId,
          baseRevision,
          commands,
        },
      });
    await execute(setupCommands());
    await execute([
      {
        type: "InsertClip",
        commandId: id(940),
        sequenceId,
        trackId: unaffectedTrackId,
        clip: { ...clip(siblingClipId), timelineStart: createRationalTime(40, rate) },
      },
    ]);
    const speed: Extract<ProjectCommandV2, { type: "SetClipSpeed" }> = {
      type: "SetClipSpeed",
      commandId: id(941),
      sequenceId,
      trackId: unaffectedTrackId,
      clipId: unaffectedClipId,
      speed: { numerator: 1, denominator: 2 },
    };
    await execute([speed]);
    const adjacent = structuredClone(service.projection);
    await expect(
      execute([{ ...speed, speed: { numerator: 2, denominator: 1 } }], 0),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(service.projection).toEqual(adjacent);
    await execute([
      { ...speed, speed: { numerator: 1, denominator: 1 } },
      {
        type: "MoveClip",
        commandId: id(942),
        sequenceId,
        trackId: unaffectedTrackId,
        clipId: siblingClipId,
        timelineStart: createRationalTime(30, rate),
      },
    ]);
    const before = structuredClone(service.projection);
    await expect(
      execute([
        {
          type: "SetTrackLocked",
          commandId: id(943),
          sequenceId,
          trackId: lockedTrackId,
          locked: true,
        },
        speed,
      ]),
    ).rejects.toMatchObject({ details: { category: "clip_overlap" } });
    expect(service.projection).toEqual(before);
    await execute([
      {
        type: "SetTrackLocked",
        commandId: id(944),
        sequenceId,
        trackId: unaffectedTrackId,
        locked: true,
      },
    ]);
    const locked = structuredClone(service.projection);
    await expect(execute([speed])).rejects.toMatchObject({ details: { category: "track_locked" } });
    expect(service.projection).toEqual(locked);
  });

  it("rejects inexact speed without advancing state or revision, applies exact speed and omits reset", async () => {
    const service = createMockVideoService();
    await service.invoke("video_create_project");
    await service.invoke("video_execute_project_group", {
      request: {
        groupId: id(900),
        projectId: service.projection.projectId,
        baseRevision: service.projection.revision.number,
        commands: setupCommands(),
      },
    });
    const before = structuredClone(service.projection);
    const request: CommandGroupRequest = {
      groupId: id(901),
      projectId: before.projectId,
      baseRevision: before.revision.number,
      commands: [
        {
          type: "SetClipSpeed",
          commandId: id(902),
          sequenceId,
          trackId: unaffectedTrackId,
          clipId: unaffectedClipId,
          speed: { numerator: 3, denominator: 2 },
        },
      ],
    };
    await expect(service.invoke("video_execute_project_group", { request })).rejects.toThrow(
      "inexact",
    );
    expect(service.projection).toEqual(before);
    const command = request.commands[0]!;
    if (command.type !== "SetClipSpeed") throw new Error("Expected speed");
    const result = (await service.invoke("video_execute_project_group", {
      request: { ...request, commands: [{ ...command, speed: { numerator: 2, denominator: 1 } }] },
    })) as CommandResult;
    expect(result.cacheInvalidations).toEqual(["timeline", "preview", "render_plan"]);
    const updated = track(service.projection, unaffectedTrackId);
    if (updated.kind !== "video") throw new Error("Expected video");
    expect(updated.clips[0]).toEqual({
      ...clip(unaffectedClipId),
      speed: { numerator: 2, denominator: 1 },
    });
    await service.invoke("video_execute_project_group", {
      request: {
        ...request,
        groupId: id(903),
        baseRevision: service.projection.revision.number,
        commands: [{ ...command, speed: { numerator: 1, denominator: 1 } }],
      },
    });
    expect(track(service.projection, unaffectedTrackId)).toEqual(track(before, unaffectedTrackId));
    const reset = structuredClone(service.projection);
    await expect(
      service.invoke("video_execute_project_group", {
        request: {
          ...request,
          baseRevision: reset.revision.number,
          commands: [{ ...command, type: "RestoreClipSpeed", speed: null }],
        },
      }),
    ).rejects.toMatchObject({ details: { category: "private_inverse" } });
    expect(service.projection).toEqual(reset);
  });
});

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
