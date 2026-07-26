use serde::Serialize;
use sha2::{Digest, Sha256};

use super::types::VideoProjectStateV2;
use crate::video::error::VideoCommandError;

pub fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, VideoCommandError> {
    serde_json_canonicalizer::to_vec(value)
        .map_err(|_| VideoCommandError::project_io("canonicalize_project", "json"))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn canonical_hash<T: Serialize>(value: &T) -> Result<String, VideoCommandError> {
    Ok(sha256_hex(&canonical_bytes(value)?))
}

pub fn state_hash(state: &VideoProjectStateV2) -> Result<String, VideoCommandError> {
    canonical_hash(state)
}
