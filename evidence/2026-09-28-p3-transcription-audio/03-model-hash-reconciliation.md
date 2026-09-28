# Step 3 · ASR model hash reconciliation (2026-09-28)

**Decision:** the verified hash is `a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae`. The
lock value `a5c44d1dc9864b03935e21e0a3b0fcc8e77651e4f5273a1938cb42c01664e6cd` is an erratum in the
2026-08-09 lock.

## Evidence (re-checked today)

| Source | sha256 |
|---|---|
| HF `paths-info` API, `nvidia/nemotron-3.5-asr-streaming-0.6b@1c8deaecc64b91f034d73e08dd8b64625eb3395d`, `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf` (LFS oid, size 741,548,352) | `a5c435f2…f429ae` |
| `sha256sum E:\nemo-runtime\model\…q8_0.gguf` | `a5c435f2…f429ae` |
| `sha256sum E:\nemo-runtime\runtime\…q8_0.gguf` (the copy the app loads) | `a5c435f2…f429ae` |
| `apps/desktop/src-tauri/src/video/nemo-runtime-manifest.json` (what the app enforces) | `a5c435f2…f429ae` |
| `evidence/2026-08-09-nemo-asr-machine-validation/provenance-lock.json:134` and 4 entries in `provenance-validation-fixtures.json` | `a5c44d1d…` (differs after the 5th hex digit) |

## Reasoning

- Upstream, both local copies and the enforced manifest agree. The byte size in the lock matches upstream,
  and only the hash differs.
- No code reads the 2026-08-09 lock (`git grep` outside `evidence/` finds only a ROADMAP formatting note),
  so the erratum has no runtime effect. The app refuses any model whose hash differs from the manifest.
- The lock is historical evidence and is **left unedited** so the record of what was written on
  2026-08-09 stays intact. This file is its erratum.
