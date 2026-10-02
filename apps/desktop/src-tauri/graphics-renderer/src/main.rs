//! `supa-graphics-render`: renders a graphics description to transparent PNG frames.
//!
//! ```text
//! supa-graphics-render render --description <json> --frames-dir <dir> [--backend auto|gpu|cpu]
//! supa-graphics-render bench --font <ttf> [--seconds 10] [--width 1080] [--height 1920]
//!                            [--fps 30] [--backend auto|gpu|cpu] [--runs 3]
//! ```
//!
//! stdout carries line records in FFmpeg's `-progress` shape: `frame=<n>` then `progress=continue`
//! per written frame, and finally `summary=<json>` then `progress=end`.
//! Exit codes: 0 success, 2 invalid input or usage, 3 render failure.

mod backend;
mod description;
mod render;
mod video;

use std::{
    fs,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Instant,
};

use backend::{BackendChoice, DEFAULT_BACKEND};
use description::GraphicsDescription;
use render::{RenderError, hex, render_frames};
use serde::Serialize;
use sha2::{Digest, Sha256};

const EXIT_INVALID_INPUT: u8 = 2;
const EXIT_RENDER_FAILURE: u8 = 3;

enum Failure {
    Input(String),
    Render(String),
}

impl From<RenderError> for Failure {
    fn from(error: RenderError) -> Self {
        match error {
            RenderError::Input(reason) => Self::Input(reason),
            RenderError::Render(reason) => Self::Render(reason),
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("render") => run_render(&args[1..]),
        Some("bench") => run_bench(&args[1..]),
        _ => Err(Failure::Input(
            "usage: supa-graphics-render <render|bench> [options]".to_owned(),
        )),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Input(reason)) => {
            eprintln!("invalid input: {reason}");
            ExitCode::from(EXIT_INVALID_INPUT)
        }
        Err(Failure::Render(reason)) => {
            eprintln!("render failed: {reason}");
            ExitCode::from(EXIT_RENDER_FAILURE)
        }
    }
}

type Flags<'a> = Vec<(&'a str, &'a str)>;

/// `--key value` pairs; every key must be known and appear once.
fn parse_flags<'a>(args: &'a [String], known: &[&str]) -> Result<Flags<'a>, Failure> {
    let mut flags: Flags<'a> = Vec::new();
    let mut iter = args.iter();
    while let Some(key) = iter.next() {
        let name = key
            .strip_prefix("--")
            .filter(|name| known.contains(name))
            .ok_or_else(|| Failure::Input(format!("unknown argument {key:?}")))?;
        if flags.iter().any(|(existing, _)| *existing == name) {
            return Err(Failure::Input(format!("--{name} given twice")));
        }
        let value = iter
            .next()
            .ok_or_else(|| Failure::Input(format!("--{name} needs a value")))?;
        flags.push((name, value));
    }
    Ok(flags)
}

fn flag<'a>(flags: &[(&str, &'a str)], name: &str) -> Option<&'a str> {
    flags
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| *value)
}

fn required<'a>(flags: &[(&str, &'a str)], name: &str) -> Result<&'a str, Failure> {
    flag(flags, name).ok_or_else(|| Failure::Input(format!("--{name} is required")))
}

fn backend_flag(flags: &[(&str, &str)]) -> Result<BackendChoice, Failure> {
    match flag(flags, "backend") {
        None => Ok(DEFAULT_BACKEND),
        Some(value) => BackendChoice::parse(value).ok_or_else(|| {
            Failure::Input(format!("--backend must be auto, gpu or cpu, got {value:?}"))
        }),
    }
}

