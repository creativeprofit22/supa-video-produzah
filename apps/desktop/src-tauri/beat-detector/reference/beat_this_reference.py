"""Python Beat This! reference for parity tests and benchmarks. Test-only; never bundled.

Usage:
    beat_this_reference.py --checkpoint <final0.ckpt> --device cuda|cpu <audio.wav>

Prints one JSON object on stdout:
    {"beats":[s],"downbeats":[s],"device":"cuda"|"cpu","elapsedMs":n}

Always runs File2Beats(checkpoint_path=<local file>, device=..., dbn=False), the configuration
the app used before the Rust sidecar. Exits 4 (message on stderr) before running anything unless:
- the checkpoint is a local file with the pinned final0 SHA-256 and size;
- the installed beat-this distribution is 1.1.0;
- a commit recorded by the installation (VCS commit or GitHub archive URL) is the pinned one;
- --device cuda is only accepted when torch.cuda.is_available() is true.
Exit 2 is a usage error, 3 a failure while running the model.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

PINNED_VERSION = "1.1.0"
PINNED_COMMIT = "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c"
PINNED_CHECKPOINT_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
PINNED_CHECKPOINT_BYTES = 81_058_141
ARCHIVE_URL = re.compile(r"^https://github\.com/CPJKU/beat_this/archive/([0-9a-f]{40})\.zip$")

EXIT_USAGE = 2
EXIT_RUN_FAILED = 3
EXIT_PIN_CHECK_FAILED = 4

Device = Literal["cuda", "cpu"]


class PinCheckError(Exception):
    """A pinned property of the reference environment does not hold."""


@dataclass(slots=True, frozen=True)
class Arguments:
    checkpoint: Path
    device: Device
    audio: Path


def parse_arguments(argv: list[str]) -> Arguments:
    parser = argparse.ArgumentParser(prog="beat_this_reference.py")
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--device", required=True, choices=["cuda", "cpu"])
    parser.add_argument("audio", type=Path)
    namespace = parser.parse_args(argv)
    device: Device = "cuda" if namespace.device == "cuda" else "cpu"
    return Arguments(checkpoint=namespace.checkpoint, device=device, audio=namespace.audio)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def check_checkpoint(path: Path) -> None:
    if not path.is_file():
        raise PinCheckError(f"checkpoint is not a local file: {path}")
    size = path.stat().st_size
    if size != PINNED_CHECKPOINT_BYTES:
        raise PinCheckError(f"checkpoint is {size} bytes; final0 is {PINNED_CHECKPOINT_BYTES}")
    actual = sha256_file(path)
    if actual != PINNED_CHECKPOINT_SHA256:
        raise PinCheckError(f"checkpoint SHA-256 {actual} is not final0 {PINNED_CHECKPOINT_SHA256}")


def string_field(data: object, *keys: str) -> str | None:
    """`data[keys[0]][keys[1]]...` when every level is a JSON object and the leaf is a string."""
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = cast(dict[str, object], current).get(key)
    return current if isinstance(current, str) else None


def recorded_commit(direct_url: str | None) -> str | None:
    """The commit an installation records in direct_url.json, if any."""
    if direct_url is None:
        return None
    data: object = json.loads(direct_url)
    if (commit := string_field(data, "vcs_info", "commit_id")) is not None:
        return commit
    url = string_field(data, "url")
    if url is not None and (match := ARCHIVE_URL.match(url)):
        return match.group(1)
    return None


def check_package() -> None:
    try:
        distribution = importlib.metadata.distribution("beat-this")
    except importlib.metadata.PackageNotFoundError as error:
        raise PinCheckError("beat-this is not installed in this interpreter") from error
    if distribution.version != PINNED_VERSION:
        raise PinCheckError(
            f"beat-this {distribution.version} installed; {PINNED_VERSION} is pinned"
        )
    commit = recorded_commit(distribution.read_text("direct_url.json"))
    if commit is not None and commit != PINNED_COMMIT:
        raise PinCheckError(
            f"beat-this was installed from commit {commit}; {PINNED_COMMIT} is pinned"
        )


def check_device(device: Device) -> None:
    import torch

    if device == "cuda" and not torch.cuda.is_available():
        raise PinCheckError("--device cuda was requested but torch.cuda.is_available() is false")


def detect(arguments: Arguments) -> dict[str, object]:
    # beat_this ships no type information; its File2Beats returns two numpy arrays of seconds.
    from beat_this.inference import File2Beats  # pyright: ignore[reportMissingTypeStubs]

    started = time.perf_counter()
    tracker = File2Beats(
        checkpoint_path=str(arguments.checkpoint), device=arguments.device, dbn=False
    )
    result = cast(tuple[Iterable[float], Iterable[float]], tracker(str(arguments.audio)))
    beats, downbeats = result
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    return {
        "beats": [float(time_s) for time_s in beats],
        "downbeats": [float(time_s) for time_s in downbeats],
        "device": arguments.device,
        "elapsedMs": elapsed_ms,
    }


def main(argv: list[str]) -> int:
    try:
        arguments = parse_arguments(argv)
    except SystemExit as exit_:
        # argparse exits 0 for --help and 2 for bad arguments.
        return EXIT_USAGE if exit_.code not in (0, None) else 0
    try:
        check_checkpoint(arguments.checkpoint)
        check_package()
        check_device(arguments.device)
    except PinCheckError as error:
        print(f"beat_this_reference: pin check failed: {error}", file=sys.stderr)
        return EXIT_PIN_CHECK_FAILED
    try:
        result = detect(arguments)
    # Every failure inside beat_this/torch/soundfile is a run failure (exit 3), per the contract.
    except Exception as error:  # noqa: BLE001
        print(f"beat_this_reference: {error}", file=sys.stderr)
        return EXIT_RUN_FAILED
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
