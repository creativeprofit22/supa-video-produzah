# Phase 1 Windows Evidence

## Status

**Step 18 runtime proof is complete at HEAD `1228855703f62c83739131f56088ee59896537b6`; exact-SHA CI is green.**

The current release executable reran the paths changed after the original completion commit: native create/import, controlled playback, unsaved-draft discard guarding, exact `[5, 50)` Apply/Undo/Redo, verified export/reopen, missing-source detection, relink-required status, and exact source regrant. The unchanged original proof remains authoritative for collision cancel/replace, long-render cancellation/process/partial cleanup, minimum-window/320px/200% reflow, and the broader accessibility matrix.

## Environment

- Original proof date: 25 July 2026
- Targeted HEAD rerun: 25 July 2026
- Baseline commit before the completion change: `595fa8fef0f577e5a78ecd8b69673224ff580549`
- Original completion commit: `4146ac0480b92fe0c9a0201d50b36d0384b640b6`
- Current verified HEAD: `1228855703f62c83739131f56088ee59896537b6`
- Exact-SHA CI: GitHub Actions run [`30189534426`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30189534426), TypeScript, Linux Rust, Windows MSVC, and Tauri assembly all green
- OS: Windows, MSVC/Tauri production executable
- Node: `v22.20.0`
- pnpm: `10.34.5`
- Rust: `rustc 1.92.0`, `cargo 1.92.0`
- FFmpeg and FFprobe: `8.1.2-full_build-www.gyan.dev`
- Original neutral runtime directory: `C:\svp-phase1-evidence`
- Targeted rerun directory: `C:\svp-phase1-head-evidence`
- Source: copied canonical self-generated fixture `single-clip.mp4`

## Commands and gates

