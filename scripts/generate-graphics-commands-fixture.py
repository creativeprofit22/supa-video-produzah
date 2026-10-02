"""Writes packages/video-contracts/fixtures/graphics-commands.json.

Each case runs on the graphics track (sequence 0, track 1) of
fixtures/project-v2/valid-graphics.svpvideo. `expectedGraphicsClips` is that
track's `graphicsClips` after the group applies; undo must restore the base and
redo must reproduce the expected clips. Expected values are written out by
hand here (not produced by either implementation) so TypeScript and Rust are
both checked against the same independent answer.

Usage: python scripts/generate-graphics-commands-fixture.py
"""

import copy
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "packages" / "video-contracts" / "fixtures"
base = json.loads((FIXTURES / "project-v2" / "valid-graphics.svpvideo").read_text("utf8"))
sequence = base["state"]["sequences"][0]
SEQUENCE_ID = sequence["id"]
VIDEO_TRACK_ID = sequence["tracks"][0]["id"]
TRACK_ID = sequence["tracks"][1]["id"]
CLIP1 = sequence["tracks"][1]["graphicsClips"][0]


def uid(value):
    return f"9c000000-0000-4000-8000-{value:012x}"


def t(value):
    return {"value": value, "rateNumerator": 30, "rateDenominator": 1}


def hold(value):
    return [{"timeMicroseconds": 0, "value": value}]


def rect_layer(fill="#FF5722"):
    return {
        "kind": "rect",
        "width": 200,
        "height": 60,
        "cornerRadius": 8,
        "fill": fill,
        "x": hold(10),
        "y": hold(20),
        "scale": [
            {"timeMicroseconds": 0, "value": 0, "easing": {"kind": "preset", "name": "strong"}},
            {"timeMicroseconds": 400000, "value": 1},
        ],
        "rotation": hold(0),
        "opacity": hold(1),
    }


def new_clip(clip_id, start, duration):
    return {
        "graphicsVersion": 1,
        "id": clip_id,
        "timelineStart": t(start),
        "duration": t(duration),
        "fontKey": "arial-bold",
        "layers": [rect_layer()],
    }


def command(kind, number, track_id=TRACK_ID, **fields):
    return {"type": kind, "commandId": uid(number), "sequenceId": SEQUENCE_ID, "trackId": track_id, **fields}


def moved(clip, start, duration):
    result = copy.deepcopy(clip)
    result["timelineStart"] = t(start)
    result["duration"] = t(duration)
    return result


clip2 = new_clip(uid(2), 60, 30)
clip3 = new_clip(uid(3), 40, 10)
new_layers = [rect_layer("#4CAF50"), copy.deepcopy(CLIP1["layers"][1])]
clip1_new_layers = {**copy.deepcopy(CLIP1), "fontKey": "georgia-bold", "layers": new_layers}

cases = [
    {
        "name": "add appends in start order",
        "commands": [command("AddGraphicsClip", 100, graphicsClip=clip2)],
        "expectedGraphicsClips": [CLIP1, clip2],
    },
    {
        "name": "add at an explicit index",
        "commands": [command("AddGraphicsClip", 101, index=1, graphicsClip=clip3)],
        "expectedGraphicsClips": [CLIP1, clip3],
    },
    {
        "name": "remove",
        "commands": [command("RemoveGraphicsClip", 102, graphicsClipId=CLIP1["id"])],
        "expectedGraphicsClips": [],
    },
    {
        "name": "move and resize",
        "commands": [
            command("MoveGraphicsClip", 103, graphicsClipId=CLIP1["id"], timelineStart=t(45), duration=t(15))
        ],
        "expectedGraphicsClips": [moved(CLIP1, 45, 15)],
    },
    {
        "name": "set layers and font",
        "commands": [
            command(
                "SetGraphicsClipLayers",
                104,
                graphicsClipId=CLIP1["id"],
                fontKey="georgia-bold",
                layers=new_layers,
            )
        ],
        "expectedGraphicsClips": [clip1_new_layers],
    },
    {
        "name": "group add then move the first clip after it keeps start order",
        "commands": [
            command("AddGraphicsClip", 105, graphicsClip=clip2),
            command("MoveGraphicsClip", 106, graphicsClipId=CLIP1["id"], timelineStart=t(100), duration=t(30)),
        ],
        "expectedGraphicsClips": [clip2, moved(CLIP1, 100, 30)],
    },
]

