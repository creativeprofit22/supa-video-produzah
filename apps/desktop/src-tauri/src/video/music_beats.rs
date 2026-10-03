//! Music beat analysis: the stored `music-beats-v1` artifact type and the
//! in-app `tempo_fallback` detector.
//!
//! Music beats are detected pulses in a music asset. They are never narrative
//! beats (see CONTEXT.md). The fallback is pure Rust and needs no runtime:
//!
//! 1. Onset envelope: log-magnitude spectral flux of a 1024-point Hann STFT at
//!    a 512-sample hop on 22.05 kHz mono PCM (librosa `onset_strength` shape).
//! 2. Tempo: autocorrelation of the smoothed envelope over 60–200 BPM with a
//!    log-normal prior centred on 120 BPM (librosa `tempo` / Ellis 2007).
//! 3. Music beats: Ellis dynamic-programming beat tracking (librosa
//!    `beat_track`), then the period is refined by a least-squares fit.
//! 4. Onsets: librosa-style peak picking on the same envelope.
//!
//! It is weak on non-percussive music; analyses record which detector ran.

use std::{
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use serde::{Deserialize, Serialize};

use super::{
    error::VideoCommandError, media_store::is_reparse_or_symlink, process::ProcessCancellation,
};

const OPERATION: &str = "detect_music_beats";

/// Sample rate of the extracted analysis audio.
pub(crate) const MUSIC_BEAT_SAMPLE_RATE: u32 = 22_050;
const HOP: usize = 512;
const N_FFT: usize = 1024;
/// Spectral flux at frame `t` peaks on the first frame that contains an onset,
/// which starts up to one hop before it; half a hop centres the error.
const FRAME_OFFSET_SAMPLES: f64 = (HOP / 2) as f64;
const LOG_GAMMA: f32 = 10.0;
const CANCEL_CHECK_FRAMES: usize = 256;

pub(crate) const MUSIC_BEAT_ANALYSIS_FORMAT: &str = "music-beats-v1";
pub(crate) const TEMPO_FALLBACK_VERSION: &str = "tempo-fallback-v1";
pub(crate) const MAX_MUSIC_BEATS: usize = 20_000;
pub(crate) const MAX_DOWNBEATS: usize = 20_000;
pub(crate) const MAX_ONSETS: usize = 60_000;
/// One hour; longer sources are rejected before any work starts.
pub(crate) const MAX_MUSIC_BEAT_DURATION_US: u64 = 3_600_000_000;
pub(crate) const MIN_TEMPO_BPM: f64 = 20.0;
pub(crate) const MAX_TEMPO_BPM: f64 = 400.0;

const SEARCH_MIN_BPM: f64 = 60.0;
const SEARCH_MAX_BPM: f64 = 200.0;
const PRIOR_CENTER_BPM: f64 = 120.0;
const PRIOR_STD_OCTAVES: f64 = 1.0;
const DP_TIGHTNESS: f64 = 100.0;

// ---------------------------------------------------------------------------
// Stored analysis
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MusicBeatDetectorKind {
    BeatThis,
    TempoFallback,
}

impl MusicBeatDetectorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BeatThis => "beat_this",
            Self::TempoFallback => "tempo_fallback",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatDetectorV1 {
    pub(crate) kind: MusicBeatDetectorKind,
    pub(crate) version: String,
    pub(crate) checkpoint_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MusicBeatAnalysisV1 {
    pub(crate) schema_version: u8,
    pub(crate) detector: MusicBeatDetectorV1,
    pub(crate) duration_us: u64,
    pub(crate) tempo_bpm: Option<f64>,
    pub(crate) beats_us: Vec<u64>,
    pub(crate) downbeats_us: Vec<u64>,
    pub(crate) onsets_us: Vec<u64>,
}

/// Why a music beat analysis failed validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MusicBeatAnalysisProblem {
    SchemaVersion,
    Detector,
    Duration,
    Tempo,
    Unsorted,
    OutOfRange,
    TooMany,
}

impl MusicBeatAnalysisV1 {
    pub(crate) fn validate(&self) -> Result<(), MusicBeatAnalysisProblem> {
        if self.schema_version != 1 {
            return Err(MusicBeatAnalysisProblem::SchemaVersion);
        }
        let detector = &self.detector;
        let version_ok = !detector.version.is_empty()
            && detector.version.len() <= 64
            && detector
                .version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_+".contains(&byte));
        let checkpoint_ok = match (detector.kind, detector.checkpoint_sha256.as_deref()) {
            (MusicBeatDetectorKind::BeatThis, Some(digest)) => is_lower_hex_64(digest),
            (MusicBeatDetectorKind::TempoFallback, None) => true,
            _ => false,
        };
        if !version_ok || !checkpoint_ok {
            return Err(MusicBeatAnalysisProblem::Detector);
        }
        if self.duration_us > MAX_MUSIC_BEAT_DURATION_US {
            return Err(MusicBeatAnalysisProblem::Duration);
        }
        match self.tempo_bpm {
            Some(tempo) if !(MIN_TEMPO_BPM..=MAX_TEMPO_BPM).contains(&tempo) => {
                return Err(MusicBeatAnalysisProblem::Tempo)
            }
            Some(_) if self.beats_us.is_empty() => return Err(MusicBeatAnalysisProblem::Tempo),
            _ => {}
        }
        for (times, cap) in [
            (&self.beats_us, MAX_MUSIC_BEATS),
            (&self.downbeats_us, MAX_DOWNBEATS),
            (&self.onsets_us, MAX_ONSETS),
        ] {
            if times.len() > cap {
                return Err(MusicBeatAnalysisProblem::TooMany);
            }
            if times.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(MusicBeatAnalysisProblem::Unsorted);
            }
            if times.last().is_some_and(|last| *last > self.duration_us) {
                return Err(MusicBeatAnalysisProblem::OutOfRange);
            }
        }
        Ok(())
    }
}

