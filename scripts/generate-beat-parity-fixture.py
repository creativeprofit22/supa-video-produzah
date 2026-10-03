"""Generates the committed beat parity fixture and its Python Beat This! goldens.

Writes, under apps/desktop/src-tauri/beat-detector/tests/fixtures/:
- tempo-changes.wav          45 s, 22.05 kHz mono 16-bit PCM, deterministic (seeded)
- tempo-changes.golden.json  beats/downbeats from the Python reference + provenance

The track has three sections: 4/4 at 100 BPM, 4/4 at 128 BPM, and 3/4 at 90 BPM. Each beat has a
kick (accented on the bar's first beat), a hi-hat, and a sustained bass note that changes per bar,
so the model gets both rhythm and harmony. Only the standard library is used for the audio, so the
WAV bytes do not depend on numpy versions.

Usage (golden generation needs the reference environment, see beat_this_reference.py):
    python scripts/generate-beat-parity-fixture.py \
        --python <reference python> --checkpoint <final0.ckpt>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import struct
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import cast

SAMPLE_RATE = 22_050
SEED = 20261003
REPO = Path(__file__).resolve().parent.parent
DETECTOR = REPO / "apps/desktop/src-tauri/beat-detector"
FIXTURES = DETECTOR / "tests/fixtures"
REFERENCE_SCRIPT = DETECTOR / "reference/beat_this_reference.py"
FIXTURE_NAME = "tempo-changes"


@dataclass(slots=True, frozen=True)
class Section:
    bpm: float
    beats_per_bar: int
    bars: int


SECTIONS = (Section(100.0, 4, 6), Section(128.0, 4, 8), Section(90.0, 3, 8))
BASS_NOTES_HZ = (55.0, 73.42, 61.74, 82.41, 65.41, 49.0)


def beat_grid() -> list[tuple[float, bool, float]]:
    """(time_s, is_downbeat, seconds_per_beat) for every beat in the track."""
    beats: list[tuple[float, bool, float]] = []
    time_s = 0.5
    for section in SECTIONS:
        period = 60.0 / section.bpm
        for _bar in range(section.bars):
            for beat in range(section.beats_per_bar):
                beats.append((time_s, beat == 0, period))
                time_s += period
    return beats


def synthesize() -> list[int]:
    grid = beat_grid()
    total_s = grid[-1][0] + 2.0
    samples = [0.0] * int(total_s * SAMPLE_RATE)
    rng = random.Random(SEED)
    bar = -1
    for time_s, downbeat, period in grid:
        start = int(time_s * SAMPLE_RATE)
        if downbeat:
            bar += 1
        # Kick: pitch-swept sine, louder on the downbeat.
        kick_gain = 0.9 if downbeat else 0.55
        for offset in range(int(0.18 * SAMPLE_RATE)):
            index = start + offset
            if index >= len(samples):
                break
            t = offset / SAMPLE_RATE
            frequency = 50.0 + 90.0 * math.exp(-t * 30.0)
            samples[index] += (
                kick_gain * math.exp(-t * 18.0) * math.sin(2 * math.pi * frequency * t)
            )
        # Hi-hat on the off-beat: short seeded noise burst.
        hat = start + int(period * SAMPLE_RATE / 2)
        for offset in range(int(0.04 * SAMPLE_RATE)):
            index = hat + offset
            if index >= len(samples):
                break
            t = offset / SAMPLE_RATE
            samples[index] += 0.18 * math.exp(-t * 90.0) * (rng.random() * 2.0 - 1.0)
        # Bass: sustained note for the beat, root changes every bar.
        note = BASS_NOTES_HZ[bar % len(BASS_NOTES_HZ)]
        length = int(period * SAMPLE_RATE * 0.9)
        for offset in range(length):
            index = start + offset
            if index >= len(samples):
                break
            t = offset / SAMPLE_RATE
            envelope = min(1.0, t * 200.0) * math.exp(-t * 2.5)
            samples[index] += 0.22 * envelope * math.sin(2 * math.pi * note * t)
    # Light seeded noise floor, then 16-bit quantisation with clipping.
    peak = max(abs(value) for value in samples) or 1.0
    scale = 0.8 / peak
    return [
        max(-32_768, min(32_767, round((value * scale + (rng.random() - 0.5) * 0.004) * 32_767)))
        for value in samples
    ]


def write_wav(path: Path, pcm: list[int]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(struct.pack(f"<{len(pcm)}h", *pcm))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@dataclass(slots=True, frozen=True)
class ReferenceResult:
    beats: list[float]
    downbeats: list[float]
    device: str


def float_list(value: object, name: str) -> list[float]:
    if not isinstance(value, list):
        raise SystemExit(f"reference {name} is not a list")
    items = cast(list[object], value)
    if not all(isinstance(item, int | float) for item in items):
        raise SystemExit(f"reference {name} holds a non-number")
    return [float(cast(float, item)) for item in items]


def run_reference(python: Path, checkpoint: Path, device: str, wav: Path) -> ReferenceResult:
    completed = subprocess.run(
        [
            str(python),
            str(REFERENCE_SCRIPT),
            "--checkpoint",
            str(checkpoint),
            "--device",
            device,
            str(wav),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        raise SystemExit(f"reference script exited {completed.returncode} on {device}")
    result: object = json.loads(completed.stdout)
    if not isinstance(result, dict):
        raise SystemExit("reference script did not print a JSON object")
    fields = cast(dict[str, object], result)
    return ReferenceResult(
        beats=float_list(fields.get("beats"), "beats"),
        downbeats=float_list(fields.get("downbeats"), "downbeats"),
        device=str(fields.get("device")),
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path, help="reference interpreter")
    parser.add_argument("--checkpoint", required=True, type=Path, help="local final0.ckpt")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    arguments = parser.parse_args(argv)

    FIXTURES.mkdir(parents=True, exist_ok=True)
    wav = FIXTURES / f"{FIXTURE_NAME}.wav"
    write_wav(wav, synthesize())
    result = run_reference(arguments.python, arguments.checkpoint, arguments.device, wav)
    grid = beat_grid()
    golden = {
        "fixture": wav.name,
        "fixtureSha256": sha256_file(wav),
        "sections": [
            {"bpm": section.bpm, "beatsPerBar": section.beats_per_bar, "bars": section.bars}
            for section in SECTIONS
        ],
        "syntheticBeatCount": len(grid),
        "syntheticDownbeatCount": sum(1 for _time, downbeat, _period in grid if downbeat),
        "provenance": {
            "generator": "scripts/generate-beat-parity-fixture.py",
            "reference": "apps/desktop/src-tauri/beat-detector/reference/beat_this_reference.py",
            "beatThisCommit": "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c",
            "beatThisVersion": "1.1.0",
            "checkpoint": "final0",
            "checkpointSha256": sha256_file(arguments.checkpoint),
            "call": (
                f"File2Beats(checkpoint_path=<final0.ckpt>, device='{arguments.device}', dbn=False)"
            ),
            "device": result.device,
        },
        "beats": result.beats,
        "downbeats": result.downbeats,
    }
    golden_path = FIXTURES / f"{FIXTURE_NAME}.golden.json"
    golden_path.write_text(json.dumps(golden, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {wav.name} and {golden_path.name}: "
        f"{len(result.beats)} beats, {len(result.downbeats)} downbeats"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
