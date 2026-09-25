mod clip_speed;
pub mod clip_timing;
pub mod commands;
pub mod hash;
pub mod history;
pub mod integrity;
pub mod ipc;
pub mod journal;
pub mod migration;
pub mod recovery;
pub mod service;
pub mod snapshot;
pub mod types;

#[cfg(test)]
mod audio_edit_tests;
#[cfg(test)]
mod clip_speed_compatibility_tests;
#[cfg(test)]
mod editor_controls_persistence_tests;
#[cfg(test)]
mod speed_contract_tests;
#[cfg(test)]
mod speed_edit_tests;
#[cfg(test)]
mod speed_persistence_tests;
#[cfg(test)]
mod speed_timing_tests;
#[cfg(test)]
mod tests;
