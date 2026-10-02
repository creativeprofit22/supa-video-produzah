# Graphics render engine — GPU vs CPU benchmark

Recorded 2026-10-02 for phase 14 ("Graphics render engine on fframes"). Decides the default backend of `supa-graphics-render` (see `docs/adr/0002-graphics-render-engine.md`).

## Setup

- Machine: Intel Core i7-8700 @ 3.20 GHz, 24 GB RAM, Windows 10 Pro (build 19045)
- GPU: NVIDIA GeForce GTX 1080, 8 GB, driver 561.17, Vulkan via `C:\Windows\System32\vulkan-1.dll`
- Renderer: `supa-graphics-render` release build, fframes `7bbec1278c7687ac43f88524d9b149a31b7cfdf6`, rustc 1.97.1
- Workload: built-in `bench` description — 1080×1920, 30 fps, 10 s (300 frames), 8 rounded rects and 8 text lines (Arial), every layer animating position and/or opacity
- Measures render time only: the description → SVG tree → backend → RGBA frame in memory. PNG writing and FFmpeg encoding are excluded so the numbers compare the backends, not disk I/O.

```text
graphics-renderer/target/release/supa-graphics-render.exe bench --backend <gpu|cpu> \
  --seconds 10 --width 1080 --height 1920 --fps 30 --runs 3 --font 'C:\Windows\Fonts\arial.ttf'
```

## Results

| Backend              | Runs (ms)                | Median (ms) | Median fps |
| -------------------- | ------------------------ | ----------- | ---------- |
| GPU (Skia on Vulkan) | 13 689 · 13 625 · 13 353 | 13 625      | 22.0       |
| CPU (tiny-skia)      | 40 002 · 41 159 · 40 501 | 40 501      | 7.4        |

The GPU median wall time is 66 % lower than the CPU median (threshold for keeping GPU-first: ≥ 15 % lower).

## Decision

Default backend stays `auto`: Skia on Vulkan, falling back to the CPU renderer when Vulkan cannot initialise or the first frame fails on the GPU. The fallback was exercised by pointing the Vulkan loader at a missing driver manifest (`graphics_renderer_auto_falls_back_to_cpu_without_vulkan`).

GPU and CPU output differ only in edge antialiasing: against the CPU reference frames, the GPU render has ≤ 0.08 % of pixels off by more than 8 levels and a mean channel error ≤ 0.02 (`graphics_overlay_gpu_matches_reference_frames`). Re-renders on one backend are bit-identical (`graphics_overlay_render_is_deterministic`).
