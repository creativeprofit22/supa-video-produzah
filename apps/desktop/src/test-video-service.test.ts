import {
  createRationalTime,
  createTimelineViewport,
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
