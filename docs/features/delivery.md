# Review and Deliver

Every export is quality-checked before it is promoted. Deliver renders the reviewed revision into each output format.

## Export and quality checks

1. The app computes an **editorial evaluation** for the exact revision being exported (repeated shots, beats without picture, must-show / must-not-show, missing media) and sends it with the render request. The worker rejects a missing, malformed or mismatched evaluation with `invalid_editorial_evaluation` before encoding anything.
2. After encoding, probe validation and loudness verification, one supervised FFmpeg pass runs `blackdetect`, `freezedetect`, `silencedetect`, `astats` and `ebur128` on the partial output. Caption cues are checked against duration and the frame's safe area.
3. Native and editorial findings are merged into the immutable `<output>.manifest.json`, which is written atomically before the output is promoted.

| Situation                                  | Output       | Result                            |
| ------------------------------------------ | ------------ | --------------------------------- |
| Blockers on a review export                | Promoted     | `completed`, `qc.status: blocked` |
| New unaccepted blocker on a Deliver preset | Not promoted | `qc_release_blocked`              |
| QC pass crashes, fails or times out        | Not promoted | `qc_unavailable`                  |
| Cancel during QC                           | Not promoted | `cancelled` after cleanup         |
| Manifest write fails                       | Not promoted | `manifest_write`                  |

## Review

The Review panel lists findings with their timeline range (click to seek). For each finding you can:

- **Suggest a fix** — silence findings offer a repair through the normal suggestion/approval flow; at most three attempts per finding.
- **Stop fixing** — records that repair stopped.
- **Accept anyway** — requires a reason. Rights findings can never be accepted.

Decisions go to the append-only `<output>.review.jsonl`. Each line is bound to the output and manifest digests, so a changed export or a hand-edited line makes the record invalid (fail closed).

## Deliver

Deliver is available only when the review export is **releasable** (every blocker accepted) and the open project still has the reviewed content (same state hash). For each selected preset — 16:9 1920×1080, 9:16 1080×1920, 1:1 1080×1080 (H.264/AAC MP4) — it:

- re-runs the rights gate, the editorial evaluation and the full QC pass;
- carries over accepted findings by id (ids exclude frame size), and fails the preset on any new unaccepted blocker;
- writes the output, its own manifest (referencing the review manifest and the accepted decision ids), a JPEG thumbnail, `metadata.json`, and SRT/VTT caption sidecars when the sequence has captions.

## Release build

- `node scripts/license-inventory.mjs [--check]` regenerates/checks `apps/desktop/src-tauri/licenses/THIRD_PARTY_LICENSES.md` (npm + cargo; fails on unknown or denied licenses). It ships in the bundle next to the FFmpeg notices.
- A panic writes a redacted local report to app-local data `crash-reports/`. The next launch shows it once. Nothing is sent anywhere.
- `node scripts/release-smoke/release-smoke.mjs --msi <msi> --out <dir> [--installer-only]` extracts the unsigned MSI, checks bundled resources and hashes, launches it, requires zero CSP violations, and (without `--installer-only`) drives export → Review → Deliver on a broken fixture. Run the full scenario on a build with a separate app identifier (for example `--config '{"identifier":"com.supavideo.producer.releasesmoke"}'`) so your real app state is never touched.

## Not included (recorded decisions, 1 Oct 2026)

- No auto-updater: single-user personal app with no signing key or update host.
- No C2PA signing: the readable manifest plus credits sidecars is the provenance record.
- Public distribution belongs to the "Release gate · public-distribution legal approval" phase.
