# Step 1 · Runtime prerequisites (read-only inspection, 2026-09-28)

Commands run on this machine: `nvidia-smi`, `nvcc --version`, `vswhere -latest`, `where cmake ninja cl`,
bounded `find` (maxdepth 5, 120 s) over `E:\` and the user profile for `*nemotron*gguf` / `NeMo-Speech*`.

| Prerequisite | Found |
|---|---|
| GPU | NVIDIA GeForce GTX 1080, 8192 MiB, WDDM, bus 01:00.0 (compute capability 6.1 = lock `cudaArch: "61"`) |
| Driver | 561.17, CUDA runtime capability 12.6 |
| CUDA toolkit | v12.6 installed (`nvcc` V12.6.85) |
| Build tools | CMake, Ninja on PATH; MSVC 2022 Build Tools installed (`cl` only via developer shell) |
| NeMo-Speech.cpp build | Not found (search bounded; not exhaustive) |
| Pinned GGUF model (741,548,352 bytes) | Not found (search bounded; not exhaustive) |
| Free disk | E: 63 GB, C: 12 GB |

Conclusion: hardware and toolchain satisfy the pinned lock. Runtime and model are absent, so real GPU
proof (criterion 2) needs user authorization to clone/build NeMo-Speech.cpp at
`5be7bfb104802131e61fe679b3f1401b27270216` and download the pinned model
(`nvidia/nemotron-3.5-asr-streaming-0.6b@1c8deaecc64b91f034d73e08dd8b64625eb3395d`, q8_0, sha256
`a5c44d1dc9864b03935e21e0a3b0fcc8e77651e4f5273a1938cb42c01664e6cd`, license OpenMDW-1.1,
redistribution status UNRESOLVED per lock).

## Provisioning performed (user-authorized, 2026-09-28)

- NeMo-Speech.cpp cloned to `E:\nemo-runtime\src`, detached at `5be7bfb104802131e61fe679b3f1401b27270216`;
  commit, tree and all submodule SHAs matched the lock.
- Upstream `scripts/windows/build.ps1` could not run: the WinGet `ninja.exe` link on PATH is dangling. The same
  CMake options were applied through `E:\nemo-runtime\build-cuda.cmd` using Visual Studio's bundled Ninja,
  `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=61`.
- SentencePiece (required by the ASR target) was built static with MSVC at NVIDIA's own pinned commit
  `17d7580d6407802f85855d2cc9190634e2c95624` (from `scripts/build_sentencepiece_static.sh`).
- Model: `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf` at revision `1c8deae…`, 741,548,352 bytes.
  **sha256 `a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae`**. This matches the
  Hugging Face LFS pointer for the pinned revision but **differs from the 2026-08-09 lock's `a5c44d1d…`**
  (the byte length is identical). The runtime manifest pins the upstream-published hash. The lock's value
  was never tied to a local download (its GPU run was not executed), so treat it as a transcription error
  in the lock, not a tampered download. This is recorded, not silently corrected.
- Runtime folder `E:\nemo-runtime\runtime` holds the exe, the 5 ggml/NeMo DLLs, the CUDA 12.6
  `cudart64_12`/`cublas64_12`/`cublasLt64_12` DLLs (from `dumpbin /dependents`) and the model. Hashes are
  in `apps/desktop/src-tauri/src/video/nemo-runtime-manifest.json`.
- CLI smoke run (`smoke.out`, `smoke.err`, PATH stripped to System32): stderr logs
  `Using GPU backend: CUDA0` and the transcript text matches the JFK sample. This is **not** the
  production-path proof; that is step 10.
