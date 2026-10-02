"""Writes apps/desktop/src-tauri/graphics-renderer/fixtures/motion-graphic-16x9.json.

A schema 2 graphics description that exercises scale, rotation, spring and steps easing,
an embedded PNG image layer and a per-word text reveal. The image is a 64x64 PNG
(orange disc on blue), embedded as a data URI.

Usage: python scripts/generate-motion-graphic-fixture.py apps/desktop/src-tauri/graphics-renderer/fixtures/images/badge.png
"""

import base64
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET = ROOT / "apps" / "desktop" / "src-tauri" / "graphics-renderer" / "fixtures" / "motion-graphic-16x9.json"
FONT = "C:" + "\\" + "Windows" + "\\" + "Fonts" + "\\" + "arial.ttf"


def hold(value):
    return [{"frame": 0, "value": value}]


def main():
    png = pathlib.Path(sys.argv[1]).read_bytes()
    assert png.startswith(b"\x89PNG"), "badge must be a PNG"
    spring = {"kind": "spring", "bounce": 0.4, "durationMs": 500}
    words = ["Motion", "graphics", "everywhere"]
    description = {
        "schemaVersion": 2,
        "canvas": {"width": 1280, "height": 720},
        "frameRate": {"numerator": 30, "denominator": 1},
        "durationFrames": 48,
        "font": {"file": FONT, "family": "Arial"},
        "images": [{"data": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}],
        "layers": [
            {
                # Card pops in with a spring on scale and settles its rotation.
                "kind": "rect",
                "width": 720,
                "height": 200,
                "cornerRadius": 28,
                "fill": "#0F766E",
                "x": hold(280),
                "y": hold(260),
                "scale": [{"frame": 0, "value": 0.2, "easing": spring}, {"frame": 18, "value": 1}],
                "rotation": [
                    {"frame": 0, "value": -12, "easing": {"kind": "cubicBezier", "x1": 0.34, "y1": 1.56, "x2": 0.64, "y2": 1}},
                    {"frame": 16, "value": 0},
                ],
                "opacity": [{"frame": 0, "value": 0}, {"frame": 6, "value": 1}],
            },
            {
                # Headline revealed word by word: each word fades in and rises 30 px.
                "kind": "text",
                "text": " ".join(words),
                "fontSize": 48,
                "fill": "#FFFFFF",
                "units": {
                    "split": "word",
                    "opacity": [
                        [{"frame": 6 + 6 * index, "value": 0}, {"frame": 14 + 6 * index, "value": 1}]
                        for index in range(len(words))
                    ],
                    "offsetY": [
                        [
                            {"frame": 6 + 6 * index, "value": 30, "easing": {"kind": "preset", "name": "snappy"}},
                            {"frame": 16 + 6 * index, "value": 0},
                        ]
                        for index in range(len(words))
                    ],
                },
                "x": hold(330),
                "y": hold(332),
                "scale": hold(1),
                "rotation": hold(0),
                "opacity": hold(1),
            },
            {
                # Badge image ticks in with steps and spins once.
                "kind": "image",
                "image": 0,
                "width": 96,
                "height": 96,
                "x": hold(940),
                "y": hold(200),
                "scale": [{"frame": 0, "value": 0, "easing": {"kind": "steps", "count": 4}}, {"frame": 12, "value": 1}],
                "rotation": [{"frame": 0, "value": 0, "easing": {"kind": "preset", "name": "easeInOut"}}, {"frame": 40, "value": 360}],
                "opacity": hold(1),
            },
        ],
    }
    TARGET.write_text(json.dumps(description, indent=2) + "\n", encoding="utf8")
    print(f"wrote {TARGET}")


if __name__ == "__main__":
    main()