Passed locally:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm lint
pnpm format:check
cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --locked --all-targets --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --features tauri-ipc-test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --all-features --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored --nocapture
cargo tree --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -e features -i tauri
pnpm --dir apps/desktop tauri build --no-bundle --ci
git diff --check
```

- TypeScript source tests: 159 unique passes (40 contracts, 5 project, 9 render, 105 desktop).
- Rust default: 63 passes.
- Rust `tauri-ipc-test`: 69 passes.
- Real FFmpeg: all eight ignored integrations pass unchanged.
- Process-tree timeout and cancellation: 20 targeted repetitions each before feature work and 20 each after the original full gate; complete feature suite passed ten consecutive Windows repetitions in both runs.
- Cargo feature graph includes `tauri/protocol-asset` and `http-range`.
- Release executable: `apps/desktop/src-tauri/target/release/supa-video-desktop.exe`.

## Real workflow observed

1. Launched the production no-bundle executable at 1280 by 800.
2. Confirmed the no-project/tool-ready opener.
3. Used the native save picker to create `C:\svp-phase1-evidence\phase1.svpvideo`.
4. Used the native source picker to choose the copied canonical fixture.
5. Observed the validated proxy and thumbnail in the real Tauri WebView.
6. Played and paused the proxy; exercised frame navigation.
7. Entered exact source range `[5, 50)`, applied one trim, then used Undo and Redo. The saved project grew from 5,454 to 7,677 bytes and reopened with frames 5 through 50.
8. Exported `phase1-trim.mp4` through the product.
9. Re-selected the existing output, cancelled the product overwrite dialog with Escape, then repeated and confirmed replacement.
10. Observed the verified output report and selected the controlled final preview.
11. Opened a disposable 600-second AV project with a unique source/output stem and 3840×2160 render target, started a real FFmpeg export, invoked Cancel through the UI, and waited for settlement.
12. Captured the matching FFmpeg PID/parent/command line before cancellation, then proved after cancellation: zero matching `ffmpeg.exe`, zero `.svp-part-*`/`.temp-render.mp4`, and no final output.

### Targeted current-HEAD rerun

1. Built the no-bundle release executable from HEAD and launched it on Windows.
2. Created `C:\svp-phase1-head-evidence\head-step18.svpvideo` through the native picker and imported the canonical fixture copy.
3. Observed and played/paused the controlled proxy, then entered an unsaved trim and opened/cancelled the new-project discard dialog.
4. Applied exact `[5, 50)`, invoked persisted Undo and Redo, exported `head-step18-trim.mp4`, and reopened the project.
5. Verified H.264/yuv420p 320×180 video at 30/1, AAC 48 kHz mono audio, 60,508 bytes, and exactly 1.5 seconds with ffprobe.
6. Removed the source temporarily, reopened to the real missing-source state, restored the file, reopened to the real relink-required state, and completed exact native source regrant without changing the saved locator.
7. Captured current-HEAD editor, discard, trim, export, reopen, missing-source, relink-required, and source-regrant states under this evidence directory.

## External output proof

`ffprobe` reported:

```json
{
  "video": {
    "codec": "h264",
    "pixelFormat": "yuv420p",
    "width": 320,
    "height": 180,
    "rate": "30/1"
  },
  "audio": {
    "codec": "aac",
    "sampleRate": 48000,
    "channels": 1
  },
  "durationSeconds": 1.5,
  "sizeBytes": 60508
}
```

This exactly matches the known fixture trim `[5, 50)` at 30 fps: 45 frames or 1.5 seconds.

SHA-256:

```text
24068bdff2b768ba39b993c0a02c2599b33b5cef1681602effef72c1ae6217  phase1.svpvideo
b8385b8f8098ae7f9cc0a5fac25bee6fc3a3d76c1daa827bbb847c34b09cbcaf  phase1-trim.mp4
b8dd67e6936cae69d43653f1515b0e3cbd79991bd34084ab9c9fe26d8e4ac714  head-step18.svpvideo
b8385b8f8098ae7f9cc0a5fac25bee6fc3a3d76c1daa827bbb847c34b09cbcaf  head-step18-trim.mp4
```

## Captures

- `runtime-initial.png`: real 1280 by 800 no-project/tool-ready state.
- `runtime-project-empty.png`: real empty persisted project.
- `runtime-editor.png`: real 1280 by 800 prepared editor.
- `runtime-editor-1920x1080.png`: maximized prepared editor after trim/Undo/Redo/playback.
- `runtime-success-1920x1080.png`: verified export facts and final-preview mode.
- `runtime-success-480x360.png`: real minimum-window reflow with no horizontal page scrollbar.
- `runtime-reflow-320-css.png`: 320 CSS-pixel equivalent reflow; single semantic column, visible project actions, no horizontal page scrollbar.
- `runtime-200-percent-text.png`: 200% text/zoom stress at the minimum native window; content wraps and primary actions remain available.
- `runtime-app-collision-dialog.png`: product modal overwrite confirmation with background inert/dimmed.
- `cancel-running.png` and `runtime-cancelled.png`: real long render before and after UI cancellation.
- `state-missing-tools.png`, `state-malformed-project.png`, and `state-missing-source.png`: representative real recovery states.
- `accessibility-keyboard-focus.png`: visible focus at 200% text.
- `head-discard-dialog.png`: current-HEAD unsaved-draft discard guard.
- `head-trim-applied.png`, `head-export-success.png`, and `head-reopen-success.png`: current-HEAD exact trim, verified export, and reopen path.
- `head-missing-source.png`, `head-source-recovered.png`, and `head-source-regrant-complete.png`: current-HEAD missing-source, relink-required, and completed regrant states.
- `head-output-ffprobe.json` and `head-output-sha256.txt`: machine-readable current-HEAD output proof.

The 1920 captures are full 2560 by 1440 desktop captures because the available Windows display is 2560 by 1440; the maximized app content rail is fully visible.

## Accessibility and state matrix

| Check                                                                           | Result                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard path and focus                                                         | Passed real keyboard project/open/edit/navigation path; visible focus capture and shortcut suppression tests pass                                                                                                                         |
| Dialog safe initial focus, Escape, focus return                                 | Passed component tests and real Escape cancel/retry flow                                                                                                                                                                                  |
| Non-drag trim alternative                                                       | Passed; exact numeric inputs used in the real app                                                                                                                                                                                         |
| Axe opener/editor/error/running/dialog                                          | Zero applicable violations in all five rendered states                                                                                                                                                                                    |
| Cache-only media conversion                                                     | Passed component/integration tests; real proxy/final preview observed                                                                                                                                                                     |
| Native picker focus return                                                      | Passed repeatedly in the real create/open/source/export workflow                                                                                                                                                                          |
| 480 by 360 and 320 CSS-pixel reflow                                             | Passed captures; semantic column and vertical scrolling preserve primary actions                                                                                                                                                          |
| 200% text                                                                       | Passed capture at minimum native window; no horizontal page scroll or clipped primary action                                                                                                                                              |
| RTL/logical layout, localization, coarse pointer, reduced motion, forced colors | Passed explicit CSS/source contract and automated semantic/state tests; no layout uses physical left/right for core composition                                                                                                           |
| UIA/Windows semantics                                                           | Native landmarks/controls/labels/dialog/progress verified by axe and source; available raw PowerShell UIA walker exposed only the WebView document root, so Chromium child semantics are recorded from axe rather than falsely inferred   |
| Sticky pointer focus                                                            | Pointer and keyboard transitions exercised; focus-visible prevents sticky pointer rings                                                                                                                                                   |
| Failure/state matrix                                                            | Real missing tools, malformed project, missing source, invalid trim, missing media, collision, running/cancelling/cancelled/success; remaining typed preparation/save/render/preview branches pass adapter/controller/Rust recovery tests |
| Cancellation process/partial proof                                              | Passed: captured matching FFmpeg child before cancellation; `cancellation-cleanup.json` proves zero matching process, zero partials, and no final output after UI cancellation                                                            |

## Final evidence-led critique

Final rendered score: **24/24**.

| Criterion              | Score | Evidence                                                                                                                                     |
| ---------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief specificity      |     2 | Monitor, one track, exact frame trim, and verified MP4 report make the task unmistakable.                                                    |
| Information hierarchy  |     2 | Monitor, timeline, inspector, and Export follow the editing decision order.                                                                  |
| Composition            |     2 | Shared rail and stable monitor/inspector key lines remain coherent at desktop, minimum native size, 320px equivalent, and 200% text.         |
| Consistency and flow   |     2 | One button, border, type, icon, status, and recovery system carries through every captured state.                                            |
| Typography             |     2 | Geist and Geist Mono divide interface and exact technical values clearly under normal and 200% text.                                         |
| Material/surface logic |     2 | Flat dark media surfaces and one modal elevation have distinct reasons.                                                                      |
| State completeness     |     2 | Real state captures plus typed adapter/controller/component/Rust tests cover every specified recovery branch.                                |
| Responsive behavior    |     2 | 1280×800, maximized desktop, 480×360, 320 CSS-pixel equivalent, and 200% text evidence retain task order and actions.                        |
| Accessibility          |     2 | Native semantics, keyboard/non-drag alternatives, visible focus, axe zero-violation states, reduced motion, and forced-color contracts pass. |
| Motion purpose         |     2 | Resting UI is still; named feedback and reduced-motion rules exist.                                                                          |
| Content authenticity   |     2 | Only canonical/self-generated fixture data and neutral paths are shown.                                                                      |
| Visual distinctiveness |     2 | The exact-frame monitor/timeline/inspector chain remains recognizable across every viewport and state.                                       |

### Decorative removal and weakest-criterion revision

The prior radial page glow was removed and the canvas remains flat. The expanded state, cancellation, 320px, and 200% evidence closes the previous weakest criteria—state completeness, responsive behavior, accessibility, and distinctiveness—without adding decoration.

## Final exact-SHA CI

GitHub Actions run [`30189534426`](https://github.com/creativeprofit22/supa-video-produzah/actions/runs/30189534426) completed successfully for exact SHA `1228855703f62c83739131f56088ee59896537b6`. Green jobs:

- TypeScript contracts and desktop bundle
- Rust native project I/O on Linux
- Windows MSVC supervisor and Tauri production build

The current exact-SHA CI requirement passes.