/// Sorts, de-duplicates, drops times past `duration_us` and keeps at most `cap`.
pub(crate) fn normalized_times(mut times: Vec<u64>, duration_us: u64, cap: usize) -> Vec<u64> {
    times.retain(|time| *time <= duration_us);
    times.sort_unstable();
    times.dedup();
    times.truncate(cap);
    times
}

/// Converts finite, non-negative seconds to integer microseconds.
pub(crate) fn seconds_to_us(seconds: f64) -> Option<u64> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let micros = (seconds * 1_000_000.0).round();
    (micros <= MAX_MUSIC_BEAT_DURATION_US as f64).then_some(micros as u64)
}

/// Tempo from music beat times: a least-squares period over beat indices
/// assigned from the median interval, so frame quantisation averages out.
pub(crate) fn tempo_from_beats_us(beats_us: &[u64]) -> Option<f64> {
    if beats_us.len() < 4 {
        return None;
    }
    let mut intervals: Vec<f64> = beats_us
        .windows(2)
        .map(|pair| (pair[1] - pair[0]) as f64)
        .collect();
    intervals.sort_by(f64::total_cmp);
    let median = intervals[intervals.len() / 2];
    if median <= 0.0 {
        return None;
    }
    // Indices advance per interval, so a median that is one frame off does
    // not accumulate into a wrong index over a long track.
    let mut index = 0.0;
    let mut points: Vec<(f64, f64)> = Vec::with_capacity(beats_us.len());
    points.push((0.0, beats_us[0] as f64));
    for pair in beats_us.windows(2) {
        index += ((pair[1] - pair[0]) as f64 / median).round().max(1.0);
        points.push((index, pair[1] as f64));
    }
    let count = points.len() as f64;
    let mean_x = points.iter().map(|(x, _)| x).sum::<f64>() / count;
    let mean_y = points.iter().map(|(_, y)| y).sum::<f64>() / count;
    let covariance: f64 = points
        .iter()
        .map(|(x, y)| (x - mean_x) * (y - mean_y))
        .sum();
    let variance: f64 = points.iter().map(|(x, _)| (x - mean_x).powi(2)).sum();
    if variance <= 0.0 {
        return None;
    }
    let period_us = covariance / variance;
    let tempo = 60_000_000.0 / period_us;
    (MIN_TEMPO_BPM..=MAX_TEMPO_BPM)
        .contains(&tempo)
        .then(|| (tempo * 100.0).round() / 100.0)
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// ---------------------------------------------------------------------------
// PCM input
// ---------------------------------------------------------------------------

fn invalid_audio() -> VideoCommandError {
    VideoCommandError::invalid_media(OPERATION, "extracted_audio")
}

fn cancelled() -> VideoCommandError {
    VideoCommandError::process_cancelled(OPERATION, "music_beats")
}

/// Streams a 16-bit mono 22.05 kHz PCM WAV into an onset envelope without
/// holding the samples in memory.
pub(crate) fn onset_envelope_from_wav(
    path: &Path,
    cancellation: &ProcessCancellation,
) -> Result<OnsetEnvelope, VideoCommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid_audio())?;
    if !metadata.is_file() || is_reparse_or_symlink(&metadata) || metadata.len() < 44 {
        return Err(invalid_audio());
    }
    let mut file = File::open(path).map_err(|_| invalid_audio())?;
    let (data_offset, data_len) = pcm_data_chunk(&mut file, metadata.len())?;
    let max_bytes = MAX_MUSIC_BEAT_DURATION_US * u64::from(MUSIC_BEAT_SAMPLE_RATE) / 1_000_000 * 2;
    if data_len > max_bytes {
        return Err(VideoCommandError::invalid_media(
            OPERATION,
            "music_too_long",
        ));
    }
    file.seek(SeekFrom::Start(data_offset))
        .map_err(|_| invalid_audio())?;
    let mut reader = BufReader::with_capacity(1 << 16, file.take(data_len));
    let mut builder = OnsetEnvelopeBuilder::new();
    let mut bytes = vec![0_u8; 1 << 16];
    let mut samples = Vec::with_capacity(1 << 15);
    let mut carry: Option<u8> = None;
    loop {
        let read = reader.read(&mut bytes).map_err(|_| invalid_audio())?;
        if read == 0 {
            break;
        }
        samples.clear();
        let mut chunk = &bytes[..read];
        if let Some(low) = carry.take() {
            samples.push(i16::from_le_bytes([low, chunk[0]]));
            chunk = &chunk[1..];
        }
        let mut pairs = chunk.chunks_exact(2);
        samples.extend(
            pairs
                .by_ref()
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]])),
        );
        carry = pairs.remainder().first().copied();
        builder.push(&samples, cancellation)?;
    }
    builder.finish(cancellation)
}

