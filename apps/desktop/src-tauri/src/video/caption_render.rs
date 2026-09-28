//! Native mirror of `packages/video-render/src/caption-render.ts`. The render
//! validator rebuilds the expected FFmpeg arguments from the plan and requires
//! byte-for-byte equality, so every string here must match the TS compiler.

use super::types::{RenderCaptionInput, RenderCaptionStyle};

/// Windows core fonts directory as FFmpeg sees it (forward slashes).
const FONT_DIRECTORY: &str = "C:/Windows/Fonts";
const BOX_BORDER_PX: u64 = 12;

/// Closed font-key → file table (mirrors `RENDER_CAPTION_FONT_FILES`).
pub(crate) fn caption_font_file(key: &str) -> Option<&'static str> {
    Some(match key {
        "arial-regular" => "arial.ttf",
        "arial-bold" => "arialbd.ttf",
        "arial-italic" => "ariali.ttf",
        "arial-bold-italic" => "arialbi.ttf",
        "segoe-ui-regular" => "segoeui.ttf",
        "segoe-ui-bold" => "segoeuib.ttf",
        "segoe-ui-italic" => "segoeuii.ttf",
        "segoe-ui-bold-italic" => "segoeuiz.ttf",
        "verdana-regular" => "verdana.ttf",
        "verdana-bold" => "verdanab.ttf",
        "verdana-italic" => "verdanai.ttf",
        "verdana-bold-italic" => "verdanaz.ttf",
        "georgia-regular" => "georgia.ttf",
        "georgia-bold" => "georgiab.ttf",
        "georgia-italic" => "georgiai.ttf",
        "georgia-bold-italic" => "georgiaz.ttf",
        "consolas-regular" => "consola.ttf",
        "consolas-bold" => "consolab.ttf",
        "consolas-italic" => "consolai.ttf",
        "consolas-bold-italic" => "consolaz.ttf",
        _ => return None,
    })
}

