//! App-level rights state: the receipt store, provider endpoints, keyring and
//! per-window cancellation tokens. Shared by the IPC commands, the import
//! origin check and the render release gate.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{
    acquire::{startup_sweep, QUARANTINE_MAX_AGE},
    net::{CancelToken, KeyringProviderKeys, NetPolicy, ProviderKeyStore},
    providers::ProviderEndpoints,
    store::{ReceiptStore, ReceiptStoreError},
    types::ProviderId,
};
use crate::video::{
    error::VideoCommandError, media_store::MediaContentIdentityV1, types::AssetOrigin,
};

/// Default freshness window for rights evidence used by the release gate.
pub const DEFAULT_FRESHNESS: Duration = Duration::from_secs(30 * 24 * 60 * 60);

type PolicyFactory = Arc<dyn Fn(ProviderId) -> NetPolicy + Send + Sync>;

pub struct RightsService {
    store: ReceiptStore,
    app_cache_root: PathBuf,
    endpoints: ProviderEndpoints,
    keys: Arc<dyn ProviderKeyStore>,
    net_policy: PolicyFactory,
    freshness: Duration,
    cancels: Mutex<BTreeMap<String, CancelToken>>,
}

impl std::fmt::Debug for RightsService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RightsService").finish_non_exhaustive()
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RightsService {
    /// Opens the receipt store under `local_data_dir/rights` and runs the startup sweep.
    pub fn initialize(
        local_data_dir: &Path,
        app_cache_root: &Path,
    ) -> Result<Self, ReceiptStoreError> {
        let store = ReceiptStore::open(&local_data_dir.join("rights"))?;
        let service = Self::with_parts(
            store,
            app_cache_root.to_owned(),
            ProviderEndpoints::production(),
            Arc::new(KeyringProviderKeys::new()),
            Arc::new(NetPolicy::for_provider),
        );
        let started = std::time::Instant::now();
        let swept = startup_sweep(
            app_cache_root,
            &service.store,
            SystemTime::now(),
            QUARANTINE_MAX_AGE,
        );
        match swept {
            Ok((quarantine, blobs)) => eprintln!(
                "rights.startup_sweep outcome=ok quarantine_removed={quarantine} snapshots_removed={blobs} elapsed_ms={}",
                started.elapsed().as_millis()
            ),
            Err(error) => eprintln!(
                "rights.startup_sweep outcome=error code={} elapsed_ms={}",
                error.code(),
                started.elapsed().as_millis()
            ),
        }
        Ok(service)
    }

    pub fn with_parts(
        store: ReceiptStore,
        app_cache_root: PathBuf,
        endpoints: ProviderEndpoints,
        keys: Arc<dyn ProviderKeyStore>,
        net_policy: PolicyFactory,
    ) -> Self {
        Self {
            store,
            app_cache_root,
            endpoints,
            keys,
            net_policy,
            freshness: freshness_from_env(),
            cancels: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn store(&self) -> &ReceiptStore {
        &self.store
    }

    pub fn app_cache_root(&self) -> &Path {
        &self.app_cache_root
    }

    pub fn endpoints(&self) -> &ProviderEndpoints {
        &self.endpoints
    }

    pub fn keys(&self) -> &dyn ProviderKeyStore {
        self.keys.as_ref()
    }

    pub fn net_policy(&self, provider_id: ProviderId) -> NetPolicy {
        (self.net_policy)(provider_id)
    }

    pub fn freshness(&self) -> Duration {
        self.freshness
    }

    /// Gate inputs for the render authority, with the clock read now.
    pub fn render_rights(&self) -> crate::rights::gate::RenderRights<'_> {
        crate::rights::gate::RenderRights {
            lookup: &self.store,
            now_ms: now_ms(),
            freshness: self.freshness,
        }
    }

    #[cfg(test)]
    pub fn set_freshness(&mut self, freshness: Duration) {
        self.freshness = freshness;
    }

    /// Registers the single in-flight acquisition token for a window.
    pub fn begin(&self, owner: &str) -> Result<CancelToken, ()> {
        let mut cancels = self.cancels.lock().map_err(|_| ())?;
        if cancels.contains_key(owner) {
            return Err(());
        }
        let token = CancelToken::new();
        cancels.insert(owner.to_owned(), token.clone());
        Ok(token)
    }

    pub fn finish(&self, owner: &str) {
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(owner);
        }
    }

    pub fn cancel(&self, owner: &str) -> bool {
        self.cancels
            .lock()
            .ok()
            .and_then(|cancels| cancels.get(owner).cloned())
            .map(|token| token.cancel())
            .is_some()
    }
}

fn freshness_from_env() -> Duration {
    std::env::var("SUPA_VIDEO_RIGHTS_FRESHNESS_DAYS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|days| (1..=365).contains(days))
        .map(|days| Duration::from_secs(days * 24 * 60 * 60))
        .unwrap_or(DEFAULT_FRESHNESS)
}

/// Import-time check: an asset claiming an acquisition receipt must match it.
/// (The render gate re-checks by digest regardless of this field.)
pub fn validate_asset_origin(
    store: Option<&ReceiptStore>,
    origin: Option<&AssetOrigin>,
    identity: &MediaContentIdentityV1,
) -> Result<(), VideoCommandError> {
    let Some(AssetOrigin::Acquired {
        acquisition_receipt_id,
    }) = origin
    else {
        return Ok(());
    };
    let reject = |category| VideoCommandError::invalid_media("import_project_asset", category);
    let store = store.ok_or_else(|| reject("rights_unavailable"))?;
    let receipt = store
        .receipt(acquisition_receipt_id)
        .map_err(|_| reject("rights_receipt_unreadable"))?
        .ok_or_else(|| reject("rights_receipt_missing"))?;
    if receipt.content.digest != identity.digest
        || receipt.content.byte_length != identity.byte_length
    {
        return Err(reject("rights_receipt_mismatch"));
    }
    Ok(())
}

impl super::acquire::AcquireError {
    pub fn is_cancelled(&self) -> bool {
        matches!(self, super::acquire::AcquireError::Cancelled)
    }
}

impl super::store::ReceiptStoreError {
    pub fn code(&self) -> &'static str {
        match self {
            ReceiptStoreError::Sqlite(_) => "sqlite",
            ReceiptStoreError::Io(_) => "io",
            ReceiptStoreError::Json(_) => "json",
            _ => "store",
        }
    }
}
