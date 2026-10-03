import { describe, expect, it } from "vitest";

import {
  musicBeatFramesToMicroseconds,
  musicBeatTimelineFrames,
  musicBeatTimelineTargets,
  type MusicBeatSourceTimes,
} from "./music-beat-timeline.js";
import {
  DEFAULT_CLIP_TRANSFORM_GEOMETRY,
  type ProjectClip,
  type ProjectTrack,
  type TrackAudioRole,
  type VideoSequenceV2,
} from "./project-v2-entities.js";
import { createRationalRate, createRationalTime } from "./time.js";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const musicAsset = id(100);
const rate = createRationalRate(24, 1);
const at = (frame: number) => createRationalTime(frame, rate);

function clip(
  overrides: Partial<Pick<ProjectClip, "timelineStart" | "sourceIn" | "sourceOut" | "speed">> = {},
  assetId = musicAsset,
): ProjectClip {
  return {
    id: id(200),
    source: { kind: "asset", assetId },
    timelineStart: at(0),
    sourceIn: at(0),
    sourceOut: at(96),
    transform: { ...DEFAULT_CLIP_TRANSFORM_GEOMETRY, opacityPermille: 1_000 },
    gainMilliDecibels: 0,
    ...overrides,
  };
}

function audioTrack(
  clips: ProjectClip[],
  options: { audioRole?: TrackAudioRole; muted?: boolean } = { audioRole: "music" },
): ProjectTrack {
  return { id: id(300), name: "Music", kind: "audio", clips, ...options };
}

function sequence(tracks: ProjectTrack[]): VideoSequenceV2 {
  return {
    id: id(1),
    name: "Main",
    rate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
    markers: [],
  };
}

// 120 BPM: one music beat every 0.5 s = every 12 frames at 24 fps.
const musicBeats120: MusicBeatSourceTimes = {
  beatsUs: Array.from({ length: 16 }, (_, index) => index * 500_000),
};
const analyses = new Map([[musicAsset, musicBeats120]]);

describe("musicBeatTimelineFrames", () => {
  it("maps untrimmed music beats to timeline frames", () => {
    expect(musicBeatTimelineFrames(sequence([audioTrack([clip()])]), analyses)).toEqual([
      0, 12, 24, 36, 48, 60, 72, 84,
    ]);
  });

  it("applies the timeline offset and drops music beats outside the trim", () => {
    const trimmed = clip({ timelineStart: at(100), sourceIn: at(6), sourceOut: at(42) });
    // Source 0.25 s–1.75 s keeps music beats at 0.5, 1.0, 1.5 s → offsets 6, 18, 30.
    expect(musicBeatTimelineFrames(sequence([audioTrack([trimmed])]), analyses)).toEqual([
      106, 118, 130,
    ]);
  });

  it("applies clip speed", () => {
    const doubleSpeed = clip({ speed: createRationalRate(2, 1) });
    // 96 source frames play in 48 timeline frames; music beats land every 6 frames.
    expect(musicBeatTimelineFrames(sequence([audioTrack([doubleSpeed])]), analyses)).toEqual([
      0, 6, 12, 18, 24, 30, 36, 42,
    ]);
    const halfSpeed = clip({ speed: createRationalRate(1, 2), sourceOut: at(24) });
    expect(musicBeatTimelineFrames(sequence([audioTrack([halfSpeed])]), analyses)).toEqual([0, 24]);
  });

  it("ignores muted tracks, non-music roles, video tracks and unanalysed assets", () => {
    const tracks: ProjectTrack[] = [
      audioTrack([clip()], { audioRole: "music", muted: true }),
      audioTrack([clip()], { audioRole: "dialogue" }),
      audioTrack([clip()], {}),
      { ...audioTrack([clip()]), kind: "video" } as ProjectTrack,
      audioTrack([clip({}, id(101))]),
    ];
    expect(musicBeatTimelineFrames(sequence(tracks), analyses)).toEqual([]);
  });

  it("sorts and de-duplicates music beats from overlapping music clips", () => {
    const tracks = [audioTrack([clip()]), audioTrack([clip({ timelineStart: at(6) })])];
    expect(musicBeatTimelineFrames(sequence(tracks), analyses)).toEqual([
      0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90,
    ]);
  });

  it("keeps the source clip of each music beat target", () => {
    const first = { ...clip({ sourceOut: at(24) }), id: id(201) };
    const second = { ...clip({ timelineStart: at(12), sourceOut: at(24) }), id: id(202) };
    expect(
      musicBeatTimelineTargets(sequence([audioTrack([first]), audioTrack([second])]), analyses),
    ).toEqual([
      { frame: 0, clipId: id(201) },
      { frame: 12, clipId: id(201) },
      { frame: 12, clipId: id(202) },
      { frame: 24, clipId: id(202) },
    ]);
  });

  it("converts timeline frames to timeline microseconds", () => {
    expect(musicBeatFramesToMicroseconds([0, 12, 25], sequence([]))).toEqual([
      0, 500_000, 1_041_667,
    ]);
  });
});
