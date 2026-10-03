# 0004 — Music beat detection in a Rust sidecar (ONNX, CUDA or CPU)

Beat This! used to run as Python: a user-built folder with a `uv` virtual environment, PyTorch (about 2.5 GB) and the `final0.ckpt` checkpoint, driven by a runner script the app wrote into its cache. We replaced that with `supa-beat-detect`, a Rust program built from `apps/desktop/src-tauri/beat-detector/`. It runs the **same final0 model**. That crate has its own `[workspace]` and `Cargo.lock`, and the Tauri app does not depend on it. The app runs it like the graphics renderer (ADR 0002): through `run_supervised`, with cancellation that kills the process. The installer bundles the executable as the `beat-detector/` resource.

The sidecar uses the `beat-this` crate pinned at `=1.1.0` (danigb/beat-this-rs @ `1ae768e7`, MIT). It ports the whole pipeline: the mel front end as an ONNX graph, 30 s chunked inference and minimal peak picking. It also exposes `Runtime`/`Model` traits, so we plug in our own backends:

- **CUDA:** ONNX Runtime 1.28.0 through the `ort` crate (`=2.0.0-rc.13`, `load-dynamic`). The CUDA provider is registered with `error_on_failure`, so a broken GPU setup reports an error instead of silently running on the CPU.
- **CPU:** the crate's `rten` backend, pure Rust and always available.

`--device auto` tries CUDA. On any CUDA error before results exist, it reruns on the CPU and says why. `cuda` and `cpu` are strict, and the tests use them.

ONNX Runtime and the CUDA libraries are not part of any build. They live in the user-chosen runtime folder as an optional **GPU pack** (`cuda/`): ONNX Runtime 1.28.0 `win-x64-gpu_cuda12`, plus the CUDA 12.8 runtime, cuBLAS and cuDNN 9.10.2 libraries from NVIDIA's redistributable archives. The sidecar preloads the pack by full path before loading ONNX Runtime, so `PATH` and any installed toolkit play no part. The models (`models/mel_spectrogram.onnx`, `models/beat_this.onnx`) are required.

`apps/desktop/src-tauri/src/video/beat-detect-runtime-manifest.json` (schema 2) pins every file, model and archive by SHA-256 and size. `scripts/bootstrap-beat-runtime-windows.ps1` fills the folder from it. The app checks every file in full when it verifies the folder, then probes the sidecar once. Before each run it re-hashes the models (about 83 MB). It also rechecks the GPU pack's sizes and modification times, and a changed pack runs that job on the CPU.

**Why the GPU pack looks like this.** We checked it on the development machine: GTX 1080, compute capability 6.1, driver 561.17.

- The ORT 1.28 CUDA 12 build includes real sm_61 kernels. Its CUDA 13 build starts at sm_75, so it is not an option.
- Without cuDNN, `BatchNormalization` is placed on CUDA and the first run fails. So cuDNN is required, despite ORT 1.28 calling it optional.
- With cuDNN 9, about 70 % of nodes run on CUDA; the rest are shape/index ops that ORT keeps on the CPU.

**Quality is proven, not assumed.**

- The parity tests compare the sidecar against a pinned Python reference: `beat-detector/reference/beat_this_reference.py`, which is test-only, never bundled, and checks the beat-this version, commit and checkpoint hash before it runs.
- The comparison covers a committed synthetic fixture (tempo changes and a 3/4 section) and ten real tracks. Python vs Rust CUDA, Python vs Rust CPU, and CPU vs CUDA all produced identical beat and downbeat lists (`docs/benchmarks/beat-detect.md`).
- Both sides read the same 22.05 kHz mono samples the app's ffmpeg step writes, so neither resamples. The sidecar rejects any other WAV format rather than converting it.
- The model's peaks fall on a 20 ms frame grid. The sidecar snaps its `f32` times back to that grid, so it reports the same `frame / 50` seconds as Python.

**Cache identity.** The detector version becomes `rs-1.1.0`, and `checkpointSha256` now holds the SHA-256 of `beat_this.onnx`, the weights that actually run. Analyses from the Python runner are therefore not reused, and assets are re-detected once. Device is not part of the key, because CUDA and CPU results are interchangeable (proven above).

**Speed** (GTX 1080; see the benchmark for numbers):

- For 3 and 10 minute tracks, Rust CUDA is faster than Python end to end, because there is no Python start-up.
- It is 3–7× faster than the Rust CPU path.
- For an hour of audio, PyTorch's fused attention kernels make the Python reference faster than ONNX Runtime CUDA. We accepted that for a single-user app: there is no Python runtime to install, and results are identical.

**Rejected:**

- **Linking the detector into the Tauri crate.** That would put `ort` and CUDA into every app build, the Linux CI job and cargo-audit. A GPU driver crash would take the app down. And a running inference call cannot be interrupted, while a process can be killed.
- **The `beat-this` crate's own `ort` feature.** It is hard-wired to CoreML and pinned to `ort =2.0.0-rc.12`.
- **ONNX Runtime's WebGPU provider.** It is not part of the CUDA package, and parity on it is unproven.
- **A full port to candle or burn.** It would mean re-implementing and re-proving the model, with no quality gain.
- **ORT's CUDA 13 builds.** They have no sm_61 kernels.
- **Keeping Python as the runtime.** Its 2.5 GB environment and runner script were the problem this replaces.

The Python reference stays in the repository, so parity can be proven again on any later crate, model or ONNX Runtime upgrade.
