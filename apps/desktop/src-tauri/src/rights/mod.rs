//! Stock and public media acquisition with rights checked first.
//!
//! Rust is the only rights authority. It fetches provider records itself,
//! normalizes licenses, applies policy, snapshots evidence, writes receipts and
//! enforces the release gate during render validation.

pub(crate) mod acquire;
pub(crate) mod attribution;
pub(crate) mod gate;
pub(crate) mod ipc;
pub(crate) mod license;
pub(crate) mod net;
pub(crate) mod policy;
pub(crate) mod providers;
pub(crate) mod refresh;
pub(crate) mod service;
pub(crate) mod store;
pub(crate) mod types;

#[cfg(test)]
mod live_search;
#[cfg(test)]
mod matrix_tests;
#[cfg(test)]
pub(crate) mod test_server;
