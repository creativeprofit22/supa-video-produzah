//! Still-image (PNG/JPEG) probing for graphics image layers.
//!
//! The probe reads at most `MAX_HEADER_BYTES` of the file and validates the real container
//! signature and image header, so a renamed or truncated file is rejected regardless of its
//! extension. See docs/adr/0003-graphics-clips.md.

use std::{fs::File, io::Read, path::Path, time::Instant};

use super::{error::VideoCommandError, types::MediaProbe, types::RationalRate};

pub const MAX_STILL_SIDE: u64 = 4096;
pub const MAX_STILL_BYTES: u64 = 32 * 1024 * 1024;
/// JPEG frame headers may follow large EXIF/ICC segments; 1 MiB covers real-world files.
const MAX_HEADER_BYTES: u64 = 1024 * 1024;
pub const STILL_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StillFormat {
    Png,
    Jpeg,
}

impl StillFormat {
    fn codec_name(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "mjpeg",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StillHeader {
    pub format: StillFormat,
    pub width: u64,
    pub height: u64,
}

pub fn has_still_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            STILL_EXTENSIONS
                .iter()
                .any(|extension| value.eq_ignore_ascii_case(extension))
        })
}

fn still_extension_format(path: &Path) -> Option<StillFormat> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some(StillFormat::Png),
        "jpg" | "jpeg" => Some(StillFormat::Jpeg),
        _ => None,
    }
}

/// Parses a PNG or JPEG header. `None` for anything that is not a well-formed header.
pub fn parse_still_header(bytes: &[u8]) -> Option<StillHeader> {
    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(&PNG_SIGNATURE) {
        // The first chunk must be IHDR with length 13.
        let ihdr = bytes.get(8..8 + 8 + 13)?;
        if ihdr[0..4] != [0, 0, 0, 13] || &ihdr[4..8] != b"IHDR" {
            return None;
        }
        let width = u32::from_be_bytes(ihdr[8..12].try_into().ok()?);
        let height = u32::from_be_bytes(ihdr[12..16].try_into().ok()?);
        let bit_depth = ihdr[16];
        let color_type = ihdr[17];
        let valid_depth = match color_type {
            0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
            3 => matches!(bit_depth, 1 | 2 | 4 | 8),
            2 | 4 | 6 => matches!(bit_depth, 8 | 16),
            _ => false,
        };
        if !valid_depth || ihdr[18] != 0 || ihdr[19] != 0 || ihdr[20] > 1 {
            return None;
        }
        return Some(StillHeader {
            format: StillFormat::Png,
            width: u64::from(width),
            height: u64::from(height),
        });
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut offset = 2;
        loop {
            // Skip fill bytes before a marker.
            while *bytes.get(offset)? == 0xFF && *bytes.get(offset + 1)? == 0xFF {
                offset += 1;
            }
            if *bytes.get(offset)? != 0xFF {
                return None;
            }
            let marker = *bytes.get(offset + 1)?;
            offset += 2;
            match marker {
                // Standalone markers carry no length.
                0x01 | 0xD0..=0xD7 => continue,
                // End of image or start of scan before a frame header: no dimensions.
                0xD9 | 0xDA => return None,
                _ => {}
            }
            let length = usize::from(u16::from_be_bytes([
                *bytes.get(offset)?,
                *bytes.get(offset + 1)?,
            ]));
            if length < 2 {
                return None;
            }
            let is_frame_header =
                matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
            if is_frame_header {
                let segment = bytes.get(offset + 2..offset + length)?;
                if segment.len() < 6 {
                    return None;
                }
                let height = u16::from_be_bytes([segment[1], segment[2]]);
                let width = u16::from_be_bytes([segment[3], segment[4]]);
                let components = segment[5];
                if !matches!(components, 1 | 3 | 4)
                    || segment.len() < 6 + 3 * usize::from(components)
                {
                    return None;
                }
                return Some(StillHeader {
                    format: StillFormat::Jpeg,
                    width: u64::from(width),
                    height: u64::from(height),
                });
            }
            offset += length;
        }
    }
    None
}

fn invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_media("probe_still_image", category)
}

/// One structured record per probe: input size, outcome and elapsed time.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StillProbeLog {
    pub file_size_bytes: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    /// `"ok"` or the rejection category.
    pub outcome: String,
    pub elapsed_ms: u64,
}

/// The still-image probe for a trusted (granted, normalized) path. `log` receives one record.
pub fn probe_still_image(
    trusted_path: &Path,
    log: &dyn Fn(&StillProbeLog),
) -> Result<MediaProbe, VideoCommandError> {
    probe_still_object(trusted_path, trusted_path, log)
}

