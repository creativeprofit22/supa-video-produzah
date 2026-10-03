//! Strict reader for the analysis WAV the app writes with ffmpeg: 22.05 kHz, mono, 16-bit PCM.
//!
//! Anything else is rejected rather than converted, so the model always sees exactly the samples
//! the Python reference sees (Beat This! only resamples when the rate differs from 22 050 Hz).

use std::fmt;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// The only sample rate the model accepts without resampling.
pub const SAMPLE_RATE: u32 = 22_050;

/// One hour (the app's analysis limit) plus one second of slack.
pub const MAX_SAMPLES: u32 = SAMPLE_RATE * 3_601;

/// Why a WAV file was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WavError {
    Open(String),
    Format(String),
    TooLong { samples: u32 },
    Empty,
    Read(String),
}

impl fmt::Display for WavError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Open(message) => write!(f, "could not open WAV: {message}"),
            Self::Format(message) => write!(f, "unsupported WAV format: {message}"),
            Self::TooLong { samples } => write!(
                f,
                "WAV has {samples} samples; the limit is {MAX_SAMPLES} ({} s)",
                MAX_SAMPLES / SAMPLE_RATE
            ),
            Self::Empty => write!(f, "WAV has no samples"),
            Self::Read(message) => write!(f, "could not read WAV samples: {message}"),
        }
    }
}

impl std::error::Error for WavError {}

/// Reads a 22.05 kHz mono 16-bit PCM WAV as `f32` samples in `[-1, 1)` (`sample / 32768`,
/// the same scaling soundfile applies for the Python reference).
pub fn read_analysis_wav(path: &Path) -> Result<Vec<f32>, WavError> {
    let file = File::open(path).map_err(|error| WavError::Open(error.to_string()))?;
    let reader = hound::WavReader::new(BufReader::new(file))
        .map_err(|error| WavError::Format(error.to_string()))?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(WavError::Format(format!(
            "{:?} {}-bit samples; expected 16-bit integer PCM",
            spec.sample_format, spec.bits_per_sample
        )));
    }
    if spec.channels != 1 {
        return Err(WavError::Format(format!(
            "{} channels; expected mono",
            spec.channels
        )));
    }
    if spec.sample_rate != SAMPLE_RATE {
        return Err(WavError::Format(format!(
            "{} Hz; expected {SAMPLE_RATE} Hz",
            spec.sample_rate
        )));
    }
    let samples = reader.duration();
    if samples > MAX_SAMPLES {
        return Err(WavError::TooLong { samples });
    }
    if samples == 0 {
        return Err(WavError::Empty);
    }
    let mut output = Vec::with_capacity(samples as usize);
    for sample in reader.into_samples::<i16>() {
        let sample = sample.map_err(|error| WavError::Read(error.to_string()))?;
        output.push(f32::from(sample) / 32_768.0);
    }
    if output.len() != samples as usize {
        return Err(WavError::Read(format!(
            "header declares {samples} samples, file holds {}",
            output.len()
        )));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, spec: hound::WavSpec, samples: &[i32]) {
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for &sample in samples {
            match (spec.sample_format, spec.bits_per_sample) {
                (hound::SampleFormat::Int, 16) => writer.write_sample(sample as i16).unwrap(),
                (hound::SampleFormat::Int, _) => writer.write_sample(sample).unwrap(),
                (hound::SampleFormat::Float, _) => writer.write_sample(sample as f32).unwrap(),
            }
        }
        writer.finalize().unwrap();
    }

    fn spec(
        channels: u16,
        sample_rate: u32,
        bits: u16,
        format: hound::SampleFormat,
    ) -> hound::WavSpec {
        hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: bits,
            sample_format: format,
        }
    }

    #[test]
    fn reads_mono_16_bit_at_22050_with_soundfile_scaling() {
        let dir = tempdir();
        let path = dir.join("ok.wav");
        write_wav(
            &path,
            spec(1, SAMPLE_RATE, 16, hound::SampleFormat::Int),
            &[0, 16_384, -32_768, 32_767],
        );

        let samples = read_analysis_wav(&path).unwrap();

        assert_eq!(samples, vec![0.0, 0.5, -1.0, 32_767.0 / 32_768.0]);
    }

    #[test]
    fn rejects_formats_the_model_would_have_to_convert() {
        let cases = [
            ("stereo", spec(2, SAMPLE_RATE, 16, hound::SampleFormat::Int)),
            ("44k", spec(1, 44_100, 16, hound::SampleFormat::Int)),
            ("24bit", spec(1, SAMPLE_RATE, 24, hound::SampleFormat::Int)),
            (
                "float",
                spec(1, SAMPLE_RATE, 32, hound::SampleFormat::Float),
            ),
        ];
        let dir = tempdir();
        for (name, case) in cases {
            let path = dir.join(format!("{name}.wav"));
            write_wav(&path, case, &[0, 0, 0, 0]);

            let result = read_analysis_wav(&path);

            assert!(
                matches!(result, Err(WavError::Format(_))),
                "{name}: {result:?}"
            );
        }
    }

    #[test]
    fn rejects_empty_missing_and_non_wav_files() {
        let dir = tempdir();
        let empty = dir.join("empty.wav");
        write_wav(
            &empty,
            spec(1, SAMPLE_RATE, 16, hound::SampleFormat::Int),
            &[],
        );
        let text = dir.join("text.wav");
        std::fs::write(&text, b"not a wav file at all").unwrap();

        assert_eq!(read_analysis_wav(&empty), Err(WavError::Empty));
        assert!(matches!(
            read_analysis_wav(&dir.join("missing.wav")),
            Err(WavError::Open(_))
        ));
        assert!(matches!(read_analysis_wav(&text), Err(WavError::Format(_))));
    }

    #[test]
    fn rejects_a_header_longer_than_the_limit_before_reading_samples() {
        let dir = tempdir();
        let path = dir.join("long.wav");
        write_wav(
            &path,
            spec(1, SAMPLE_RATE, 16, hound::SampleFormat::Int),
            &[0; 4],
        );
        // Patch the data chunk length to claim more than an hour of audio.
        let mut bytes = std::fs::read(&path).unwrap();
        let data = bytes
            .windows(4)
            .position(|window| window == b"data")
            .unwrap();
        let claimed = (MAX_SAMPLES + 1) * 2;
        bytes[data + 4..data + 8].copy_from_slice(&claimed.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();

        assert_eq!(
            read_analysis_wav(&path),
            Err(WavError::TooLong {
                samples: MAX_SAMPLES + 1
            })
        );
    }

    #[test]
    fn rejects_a_truncated_data_chunk() {
        let dir = tempdir();
        let path = dir.join("truncated.wav");
        write_wav(
            &path,
            spec(1, SAMPLE_RATE, 16, hound::SampleFormat::Int),
            &[1; 100],
        );
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() - 50]).unwrap();

        assert!(matches!(read_analysis_wav(&path), Err(WavError::Read(_))));
    }

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "supa-beat-detect-wav-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
