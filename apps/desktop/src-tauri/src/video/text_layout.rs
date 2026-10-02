//! Font-accurate text measurement and line breaking (parley, system fonts off).
//!
//! Only the font file registered here is ever used, so the same text, font and size always lay
//! out the same way. Contexts are created per call site (one export or one QC run) and passed in;
//! nothing is cached at module level.

use std::{ops::Range, path::Path, sync::Arc};

use parley::{
    fontique::{Blob, Collection, CollectionOptions, SourceCache},
    FontContext, FontFamily, LayoutContext, LineHeight, StyleProperty,
};

/// Line height as a multiple of the font size, shared by measurement and drawing.
pub(crate) const LINE_HEIGHT_RATIO: f32 = 1.2;
/// Auto-fit never shrinks below this fraction of the authored size…
pub(crate) const MIN_FIT_RATIO: f32 = 0.8;
/// …nor below this many pixels.
pub(crate) const MIN_FIT_PX: f32 = 12.0;
/// Upper bound on font files read for measurement (core fonts are well under this).
const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextLayoutError {
    UnknownFont,
    FontUnreadable,
    FontInvalid,
}

/// One font file, registered into its own collection with system fonts disabled.
pub(crate) struct TextFont {
    family: String,
    context: FontContext,
}

/// Loads the font for a closed caption/graphics font key from `font_dir`.
pub(crate) fn load_text_font(key: &str, font_dir: &Path) -> Result<TextFont, TextLayoutError> {
    let file = super::caption_render::caption_font_file(key).ok_or(TextLayoutError::UnknownFont)?;
    let path = font_dir.join(file);
    let metadata = std::fs::metadata(&path).map_err(|_| TextLayoutError::FontUnreadable)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FONT_BYTES {
        return Err(TextLayoutError::FontUnreadable);
    }
    let bytes = std::fs::read(&path).map_err(|_| TextLayoutError::FontUnreadable)?;
    text_font_from_bytes(bytes)
}

/// Registers raw font bytes; the family name comes from the font itself.
pub(crate) fn text_font_from_bytes(bytes: Vec<u8>) -> Result<TextFont, TextLayoutError> {
    let mut collection = Collection::new(CollectionOptions {
        shared: false,
        system_fonts: false,
    });
    let registered = collection.register_fonts(Blob::new(Arc::new(bytes)), None);
    let family_id = registered
        .first()
        .map(|(id, _)| *id)
        .ok_or(TextLayoutError::FontInvalid)?;
    let family = collection
        .family_name(family_id)
        .ok_or(TextLayoutError::FontInvalid)?
        .to_owned();
    Ok(TextFont {
        family,
        context: FontContext {
            collection,
            source_cache: SourceCache::default(),
        },
    })
}

/// A laid-out paragraph: byte ranges of each line plus its box in pixels.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TextLayoutResult {
    pub(crate) lines: Vec<Range<usize>>,
    pub(crate) line_height: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

/// Something that can measure text; the real implementation is [`TextMeasurer`], tests inject
/// fakes so the fitting rules are checkable without font files.
pub(crate) trait MeasureText {
    fn layout(&mut self, text: &str, font_size: f32, max_width: Option<f32>) -> TextLayoutResult;
}

/// A font plus a layout context, created once per export or QC run.
pub(crate) struct TextMeasurer {
    font: TextFont,
    layout: LayoutContext<[u8; 4]>,
}

impl TextMeasurer {
    pub(crate) fn new(font: TextFont) -> Self {
        Self {
            font,
            layout: LayoutContext::new(),
        }
    }
}

impl MeasureText for TextMeasurer {
    fn layout(&mut self, text: &str, font_size: f32, max_width: Option<f32>) -> TextLayoutResult {
        layout_text(&mut self.font, &mut self.layout, text, font_size, max_width)
    }
}

/// Shapes `text` at `font_size` and breaks it to `max_width` (no limit when `None`).
/// Explicit `\n` always breaks.
pub(crate) fn layout_text(
    font: &mut TextFont,
    layout_context: &mut LayoutContext<[u8; 4]>,
    text: &str,
    font_size: f32,
    max_width: Option<f32>,
) -> TextLayoutResult {
    let family = font.family.clone();
    let mut builder = layout_context.ranged_builder(&mut font.context, text, 1.0, false);
    builder.push_default(StyleProperty::FontFamily(FontFamily::named(&family)));
    builder.push_default(StyleProperty::FontSize(font_size));
    builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
        LINE_HEIGHT_RATIO,
    )));
    let mut layout = builder.build(text);
    layout.break_all_lines(max_width);
    let lines: Vec<Range<usize>> = layout.lines().map(|line| line.text_range()).collect();
    let line_height = font_size * LINE_HEIGHT_RATIO;
    TextLayoutResult {
        height: line_height * lines.len().max(1) as f32,
        lines,
        line_height,
        width: layout.width(),
    }
}

/// Width/height of a box in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Size {
    pub(crate) width: f32,
    pub(crate) height: f32,
}