invalid = [
    {
        "name": "overlapping clip",
        "commands": [command("AddGraphicsClip", 200, graphicsClip=new_clip(uid(4), 10, 30))],
        "category": "graphics_clip_overlap",
    },
    {
        "name": "duplicate clip id",
        "commands": [command("AddGraphicsClip", 201, graphicsClip={**clip2, "id": CLIP1["id"]})],
        "category": "duplicate_graphics_clip",
    },
    {
        "name": "unknown clip",
        "commands": [command("RemoveGraphicsClip", 202, graphicsClipId=uid(99))],
        "category": "unknown_graphics_clip",
    },
    {
        "name": "media track target",
        "commands": [command("AddGraphicsClip", 203, track_id=VIDEO_TRACK_ID, graphicsClip=clip2)],
        "category": "non_graphics_track",
    },
    {
        "name": "index past the end",
        "commands": [command("AddGraphicsClip", 204, index=5, graphicsClip=clip2)],
        "category": "graphics_clip_index",
    },
    {
        "name": "clip at another rate",
        "commands": [
            command(
                "MoveGraphicsClip",
                205,
                graphicsClipId=CLIP1["id"],
                timelineStart={"value": 0, "rateNumerator": 25, "rateDenominator": 1},
                duration={"value": 30, "rateNumerator": 25, "rateDenominator": 1},
            )
        ],
        "category": "graphics_clip_rate",
    },
    {
        "name": "locked track",
        "lockTrack": True,
        "commands": [command("RemoveGraphicsClip", 206, graphicsClipId=CLIP1["id"])],
        "category": "track_locked",
    },
]

# Whole-state rules (Rust validate_state) fail as invalid_project; command preconditions as invalid_command.
for case in invalid:
    case["code"] = "invalid_project" if case["category"] in ("graphics_clip_overlap", "graphics_clip_rate") else "invalid_command"

# Commands every implementation must refuse at the wire boundary (schema / shape).
invalid_wire = [
    {"name": "opacity above 1", "command": command(
        "SetGraphicsClipLayers", 300, graphicsClipId=CLIP1["id"], fontKey="arial-bold",
        layers=[{**rect_layer(), "opacity": hold(2)}])},
    {"name": "unknown font", "command": command(
        "SetGraphicsClipLayers", 301, graphicsClipId=CLIP1["id"], fontKey="comic-sans", layers=[])},
    {"name": "string easing", "command": command(
        "SetGraphicsClipLayers", 302, graphicsClipId=CLIP1["id"], fontKey="arial-bold",
        layers=[{**rect_layer(), "x": [{"timeMicroseconds": 0, "value": 0, "easing": "snappy"}]}])},
    {"name": "future graphics version", "command": command(
        "AddGraphicsClip", 303, graphicsClip={**clip2, "graphicsVersion": 2})},
    {"name": "zero duration", "command": command(
        "MoveGraphicsClip", 304, graphicsClipId=CLIP1["id"], timelineStart=t(0), duration=t(0))},
    {"name": "extra field", "command": {**command("RemoveGraphicsClip", 305, graphicsClipId=CLIP1["id"]), "clipId": uid(1)}},
]

output = {
    "base": "project-v2/valid-graphics.svpvideo",
    "sequenceIndex": 0,
    "trackIndex": 1,
    "cases": cases,
    "invalid": invalid,
    "invalidWire": invalid_wire,
}
target = FIXTURES / "graphics-commands.json"
target.write_text(json.dumps(output, indent=2) + "\n", encoding="utf8")
print(f"wrote {target}")