fn pcm_data_chunk(file: &mut File, file_len: u64) -> Result<(u64, u64), VideoCommandError> {
    let mut riff = [0_u8; 12];
    file.read_exact(&mut riff).map_err(|_| invalid_audio())?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(invalid_audio());
    }
    let mut valid_format = false;
    let mut data = None;
    while file.stream_position().map_err(|_| invalid_audio())? + 8 <= file_len {
        let mut header = [0_u8; 8];
        file.read_exact(&mut header).map_err(|_| invalid_audio())?;
        let size = u64::from(u32::from_le_bytes([
            header[4], header[5], header[6], header[7],
        ]));
        let start = file.stream_position().map_err(|_| invalid_audio())?;
        let end = start.checked_add(size).ok_or_else(invalid_audio)?;
        if end > file_len {
            return Err(invalid_audio());
        }
        if &header[0..4] == b"fmt " {
            if size < 16 {
                return Err(invalid_audio());
            }
            let mut format = [0_u8; 16];
            file.read_exact(&mut format).map_err(|_| invalid_audio())?;
            valid_format = u16::from_le_bytes([format[0], format[1]]) == 1
                && u16::from_le_bytes([format[2], format[3]]) == 1
                && u32::from_le_bytes([format[4], format[5], format[6], format[7]])
                    == MUSIC_BEAT_SAMPLE_RATE
                && u16::from_le_bytes([format[14], format[15]]) == 16;
        } else if &header[0..4] == b"data" {
            if data.is_some() {
                return Err(invalid_audio());
            }
            data = Some((start, size));
        }
        let next = end.checked_add(size % 2).ok_or_else(invalid_audio)?;
        file.seek(SeekFrom::Start(next.min(file_len)))
            .map_err(|_| invalid_audio())?;
    }
    match data {
        Some(layout) if valid_format => Ok(layout),
        _ => Err(invalid_audio()),
    }
}

// ---------------------------------------------------------------------------
// Onset envelope
// ---------------------------------------------------------------------------

/// Spectral flux per analysis frame. Frame `t` is centred on sample `t * HOP`.
#[derive(Clone, Debug)]
pub(crate) struct OnsetEnvelope {
    pub(crate) values: Vec<f32>,
    pub(crate) sample_count: u64,
}

impl OnsetEnvelope {
    pub(crate) fn duration_us(&self) -> u64 {
        self.sample_count * 1_000_000 / u64::from(MUSIC_BEAT_SAMPLE_RATE)
    }

    fn frame_rate() -> f64 {
        f64::from(MUSIC_BEAT_SAMPLE_RATE) / HOP as f64
    }

    fn frame_time_us(frame: f64) -> u64 {
        let seconds =
            (frame * HOP as f64 + FRAME_OFFSET_SAMPLES) / f64::from(MUSIC_BEAT_SAMPLE_RATE);
        (seconds * 1_000_000.0).round().max(0.0) as u64
    }
}

#[cfg(test)]
pub(crate) fn onset_envelope_from_pcm(
    samples: &[i16],
    cancellation: &ProcessCancellation,
) -> Result<OnsetEnvelope, VideoCommandError> {
    let mut builder = OnsetEnvelopeBuilder::new();
    builder.push(samples, cancellation)?;
    builder.finish(cancellation)
}

struct OnsetEnvelopeBuilder {
    fft: Fft,
    window: Vec<f32>,
    /// Centred framing: starts with `N_FFT / 2` zeros (librosa `center=True`).
    pending: Vec<f32>,
    previous: Vec<f32>,
    values: Vec<f32>,
    sample_count: u64,
    real: Vec<f32>,
    imaginary: Vec<f32>,
    current: Vec<f32>,
}

impl OnsetEnvelopeBuilder {
    fn new() -> Self {
        let window = (0..N_FFT)
            .map(|index| {
                let phase = std::f32::consts::PI * index as f32 / N_FFT as f32;
                phase.sin().powi(2)
            })
            .collect();
        Self {
            fft: Fft::new(N_FFT),
            window,
            pending: vec![0.0; N_FFT / 2],
            previous: vec![0.0; N_FFT / 2],
            values: Vec::new(),
            sample_count: 0,
            real: vec![0.0; N_FFT],
            imaginary: vec![0.0; N_FFT],
            current: vec![0.0; N_FFT / 2],
        }
    }