/// The fitted size and line breaks for one text at one available box.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FittedText {
    pub(crate) font_size: f32,
    /// Byte offsets where a new line starts (empty for a single line).
    pub(crate) line_breaks: Vec<usize>,
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) fits: bool,
}

/// Smallest size auto-fit may shrink `authored` to.
pub(crate) fn fit_floor(authored: f32) -> f32 {
    (authored * MIN_FIT_RATIO).max(MIN_FIT_PX).min(authored)
}

fn fitted(result: &TextLayoutResult, font_size: f32, available: Size) -> FittedText {
    FittedText {
        font_size,
        line_breaks: result.lines.iter().skip(1).map(|line| line.start).collect(),
        width: result.width,
        height: result.height,
        fits: result.width <= available.width + 0.01 && result.height <= available.height + 0.01,
    }
}

/// Fits `text` into `available`: shrink first (down to [`fit_floor`]), then wrap at the floor.
///
/// Text that already fits at the authored size is returned unchanged. `fits` is false when even
/// the wrapped text overflows the box (too tall, or a single word wider than the box).
pub(crate) fn fit_text(
    measure: &mut dyn MeasureText,
    text: &str,
    authored_size: f32,
    available: Size,
) -> FittedText {
    let natural = measure.layout(text, authored_size, None);
    let result = fitted(&natural, authored_size, available);
    if result.fits {
        return result;
    }
    let floor = fit_floor(authored_size);
    // Width scales linearly with size, so the shrink that makes one line fit is computed
    // directly and then confirmed with a real layout (hinting-free shaping keeps it exact).
    if natural.width > 0.0 && natural.width > available.width {
        let size = (authored_size * available.width / natural.width).max(floor);
        let shrunk = measure.layout(text, size, None);
        let candidate = fitted(&shrunk, size, available);
        if candidate.fits {
            return candidate;
        }
    } else if natural.height > available.height {
        // Too tall at one line (explicit breaks or a tiny box): shrinking is all that helps.
        let size = (authored_size * available.height / natural.height).max(floor);
        let shrunk = measure.layout(text, size, None);
        return fitted(&shrunk, size, available);
    }
    let wrapped = measure.layout(text, floor, Some(available.width.max(0.0)));
    fitted(&wrapped, floor, available)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed-advance fake: every char is `0.5 × size` wide, words break on spaces.
    struct FakeMeasure;

    impl MeasureText for FakeMeasure {
        fn layout(&mut self, text: &str, size: f32, max_width: Option<f32>) -> TextLayoutResult {
            let advance = size * 0.5;
            let mut lines = Vec::new();
            let mut start = 0;
            let mut width: f32 = 0.0;
            let mut widest: f32 = 0.0;
            let mut last_space = None;
            for (index, ch) in text.char_indices() {
                if ch == ' ' {
                    last_space = Some(index);
                }
                width += advance;
                if let (Some(limit), Some(space)) = (max_width, last_space) {
                    if width > limit && space > start {
                        lines.push(start..space + 1);
                        widest = widest.max((space - start) as f32 * advance);
                        start = space + 1;
                        width = (index + 1 - start) as f32 * advance;
                        last_space = None;
                    }
                }
            }
            lines.push(start..text.len());
            widest = widest.max(width);
            TextLayoutResult {
                height: size * LINE_HEIGHT_RATIO * lines.len() as f32,
                line_height: size * LINE_HEIGHT_RATIO,
                lines,
                width: widest,
            }
        }
    }

    fn size(width: f32, height: f32) -> Size {
        Size { width, height }
    }

    #[test]
    fn text_that_fits_keeps_its_authored_size_and_one_line() {
        let fit = fit_text(&mut FakeMeasure, "hello", 40.0, size(200.0, 100.0));
        assert_eq!(fit.font_size, 40.0);
        assert!(fit.line_breaks.is_empty());
        assert!(fit.fits);
    }

    #[test]
    fn slightly_wide_text_shrinks_without_wrapping() {
        // 10 chars × 20 px = 200 px; 180 px available → 36 px, above the 32 px floor.
        let fit = fit_text(&mut FakeMeasure, "abcde fghi", 40.0, size(180.0, 100.0));
        assert!((fit.font_size - 36.0).abs() < 1e-3);
        assert!(fit.line_breaks.is_empty());
        assert!(fit.fits);
    }

    #[test]
    fn very_wide_text_wraps_at_the_floor_size() {
        let fit = fit_text(
            &mut FakeMeasure,
            "abcde fghij klmno",
            40.0,
            size(120.0, 200.0),
        );
        assert_eq!(fit.font_size, 32.0);
        assert_eq!(fit.line_breaks, vec![6, 12]);
        assert!(fit.fits);
    }

    #[test]
    fn wrapped_text_taller_than_the_box_does_not_fit() {
        let fit = fit_text(
            &mut FakeMeasure,
            "abcde fghij klmno",
            40.0,
            size(120.0, 50.0),
        );
        assert!(!fit.fits);
    }

    #[test]
    fn floor_is_eighty_percent_but_never_below_twelve_px() {
        assert_eq!(fit_floor(40.0), 32.0);
        assert_eq!(fit_floor(14.0), 12.0);
        assert_eq!(fit_floor(10.0), 10.0);
    }

    /// Real shaping with the Windows core fonts (the windows CI job runs these).
    #[cfg(windows)]
    mod real_fonts {
        use super::super::*;

        fn arial() -> TextMeasurer {
            TextMeasurer::new(
                load_text_font("arial-regular", Path::new("C:/Windows/Fonts"))
                    .expect("arial.ttf is a Windows core font"),
            )
        }

        fn line_texts<'a>(text: &'a str, result: &TextLayoutResult) -> Vec<&'a str> {
            result
                .lines
                .iter()
                .map(|line| &text[line.clone()])
                .collect()
        }

        #[test]
        fn font_family_comes_from_the_file_and_unknown_keys_are_rejected() {
            let font = load_text_font("arial-regular", Path::new("C:/Windows/Fonts")).unwrap();
            assert_eq!(font.family, "Arial");
            assert_eq!(
                load_text_font("../evil", Path::new("C:/Windows/Fonts")).err(),
                Some(TextLayoutError::UnknownFont)
            );
            assert_eq!(
                text_font_from_bytes(b"not a font".to_vec()).err(),
                Some(TextLayoutError::FontInvalid)
            );
        }

        #[test]
        fn latin_wraps_at_word_boundaries_within_the_width() {
            let mut measure = arial();
            let text = "The quick brown fox jumps over the lazy dog";
            let result = measure.layout(text, 40.0, Some(300.0));
            assert_eq!(
                line_texts(text, &result),
                vec!["The quick brown ", "fox jumps over ", "the lazy dog"]
            );
            assert!(result.width <= 300.0);
            assert!((result.height - 3.0 * 48.0).abs() < 1e-3);
            // Every line starts a word.
            for line in &result.lines[1..] {
                assert_eq!(&text[line.start - 1..line.start], " ");
            }
        }

        #[test]
        fn arabic_wraps_at_word_boundaries() {
            let mut measure = arial();
            // "Peace be upon you, my dear friend" in Arabic; Arial carries Arabic glyphs.
            let text = "السلام عليكم يا صديقي العزيز";
            let single = measure.layout(text, 40.0, None);
            assert_eq!(single.lines.len(), 1);
            let result = measure.layout(text, 40.0, Some(single.width * 0.6));
            assert!(result.lines.len() >= 2, "{:?}", line_texts(text, &result));
            for line in &result.lines[1..] {
                assert_eq!(&text[line.start - 1..line.start], " ");
            }
            assert_eq!(
                line_texts(text, &result),
                vec!["السلام عليكم يا ", "صديقي العزيز"]
            );
        }

        #[test]
        fn cjk_breaks_between_ideographs_without_spaces() {
            let mut measure = arial();
            let text = "今日は良い天気ですね";
            let single = measure.layout(text, 40.0, None);
            let result = measure.layout(text, 40.0, Some(single.width / 2.0 + 1.0));
            assert!(result.lines.len() >= 2);
            // Every break lands on a char boundary, with no spaces in the text at all.
            for line in &result.lines {
                assert!(text.is_char_boundary(line.start) && text.is_char_boundary(line.end));
            }
            assert_eq!(line_texts(text, &result), vec!["今日は良い", "天気ですね"]);
        }

        #[test]
        fn width_grows_linearly_with_font_size() {
            let mut measure = arial();
            let small = measure.layout("Safe area", 20.0, None).width;
            let large = measure.layout("Safe area", 40.0, None).width;
            assert!(small > 0.0);
            assert!((large / small - 2.0).abs() < 0.01, "{small} {large}");
        }

        #[test]
        fn fit_shrinks_before_wrapping_and_reports_overflow() {
            let mut measure = arial();
            let text = "Subscribe for more";
            let natural = measure.layout(text, 60.0, None).width;
            // 10% too wide: shrink only.
            let shrunk = fit_text(
                &mut measure,
                text,
                60.0,
                Size {
                    width: natural * 0.9,
                    height: 200.0,
                },
            );
            assert!(shrunk.line_breaks.is_empty());
            assert!(shrunk.font_size < 60.0 && shrunk.font_size >= 48.0);
            assert!(shrunk.fits && shrunk.width <= natural * 0.9 + 0.01);
            // Half as wide: wrap at the 48 px floor.
            let wrapped = fit_text(
                &mut measure,
                text,
                60.0,
                Size {
                    width: natural * 0.5,
                    height: 400.0,
                },
            );
            assert_eq!(wrapped.font_size, 48.0);
            assert!(!wrapped.line_breaks.is_empty());
            assert!(wrapped.fits);
            // Same width but only one line tall: overflows.
            let overflow = fit_text(
                &mut measure,
                text,
                60.0,
                Size {
                    width: natural * 0.5,
                    height: 60.0,
                },
            );
            assert!(!overflow.fits);
        }
    }
}
