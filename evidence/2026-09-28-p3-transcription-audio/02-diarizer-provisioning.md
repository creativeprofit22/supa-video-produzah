# Step 2 · Speaker diarizer provisioning (user-authorized, 2026-09-28)

The user authorized the full-accuracy (f32) conversion, with every artifact kept on drive E:.

| Item | Value |
|---|---|
| Source model | `nvidia/diar_streaming_sortformer_4spk-v2` |
| Source revision | `84edd514b8ef68004c10086918cd62f2148cbd59` (the HF API `sha` at download time) |
| Licence | `cc-by-4.0` (HF model card `cardData.license`). Attribution to NVIDIA is required when redistributed. The app does not redistribute the model; users supply it. |
| Source file | `diar_streaming_sortformer_4spk-v2.nemo`, 471,367,680 bytes, sha256 `b371afce2c4958186469df33d939936b9746c89f38b10a69cfd2c61254e83329`. This matches the HF LFS pointer for the pinned revision (`paths-info` API). |
| Converter | `E:\nemo-runtime\src\convert_model.py` at NeMo-Speech.cpp `5be7bfb104802131e61fe679b3f1401b27270216`, run in an isolated Python 3.12 venv `E:\nemo-runtime\convert-venv` using the pinned `requirements.txt` (CPU torch 2.6) |
| Command | `convert_model.py nvidia/diar_streaming_sortformer_4spk-v2 --revision 84edd51… --cache-dir E:/nemo-runtime/convert-cache/hf/hub --outfile E:/nemo-runtime/model/sortformer-v2-f32.gguf` |
| Converter log | 990 tensors in, 969 emitted, 21 skipped; F32=947, F16=22; encoder d_model=512 ×17 layers, transformer 18 layers, num_speakers=4 |
| Output | `E:\nemo-runtime\model\sortformer-v2-f32.gguf`, 491,094,720 bytes, **sha256 `17ebac6c710753039820d7ec3580865fa29f29ccc2ca75ed69a7b21f1146579b`** |
| Caches | venv, uv cache, HF cache and TMP all under `E:\nemo-runtime\` (`convert-venv`, `convert-cache`) |

The Sortformer output hash is local: NVIDIA publishes only the `.nemo` checkpoint and a q8_0 GGUF, not an
f32 GGUF. So the manifest pins the hash of this conversion, and the source-checkpoint hash above is what
ties it to upstream. The conversion was not re-run to test determinism.
