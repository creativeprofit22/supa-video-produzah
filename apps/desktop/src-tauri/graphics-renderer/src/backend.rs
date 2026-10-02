//! Render backend selection: Skia on Vulkan (GPU) or tiny-skia (CPU).

use std::fmt;

use fframes::{CpuFrameRenderer, FrameRenderer};
use fframes_skia_renderer::{SkiaFrameRenderer, vulkan::SkiaVulkanCtx};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendChoice {
    /// GPU when it initialises and renders, otherwise CPU.
    Auto,
    Gpu,
    Cpu,
}

/// Default when `--backend` is omitted. docs/benchmarks/graphics-render.md: GPU median 66 %
/// faster than CPU at 1080×1920, so GPU-first with CPU fallback.
pub const DEFAULT_BACKEND: BackendChoice = BackendChoice::Auto;

impl BackendChoice {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "gpu" => Some(Self::Gpu),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Gpu,
    Cpu,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gpu => "gpu",
            Self::Cpu => "cpu",
        }
    }
}

impl fmt::Display for BackendKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Owns the GPU context the Skia renderer borrows.
pub struct Backend {
    vulkan: Option<SkiaVulkanCtx>,
    /// Why the GPU was not used under `auto`, if it was not.
    pub gpu_fallback_reason: Option<String>,
}

impl Backend {
    /// Opens the requested backend. `gpu` fails when Vulkan cannot initialise; `auto` falls back.
    pub fn open(choice: BackendChoice, width: u32, height: u32) -> Result<Self, String> {
        if choice == BackendChoice::Cpu {
            return Ok(Self::cpu(None));
        }
        match open_vulkan(width, height) {
            Ok(vulkan) => Ok(Self {
                vulkan: Some(vulkan),
                gpu_fallback_reason: None,
            }),
            Err(reason) if choice == BackendChoice::Auto => Ok(Self::cpu(Some(reason))),
            Err(reason) => Err(format!("GPU backend unavailable: {reason}")),
        }
    }

    pub fn cpu(gpu_fallback_reason: Option<String>) -> Self {
        Self {
            vulkan: None,
            gpu_fallback_reason,
        }
    }

    pub fn kind(&self) -> BackendKind {
        if self.vulkan.is_some() {
            BackendKind::Gpu
        } else {
            BackendKind::Cpu
        }
    }

    pub fn renderer(&self) -> Box<dyn FrameRenderer + '_> {
        match &self.vulkan {
            Some(vulkan) => Box::new(SkiaFrameRenderer::new(vulkan)),
            None => Box::new(CpuFrameRenderer::default()),
        }
    }
}

/// Vulkan loader and driver failures surface as errors, but a broken driver can also panic
/// inside the bindings; both count as "no GPU".
fn open_vulkan(width: u32, height: u32) -> Result<SkiaVulkanCtx, String> {
    let attempt = std::panic::catch_unwind(|| SkiaVulkanCtx::new(width as usize, height as usize));
    match attempt {
        Ok(Ok(vulkan)) => Ok(vulkan),
        Ok(Err(error)) => Err(one_line(&error.to_string())),
        Err(_) => Err("Vulkan initialisation panicked".to_owned()),
    }
}

/// Skia's errors span several lines; the summary carries them as one.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_backend_choices() {
        let cases = [
            ("auto", Some(BackendChoice::Auto)),
            ("gpu", Some(BackendChoice::Gpu)),
            ("cpu", Some(BackendChoice::Cpu)),
            ("GPU", None),
            ("", None),
        ];
        for (input, expected) in cases {
            assert_eq!(BackendChoice::parse(input), expected, "{input}");
        }
    }

    #[test]
    fn cpu_choice_never_touches_the_gpu() {
        let backend = Backend::open(BackendChoice::Cpu, 64, 64).unwrap();

        assert_eq!(backend.kind(), BackendKind::Cpu);
        assert_eq!(backend.gpu_fallback_reason, None);
    }
}
