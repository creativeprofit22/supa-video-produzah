//! ONNX Runtime + CUDA backend for the `beat-this` pipeline.
//!
//! ONNX Runtime and the CUDA libraries are loaded at run time from a verified "GPU pack" folder,
//! never from `PATH`: the CUDA libraries are preloaded by full path before ONNX Runtime is
//! loaded, so the CUDA provider binds to them and not to whatever toolkit is installed.
//! The CUDA provider is registered with `error_on_failure`, so a broken GPU setup reports an
//! error instead of silently running on the CPU.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use beat_this::{Model, Runtime, Tensor};
use ort::ep::{self, ExecutionProvider};
use ort::logging::LoggerFunction;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;

/// ONNX Runtime library inside the GPU pack.
pub const ORT_LIBRARY: &str = "onnxruntime.dll";

/// CUDA libraries the CUDA provider links against, in load order (dependencies first).
pub const CUDA_LIBRARIES: &[&str] = &["cudart64_12.dll", "cublasLt64_12.dll", "cublas64_12.dll"];

/// Optional cuDNN 9 libraries, preloaded only when present in the pack (in load order).
pub const CUDNN_LIBRARIES: &[&str] = &[
    "cudnn64_9.dll",
    "cudnn_graph64_9.dll",
    "cudnn_ops64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
];

fn ort_err<R>(error: ort::Error<R>) -> anyhow::Error {
    anyhow!(error.to_string())
}

/// Loads ONNX Runtime and the CUDA libraries from `pack_dir` into this process.
///
/// Must run once, before any other ONNX Runtime call. Returns the libraries that were loaded.
pub fn load_gpu_pack(pack_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut loaded = Vec::new();
    for name in CUDA_LIBRARIES {
        let path = pack_dir.join(name);
        ort::util::preload_dylib(&path)
            .with_context(|| format!("could not load {}", path.display()))?;
        loaded.push(path);
    }
    if pack_dir.join(CUDNN_LIBRARIES[0]).is_file() {
        for name in CUDNN_LIBRARIES {
            let path = pack_dir.join(name);
            ort::util::preload_dylib(&path)
                .with_context(|| format!("could not load {}", path.display()))?;
            loaded.push(path);
        }
    }
    let ort_path = pack_dir.join(ORT_LIBRARY);
    let environment = ort::init_from(&ort_path)
        .map_err(|error| anyhow!("could not load {}: {error}", ort_path.display()))?
        .with_name("supa-beat-detect");
    // `commit` only reports whether this call created the environment; a second call in the
    // same process keeps the first environment, which is the same library.
    let _ = environment.commit();
    loaded.push(ort_path);
    Ok(loaded)
}

/// Whether the loaded ONNX Runtime build includes the CUDA provider.
pub fn cuda_provider_available() -> Result<bool> {
    ep::CUDA::default().is_available().map_err(ort_err)
}

/// `beat_this::Runtime` that runs every model on the CUDA execution provider.
pub struct OrtCudaRuntime {
    logger: Option<LoggerFunction>,
}

impl OrtCudaRuntime {
    /// A runtime for a process where [`load_gpu_pack`] already succeeded.
    pub fn new() -> Self {
        Self { logger: None }
    }

    /// Same as [`new`](Self::new), but routes ONNX Runtime's verbose session log (including
    /// node-to-provider placement) to `logger`. Diagnostics only.
    pub fn with_verbose_logger(logger: LoggerFunction) -> Self {
        Self {
            logger: Some(logger),
        }
    }
}

impl Default for OrtCudaRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime for OrtCudaRuntime {
    type Model = OrtCudaModel;

    fn load_model(&self, path: &Path) -> Result<OrtCudaModel> {
        let mut builder = Session::builder()
            .map_err(ort_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(ort_err)?;
        if let Some(logger) = &self.logger {
            builder = builder
                .with_logger(logger.clone())
                .map_err(ort_err)?
                .with_log_level(ort::logging::LogLevel::Verbose)
                .map_err(ort_err)?;
        }
        let session = builder
            .with_execution_providers([ep::CUDA::default().build().error_on_failure()])
            .map_err(ort_err)?
            .commit_from_file(path)
            .map_err(ort_err)
            .with_context(|| format!("could not load {} on CUDA", path.display()))?;
        Ok(OrtCudaModel { session })
    }
}

/// One ONNX Runtime session bound to the CUDA provider.
pub struct OrtCudaModel {
    session: Session,
}

impl Model for OrtCudaModel {
    fn run(&mut self, inputs: &[(&str, &Tensor)]) -> Result<HashMap<String, Tensor>> {
        let values = inputs
            .iter()
            .map(|(name, tensor)| {
                let view =
                    TensorRef::from_array_view((tensor.shape.clone(), tensor.data.as_slice()))
                        .map_err(ort_err)
                        .with_context(|| format!("input '{name}'"))?;
                Ok((*name, view))
            })
            .collect::<Result<Vec<_>>>()?;
        let outputs = self.session.run(values).map_err(ort_err)?;
        let mut result = HashMap::new();
        for (name, value) in outputs.iter() {
            let (shape, data) = value
                .try_extract_tensor::<f32>()
                .map_err(ort_err)
                .with_context(|| format!("output '{name}' is not f32"))?;
            let shape = shape
                .iter()
                .map(|&dimension| {
                    usize::try_from(dimension)
                        .map_err(|_| anyhow!("output '{name}' has a negative dimension"))
                })
                .collect::<Result<Vec<_>>>()?;
            result.insert(
                name.to_string(),
                Tensor {
                    shape,
                    data: data.to_vec(),
                },
            );
        }
        Ok(result)
    }
}