/// The still-image probe for content stored apart from its declared name, such as an ingested
/// media-store object (`<digest>.blob`). The expected format comes from `declared_path`'s
/// extension; the bytes come from `content_path`. `log` receives one record.
pub fn probe_still_object(
    content_path: &Path,
    declared_path: &Path,
    log: &dyn Fn(&StillProbeLog),
) -> Result<MediaProbe, VideoCommandError> {
    let started = Instant::now();
    let result = probe_still_image_inner(content_path, declared_path);
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    log(&match &result {
        Ok(probe) => StillProbeLog {
            file_size_bytes: Some(probe.file_size_bytes),
            width: Some(probe.width),
            height: Some(probe.height),
            outcome: "ok".to_owned(),
            elapsed_ms,
        },
        Err(error) => StillProbeLog {
            file_size_bytes: std::fs::metadata(content_path)
                .ok()
                .map(|metadata| metadata.len()),
            width: None,
            height: None,
            outcome: error.details["category"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned(),
            elapsed_ms,
        },
    });
    result
}

fn probe_still_image_inner(
    content_path: &Path,
    declared_path: &Path,
) -> Result<MediaProbe, VideoCommandError> {
    let expected = still_extension_format(declared_path).ok_or_else(|| invalid("extension"))?;
    let file = File::open(content_path).map_err(|_| invalid("metadata"))?;
    let file_size_bytes = file.metadata().map_err(|_| invalid("metadata"))?.len();
    if file_size_bytes == 0 {
        return Err(invalid("empty"));
    }
    if file_size_bytes > MAX_STILL_BYTES {
        return Err(invalid("file_too_large"));
    }
    let mut header = Vec::new();
    file.take(MAX_HEADER_BYTES)
        .read_to_end(&mut header)
        .map_err(|_| invalid("read"))?;
    let parsed = parse_still_header(&header).ok_or_else(|| invalid("malformed_header"))?;
    if parsed.format != expected {
        return Err(invalid("format_mismatch"));
    }
    if parsed.width == 0 || parsed.height == 0 {
        return Err(invalid("empty_dimensions"));
    }
    if parsed.width > MAX_STILL_SIDE || parsed.height > MAX_STILL_SIDE {
        return Err(invalid("dimensions_too_large"));
    }
    let one = RationalRate {
        numerator: 1,
        denominator: 1,
    };
    Ok(MediaProbe {
        duration_microseconds: 1_000_000,
        average_frame_rate: one.clone(),
        real_frame_rate: one,
        variable_frame_rate: false,
        width: parsed.width,
        height: parsed.height,
        video_codec_name: parsed.format.codec_name().to_owned(),
        audio: None,
        file_size_bytes,
        still: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::error::VideoErrorCode;
    use std::fs;
    use tempfile::tempdir;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]); // CRC (not checked by the header probe)
        bytes
    }

    fn jpeg(width: u16, height: u16, app_padding: usize) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8];
        // An APP1 segment before the frame header, like EXIF.
        let app_length = (app_padding + 2) as u16;
        bytes.extend_from_slice(&[0xFF, 0xE1]);
        bytes.extend_from_slice(&app_length.to_be_bytes());
        bytes.extend(std::iter::repeat_n(0_u8, app_padding));
        bytes.extend_from_slice(&[0xFF, 0xC0, 0, 17, 8]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        bytes
    }

    fn probe_bytes(name: &str, bytes: &[u8]) -> Result<MediaProbe, VideoCommandError> {
        let directory = tempdir().unwrap();
        let path = directory.path().join(name);
        fs::write(&path, bytes).unwrap();
        let records = std::cell::RefCell::new(Vec::new());
        let result = probe_still_image(&path, &|record| records.borrow_mut().push(record.clone()));
        let records = records.into_inner();
        assert_eq!(records.len(), 1, "exactly one log record");
        let expected_outcome = match &result {
            Ok(_) => "ok".to_owned(),
            Err(error) => error.details["category"].as_str().unwrap().to_owned(),
        };
        assert_eq!(records[0].outcome, expected_outcome);
        result
    }

    fn category(result: Result<MediaProbe, VideoCommandError>) -> String {
        let error = result.unwrap_err();
        assert_eq!(error.code, VideoErrorCode::InvalidMedia);
        error.details["category"].as_str().unwrap().to_owned()
    }

    #[test]
    fn png_and_jpeg_headers_produce_a_still_probe() {
        let png = probe_bytes("logo.PNG", &png(640, 360)).unwrap();
        assert_eq!(
            (png.width, png.height, png.video_codec_name.as_str()),
            (640, 360, "png")
        );
        assert!(png.still && png.audio.is_none() && !png.variable_frame_rate);

        for name in ["photo.jpg", "photo.jpeg"] {
            let jpeg = probe_bytes(name, &jpeg(1920, 1080, 4000)).unwrap();
            assert_eq!(
                (jpeg.width, jpeg.height, jpeg.video_codec_name.as_str()),
                (1920, 1080, "mjpeg")
            );
        }
    }

    #[test]
    fn malformed_disguised_and_oversized_files_are_rejected() {
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            (
                "truncated.png",
                png(10, 10)[..14].to_vec(),
                "malformed_header",
            ),
            (
                "text.png",
                b"hello, not an image".to_vec(),
                "malformed_header",
            ),
            ("empty.png", Vec::new(), "empty"),
            ("jpeg-named.png", jpeg(10, 10, 0), "format_mismatch"),
            ("png-named.jpg", png(10, 10), "format_mismatch"),
            (
                "video.mp4.png",
                b"\x00\x00\x00\x18ftypmp42".to_vec(),
                "malformed_header",
            ),
            ("wide.png", png(4097, 10), "dimensions_too_large"),
            ("tall.jpg", jpeg(10, 4097, 0), "dimensions_too_large"),
            ("zero.png", png(0, 10), "empty_dimensions"),
            ("photo.gif", png(10, 10), "extension"),
        ];
        for (name, bytes, expected) in cases {
            assert_eq!(category(probe_bytes(name, &bytes)), expected, "{name}");
        }
    }

    #[test]
    fn files_over_32_megabytes_are_rejected_before_parsing() {
        let mut bytes = png(10, 10);
        bytes.resize((MAX_STILL_BYTES + 1) as usize, 0);
        assert_eq!(category(probe_bytes("huge.png", &bytes)), "file_too_large");
    }

    #[test]
    fn jpeg_without_a_frame_header_inside_the_bound_is_rejected() {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xDA, 0, 2];
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(
            category(probe_bytes("scan.jpg", &bytes)),
            "malformed_header"
        );
    }
}
