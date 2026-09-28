//! Real NVIDIA GPU proof through the production transcription path.
//!
//! Runs consent → pinned-manifest runtime verification → authorized ingest and
//! probe → durable `transcription` job on the GPU slot → real FFmpeg audio
//! extraction → real NeMo-Speech.cpp on `cuda:0` → managed-cache publish →
//! owner-scoped result read. Only the webview click is bypassed. The runner
//! rejects any run whose stderr lacks `Using GPU backend: CUDA0`, so a
//! completed job is itself the device-0 proof.

use std::{collections::BTreeMap, path::PathBuf, time::Duration, time::Instant};

use super::*;
use crate::video::{grants::GrantCategory, nemo_transcription::REAL_ASR_PROOF_ENV};

const GOLD: &str = "And so my fellow Americans ask not what your country can do for you \
                    ask what you can do for your country.";
const JFK_WER_THRESHOLD: f64 = 0.15;

fn normalize(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|character| character.is_alphanumeric() || *character == '\'')
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

fn word_error_rate(reference: &str, hypothesis: &str) -> f64 {
    let (reference, hypothesis) = (normalize(reference), normalize(hypothesis));
    let mut row: Vec<usize> = (0..=hypothesis.len()).collect();
    for (index, expected) in reference.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = index + 1;
        for (column, actual) in hypothesis.iter().enumerate() {
            let substitution = diagonal + usize::from(expected != actual);
            diagonal = row[column + 1];
            row[column + 1] = substitution.min(row[column] + 1).min(row[column + 1] + 1);
        }
    }
    row[hypothesis.len()] as f64 / reference.len().max(1) as f64
}

