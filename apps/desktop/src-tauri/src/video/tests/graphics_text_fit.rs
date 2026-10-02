//! Export-time auto-fit of graphics text into each delivery preset's safe area (shrink, then
//! wrap), measured with the real Windows core fonts.

use std::{collections::BTreeMap, path::Path};

use serde_json::Value;

use crate::video::{
    delivery::{safe_area_for_frame, SafeAreaRect, DELIVERY_PRESETS},
    graphics_export::{graphics_description, TextFitContext, FONT_DIRECTORY},
    text_layout::{load_text_font, MeasureText, TextMeasurer},
    types::{RationalRate, RenderGraphicsInputV2},
};

const TEXT: &str = "Subscribe for tips";
const AUTHORED: f64 = 72.0;

fn hold(value: f64) -> Value {
    serde_json::json!([{ "timeMicroseconds": 0, "value": value }])
}

fn input(x: f64, y: f64, rotation: f64) -> RenderGraphicsInputV2 {
    serde_json::from_value(serde_json::json!({
        "trackId": "7f000000-0000-4000-8000-000000000002",
        "clip": {
            "graphicsVersion": 1, "id": "7f000000-0000-4000-8000-000000000009",
            "timelineStart": { "value": 0, "rateNumerator": 30, "rateDenominator": 1 },
            "duration": { "value": 30, "rateNumerator": 30, "rateDenominator": 1 },
            "fontKey": "arial-regular",
            "layers": [{ "kind": "text", "text": TEXT, "fontSize": AUTHORED, "fill": "#FFFFFF",
                "x": hold(x), "y": hold(y), "scale": hold(1.0), "rotation": hold(rotation),
                "opacity": hold(1.0) }]
        },
        "startMicroseconds": 0,
        "endMicroseconds": 1_000_000,
        "imagePathsByAssetId": {},
    }))
    .unwrap()
}

fn describe(preset_id: &str, x: f64, y: f64, rotation: f64) -> Value {
    let preset = DELIVERY_PRESETS
        .iter()
        .find(|preset| preset.id == preset_id)
        .unwrap();
    graphics_description(
        &input(x, y, rotation),
        &RationalRate {
            numerator: 30,
            denominator: 1,
        },
        (preset.width, preset.height),
        &BTreeMap::new(),
        TextFitContext {
            safe_area: safe_area(preset_id),
            font_dir: Path::new(FONT_DIRECTORY),
        },
    )
    .unwrap()
}

fn safe_area(preset_id: &str) -> SafeAreaRect {
    let preset = DELIVERY_PRESETS
        .iter()
        .find(|preset| preset.id == preset_id)
        .unwrap();
    safe_area_for_frame(preset.width, preset.height, Some(preset_id))
}

fn arial() -> TextMeasurer {
    TextMeasurer::new(load_text_font("arial-regular", Path::new(FONT_DIRECTORY)).unwrap())
}

fn natural_width() -> f64 {
    f64::from(arial().layout(TEXT, AUTHORED as f32, None).width)
}

fn text_layer(description: &Value) -> &Value {
    &description["layers"][0]
}

/// Widest drawn line of the emitted layer, re-measured at its emitted size.
fn drawn_line_widths(layer: &Value) -> Vec<f64> {
    let size = layer["fontSize"].as_f64().unwrap() as f32;
    let breaks: Vec<usize> = layer
        .get("lineBreaks")
        .map(|breaks| {
            breaks
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as usize)
                .collect()
        })
        .unwrap_or_default();
    let mut measure = arial();
    let mut start = 0;
    breaks
        .iter()
        .copied()
        .chain([TEXT.len()])
        .map(|end| {
            let line = TEXT[start..end].trim_end();
            start = end;
            f64::from(measure.layout(line, size, None).width)
        })
        .collect()
}

const PRESETS: [&str; 3] = [
    "landscape_16x9_1080p",
    "portrait_9x16_1080p",
    "square_1x1_1080p",
];

#[test]
fn text_inside_the_safe_area_is_emitted_as_authored() {
    for preset in PRESETS {
        let safe = safe_area(preset);
        let layer = describe(preset, safe.left, safe.top, 0.0);
        let layer = text_layer(&layer);
        assert!(natural_width() < safe.right - safe.left, "{preset}");
        assert_eq!(layer["fontSize"], AUTHORED, "{preset}");
        assert!(layer.get("lineBreaks").is_none(), "{preset}");
    }
}

#[test]
fn slightly_too_wide_text_shrinks_without_wrapping_in_every_preset() {
    for preset in PRESETS {
        let safe = safe_area(preset);
        // Leave 90 % of the natural width before the safe right edge.
        let available = natural_width() * 0.9;
        let x = safe.right - available;
        assert!(
            x >= safe.left,
            "{preset}: test text must start inside the safe area"
        );
        let description = describe(preset, x, safe.top + 20.0, 0.0);
        let layer = text_layer(&description);
        let size = layer["fontSize"].as_f64().unwrap();
        assert!(
            (AUTHORED * 0.8..AUTHORED).contains(&size),
            "{preset}: {size}"
        );
        assert!(layer.get("lineBreaks").is_none(), "{preset}");
        let widths = drawn_line_widths(layer);
        assert!(
            widths[0] <= available + 0.01,
            "{preset}: {widths:?} > {available}"
        );
    }
}

#[test]
fn far_too_wide_text_shrinks_to_the_floor_then_wraps_in_every_preset() {
    for preset in PRESETS {
        let safe = safe_area(preset);
        // Half the natural width: shrinking alone (≥ 80 %) cannot fit, so it wraps at 57.6 px.
        let available = natural_width() * 0.5;
        let x = safe.right - available;
        assert!(x >= safe.left, "{preset}");
        let description = describe(preset, x, safe.top + 20.0, 0.0);
        let layer = text_layer(&description);
        assert_eq!(
            layer["fontSize"].as_f64().unwrap(),
            AUTHORED * 0.8,
            "{preset}"
        );
        let breaks = layer["lineBreaks"]
            .as_array()
            .expect("wrapped text has line breaks");
        assert!(!breaks.is_empty());
        for offset in breaks {
            let offset = offset.as_u64().unwrap() as usize;
            assert_eq!(
                &TEXT[offset - 1..offset],
                " ",
                "{preset}: breaks fall between words"
            );
        }
        for width in drawn_line_widths(layer) {
            assert!(width <= available + 0.01, "{preset}: {width} > {available}");
        }
    }
}

#[test]
fn rotated_text_keeps_its_authored_size() {
    let safe = safe_area("portrait_9x16_1080p");
    let description = describe(
        "portrait_9x16_1080p",
        safe.right - 100.0,
        safe.top + 20.0,
        15.0,
    );
    let layer = text_layer(&description);
    assert_eq!(layer["fontSize"], AUTHORED);
    assert!(layer.get("lineBreaks").is_none());
}

#[test]
fn missing_font_fails_the_export_closed() {
    let error = graphics_description(
        &input(100.0, 100.0, 0.0),
        &RationalRate {
            numerator: 30,
            denominator: 1,
        },
        (1920, 1080),
        &BTreeMap::new(),
        TextFitContext {
            safe_area: safe_area("landscape_16x9_1080p"),
            font_dir: Path::new("Z:/no/such/fonts"),
        },
    )
    .expect_err("an unreadable font must fail");
    assert!(format!("{error:?}").contains("graphics_font"), "{error:?}");
}
