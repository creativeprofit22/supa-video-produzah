//! Command-line contract (stdout = one JSON object, nothing else).
//!
//! ```text
//! supa-beat-detect probe  --models <dir> [--cuda <dir>]
//! supa-beat-detect detect --models <dir> [--cuda <dir>] --device auto|cuda|cpu <wav>
//! ```
//!
//! Exit codes: 0 success, 2 bad input (arguments or WAV), 3 runtime failure (models, devices).
//! Without `--cuda`, `auto` runs on the CPU and `cuda` is a usage error.

use std::ffi::OsString;
use std::path::PathBuf;

use serde::Serialize;

use crate::device::{Detection, DevicePreference, Outcome};

/// `beat-this` crate version that implements the pipeline (pinned `=1.1.0` in Cargo.toml).
pub const BEAT_THIS_VERSION: &str = "1.1.0";

pub const EXIT_BAD_INPUT: i32 = 2;
pub const EXIT_RUNTIME_FAILURE: i32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Probe {
        models: PathBuf,
        cuda: Option<PathBuf>,
    },
    Detect {
        models: PathBuf,
        cuda: Option<PathBuf>,
        device: DevicePreference,
        wav: PathBuf,
    },
}

pub fn usage() -> &'static str {
    "usage: supa-beat-detect probe --models <dir> [--cuda <dir>]\n       supa-beat-detect detect --models <dir> [--cuda <dir>] --device auto|cuda|cpu <wav>"
}

/// Parses the arguments after the program name.
pub fn parse(args: &[OsString]) -> Result<Command, String> {
    let (subcommand, rest) = args.split_first().ok_or("missing subcommand")?;
    let subcommand = subcommand.to_str().ok_or("subcommand is not UTF-8")?;
    let mut models = None;
    let mut cuda = None;
    let mut device = None;
    let mut positional = Vec::new();
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        let flag = arg.to_str().unwrap_or_default();
        let slot = match flag {
            "--models" => Some(&mut models),
            "--cuda" => Some(&mut cuda),
            "--device" => Some(&mut device),
            _ if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            _ => None,
        };
        match slot {
            Some(slot) => {
                let value = iter.next().ok_or(format!("{flag} needs a value"))?;
                if slot.replace(value.clone()).is_some() {
                    return Err(format!("{flag} given twice"));
                }
            }
            None => positional.push(PathBuf::from(arg)),
        }
    }
    let models = models.map(PathBuf::from).ok_or("--models is required")?;
    let cuda = cuda.map(PathBuf::from);
    match subcommand {
        "probe" => {
            if device.is_some() || !positional.is_empty() {
                return Err("probe takes only --models and --cuda".to_owned());
            }
            Ok(Command::Probe { models, cuda })
        }
        "detect" => {
            let device = device.ok_or("--device is required")?;
            let device = device
                .to_str()
                .and_then(DevicePreference::parse)
                .ok_or("--device must be auto, cuda or cpu")?;
            if device == DevicePreference::Cuda && cuda.is_none() {
                return Err("--device cuda needs --cuda <dir>".to_owned());
            }
            let [wav] = <[PathBuf; 1]>::try_from(positional)
                .map_err(|_| "detect takes exactly one WAV path".to_owned())?;
            Ok(Command::Detect {
                models,
                cuda,
                device,
                wav,
            })
        }
        other => Err(format!("unknown subcommand {other}")),
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutput {
    pub version: &'static str,
    pub device: &'static str,
    pub cuda_error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub mel_ms: u64,
    pub inference_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectOutput {
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub device: &'static str,
    pub cuda_error: Option<String>,
    pub timing: Timing,
}

impl From<Outcome<Detection>> for DetectOutput {
    fn from(outcome: Outcome<Detection>) -> Self {
        Self {
            beats: outcome.value.beats,
            downbeats: outcome.value.downbeats,
            device: outcome.device.as_str(),
            cuda_error: outcome.cuda_error,
            timing: Timing {
                mel_ms: outcome.value.mel_ms,
                inference_ms: outcome.value.inference_ms,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::Device;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_probe_and_detect() {
        assert_eq!(
            parse(&args(&["probe", "--models", "m", "--cuda", "c"])),
            Ok(Command::Probe {
                models: "m".into(),
                cuda: Some("c".into())
            })
        );
        assert_eq!(
            parse(&args(&[
                "detect", "--device", "auto", "--models", "m", "in.wav"
            ])),
            Ok(Command::Detect {
                models: "m".into(),
                cuda: None,
                device: DevicePreference::Auto,
                wav: "in.wav".into()
            })
        );
    }

    #[test]
    fn rejects_bad_arguments() {
        let cases: &[&[&str]] = &[
            &[],
            &["explode", "--models", "m"],
            &["probe"],
            &["probe", "--models"],
            &["probe", "--models", "m", "--models", "n"],
            &["probe", "--models", "m", "--device", "cpu"],
            &["probe", "--models", "m", "extra"],
            &["probe", "--models", "m", "--verbose"],
            &["detect", "--models", "m", "in.wav"],
            &["detect", "--models", "m", "--device", "gpu", "in.wav"],
            &["detect", "--models", "m", "--device", "cuda", "in.wav"],
            &["detect", "--models", "m", "--device", "cpu"],
            &[
                "detect", "--models", "m", "--device", "cpu", "a.wav", "b.wav",
            ],
        ];
        for case in cases {
            assert!(parse(&args(case)).is_err(), "{case:?} should be rejected");
        }
    }

    #[test]
    fn detect_output_uses_the_documented_json_shape() {
        let output = DetectOutput::from(Outcome {
            value: Detection {
                beats: vec![0.5, 1.0],
                downbeats: vec![0.5],
                load_ms: 9,
                mel_ms: 3,
                inference_ms: 7,
            },
            device: Device::Cpu,
            cuda_error: Some("no cuDNN".to_owned()),
        });

        assert_eq!(
            serde_json::to_string(&output).unwrap(),
            r#"{"beats":[0.5,1.0],"downbeats":[0.5],"device":"cpu","cudaError":"no cuDNN","timing":{"melMs":3,"inferenceMs":7}}"#
        );
    }

    #[test]
    fn probe_output_uses_the_documented_json_shape() {
        let output = ProbeOutput {
            version: BEAT_THIS_VERSION,
            device: "cuda",
            cuda_error: None,
        };

        assert_eq!(
            serde_json::to_string(&output).unwrap(),
            r#"{"version":"1.1.0","device":"cuda","cudaError":null}"#
        );
    }
}
