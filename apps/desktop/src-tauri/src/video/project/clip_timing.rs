use serde::{Deserialize, Serialize};

use super::integrity::{valid_rate, valid_time_shape};
use super::types::{ProjectClip, MAX_SAFE_INTEGER};
use crate::video::types::{RationalRate, RationalTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipSpeed {
    pub numerator: u64,
    pub denominator: u64,
}

impl Default for ClipSpeed {
    fn default() -> Self {
        Self {
            numerator: 1,
            denominator: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingError {
    InvalidRate,
    InvalidSpeed,
    InvalidRange,
    Inexact,
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SamplePolicy {
    Exact,
    Floor,
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

pub fn validate_speed(speed: &ClipSpeed) -> Result<(), TimingError> {
    let rate = RationalRate {
        numerator: speed.numerator,
        denominator: speed.denominator,
    };
    if !valid_rate(&rate) {
        return Err(TimingError::InvalidSpeed);
    }
    let percent = u128::from(speed.numerator) * 100;
    let denominator = u128::from(speed.denominator);
    if percent % denominator != 0 || !(50 * denominator..=200 * denominator).contains(&percent) {
        return Err(TimingError::InvalidSpeed);
    }
    Ok(())
}

pub fn deserialize_valid_speed<'de, D>(deserializer: D) -> Result<ClipSpeed, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let speed = ClipSpeed::deserialize(deserializer)?;
    validate_speed(&speed).map_err(|_| {
        serde::de::Error::custom("Speed must be a reduced whole percentage from 50% through 200%")
    })?;
    Ok(speed)
}

/// Only normalize deliberate edits; never rewrite a loaded snapshot's representation.
pub fn normalize_speed(speed: ClipSpeed) -> Result<Option<ClipSpeed>, TimingError> {
    validate_speed(&speed)?;
    Ok((speed != ClipSpeed::default()).then_some(speed))
}

fn rate_of(time: &RationalTime) -> Result<RationalRate, TimingError> {
    let rate = RationalRate {
        numerator: time.rate_numerator,
        denominator: time.rate_denominator,
    };
    if !valid_time_shape(time) {
        return Err(TimingError::InvalidRate);
    }
    Ok(rate)
}

fn convert_frames(
    value: u64,
    from: &RationalRate,
    to: &RationalRate,
    multiplier: ClipSpeed,
    policy: SamplePolicy,
) -> Result<u64, TimingError> {
    let mut numerators = [value, from.denominator, to.numerator, multiplier.numerator];
    let mut denominators = [from.numerator, to.denominator, multiplier.denominator];
    for numerator in &mut numerators {
        for denominator in &mut denominators {
            let divisor = gcd(*numerator, *denominator);
            *numerator /= divisor;
            *denominator /= divisor;
        }
    }
    if policy == SamplePolicy::Exact && denominators != [1, 1, 1] {
        return Err(TimingError::Inexact);
    }
    let product = |factors: &[u64]| {
        factors.iter().try_fold(1_u128, |product, &factor| {
            product
                .checked_mul(u128::from(factor))
                .ok_or(TimingError::Overflow)
        })
    };
    let result = product(&numerators)? / product(&denominators)?;
    if result > u128::from(MAX_SAFE_INTEGER) {
        return Err(TimingError::Overflow);
    }
    Ok(result as u64)
}

pub fn source_offset_to_timeline(
    offset: &RationalTime,
    sequence_rate: &RationalRate,
    speed: &ClipSpeed,
    policy: SamplePolicy,
) -> Result<RationalTime, TimingError> {
    let from = rate_of(offset)?;
    if !valid_rate(sequence_rate) {
        return Err(TimingError::InvalidRate);
    }
    validate_speed(speed)?;
    let value = convert_frames(
        offset.value,
        &from,
        sequence_rate,
        ClipSpeed {
            numerator: speed.denominator,
            denominator: speed.numerator,
        },
        policy,
    )?;
    Ok(RationalTime {
        value,
        rate_numerator: sequence_rate.numerator,
        rate_denominator: sequence_rate.denominator,
    })
}

/// Relative offsets only. Exact for edits; Floor for selecting the displayed source sample.
pub fn timeline_offset_to_source(
    offset: &RationalTime,
    source_rate: &RationalRate,
    speed: &ClipSpeed,
    policy: SamplePolicy,
) -> Result<RationalTime, TimingError> {
    let from = rate_of(offset)?;
    if !valid_rate(source_rate) {
        return Err(TimingError::InvalidRate);
    }
    validate_speed(speed)?;
    let value = convert_frames(offset.value, &from, source_rate, *speed, policy)?;
    Ok(RationalTime {
        value,
        rate_numerator: source_rate.numerator,
        rate_denominator: source_rate.denominator,
    })
}

pub fn clip_timeline_duration(
    source_in: &RationalTime,
    source_out: &RationalTime,
    sequence_rate: &RationalRate,
    speed: &ClipSpeed,
) -> Result<RationalTime, TimingError> {
    if rate_of(source_in)? != rate_of(source_out)? || source_out.value <= source_in.value {
        return Err(TimingError::InvalidRange);
    }
    let offset = RationalTime {
        value: source_out.value - source_in.value,
        rate_numerator: source_in.rate_numerator,
        rate_denominator: source_in.rate_denominator,
    };
    let duration = source_offset_to_timeline(&offset, sequence_rate, speed, SamplePolicy::Exact)?;
    if duration.value == 0 {
        return Err(TimingError::InvalidRange);
    }
    Ok(duration)
}

/// Shared by command affected ranges and native overlap/integrity validation.
pub fn project_clip_timeline_duration(clip: &ProjectClip) -> Result<u64, TimingError> {
    let rate = rate_of(&clip.timeline_start)?;
    clip_timeline_duration(
        &clip.source_in,
        &clip.source_out,
        &rate,
        &clip.speed.unwrap_or_default(),
    )
    .map(|duration| duration.value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Fixture {
        name: String,
        source_in: RationalTime,
        source_out: RationalTime,
        sequence_rate: RationalRate,
        speed: Option<ClipSpeed>,
        expected: Option<u64>,
    }

    #[test]
    fn shared_speed_timing_fixtures() {
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "../../../../../../packages/video-contracts/fixtures/clip-speed-timing.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let result = clip_timeline_duration(
                &fixture.source_in,
                &fixture.source_out,
                &fixture.sequence_rate,
                &fixture.speed.unwrap_or_default(),
            );
            assert_eq!(
                result.map(|time| time.value).ok(),
                fixture.expected,
                "{}",
                fixture.name
            );
        }
    }

    #[test]
    fn mapping_rejects_inexact_edits_but_floors_display_samples() {
        let rate = RationalRate {
            numerator: 30,
            denominator: 1,
        };
        let offset = RationalTime {
            value: 1,
            rate_numerator: 30,
            rate_denominator: 1,
        };
        let speed = ClipSpeed {
            numerator: 3,
            denominator: 2,
        };
        assert_eq!(
            timeline_offset_to_source(&offset, &rate, &speed, SamplePolicy::Exact),
            Err(TimingError::Inexact)
        );
        assert_eq!(
            timeline_offset_to_source(&offset, &rate, &speed, SamplePolicy::Floor)
                .unwrap()
                .value,
            1
        );
        let zero = RationalTime { value: 0, ..offset };
        assert_eq!(
            timeline_offset_to_source(&zero, &rate, &speed, SamplePolicy::Exact)
                .unwrap()
                .value,
            0
        );
    }

    #[test]
    fn normal_speed_edit_normalizes_to_omission() {
        assert_eq!(normalize_speed(ClipSpeed::default()), Ok(None));
        let fast = ClipSpeed {
            numerator: 3,
            denominator: 2,
        };
        assert_eq!(normalize_speed(fast), Ok(Some(fast)));
    }

    #[test]
    fn speed_wire_shape_is_strict() {
        for text in [
            r#"{"numerator":-1,"denominator":1}"#,
            r#"{"numerator":1.5,"denominator":1}"#,
            r#"{"numerator":1,"denominator":1,"extra":true}"#,
            "null",
        ] {
            assert!(serde_json::from_str::<ClipSpeed>(text).is_err());
        }
        for speed in [
            ClipSpeed {
                numerator: 0,
                denominator: 1,
            },
            ClipSpeed {
                numerator: 2,
                denominator: 2,
            },
            ClipSpeed {
                numerator: 1,
                denominator: 3,
            },
            ClipSpeed {
                numerator: 201,
                denominator: 100,
            },
            ClipSpeed {
                numerator: MAX_SAFE_INTEGER + 1,
                denominator: 1,
            },
        ] {
            assert_eq!(validate_speed(&speed), Err(TimingError::InvalidSpeed));
        }
    }
}
