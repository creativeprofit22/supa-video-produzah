//! Frame loop: description → fframes `Previewer` → backend → RGBA frames.

use std::{collections::HashMap, sync::Arc};

use fframes::{
    Color, DynamicMediaProvider, FrameRenderer, Previewer, RawFontData, RenderOptions, RgbaFrame,
    usvgr::fontdb,
};
use sha2::{Digest, Sha256};

use crate::{
    backend::{Backend, BackendChoice, BackendKind},
    description::GraphicsDescription,
    video::GraphicsVideo,
};

#[derive(Debug)]
pub struct RenderReport {
    pub backend: BackendKind,
    pub gpu_fallback_reason: Option<String>,
    pub frames: u32,
    /// SHA-256 of each frame's straight-alpha RGBA bytes, in frame order.
    pub frame_sha256: Vec<String>,
}

#[derive(Debug)]
pub enum RenderError {
    /// The description or its font could not be used.
    Input(String),
    /// Rendering or writing a frame failed.
    Render(String),
}

pub fn frame_sha256(frame: &RgbaFrame) -> String {
    hex(&Sha256::digest(&frame.pixels))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// usvg silently drops text whose family is missing from the font database, so a family that is
/// not in the loaded font file must fail as invalid input instead of rendering frames without text.
fn require_font_family(db: &fontdb::Database, family: &str) -> Result<(), RenderError> {
    let mut available: Vec<&str> = db
        .faces()
        .flat_map(|face| face.families.iter().map(|(name, _)| name.as_str()))
        .collect();
    // Exact match, like fontdb's own family lookup.
    if available.contains(&family) {
        return Ok(());
    }
    if available.is_empty() {
        return Err(RenderError::Input(
            "font file contains no usable font faces".to_owned(),
        ));
    }
    available.sort_unstable();
    available.dedup();
    let available = available
        .iter()
        .map(|name| format!("{name:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    Err(RenderError::Input(format!(
        "font family {family:?} is not in the font file; it contains {available}"
    )))
}

/// Renders every frame in order and hands each to `on_frame` (index, pixels).
pub fn render_frames(
    description: &GraphicsDescription,
    choice: BackendChoice,
    mut on_frame: impl FnMut(u32, &RgbaFrame) -> Result<(), String>,
) -> Result<RenderReport, RenderError> {
    let font_bytes = std::fs::read(&description.font.file)
        .map_err(|error| RenderError::Input(format!("cannot read font file: {}", error.kind())))?;
    let font_name = description
        .font
        .file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let media = DynamicMediaProvider::new(
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
        vec![RawFontData {
            file_name: font_name,
            data: Arc::new(font_bytes),
        }],
    );
    let options = RenderOptions {
        media: Some(&media),
        load_system_fonts: false,
        default_font: &description.font.family,
        ..RenderOptions::default()
    };
    let video = GraphicsVideo::new(description);
    let mut previewer = Previewer::new(&video, &options)
        .map_err(|error| RenderError::Render(format!("cannot prepare renderer: {error}")))?;
    require_font_family(previewer.font_db(), &description.font.family)?;
    let (width, height) = video.size();

    let mut backend = Backend::open(choice, width, height).map_err(RenderError::Render)?;
    let mut render = |frame: u32, renderer: &mut dyn FrameRenderer| {
        let tree = previewer
            .svg_tree(frame as usize)
            .map_err(|error| format!("frame {frame}: {error}"))?;
        renderer
            .render_tree(&tree, Color::TRANSPARENT, width, height)
            .map_err(|error| format!("frame {frame}: {error}"))
    };

    // Under `auto`, a GPU that initialised but cannot render the first frame still falls back.
    let first = render(0, backend.renderer().as_mut());
    let first = match first {
        Ok(frame) => frame,
        Err(reason) if choice == BackendChoice::Auto && backend.kind() == BackendKind::Gpu => {
            backend = Backend::cpu(Some(reason));
            render(0, backend.renderer().as_mut()).map_err(RenderError::Render)?
        }
        Err(reason) => return Err(RenderError::Render(reason)),
    };

    let mut hashes = Vec::with_capacity(video.duration_frames() as usize);
    hashes.push(frame_sha256(&first));
    on_frame(0, &first).map_err(RenderError::Render)?;
    drop(first);

    let mut renderer = backend.renderer();
    for index in 1..video.duration_frames() {
        let frame = render(index, renderer.as_mut()).map_err(RenderError::Render)?;
        hashes.push(frame_sha256(&frame));
        on_frame(index, &frame).map_err(RenderError::Render)?;
    }
    drop(renderer);

    Ok(RenderReport {
        backend: backend.kind(),
        gpu_fallback_reason: backend.gpu_fallback_reason.clone(),
        frames: video.duration_frames(),
        frame_sha256: hashes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn requires_the_font_family_to_be_in_the_font_file() {
        let mut arial = fontdb::Database::new();
        arial.load_font_data(std::fs::read(r"C:\Windows\Fonts\arial.ttf").unwrap());
        let empty = fontdb::Database::new();
        let cases: [(&str, &fontdb::Database, &str, Option<&str>); 4] = [
            ("match", &arial, "Arial", None),
            (
                "other family",
                &arial,
                "Helvetica",
                Some(r#"it contains "Arial""#),
            ),
            (
                "case differs",
                &arial,
                "arial",
                Some(r#""arial" is not in the font file"#),
            ),
            ("no faces", &empty, "Arial", Some("no usable font faces")),
        ];

        for (name, db, family, expected) in cases {
            let result = require_font_family(db, family);
            match (result, expected) {
                (Ok(()), None) => {}
                (Err(RenderError::Input(reason)), Some(fragment)) => {
                    assert!(reason.contains(fragment), "{name}: {reason}");
                }
                (other, _) => panic!("{name}: unexpected {other:?}"),
            }
        }
    }
}