    fn push(
        &mut self,
        samples: &[i16],
        cancellation: &ProcessCancellation,
    ) -> Result<(), VideoCommandError> {
        self.sample_count += samples.len() as u64;
        self.pending
            .extend(samples.iter().map(|sample| f32::from(*sample) / 32_768.0));
        self.drain_frames(cancellation)
    }

    fn drain_frames(
        &mut self,
        cancellation: &ProcessCancellation,
    ) -> Result<(), VideoCommandError> {
        let mut start = 0;
        while start + N_FFT <= self.pending.len() {
            if self.values.len().is_multiple_of(CANCEL_CHECK_FRAMES) && cancellation.is_cancelled()
            {
                return Err(cancelled());
            }
            self.frame(start);
            start += HOP;
        }
        self.pending.drain(..start);
        Ok(())
    }

    fn frame(&mut self, start: usize) {
        for index in 0..N_FFT {
            self.real[index] = self.pending[start + index] * self.window[index];
            self.imaginary[index] = 0.0;
        }
        self.fft.transform(&mut self.real, &mut self.imaginary);
        let mut flux = 0.0_f32;
        for bin in 1..=N_FFT / 2 {
            let magnitude = self.real[bin].hypot(self.imaginary[bin]);
            let compressed = (LOG_GAMMA * magnitude).ln_1p();
            let slot = bin - 1;
            flux += (compressed - self.previous[slot]).max(0.0);
            self.current[slot] = compressed;
        }
        std::mem::swap(&mut self.previous, &mut self.current);
        self.values.push(flux / (N_FFT / 2) as f32);
    }

    fn finish(
        mut self,
        cancellation: &ProcessCancellation,
    ) -> Result<OnsetEnvelope, VideoCommandError> {
        // Centred framing pads the tail too, so the last samples get a frame.
        let frames = self.sample_count.div_ceil(HOP as u64) as usize;
        self.pending.extend(std::iter::repeat_n(0.0, N_FFT));
        self.drain_frames(cancellation)?;
        self.values.truncate(frames.max(1));
        Ok(OnsetEnvelope {
            values: self.values,
            sample_count: self.sample_count,
        })
    }
}

/// Iterative radix-2 complex FFT with precomputed twiddles.
struct Fft {
    bit_reversed: Vec<usize>,
    twiddles: Vec<(f32, f32)>,
}

impl Fft {
    fn new(size: usize) -> Self {
        debug_assert!(size.is_power_of_two());
        let bits = size.trailing_zeros();
        let bit_reversed = (0..size)
            .map(|index| index.reverse_bits() >> (usize::BITS - bits))
            .collect();
        let twiddles = (0..size / 2)
            .map(|index| {
                let angle = -2.0 * std::f64::consts::PI * index as f64 / size as f64;
                (angle.cos() as f32, angle.sin() as f32)
            })
            .collect();
        Self {
            bit_reversed,
            twiddles,
        }
    }

    fn transform(&self, real: &mut [f32], imaginary: &mut [f32]) {
        let size = real.len();
        for index in 0..size {
            let swapped = self.bit_reversed[index];
            if swapped > index {
                real.swap(index, swapped);
                imaginary.swap(index, swapped);
            }
        }
        let mut length = 2;
        while length <= size {
            let half = length / 2;
            let stride = size / length;
            for block in (0..size).step_by(length) {
                for offset in 0..half {
                    let (cos, sin) = self.twiddles[offset * stride];
                    let even = block + offset;
                    let odd = even + half;
                    let odd_real = real[odd] * cos - imaginary[odd] * sin;
                    let odd_imaginary = real[odd] * sin + imaginary[odd] * cos;
                    real[odd] = real[even] - odd_real;
                    imaginary[odd] = imaginary[even] - odd_imaginary;
                    real[even] += odd_real;
                    imaginary[even] += odd_imaginary;
                }
            }
            length *= 2;
        }
    }
}

// ---------------------------------------------------------------------------
// Onsets
// ---------------------------------------------------------------------------

