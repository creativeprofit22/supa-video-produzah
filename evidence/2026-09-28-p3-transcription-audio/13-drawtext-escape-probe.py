"""Which drawtext quoting of an apostrophe does FFmpeg accept inside -filter_complex?

Found by the step-13 in-app run: a real caption ("it's almost an obligation.")
made the final export fail. Run: python 13-drawtext-escape-probe.py
"""
import os
import subprocess
import tempfile

FONT = r"fontfile='C\:/Windows/Fonts/arialbd.ttf'"
BS = "\\"
Q = "'"

CASES = {
    # What the app emitted: backslash-quote inside a single-quoted value.
    "app before fix": Q + "it" + BS + Q + "s" + Q,
    # Close the quote, escape the apostrophe, reopen.
    "close/escape/reopen": Q + "it" + Q + BS + Q + Q + "s" + Q,
    # Same, with the extra filtergraph-level escaping of the backslash.
    "close/double-escape/reopen": Q + "it" + Q + BS + BS + BS + Q + Q + "s" + Q,
}


def run(text: str, out: str) -> tuple[int, str]:
    graph = f"[0:v]drawtext={FONT}:text={text}:fontsize=30[v]"
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=s=400x60:d=0.1",
         "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", "-y", out],
        capture_output=True,
        check=False,
    )
    return result.returncode, result.stderr.decode("utf-8", "replace").strip()[:100]


with tempfile.TemporaryDirectory() as scratch:
    for name, text in CASES.items():
        print(f"{name:28} {text:22} -> {run(text, os.path.join(scratch, 'q.png'))}")


# Correctness, not just parsing: draw the shared TS/Rust golden sample through
# each escaper, and compare pixels with the same text drawn from a plain file
# (textfile + expansion=none, so no escaping is involved at all).
SAMPLE = "It" + Q + "s 50%, [ok];\nC:" + BS + "path"
FONT_OPTS = FONT + ":fontsize=24:fontcolor=white:line_spacing=7:x=8:y=8:expansion=none"


def quoted_close_reopen(text: str) -> str:
    """Escaping inside '...' for drawtext: backslash doubles, a quote closes and
    reopens the value (' \\' '), and , ; [ ] : need no escape while quoted."""
    return Q + text.replace(BS, BS + BS).replace(Q, Q + BS + Q + Q) + Q


def quoted_app_before_fix(text: str) -> str:
    return Q + (
        text.replace(BS, BS + BS).replace(Q, BS + Q).replace(":", BS + ":")
        .replace("%", BS + "%").replace(",", BS + ",").replace(";", BS + ";")
        .replace("[", BS + "[").replace("]", BS + "]")
    ) + Q


def render(option: str, out: str) -> tuple[int, bytes]:
    graph = f"[0:v]drawtext={FONT_OPTS}:{option}[v]"
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=s=420x90:d=0.1",
         "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", "-f", "rawvideo",
         "-pix_fmt", "gray", "-y", out],
        capture_output=True,
        check=False,
    )
    data = open(out, "rb").read() if result.returncode == 0 else b""
    return result.returncode, data


print()
with tempfile.TemporaryDirectory() as scratch:
    literal = os.path.join(scratch, "sample.txt")
    with open(literal, "w", encoding="utf-8", newline="") as handle:
        handle.write(SAMPLE)
    textfile = "textfile=" + Q + literal.replace(BS, "/").replace(":", BS + ":") + Q
    _, reference = render(textfile, os.path.join(scratch, "ref.raw"))
    for name, escaper in [("app before fix", quoted_app_before_fix), ("close/reopen fix", quoted_close_reopen)]:
        code, pixels = render("text=" + escaper(SAMPLE), os.path.join(scratch, "t.raw"))
        same = code == 0 and pixels == reference
        print(f"golden sample, {name:18} exit={code} pixels identical to literal text: {same}")
