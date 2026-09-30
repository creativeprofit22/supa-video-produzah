//! Receipt store: SQLite database holding acquisition receipts (keyed by
//! receipt id, indexed by content digest) and immutable, content-addressed
//! snapshot blobs. Blobs and the receipt row commit in one transaction.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};

use super::types::{AcquisitionReceipt, LicenseSnapshot, RefreshStatus, SnapshotKind};

const DATABASE_FILENAME: &str = "rights-v1.sqlite3";
const APPLICATION_ID: i64 = 0x5256_5231; // "RVR1"
const SCHEMA_VERSION: i64 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ReceiptStoreError {
    #[error("rights store directory is unsafe")]
    UnsafeDirectory,
    #[error("rights store belongs to another application")]
    ForeignDatabase,
    #[error("rights store schema {0} is newer than this app")]
    UnsupportedSchema(i64),
    #[error("snapshot bytes do not match their recorded digest")]
    SnapshotDigestMismatch,
    #[error("receipt is inconsistent with its snapshots")]
    ReceiptInconsistent,
    #[error("snapshot exceeds the size limit")]
    SnapshotTooLarge,
    #[error("rights store is corrupt")]
    Corrupt,
    #[error("receipt not found")]
    NotFound,
    #[error("rights store I/O failed")]
    Io(#[from] std::io::Error),
    #[error("rights store database operation failed")]
    Sqlite(#[from] rusqlite::Error),
    #[error("rights store serialization failed")]
    Json(#[from] serde_json::Error),
    #[cfg(test)]
    #[error("injected commit failure")]
    InjectedFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotBlob {
    pub meta: LicenseSnapshot,
    pub bytes: Vec<u8>,
}

impl SnapshotBlob {
    pub fn new(
        kind: SnapshotKind,
        url: String,
        media_type: String,
        fetched_at_ms: u64,
        bytes: Vec<u8>,
    ) -> Self {
        let digest = sha256_hex(&bytes);
        Self {
            meta: LicenseSnapshot {
                kind,
                digest,
                byte_length: bytes.len() as u64,
                url,
                media_type,
                fetched_at_ms,
            },
            bytes,
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotCheck {
    Ok,
    Missing,
    Tampered,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshRecord {
    pub at_ms: u64,
    pub status: RefreshStatus,
    pub snapshot_digest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReceiptStore {
    path: PathBuf,
    #[cfg(test)]
    fail_next_commit: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ReceiptStore {
    pub fn open(root: &Path) -> Result<Self, ReceiptStoreError> {
        if root.exists() {
            let metadata = fs::symlink_metadata(root)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(ReceiptStoreError::UnsafeDirectory);
            }
        } else {
            fs::create_dir_all(root)?;
        }
        let store = Self {
            path: root.join(DATABASE_FILENAME),
            #[cfg(test)]
            fail_next_commit: Default::default(),
        };
        let mut connection = store.connection()?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&mut connection)?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub fn fail_next_commit(&self) {
        self.fail_next_commit
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn connection(&self) -> Result<Connection, ReceiptStoreError> {
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(connection)
    }

    /// Writes every snapshot blob and the receipt row atomically.
    pub fn commit_receipt(
        &self,
        receipt: &AcquisitionReceipt,
        blobs: &[SnapshotBlob],
    ) -> Result<(), ReceiptStoreError> {
        let metas: Vec<&LicenseSnapshot> = blobs.iter().map(|b| &b.meta).collect();
        if receipt.snapshots.iter().collect::<Vec<_>>() != metas || blobs.is_empty() {
            return Err(ReceiptStoreError::ReceiptInconsistent);
        }
        for blob in blobs {
            validate_blob(blob)?;
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for blob in blobs {
            insert_blob(&transaction, blob)?;
        }
        transaction.execute(
            "INSERT INTO receipts (receipt_id, digest, byte_length, project_id, acquired_at_ms, receipt_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                receipt.receipt_id.to_string(),
                receipt.content.digest,
                receipt.content.byte_length as i64,
                receipt.project_id.to_string(),
                receipt.acquired_at_ms as i64,
                serde_json::to_string(receipt)?,
            ],
        )?;
        for blob in blobs {
            transaction.execute(
                "INSERT OR IGNORE INTO receipt_snapshots (receipt_id, snapshot_digest) VALUES (?1, ?2)",
                params![receipt.receipt_id.to_string(), blob.meta.digest],
            )?;
        }
        #[cfg(test)]
        if self
            .fail_next_commit
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(ReceiptStoreError::InjectedFailure);
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn receipt(
        &self,
        receipt_id: &uuid::Uuid,
    ) -> Result<Option<AcquisitionReceipt>, ReceiptStoreError> {
        let connection = self.connection()?;
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT digest, receipt_json FROM receipts WHERE receipt_id = ?1",
                [receipt_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(digest, json)| parse_receipt(&digest, &json))
            .transpose()
    }

    pub fn receipt_id_exists(&self, receipt_id: &uuid::Uuid) -> Result<bool, ReceiptStoreError> {
        let connection = self.connection()?;
        let found: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM receipts WHERE receipt_id = ?1",
                [receipt_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// True when any receipt covers content of exactly this size. The release gate
    /// uses it to skip hashing inputs that cannot possibly match a receipt.
    pub fn any_receipt_with_byte_length(
        &self,
        byte_length: u64,
    ) -> Result<bool, ReceiptStoreError> {
        let connection = self.connection()?;
        let found: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM receipts WHERE byte_length = ?1 LIMIT 1",
                [byte_length as i64],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Number of receipt rows for a digest, counted without parsing (fails closed on corruption).
    pub fn receipt_count_for_digest(&self, digest: &str) -> Result<u64, ReceiptStoreError> {
        let connection = self.connection()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM receipts WHERE digest = ?1",
            [digest],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// All receipts for a digest, ordered by acquisition time then id.
    /// Unreadable rows are returned as errors so the gate can fail closed.
    pub fn receipts_for_digest(
        &self,
        digest: &str,
    ) -> Result<Vec<Result<AcquisitionReceipt, uuid::Uuid>>, ReceiptStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT receipt_id, digest, receipt_json FROM receipts WHERE digest = ?1
             ORDER BY acquired_at_ms, receipt_id",
        )?;
        let rows = statement.query_map([digest], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, digest, json) = row?;
            let parsed_id = uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::nil());
            out.push(
                parse_receipt(&digest, &json)
                    .map_err(|_| parsed_id)
                    .and_then(|receipt| {
                        if receipt.receipt_id == parsed_id {
                            Ok(receipt)
                        } else {
                            Err(parsed_id)
                        }
                    }),
            );
        }
        Ok(out)
    }

    pub fn list_receipts(
        &self,
        project_id: Option<&uuid::Uuid>,
    ) -> Result<Vec<AcquisitionReceipt>, ReceiptStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT digest, receipt_json FROM receipts
             WHERE (?1 IS NULL OR project_id = ?1)
             ORDER BY acquired_at_ms, receipt_id",
        )?;
        let rows = statement.query_map([project_id.map(|id| id.to_string())], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (digest, json) = row?;
            out.push(parse_receipt(&digest, &json)?);
        }
        Ok(out)
    }

    pub fn snapshot_bytes(&self, digest: &str) -> Result<Option<Vec<u8>>, ReceiptStoreError> {
        let connection = self.connection()?;
        Ok(connection
            .query_row(
                "SELECT bytes FROM snapshot_blobs WHERE digest = ?1",
                [digest],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn check_snapshot(
        &self,
        snapshot: &LicenseSnapshot,
    ) -> Result<SnapshotCheck, ReceiptStoreError> {
        Ok(match self.snapshot_bytes(&snapshot.digest)? {
            None => SnapshotCheck::Missing,
            Some(bytes)
                if bytes.len() as u64 != snapshot.byte_length
                    || sha256_hex(&bytes) != snapshot.digest =>
            {
                SnapshotCheck::Tampered
            }
            Some(_) => SnapshotCheck::Ok,
        })
    }

    /// Records a refresh outcome. Acquisition facts in the receipt never change;
    /// only the refresh fields are updated, and the new record snapshot is kept.
    pub fn record_refresh(
        &self,
        receipt_id: &uuid::Uuid,
        at_ms: u64,
        status: RefreshStatus,
        snapshot: Option<&SnapshotBlob>,
    ) -> Result<AcquisitionReceipt, ReceiptStoreError> {
        if let Some(blob) = snapshot {
            validate_blob(blob)?;
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let (digest, json): (String, String) = transaction
            .query_row(
                "SELECT digest, receipt_json FROM receipts WHERE receipt_id = ?1",
                [receipt_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(ReceiptStoreError::NotFound)?;
        let mut receipt = parse_receipt(&digest, &json)?;
        receipt.last_refresh_at_ms = at_ms;
        // Once changed or withdrawn, a later "unchanged" answer cannot silently clear it.
        receipt.last_refresh_status = match (receipt.last_refresh_status, status) {
            (RefreshStatus::Withdrawn, _) | (_, RefreshStatus::Withdrawn) => {
                RefreshStatus::Withdrawn
            }
            (RefreshStatus::Changed, _) | (_, RefreshStatus::Changed) => RefreshStatus::Changed,
            _ => RefreshStatus::Unchanged,
        };
        if let Some(blob) = snapshot {
            insert_blob(&transaction, blob)?;
        }
        transaction.execute(
            "UPDATE receipts SET receipt_json = ?2 WHERE receipt_id = ?1",
            params![receipt_id.to_string(), serde_json::to_string(&receipt)?],
        )?;
        transaction.execute(
            "INSERT INTO refreshes (receipt_id, at_ms, status, snapshot_digest) VALUES (?1, ?2, ?3, ?4)",
            params![
                receipt_id.to_string(),
                at_ms as i64,
                status.as_str(),
                snapshot.map(|b| b.meta.digest.clone())
            ],
        )?;
        transaction.commit()?;
        Ok(receipt)
    }

    pub fn refresh_history(
        &self,
        receipt_id: &uuid::Uuid,
    ) -> Result<Vec<RefreshRecord>, ReceiptStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT at_ms, status, snapshot_digest FROM refreshes WHERE receipt_id = ?1 ORDER BY at_ms, rowid",
        )?;
        let rows = statement.query_map([receipt_id.to_string()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (at_ms, status, snapshot_digest) = row?;
            let status = match status.as_str() {
                "unchanged" => RefreshStatus::Unchanged,
                "changed" => RefreshStatus::Changed,
                "withdrawn" => RefreshStatus::Withdrawn,
                _ => return Err(ReceiptStoreError::Corrupt),
            };
            out.push(RefreshRecord {
                at_ms: at_ms.max(0) as u64,
                status,
                snapshot_digest,
            });
        }
        Ok(out)
    }

    /// Deletes snapshot blobs no receipt or refresh references. Returns the count removed.
    pub fn sweep_unreferenced_snapshots(&self) -> Result<usize, ReceiptStoreError> {
        let connection = self.connection()?;
        let removed = connection.execute(
            "DELETE FROM snapshot_blobs WHERE digest NOT IN (SELECT snapshot_digest FROM receipt_snapshots)
               AND digest NOT IN (SELECT snapshot_digest FROM refreshes WHERE snapshot_digest IS NOT NULL)",
            [],
        )?;
        Ok(removed)
    }

    pub fn snapshot_blob_count(&self) -> Result<u64, ReceiptStoreError> {
        let connection = self.connection()?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM snapshot_blobs", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    pub fn receipt_count(&self) -> Result<u64, ReceiptStoreError> {
        let connection = self.connection()?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM receipts", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    #[cfg(test)]
    pub fn raw_connection(&self) -> Connection {
        self.connection().expect("test connection")
    }
}

fn validate_blob(blob: &SnapshotBlob) -> Result<(), ReceiptStoreError> {
    if blob.bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(ReceiptStoreError::SnapshotTooLarge);
    }
    if blob.meta.byte_length != blob.bytes.len() as u64
        || sha256_hex(&blob.bytes) != blob.meta.digest
    {
        return Err(ReceiptStoreError::SnapshotDigestMismatch);
    }
    Ok(())
}

fn insert_blob(connection: &Connection, blob: &SnapshotBlob) -> Result<(), ReceiptStoreError> {
    // Content-addressed and immutable: identical digests are the same bytes.
    connection.execute(
        "INSERT OR IGNORE INTO snapshot_blobs (digest, byte_length, bytes) VALUES (?1, ?2, ?3)",
        params![blob.meta.digest, blob.bytes.len() as i64, blob.bytes],
    )?;
    Ok(())
}

fn parse_receipt(digest: &str, json: &str) -> Result<AcquisitionReceipt, ReceiptStoreError> {
    let receipt: AcquisitionReceipt =
        serde_json::from_str(json).map_err(|_| ReceiptStoreError::Corrupt)?;
    if receipt.content.digest != digest || receipt.schema_version != 1 {
        return Err(ReceiptStoreError::Corrupt);
    }
    Ok(receipt)
}

fn migrate(connection: &mut Connection) -> Result<(), ReceiptStoreError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(ReceiptStoreError::ForeignDatabase);
    }
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(ReceiptStoreError::UnsupportedSchema(version));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE snapshot_blobs (
            digest TEXT PRIMARY KEY NOT NULL CHECK (length(digest) = 64),
            byte_length INTEGER NOT NULL,
            bytes BLOB NOT NULL
         ) STRICT;
         CREATE TRIGGER snapshot_blobs_immutable BEFORE UPDATE ON snapshot_blobs
         BEGIN SELECT RAISE(ABORT, 'snapshot blobs are immutable'); END;
         CREATE TABLE receipts (
            receipt_id TEXT PRIMARY KEY NOT NULL,
            digest TEXT NOT NULL CHECK (length(digest) = 64),
            byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
            project_id TEXT NOT NULL,
            acquired_at_ms INTEGER NOT NULL,
            receipt_json TEXT NOT NULL
         ) STRICT;
         CREATE INDEX receipts_by_digest ON receipts (digest);
         CREATE INDEX receipts_by_length ON receipts (byte_length);
         CREATE TABLE receipt_snapshots (
            receipt_id TEXT NOT NULL REFERENCES receipts (receipt_id),
            snapshot_digest TEXT NOT NULL REFERENCES snapshot_blobs (digest),
            PRIMARY KEY (receipt_id, snapshot_digest)
         ) STRICT;
         CREATE TABLE refreshes (
            receipt_id TEXT NOT NULL REFERENCES receipts (receipt_id),
            at_ms INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('unchanged', 'changed', 'withdrawn')),
            snapshot_digest TEXT REFERENCES snapshot_blobs (digest)
         ) STRICT;",
    )?;
    transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
