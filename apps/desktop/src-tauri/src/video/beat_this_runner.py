"""Beat This! runner for supa-video music beat detection.

Usage: python -I beat_this_runner.py <audio.wav> <checkpoint.ckpt>

Prints one JSON object, {"beats": [seconds], "downbeats": [seconds]}, to
stdout. The checkpoint must be a local file: Beat This! treats any other value
as a shortname and downloads it, which the app never allows.
"""

import json
import sys
from pathlib import Path


class RunnerError(Exception):
    """An expected failure reported on stderr with a non-zero exit code."""


def detect(audio: Path, checkpoint: Path) -> dict[str, list[float]]:
    if not audio.is_file():
        raise RunnerError("audio file is missing")
    if not checkpoint.is_file():
        raise RunnerError("checkpoint file is missing")
    import torch
    from beat_this.inference import File2Beats

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tracker = File2Beats(checkpoint_path=str(checkpoint), device=device, dbn=False)
    beats, downbeats = tracker(str(audio))
    return {
        "beats": [float(time) for time in beats],
        "downbeats": [float(time) for time in downbeats],
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: beat_this_runner.py <audio.wav> <checkpoint.ckpt>", file=sys.stderr)
        return 2
    try:
        result = detect(Path(argv[1]), Path(argv[2]))
    except RunnerError as error:
        print(f"beat_this_runner: {error}", file=sys.stderr)
        return 3
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