/// librosa `onset_detect` peak picking on the min-max normalised envelope.
pub(crate) fn detect_onsets_us(envelope: &OnsetEnvelope) -> Vec<u64> {
    const PRE_MAX: usize = 1;
    const POST_MAX: usize = 1;
    const PRE_AVG: usize = 4;
    const POST_AVG: usize = 5;
    const DELTA: f32 = 0.07;
    const WAIT: usize = 1;

    let values = &envelope.values;
    let (min, max) = values
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), value| {
            (lo.min(*value), hi.max(*value))
        });
    if values.is_empty() || max - min <= f32::EPSILON {
        return Vec::new();
    }
    let normalized: Vec<f32> = values
        .iter()
        .map(|value| (value - min) / (max - min))
        .collect();
    let mut peaks: Vec<(usize, f32)> = Vec::new();
    let mut last: Option<usize> = None;
    for (frame, value) in normalized.iter().enumerate() {
        let max_window = &normalized
            [frame.saturating_sub(PRE_MAX)..(frame + POST_MAX + 1).min(normalized.len())];
        if max_window.iter().any(|other| other > value) {
            continue;
        }
        let avg_window = &normalized
            [frame.saturating_sub(PRE_AVG)..(frame + POST_AVG + 1).min(normalized.len())];
        let mean = avg_window.iter().sum::<f32>() / avg_window.len() as f32;
        if *value < mean + DELTA {
            continue;
        }
        if last.is_some_and(|previous| frame <= previous + WAIT) {
            continue;
        }
        peaks.push((frame, *value));
        last = Some(frame);
    }
    if peaks.len() > MAX_ONSETS {
        peaks.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        peaks.truncate(MAX_ONSETS);
    }
    let duration_us = envelope.duration_us();
    normalized_times(
        peaks
            .into_iter()
            .map(|(frame, _)| OnsetEnvelope::frame_time_us(frame as f64))
            .collect(),
        duration_us,
        MAX_ONSETS,
    )
}

// ---------------------------------------------------------------------------
// Tempo and music beat tracking
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FallbackMusicBeats {
    pub(crate) tempo_bpm: Option<f64>,
    pub(crate) beats_us: Vec<u64>,
}

/// Runs the tempo estimate and the dynamic-programming tracker.
pub(crate) fn track_music_beats_fallback(
    envelope: &OnsetEnvelope,
    cancellation: &ProcessCancellation,
) -> Result<FallbackMusicBeats, VideoCommandError> {
    let empty = FallbackMusicBeats {
        tempo_bpm: None,
        beats_us: Vec::new(),
    };
    let Some(normalized) = standardized(&envelope.values) else {
        return Ok(empty);
    };
    let Some(period) = estimate_period_frames(&normalized) else {
        return Ok(empty);
    };
    let local = local_score(&normalized, period);
    let frames = dynamic_programming_beats(&local, period, cancellation)?;
    let duration_us = envelope.duration_us();
    let beats_us = normalized_times(
        frames
            .into_iter()
            .map(|frame| OnsetEnvelope::frame_time_us(frame as f64))
            .collect(),
        duration_us,
        MAX_MUSIC_BEATS,
    );
    let tempo_bpm = tempo_from_beats_us(&beats_us).or_else(|| {
        let tempo = 60.0 * OnsetEnvelope::frame_rate() / period;
        (!beats_us.is_empty()).then(|| (tempo * 100.0).round() / 100.0)
    });
    Ok(FallbackMusicBeats {
        tempo_bpm,
        beats_us,
    })
}

/// Envelope divided by its sample standard deviation (librosa local score).
fn standardized(values: &[f32]) -> Option<Vec<f64>> {
    if values.len() < 8 {
        return None;
    }
    let count = values.len() as f64;
    let mean = values.iter().map(|value| f64::from(*value)).sum::<f64>() / count;
    let variance = values
        .iter()
        .map(|value| (f64::from(*value) - mean).powi(2))
        .sum::<f64>()
        / (count - 1.0);
    let deviation = variance.sqrt();
    (deviation > 1e-9).then(|| {
        values
            .iter()
            .map(|value| f64::from(*value) / deviation)
            .collect()
    })
}

