use super::{
    clip_timing::ClipSpeed,
    commands::apply_group,
    integrity::validate_state,
    speed_edit_tests::{fixture, set},
    types::{ProjectCommand, ProjectTrack},
};
use crate::video::types::{RationalRate, RationalTime};

fn id(value: u64) -> String {
    format!("a0000000-0000-4000-8000-{value:012x}")
}

#[test]
fn retimed_split_trim_move_and_ripple_use_exact_sequence_frames_and_restore_hashes() {
    for mixed in [false, true] {
        let mut base = fixture();
        let source_rate = if mixed {
            RationalRate {
                numerator: 30000,
                denominator: 1001,
            }
        } else {
            RationalRate {
                numerator: 30,
                denominator: 1,
            }
        };
        let sequence_rate = if mixed {
            RationalRate {
                numerator: 24000,
                denominator: 1001,
            }
        } else {
            source_rate.clone()
        };
        base.state.assets[0].probe.average_frame_rate = source_rate.clone();
        base.state.assets[0].probe.real_frame_rate = source_rate.clone();
        let sequence = &mut base.state.sequences[0];
        sequence.rate = sequence_rate.clone();
        for track in &mut sequence.tracks {
            match track {
                ProjectTrack::Video { clips, .. } | ProjectTrack::Audio { clips, .. } => {
                    for clip in clips {
                        clip.timeline_start.rate_numerator = sequence_rate.numerator;
                        clip.timeline_start.rate_denominator = sequence_rate.denominator;
                        clip.source_in.rate_numerator = source_rate.numerator;
                        clip.source_in.rate_denominator = source_rate.denominator;
                        clip.source_out.rate_numerator = source_rate.numerator;
                        clip.source_out.rate_denominator = source_rate.denominator;
                    }
                }
                ProjectTrack::Caption { captions, .. } => {
                    for caption in captions {
                        for time in [&mut caption.start, &mut caption.end] {
                            time.rate_numerator = sequence_rate.numerator;
                            time.rate_denominator = sequence_rate.denominator;
                        }
                    }
                }
            }
        }
        for marker in &mut sequence.markers {
            marker.time.rate_numerator = sequence_rate.numerator;
            marker.time.rate_denominator = sequence_rate.denominator;
        }
        validate_state(&base.state).unwrap();
        let normal_duration = if mixed { 240 } else { 300 };
        for speed in [
            ClipSpeed {
                numerator: 1,
                denominator: 2,
            },
            ClipSpeed {
                numerator: 1,
                denominator: 1,
            },
            ClipSpeed {
                numerator: 3,
                denominator: 2,
            },
            ClipSpeed {
                numerator: 2,
                denominator: 1,
            },
        ] {
            let retimed = apply_group(&base.state, &[set(&base, speed, 800)])
                .unwrap()
                .state;
            let seq = &retimed.sequences[0];
            let target = &seq.tracks[0].clips().unwrap()[0];
            let duration = normal_duration * speed.denominator / speed.numerator;
            let split = ProjectCommand::SplitClip {
                command_id: id(801),
                sequence_id: seq.id.clone(),
                track_id: seq.tracks[0].id().to_owned(),
                clip_id: target.id.clone(),
                split_at: RationalTime {
                    value: 180,
                    ..target.source_in.clone()
                },
                right_clip_id: id(802),
            };
            let result = apply_group(&retimed, &[split]).unwrap();
            let clips = result.state.sequences[0].tracks[0].clips().unwrap();
            assert_eq!(clips[0].source_out.value, 180);
            assert_eq!(clips[1].source_in.value, 180);
            assert_eq!(clips[1].source_out, target.source_out);
            assert_eq!(clips[1].timeline_start.value, 10 + duration / 2);
            assert_eq!(clips[0].speed, target.speed);
            assert_eq!(clips[1].speed, target.speed);
            assert_eq!(
                apply_group(&result.state, &result.inverse_commands)
                    .unwrap()
                    .state,
                retimed
            );
            let trim = ProjectCommand::TrimClip {
                command_id: id(803),
                sequence_id: seq.id.clone(),
                track_id: seq.tracks[0].id().to_owned(),
                clip_id: target.id.clone(),
                source_in: RationalTime {
                    value: 60,
                    ..target.source_in.clone()
                },
                source_out: RationalTime {
                    value: 300,
                    ..target.source_out.clone()
                },
            };
            let result = apply_group(&retimed, &[trim]).unwrap();
            assert_eq!(result.affected_ranges[1].end.value, 10 + duration * 4 / 5);
            assert_eq!(
                apply_group(&result.state, &result.inverse_commands)
                    .unwrap()
                    .state,
                retimed
            );
            let moved = ProjectCommand::MoveClip {
                command_id: id(804),
                sequence_id: seq.id.clone(),
                track_id: seq.tracks[0].id().to_owned(),
                clip_id: target.id.clone(),
                timeline_start: RationalTime {
                    value: 20,
                    ..target.timeline_start.clone()
                },
            };
            let result = apply_group(&retimed, &[moved]).unwrap();
            assert_eq!(result.affected_ranges[1].end.value, 20 + duration);
            assert_eq!(
                apply_group(&result.state, &result.inverse_commands)
                    .unwrap()
                    .state,
                retimed
            );
            let ripple = ProjectCommand::RippleDeleteClip {
                command_id: id(805),
                sequence_id: seq.id.clone(),
                track_id: seq.tracks[0].id().to_owned(),
                clip_id: target.id.clone(),
            };
            let result = apply_group(&retimed, &[ripple]).unwrap();
            assert_eq!(
                result.state.sequences[0].tracks[0].clips().unwrap()[0]
                    .timeline_start
                    .value,
                700 - duration
            );
            assert_eq!(
                result.state.sequences[0].tracks[1..],
                retimed.sequences[0].tracks[1..]
            );
            assert_eq!(
                result.state.sequences[0].markers,
                retimed.sequences[0].markers
            );
            assert_eq!(
                apply_group(&result.state, &result.inverse_commands)
                    .unwrap()
                    .state,
                retimed
            );
        }
    }
}

#[test]
fn retimed_source_boundary_rejections_do_not_round_or_mutate_the_group() {
    let base = fixture();
    let retimed = apply_group(
        &base.state,
        &[set(
            &base,
            ClipSpeed {
                numerator: 3,
                denominator: 2,
            },
            810,
        )],
    )
    .unwrap()
    .state;
    let seq = &retimed.sequences[0];
    let target = &seq.tracks[0].clips().unwrap()[0];
    let split = ProjectCommand::SplitClip {
        command_id: id(811),
        sequence_id: seq.id.clone(),
        track_id: seq.tracks[0].id().to_owned(),
        clip_id: target.id.clone(),
        split_at: RationalTime {
            value: 31,
            ..target.source_in.clone()
        },
        right_clip_id: id(812),
    };
    let trim = ProjectCommand::TrimClip {
        command_id: id(813),
        sequence_id: seq.id.clone(),
        track_id: seq.tracks[0].id().to_owned(),
        clip_id: target.id.clone(),
        source_in: target.source_in.clone(),
        source_out: RationalTime {
            value: 329,
            ..target.source_out.clone()
        },
    };
    let before = super::hash::state_hash(&retimed).unwrap();
    for command in [split, trim] {
        assert_eq!(
            apply_group(&retimed, &[command]).unwrap_err().details["category"],
            "inexact_time"
        );
        assert_eq!(super::hash::state_hash(&retimed).unwrap(), before);
    }
}