fn number(
    flags: &[(&str, &str)],
    name: &str,
    default: u32,
    range: std::ops::RangeInclusive<u32>,
) -> Result<u32, Failure> {
    let Some(value) = flag(flags, name) else {
        return Ok(default);
    };
    value
        .parse::<u32>()
        .ok()
        .filter(|parsed| range.contains(parsed))
        .ok_or_else(|| Failure::Input(format!("--{name} must be an integer in {range:?}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderSummary<'a> {
    schema_version: u32,
    backend: &'a str,
    gpu_fallback_reason: Option<&'a str>,
    width: u32,
    height: u32,
    frame_rate: description::FrameRate,
    frames: u32,
    description_sha256: String,
    elapsed_ms: u128,
    frame_sha256: &'a [String],
}

fn run_render(args: &[String]) -> Result<(), Failure> {
    let flags = parse_flags(args, &["description", "frames-dir", "backend"])?;
    let description_path = PathBuf::from(required(&flags, "description")?);
    let frames_dir = PathBuf::from(required(&flags, "frames-dir")?);
    let choice = backend_flag(&flags)?;

    let bytes = fs::read(&description_path)
        .map_err(|error| Failure::Input(format!("cannot read description: {}", error.kind())))?;
    let description_sha256 = hex(&Sha256::digest(&bytes));
    let description =
        GraphicsDescription::parse(&bytes).map_err(|error| Failure::Input(error.to_string()))?;
    prepare_frames_dir(&frames_dir)?;

    let started = Instant::now();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let report = render_frames(&description, choice, |index, frame| {
        let path = frames_dir.join(format!("{index:06}.png"));
        write_png(&path, frame.width, frame.height, &frame.pixels)?;
        writeln!(out, "frame={index}\nprogress=continue").map_err(|error| error.to_string())?;
        out.flush().map_err(|error| error.to_string())
    })?;
    let summary = RenderSummary {
        schema_version: 1,
        backend: report.backend.as_str(),
        gpu_fallback_reason: report.gpu_fallback_reason.as_deref(),
        width: description.canvas.width,
        height: description.canvas.height,
        frame_rate: description.frame_rate,
        frames: report.frames,
        description_sha256,
        elapsed_ms: started.elapsed().as_millis(),
        frame_sha256: &report.frame_sha256,
    };
    let json =
        serde_json::to_string(&summary).map_err(|error| Failure::Render(error.to_string()))?;
    writeln!(out, "summary={json}\nprogress=end")
        .and_then(|()| out.flush())
        .map_err(|error| Failure::Render(format!("cannot write summary: {error}")))
}

/// The frames directory must exist and be empty, so stale frames can never leak into an overlay.
fn prepare_frames_dir(dir: &Path) -> Result<(), Failure> {
    let mut entries = fs::read_dir(dir)
        .map_err(|error| Failure::Input(format!("cannot open --frames-dir: {}", error.kind())))?;
    if entries.next().is_some() {
        return Err(Failure::Input("--frames-dir must be empty".to_owned()));
    }
    Ok(())
}

fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let file = fs::File::create(path)
        .map_err(|error| format!("cannot create {}: {error}", path.display()))?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(rgba)
        .map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchSummary {
    backend: String,
    width: u32,
    height: u32,
    fps: u32,
    frames: u32,
    runs_ms: Vec<u128>,
    median_ms: u128,
    median_fps: f64,
}

/// Renders a synthetic description (rects + text, all animated) without writing frames, so the
/// timing is the render engine's, not PNG encoding's.
fn run_bench(args: &[String]) -> Result<(), Failure> {
    let flags = parse_flags(
        args,
        &[
            "seconds", "width", "height", "fps", "backend", "runs", "font",
        ],
    )?;
    let seconds = number(&flags, "seconds", 10, 1..=60)?;
    let width = number(&flags, "width", 1080, 2..=description::MAX_CANVAS_SIZE)?;
    let height = number(&flags, "height", 1920, 2..=description::MAX_CANVAS_SIZE)?;
    let fps = number(&flags, "fps", 30, 1..=description::MAX_FRAME_RATE)?;
    let runs = number(&flags, "runs", 3, 1..=10)?;
    let choice = backend_flag(&flags)?;
    let font = required(&flags, "font")?;

    let frames = seconds * fps;
    let json = bench_description(width, height, fps, frames, font);
    let description = GraphicsDescription::parse(json.as_bytes())
        .map_err(|error| Failure::Input(error.to_string()))?;

    let mut runs_ms = Vec::new();
    let mut backend = String::new();
    for _ in 0..runs {
        let started = Instant::now();
        let report = render_frames(&description, choice, |_, frame| {
            std::hint::black_box(&frame.pixels);
            Ok(())
        })?;
        runs_ms.push(started.elapsed().as_millis());
        backend = report.backend.as_str().to_owned();
    }
    let mut sorted = runs_ms.clone();
    sorted.sort_unstable();
    let median_ms = sorted[sorted.len() / 2];
    let summary = BenchSummary {
        backend,
        width,
        height,
        fps,
        frames,
        median_fps: f64::from(frames) * 1000.0 / median_ms.max(1) as f64,
        runs_ms,
        median_ms,
    };
    let json =
        serde_json::to_string(&summary).map_err(|error| Failure::Render(error.to_string()))?;
    println!("{json}");
    Ok(())
}

fn bench_description(width: u32, height: u32, fps: u32, frames: u32, font: &str) -> String {
    let end = frames - 1;
    let (w, h) = (f64::from(width), f64::from(height));
    let mut layers = Vec::new();
    for row in 0..8u32 {
        let y = h * f64::from(row + 1) / 10.0;
        layers.push(serde_json::json!({
            "kind": "rect", "width": w * 0.6, "height": h / 14.0,
            "cornerRadius": 24.0, "fill": "#2050d0",
            "x": {"keyframes": [{"frame": 0, "value": -w * 0.6, "easing": "easeOut"},
                                {"frame": end, "value": w * 0.2}]},
            "y": {"keyframes": [{"frame": 0, "value": y}]},
            "opacity": {"keyframes": [{"frame": 0, "value": 0.3}, {"frame": end, "value": 1.0}]}
        }));
        layers.push(serde_json::json!({
            "kind": "text", "text": format!("Benchmark line {row}"), "fontSize": h / 30.0,
            "fill": "#ffffff",
            "x": {"keyframes": [{"frame": 0, "value": w * 0.25}]},
            "y": {"keyframes": [{"frame": 0, "value": y + h / 22.0},
                                {"frame": end, "value": y + h / 20.0, "easing": "easeInOut"}]},
            "opacity": {"keyframes": [{"frame": 0, "value": 1.0}]}
        }));
    }
    serde_json::json!({
        "schemaVersion": 1,
        "canvas": {"width": width, "height": height},
        "frameRate": {"numerator": fps, "denominator": 1},
        "durationFrames": frames,
        "font": {"file": font, "family": "Arial"},
        "layers": layers
    })
    .to_string()
}
