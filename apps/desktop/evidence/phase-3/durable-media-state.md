# Phase 3B durable media state evidence

## Dependency baseline

- `rusqlite` is exactly pinned to `0.40.1` with default features disabled and `bundled` enabled.
- Cargo resolves `libsqlite3-sys 0.38.1`; the bundled feature compiles and links its vendored SQLite source instead of relying on a platform SQLite installation.
- Registry metadata identifies both Rust crates as MIT licensed. The `rusqlite 0.40.1` license file retains the 2014 rusqlite developers copyright and permission notice. The `libsqlite3-sys` bundled-source documentation identifies SQLite itself as public domain.
- `libsqlite3-sys 0.38.1` uses `std::cfg_select!` in its build script, making Rust 1.94 the effective minimum. `Cargo.toml` and `README.md` now state that verified minimum rather than the prior 1.87 baseline.

## Storage boundary

- `media-state-v1.sqlite3` is rooted in the application local-data directory; it is separate from managed cache blobs and authoritative project snapshots/journals.
- Connections explicitly enable foreign keys, a two-second busy timeout, WAL journaling, `synchronous=FULL`, and a bounded WAL autocheckpoint.
- Application ID and `user_version=1` prevent accidental opening or downgrade of unrelated/future databases.
- The V1 migration owns strict job, event, cache-artifact, lease, and setting tables plus bounded checks and query indexes.
- The versioned default managed-cache budget is 20 GiB.

## Verification

On 27 July 2026, current stable Rust `1.97.1` compiled the pinned bundled SQLite graph and both targeted store tests passed:

- fresh migration plus idempotent reopen;
- fail-closed rejection of a future schema version.