fn is_cue_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_rgba(value: &str) -> bool {
    value.len() == 9
        && value.starts_with('#')
        && value[1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Mirrors `renderCaptionStyleV1Schema` bounds.
pub(crate) fn valid_caption_style_fields(caption: &RenderCaptionInput) -> bool {
    if caption.cue_id.as_deref().is_some_and(|cue| !is_cue_id(cue)) {
        return false;
    }
    let Some(style) = &caption.style else {
        return true;
    };
    caption_font_file(&style.font).is_some()
        && (8..=400).contains(&style.font_size_px)
        && style.line_spacing_px <= 400
        && is_rgba(&style.color_rgba)
        && matches!(style.horizontal.as_str(), "left" | "center" | "right")
        && matches!(style.vertical.as_str(), "top" | "center" | "bottom")
        && style.anchor_x_permille <= 1_000
        && style.anchor_y_permille <= 1_000
        && style.safe_top_permille <= 400
        && style.safe_right_permille <= 400
        && style.safe_bottom_permille <= 400
        && style.safe_left_permille <= 400
}

pub(crate) fn escape_drawtext_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:")
        .replace('%', "\\%")
        .replace(',', "\\,")
        .replace(';', "\\;")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace("\r\n", "\\n")
        .replace(['\r', '\n'], "\\n")
}

/// Styled captions keep literal line breaks (drawtext renders them).
fn escape_styled_drawtext_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:")
        .replace('%', "\\%")
        .replace(',', "\\,")
        .replace(';', "\\;")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

/// Filter-option path escaping, separate from text escaping.
fn escape_drawtext_path(path: &str) -> String {
    path.replace('\\', "/")
        .replace('\'', "\\'")
        .replace(':', "\\:")
}

fn permille(value: u64) -> String {
    format!("{}.{:03}", value / 1_000, value % 1_000)
}

fn position_expressions(style: &RenderCaptionStyle) -> (String, String) {
    let border = BOX_BORDER_PX;
    let left = format!("w*{}+{border}", permille(style.safe_left_permille));
    let right = format!("w*(1-{})-{border}", permille(style.safe_right_permille));
    let top = format!("h*{}+{border}", permille(style.safe_top_permille));
    let bottom = format!("h*(1-{})-{border}", permille(style.safe_bottom_permille));
    let anchor_x = format!("w*{}", permille(style.anchor_x_permille));
    let anchor_y = format!("h*{}", permille(style.anchor_y_permille));
    let raw_x = match style.horizontal.as_str() {
        "left" => anchor_x,
        "right" => format!("{anchor_x}-text_w"),
        _ => format!("{anchor_x}-text_w/2"),
    };
    let raw_y = match style.vertical.as_str() {
        "top" => anchor_y,
        "bottom" => format!("{anchor_y}-text_h"),
        _ => format!("{anchor_y}-text_h/2"),
    };
    (
        format!("max({left}\\,min({raw_x}\\,{right}-text_w))"),
        format!("max({top}\\,min({raw_y}\\,{bottom}-text_h))"),
    )
}

pub(crate) fn caption_drawtext_filter(
    caption: &RenderCaptionInput,
    format_seconds: impl Fn(u64) -> String,
) -> String {
    let enable = format!(
        "enable='gte(t\\,{})*lt(t\\,{})'",
        format_seconds(caption.start_microseconds),
        format_seconds(caption.end_microseconds),
    );
    let Some(style) = &caption.style else {
        return format!(
            "drawtext=text='{}':fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:{enable}",
            escape_drawtext_text(&caption.text),
        );
    };
    // Validated earlier; an unknown key cannot reach here.
    let font_file = caption_font_file(&style.font).unwrap_or("arial.ttf");
    let fontfile = escape_drawtext_path(&format!("{FONT_DIRECTORY}/{font_file}"));
    let align = match style.horizontal.as_str() {
        "center" => "C",
        "right" => "R",
        _ => "L",
    };
    let (x, y) = position_expressions(style);
    format!(
        "drawtext=fontfile='{fontfile}':text='{}':fontcolor=0x{}:fontsize={}:line_spacing={}:text_align={align}:box=1:boxcolor=black@0.65:boxborderw={BOX_BORDER_PX}:x={x}:y={y}:{enable}",
        escape_styled_drawtext_text(&caption.text),
        &style.color_rgba[1..],
        style.font_size_px,
        style.line_spacing_px,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::types::ProjectUuid;

    fn seconds(microseconds: u64) -> String {
        format!(
            "{}.{:06}",
            microseconds / 1_000_000,
            microseconds % 1_000_000
        )
    }

    fn golden_input() -> RenderCaptionInput {
        let id: ProjectUuid =
            serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000001"))
                .unwrap();
        RenderCaptionInput {
            track_id: id.clone(),
            caption_id: id,
            cue_id: Some("cue-0001".to_owned()),
            style: Some(RenderCaptionStyle {
                font: "arial-bold".to_owned(),
                font_size_px: 32,
                line_spacing_px: 7,
                color_rgba: "#ffd700ff".to_owned(),
                horizontal: "center".to_owned(),
                vertical: "bottom".to_owned(),
                anchor_x_permille: 500,
                anchor_y_permille: 950,
                safe_top_permille: 50,
                safe_right_permille: 50,
                safe_bottom_permille: 50,
                safe_left_permille: 50,
            }),
            start_microseconds: 250_000,
            end_microseconds: 1_750_000,
            text: "It's 50%, [ok];\nC:\\path".to_owned(),
        }
    }

    /// Byte-identical to `STYLED_CAPTION_GOLDEN` in caption-render.test.ts.
    const GOLDEN: &str = concat!(
        r"drawtext=fontfile='C\:/Windows/Fonts/arialbd.ttf':text='It\'s 50\%\, \[ok\]\;",
        "\n",
        r"C\:\\path':fontcolor=0xffd700ff:fontsize=32:line_spacing=7:text_align=C:box=1:boxcolor=black@0.65:boxborderw=12:x=max(w*0.050+12\,min(w*0.500-text_w/2\,w*(1-0.050)-12-text_w)):y=max(h*0.050+12\,min(h*0.950-text_h\,h*(1-0.050)-12-text_h)):enable='gte(t\,0.250000)*lt(t\,1.750000)'"
    );

    #[test]
    fn styled_caption_drawtext_matches_ts_golden() {
        assert_eq!(caption_drawtext_filter(&golden_input(), seconds), GOLDEN);
    }

    #[test]
    fn style_validation_rejects_unknown_fonts_and_out_of_range_fields() {
        assert!(valid_caption_style_fields(&golden_input()));
        let mutate = |change: fn(&mut RenderCaptionStyle)| {
            let mut input = golden_input();
            change(input.style.as_mut().unwrap());
            valid_caption_style_fields(&input)
        };
        assert!(!mutate(|style| style.font = r"..\..\evil.ttf".to_owned()));
        assert!(!mutate(|style| style.font_size_px = 7));
        assert!(!mutate(|style| style.color_rgba = "#FFD700FF".to_owned()));
        assert!(!mutate(|style| style.vertical = "middle".to_owned()));
        assert!(!mutate(|style| style.safe_left_permille = 401));
        let mut input = golden_input();
        input.cue_id = Some("bad id".to_owned());
        assert!(!valid_caption_style_fields(&input));
    }

    /// Real frames through the bundled FFmpeg at three aspect ratios. Measures
    /// the caption box (the only non-background pixels) and asserts it lies
    /// fully inside the 5% safe area.
    #[test]
    fn styled_caption_renders_inside_safe_area_at_three_aspect_ratios() {
        let ffmpeg = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe");
        if !ffmpeg.is_file() || !std::path::Path::new("C:/Windows/Fonts/arialbd.ttf").is_file() {
            eprintln!("skipping: bundled FFmpeg or Windows fonts unavailable");
            return;
        }
        let mut input = golden_input();
        input.text = "And so, my fellow Americans\nask not what your country".to_owned();
        input.start_microseconds = 0;
        let filter = caption_drawtext_filter(&input, seconds);
        for (width, height) in [(1280_u32, 720_u32), (720, 1280), (1080, 1080)] {
            let output = std::process::Command::new(&ffmpeg)
                .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
                .arg(format!("color=c=0x000000:s={width}x{height}:d=1"))
                .args(["-vf", &format!("{filter},format=gray"), "-frames:v", "1"])
                .args(["-f", "rawvideo", "-"])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let pixels = output.stdout;
            assert_eq!(pixels.len(), (width * height) as usize);
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, 0, 0);
            for (index, value) in pixels.iter().enumerate() {
                if *value > 8 {
                    let (x, y) = (index as u32 % width, index as u32 / width);
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                    min_y = min_y.min(y);
                    max_y = max_y.max(y);
                }
            }
            assert!(max_x > min_x, "{width}x{height}: caption not drawn");
            let (safe_x, safe_y) = (width * 50 / 1_000, height * 50 / 1_000);
            assert!(
                min_x >= safe_x
                    && max_x <= width - safe_x
                    && min_y >= safe_y
                    && max_y <= height - safe_y,
                "{width}x{height}: box {min_x},{min_y}-{max_x},{max_y} leaves safe area"
            );
            assert!(
                max_y > height / 2,
                "{width}x{height}: bottom-aligned caption must sit low"
            );
        }
    }
}