/// Beat period in (fractional) frames from the autocorrelation of the
/// smoothed envelope, weighted by a log-normal tempo prior.
fn estimate_period_frames(envelope: &[f64]) -> Option<f64> {
    let smoothed = gaussian_smooth(envelope, 1.0);
    let count = smoothed.len();
    let mean = smoothed.iter().sum::<f64>() / count as f64;
    let centred: Vec<f64> = smoothed.iter().map(|value| value - mean).collect();
    let frame_rate = OnsetEnvelope::frame_rate();
    let min_lag = (60.0 * frame_rate / SEARCH_MAX_BPM).floor().max(1.0) as usize;
    let max_lag = (60.0 * frame_rate / SEARCH_MIN_BPM).floor() as usize;
    if count <= max_lag + 1 {
        return None;
    }
    let scores: Vec<f64> = (min_lag - 1..=max_lag + 1)
        .map(|lag| {
            let sum: f64 = centred[..count - lag]
                .iter()
                .zip(&centred[lag..])
                .map(|(a, b)| a * b)
                .sum();
            let correlation = sum / (count - lag) as f64;
            let bpm = 60.0 * frame_rate / lag as f64;
            let prior =
                (-0.5 * ((bpm / PRIOR_CENTER_BPM).log2() / PRIOR_STD_OCTAVES).powi(2)).exp();
            correlation.max(0.0) * prior
        })
        .collect();
    // scores[i] is lag (min_lag - 1 + i); only interior lags are candidates.
    let (best_index, best) = scores[1..scores.len() - 1]
        .iter()
        .enumerate()
        .map(|(index, score)| (index + 1, *score))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    if best <= 0.0 {
        return None;
    }
    let (left, right) = (scores[best_index - 1], scores[best_index + 1]);
    let curvature = left - 2.0 * best + right;
    let shift = if curvature < 0.0 {
        (0.5 * (left - right) / curvature).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some((min_lag - 1 + best_index) as f64 + shift)
}

fn gaussian_smooth(values: &[f64], sigma: f64) -> Vec<f64> {
    let radius = (3.0 * sigma).ceil() as isize;
    let kernel: Vec<f64> = (-radius..=radius)
        .map(|offset| (-0.5 * (offset as f64 / sigma).powi(2)).exp())
        .collect();
    let total: f64 = kernel.iter().sum();
    (0..values.len() as isize)
        .map(|center| {
            kernel
                .iter()
                .enumerate()
                .filter_map(|(index, weight)| {
                    let source = center + index as isize - radius;
                    usize::try_from(source)
                        .ok()
                        .and_then(|source| values.get(source))
                        .map(|value| value * weight)
                })
                .sum::<f64>()
                / total
        })
        .collect()
}

/// Envelope convolved with a Gaussian of width `period / 32` (librosa
/// `__beat_local_score`).
fn local_score(envelope: &[f64], period: f64) -> Vec<f64> {
    gaussian_smooth(envelope, (period / 32.0).max(0.5))
}

/// Ellis (2007) dynamic programming: each frame's cumulative score is its
/// local score plus the best predecessor 0.5–2 periods back, penalised by
/// `tightness * ln(lag / period)^2`. Backtracks from the last strong peak.
fn dynamic_programming_beats(
    local: &[f64],
    period: f64,
    cancellation: &ProcessCancellation,
) -> Result<Vec<usize>, VideoCommandError> {
    let count = local.len();
    let min_lag = (period / 2.0).round().max(1.0) as usize;
    let max_lag = (2.0 * period).round() as usize;
    let penalties: Vec<f64> = (min_lag..=max_lag)
        .map(|lag| -DP_TIGHTNESS * (lag as f64 / period).ln().powi(2))
        .collect();
    let threshold = 0.01 * local.iter().copied().fold(0.0, f64::max);
    let mut cumulative = vec![0.0_f64; count];
    let mut backlink: Vec<Option<usize>> = vec![None; count];
    let mut started = false;
    for frame in 0..count {
        if frame % 4_096 == 0 && cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let best = (min_lag..=max_lag.min(frame))
            .map(|lag| {
                (
                    frame - lag,
                    cumulative[frame - lag] + penalties[lag - min_lag],
                )
            })
            .max_by(|a, b| a.1.total_cmp(&b.1));
        let weak_start = !started && local[frame] < threshold;
        match best {
            Some((previous, score)) if !weak_start => {
                cumulative[frame] = local[frame] + score;
                backlink[frame] = Some(previous);
            }
            _ => cumulative[frame] = local[frame],
        }
        started |= !weak_start;
    }
    let Some(mut frame) = last_beat(&cumulative) else {
        return Ok(Vec::new());
    };
    let mut beats = vec![frame];
    while let Some(previous) = backlink[frame] {
        beats.push(previous);
        frame = previous;
    }
    beats.reverse();
    Ok(trim_weak_edges(beats, local))
}

/// The last local maximum of the cumulative score above half the median of
/// all local maxima (librosa `__last_beat`).
fn last_beat(cumulative: &[f64]) -> Option<usize> {
    let maxima: Vec<usize> = (0..cumulative.len())
        .filter(|&frame| {
            let left = frame
                .checked_sub(1)
                .map_or(f64::NEG_INFINITY, |i| cumulative[i]);
            let right = cumulative
                .get(frame + 1)
                .copied()
                .unwrap_or(f64::NEG_INFINITY);
            cumulative[frame] > left && cumulative[frame] >= right
        })
        .collect();
    let mut values: Vec<f64> = maxima.iter().map(|&frame| cumulative[frame]).collect();
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let median = values[values.len() / 2];
    maxima
        .into_iter()
        .rev()
        .find(|&frame| cumulative[frame] >= 0.5 * median)
}

/// Drops leading and trailing music beats whose local score is under half
/// the RMS local score at all music beats (librosa `__trim_beats`).
fn trim_weak_edges(beats: Vec<usize>, local: &[f64]) -> Vec<usize> {
    if beats.is_empty() {
        return beats;
    }
    let rms =
        (beats.iter().map(|&frame| local[frame].powi(2)).sum::<f64>() / beats.len() as f64).sqrt();
    let threshold = 0.5 * rms;
    let start = beats
        .iter()
        .position(|&frame| local[frame] >= threshold)
        .unwrap_or(beats.len());
    let end = beats
        .iter()
        .rposition(|&frame| local[frame] >= threshold)
        .map_or(start, |index| index + 1);
    beats[start..end.max(start)].to_vec()
}

/// A synthesized click track for tests in other modules.
#[cfg(test)]
pub(crate) fn click_track_samples(bpm: f64, first_s: f64, seconds: f64) -> Vec<i16> {
    tests::click_track(bpm, first_s, seconds).0
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = MUSIC_BEAT_SAMPLE_RATE as f64;

    /// A decaying 1 kHz burst every `period_s`, starting at `first_s`, plus a
    /// little deterministic noise so the envelope is never perfectly flat.
    pub(super) fn click_track(bpm: f64, first_s: f64, seconds: f64) -> (Vec<i16>, Vec<f64>) {
        let period = 60.0 / bpm;
        let total = (seconds * RATE) as usize;
        let mut samples = vec![0.0_f64; total];
        let mut clicks = Vec::new();
        let mut time = first_s;
        while time < seconds - 0.05 {
            clicks.push(time);
            let start = (time * RATE).round() as usize;
            for offset in 0..(0.03 * RATE) as usize {
                if let Some(sample) = samples.get_mut(start + offset) {
                    let t = offset as f64 / RATE;
                    *sample +=
                        0.8 * (-t / 0.006).exp() * (2.0 * std::f64::consts::PI * 1_000.0 * t).sin();
                }
            }
            time += period;
        }
        let mut seed = 0x1234_5678_u32;
        let pcm = samples
            .into_iter()
            .map(|value| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (f64::from(seed >> 16) / 65_536.0 - 0.5) * 0.002;
                ((value + noise) * 32_767.0).clamp(-32_768.0, 32_767.0) as i16
            })
            .collect();
        (pcm, clicks)
    }

    fn nearest_error_ms(time_us: u64, clicks: &[f64]) -> f64 {
        let time = time_us as f64 / 1_000_000.0;
        clicks
            .iter()
            .map(|click| (click - time).abs() * 1_000.0)
            .fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn fallback_tracks_known_tempo_click_tracks() {
        for bpm in [100.0, 120.0, 128.0] {
            let (pcm, clicks) = click_track(bpm, 0.25, 30.0);
            let envelope = onset_envelope_from_pcm(&pcm, &ProcessCancellation::new()).unwrap();
            let tracked =
                track_music_beats_fallback(&envelope, &ProcessCancellation::new()).unwrap();
            let tempo = tracked.tempo_bpm.unwrap();
            assert!((tempo - bpm).abs() <= 1.0, "{bpm} BPM tracked as {tempo}");
            assert!(
                tracked.beats_us.len() as f64 >= clicks.len() as f64 * 0.9,
                "{bpm} BPM: {} music beats for {} clicks",
                tracked.beats_us.len(),
                clicks.len()
            );
            for beat in &tracked.beats_us {
                let error = nearest_error_ms(*beat, &clicks);
                assert!(
                    error <= 20.0,
                    "{bpm} BPM music beat {beat} is {error} ms off"
                );
            }
        }
    }

    #[test]
    fn onset_peaks_land_on_each_click() {
        let (pcm, clicks) = click_track(90.0, 0.4, 10.0);
        let envelope = onset_envelope_from_pcm(&pcm, &ProcessCancellation::new()).unwrap();
        let onsets = detect_onsets_us(&envelope);
        assert_eq!(onsets.len(), clicks.len());
        for onset in onsets {
            assert!(nearest_error_ms(onset, &clicks) <= 20.0);
        }
    }

    #[test]
    fn silence_has_no_music_beats_or_onsets() {
        let envelope =
            onset_envelope_from_pcm(&vec![0; 22_050 * 5], &ProcessCancellation::new()).unwrap();
        assert!(detect_onsets_us(&envelope).is_empty());
        let tracked = track_music_beats_fallback(&envelope, &ProcessCancellation::new()).unwrap();
        assert_eq!(tracked.tempo_bpm, None);
        assert!(tracked.beats_us.is_empty());
    }

    #[test]
    fn cancellation_stops_the_envelope_and_the_tracker() {
        let (pcm, _) = click_track(120.0, 0.0, 20.0);
        let cancellation = ProcessCancellation::new();
        let envelope = onset_envelope_from_pcm(&pcm, &ProcessCancellation::new()).unwrap();
        cancellation.cancel();
        let error = onset_envelope_from_pcm(&pcm, &cancellation).unwrap_err();
        assert_eq!(
            error.code,
            super::super::error::VideoErrorCode::ProcessCancelled
        );
        let error = track_music_beats_fallback(&envelope, &cancellation).unwrap_err();
        assert_eq!(
            error.code,
            super::super::error::VideoErrorCode::ProcessCancelled
        );
    }

    #[test]
    fn fft_matches_a_direct_transform() {
        let size = 16;
        let fft = Fft::new(size);
        let input: Vec<f32> = (0..size)
            .map(|index| ((index * 7) % 5) as f32 - 2.0)
            .collect();
        let mut real = input.clone();
        let mut imaginary = vec![0.0; size];
        fft.transform(&mut real, &mut imaginary);
        for bin in 0..size {
            let (mut expected_real, mut expected_imaginary) = (0.0_f64, 0.0_f64);
            for (index, value) in input.iter().enumerate() {
                let angle = -2.0 * std::f64::consts::PI * (bin * index) as f64 / size as f64;
                expected_real += f64::from(*value) * angle.cos();
                expected_imaginary += f64::from(*value) * angle.sin();
            }
            assert!((f64::from(real[bin]) - expected_real).abs() < 1e-4);
            assert!((f64::from(imaginary[bin]) - expected_imaginary).abs() < 1e-4);
        }
    }

    fn analysis() -> MusicBeatAnalysisV1 {
        MusicBeatAnalysisV1 {
            schema_version: 1,
            detector: MusicBeatDetectorV1 {
                kind: MusicBeatDetectorKind::TempoFallback,
                version: TEMPO_FALLBACK_VERSION.to_owned(),
                checkpoint_sha256: None,
            },
            duration_us: 4_000_000,
            tempo_bpm: Some(120.0),
            beats_us: vec![0, 500_000, 1_000_000],
            downbeats_us: vec![],
            onsets_us: vec![0, 500_000],
        }
    }

    #[test]
    fn analysis_round_trips_through_json() {
        let value = analysis();
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(json["detector"]["kind"], "tempo_fallback");
        assert_eq!(json["beatsUs"][1], 500_000);
        let parsed: MusicBeatAnalysisV1 = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, value);
        assert_eq!(parsed.validate(), Ok(()));
    }

    #[test]
    fn analysis_rejects_unknown_fields() {
        let mut json = serde_json::to_value(analysis()).unwrap();
        json["narrativeBeats"] = serde_json::json!([]);
        assert!(serde_json::from_value::<MusicBeatAnalysisV1>(json).is_err());
    }

    #[test]
    fn analysis_rejects_invalid_times_and_detectors() {
        let cases: Vec<(MusicBeatAnalysisV1, MusicBeatAnalysisProblem)> = vec![
            (
                MusicBeatAnalysisV1 {
                    beats_us: vec![0, 1_000_000, 500_000],
                    ..analysis()
                },
                MusicBeatAnalysisProblem::Unsorted,
            ),
            (
                MusicBeatAnalysisV1 {
                    onsets_us: vec![5, 5],
                    ..analysis()
                },
                MusicBeatAnalysisProblem::Unsorted,
            ),
            (
                MusicBeatAnalysisV1 {
                    beats_us: vec![0, 5_000_000],
                    ..analysis()
                },
                MusicBeatAnalysisProblem::OutOfRange,
            ),
            (
                MusicBeatAnalysisV1 {
                    duration_us: MAX_MUSIC_BEAT_DURATION_US,
                    onsets_us: (0..=MAX_ONSETS as u64).collect(),
                    ..analysis()
                },
                MusicBeatAnalysisProblem::TooMany,
            ),
            (
                MusicBeatAnalysisV1 {
                    tempo_bpm: Some(f64::NAN),
                    ..analysis()
                },
                MusicBeatAnalysisProblem::Tempo,
            ),
            (
                MusicBeatAnalysisV1 {
                    beats_us: vec![],
                    ..analysis()
                },
                MusicBeatAnalysisProblem::Tempo,
            ),
            (
                MusicBeatAnalysisV1 {
                    detector: MusicBeatDetectorV1 {
                        kind: MusicBeatDetectorKind::BeatThis,
                        version: "1.0.0".to_owned(),
                        checkpoint_sha256: None,
                    },
                    ..analysis()
                },
                MusicBeatAnalysisProblem::Detector,
            ),
            (
                MusicBeatAnalysisV1 {
                    schema_version: 2,
                    ..analysis()
                },
                MusicBeatAnalysisProblem::SchemaVersion,
            ),
        ];
        for (value, problem) in cases {
            assert_eq!(value.validate(), Err(problem));
        }
        let negative = serde_json::json!({
            "schemaVersion": 1,
            "detector": { "kind": "tempo_fallback", "version": "x", "checkpointSha256": null },
            "durationUs": 10, "tempoBpm": null,
            "beatsUs": [-1], "downbeatsUs": [], "onsetsUs": []
        });
        assert!(serde_json::from_value::<MusicBeatAnalysisV1>(negative).is_err());
    }

    #[test]
    fn tempo_from_beats_averages_frame_quantisation() {
        // 120 BPM quantised to 512-sample frames alternates 21/22 frames.
        let beats: Vec<u64> = (0..40)
            .map(|index| {
                let frame = (f64::from(index) * 0.5 * RATE / 512.0).round();
                (frame * 512.0 / RATE * 1_000_000.0).round() as u64
            })
            .collect();
        let tempo = tempo_from_beats_us(&beats).unwrap();
        assert!((tempo - 120.0).abs() < 0.5, "{tempo}");
    }

    #[test]
    fn normalized_times_sorts_dedups_filters_and_caps() {
        assert_eq!(normalized_times(vec![5, 1, 5, 99, 3], 10, 2), vec![1, 3]);
        assert_eq!(seconds_to_us(0.5), Some(500_000));
        assert_eq!(seconds_to_us(-0.1), None);
        assert_eq!(seconds_to_us(f64::INFINITY), None);
    }
}