#[test]
fn word_error_rate_counts_edits_over_reference_words() {
    assert_eq!(word_error_rate("ask not what", "Ask not, what"), 0.0);
    assert!((word_error_rate("ask not what", "ask what") - 1.0 / 3.0).abs() < 1e-9);
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the pinned NeMo runtime folder, an NVIDIA GPU and FFmpeg"]
async fn real_nemo_cuda_transcription_through_production_job_path() {
    assert_eq!(required_env(REAL_ASR_PROOF_ENV), "1");
    let runtime_folder = required_env("SUPA_VIDEO_REAL_ASR_RUNTIME");
    let source = PathBuf::from(required_env("SUPA_VIDEO_REAL_ASR_SOURCE"));
    let tools = PathBuf::from(required_env("SUPA_VIDEO_REAL_ASR_FFMPEG_DIR"));
    let evidence_path = PathBuf::from(required_env("SUPA_VIDEO_REAL_ASR_EVIDENCE"));
    // Optional reference transcript for a non-JFK source. The JFK WER gate
    // applies only to the built-in JFK reference; an edited reference (such as
    // a published podcast transcript without fillers) is recorded, not gated.
    let gold_override = std::env::var("SUPA_VIDEO_REAL_ASR_GOLD_FILE")
        .ok()
        .map(|path| std::fs::read_to_string(path).expect("gold file must be readable"));
    let gold = gold_override.as_deref().unwrap_or(GOLD);

    let workspace = tempfile::tempdir().unwrap();
    let config_dir = workspace.path().join("config");
    let cache_root = workspace.path().join("cache");
    std::fs::create_dir_all(&cache_root).unwrap();
    let jobs = MediaJobService::initialize(workspace.path().join("local-data"), cache_root.clone())
        .await
        .unwrap();
    jobs.scheduler().start();

    // Fails closed before consent, exactly as the command does.
    assert!(require_ready_runtime(&config_dir).await.is_err());
    let status = set_asr_consent(&config_dir, true, &pinned_manifest_sha256())
        .await
        .unwrap();
    assert_eq!(status.consent, AsrConsentState::Accepted);
    let verify_started = Instant::now();
    let status = set_asr_runtime_folder(&config_dir, &jobs, &runtime_folder)
        .await
        .unwrap();
    let runtime_verify_ms = verify_started.elapsed().as_millis();
    assert_eq!(status.runtime, AsrRuntimeAvailability::Ready);

    let grants = VideoPathGrants::default();
    grants
        .grant_existing_file("main", GrantCategory::Source, &source)
        .unwrap();
    let programs = || {
        MediaPrograms::explicit(
            tools.join("ffmpeg.exe").into_os_string(),
            tools.join("ffprobe.exe").into_os_string(),
        )
    };
    let request = || StartTranscriptionRequest {
        project_id: "51000000-0000-4000-8000-000000000001".to_owned(),
        asset_id: "51000000-0000-4000-8000-000000000002".to_owned(),
        source_path: source.to_string_lossy().into_owned(),
    };

    let started_at = Instant::now();
    let started = start_transcription(
        TranscriptionStartContext {
            owner_label: "main",
            grants: &grants,
            jobs: &jobs,
            programs: programs(),
            app_cache_root: cache_root.clone(),
        },
        require_ready_runtime(&config_dir).await.unwrap(),
        request(),
    )
    .await
    .unwrap();
    let job = loop {
        let job = jobs
            .store()
            .get_private(started.job_id.clone())
            .await
            .unwrap()
            .public;
        if matches!(
            job.state,
            MediaJobState::Complete
                | MediaJobState::Failed
                | MediaJobState::Cancelled
                | MediaJobState::Blocked
        ) {
            break job;
        }
        assert!(started_at.elapsed() < Duration::from_secs(900), "job stuck");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let job_wall_clock_ms = started_at.elapsed().as_millis();
    assert_eq!(
        job.state,
        MediaJobState::Complete,
        "job error: {:?}",
        job.error
    );
    assert_eq!(job.kind, MediaJobKind::Transcription);

    let result = transcription_result(&jobs, "main", &started.job_id)
        .await
        .unwrap();
    let artifact = crate::video::transcript::load_managed_transcript_artifact_for_key(
        &cache_root,
        &result.transcript_key,
    )
    .await
    .unwrap();
    let text = artifact
        .words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let wer = word_error_rate(gold, &text);
    let timed = artifact
        .words
        .iter()
        .filter(|word| word.source_end_us > word.source_start_us)
        .count();
    let labelled = artifact
        .words
        .iter()
        .filter(|word| word.speaker_label.is_some())
        .count();
    let speakers: std::collections::BTreeSet<_> = artifact
        .words
        .iter()
        .filter_map(|word| word.speaker_label.as_deref())
        .collect();
    let words_detail: Vec<_> = artifact
        .words
        .iter()
        .map(|word| {
            serde_json::json!({
                "text": word.text,
                "startUs": word.source_start_us,
                "endUs": word.source_end_us,
                "speaker": word.speaker_label,
            })
        })
        .collect();

    // Same source and configuration: the artifact identity dedupes the work.
    let second_started_at = Instant::now();
    let second = start_transcription(
        TranscriptionStartContext {
            owner_label: "main",
            grants: &grants,
            jobs: &jobs,
            programs: programs(),
            app_cache_root: cache_root.clone(),
        },
        require_ready_runtime(&config_dir).await.unwrap(),
        request(),
    )
    .await
    .unwrap();
    let second_ms = second_started_at.elapsed().as_millis();
    let second_result = transcription_result(&jobs, "main", &second.job_id)
        .await
        .unwrap();

    let provider_settings: BTreeMap<_, _> = artifact
        .configuration
        .provider_settings
        .iter()
        .map(|setting| {
            (
                setting.key.clone(),
                serde_json::to_value(&setting.value).unwrap(),
            )
        })
        .collect();
    let evidence = serde_json::json!({
        "test": "real_nemo_cuda_transcription_through_production_job_path",
        "path": "consent -> pinned manifest verify -> authorized ingest/probe -> durable transcription job (Gpu slot) -> FFmpeg 16 kHz mono WAV -> NeMo-Speech.cpp cuda:0 -> managed transcript artifact -> owner-scoped result read",
        "cudaProof": "runner rejects runs without stderr 'Using GPU backend: CUDA0'; the job completed",
        "job": {
            "id": started.job_id,
            "state": job.state,
            "attempt": job.attempt,
            "maxAttempts": job.max_attempts,
        },
        "runtimeVerifyMs": runtime_verify_ms,
        "jobWallClockMs": job_wall_clock_ms,
        "sourceDurationUs": artifact.source_duration_us,
        "transcriptKey": result.transcript_key,
        "wordCount": artifact.words.len(),
        "wordsWithPositiveTiming": timed,
        "text": text,
        "gold": gold,
        "wer": wer,
        "werThreshold": gold_override.is_none().then_some(JFK_WER_THRESHOLD),
        "speakerDiarizationMode": artifact.configuration.speaker_diarization_mode,
        "labelledWordCount": labelled,
        "missingSpeakerWordCount": artifact.uncertainty_counts.missing_speaker_word_count,
        "distinctSpeakers": speakers,
        "words": words_detail,
        "engineVersion": artifact.configuration.engine_version,
        "modelId": artifact.configuration.model_id,
        "modelRevision": artifact.configuration.model_revision,
        "providerSettings": provider_settings,
        "manifestSha256": pinned_manifest_sha256(),
        "secondStart": {
            "state": second.state,
            "transcriptKey": second_result.transcript_key,
            "elapsedMs": second_ms,
        },
    });
    std::fs::write(
        &evidence_path,
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();

    if gold_override.is_none() {
        assert!(
            wer <= JFK_WER_THRESHOLD,
            "WER {wer} above threshold: {text}"
        );
    }
    if artifact.configuration.speaker_diarization_mode
        != crate::video::transcript::SpeakerDiarizationModeV1::Off
    {
        assert!(labelled > 0, "the diarizer labelled no word");
    }
    assert_eq!(timed, artifact.words.len());
    assert_eq!(second.state, MediaJobState::Complete);
    assert_eq!(second_result.transcript_key, result.transcript_key);
    jobs.shutdown().await.unwrap();
}
