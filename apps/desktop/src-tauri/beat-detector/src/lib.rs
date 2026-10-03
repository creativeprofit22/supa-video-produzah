//! Beat and downbeat detection sidecar for Supa Video.
//!
//! Runs the Beat This! final0 model (via the `beat-this` crate's ONNX pipeline) on CUDA through
//! ONNX Runtime, or on the CPU through `rten`. See docs/adr/0004-music-beat-detection-sidecar.md.

pub mod cli;
pub mod cuda;
pub mod device;
pub mod parity;
pub mod wav;
