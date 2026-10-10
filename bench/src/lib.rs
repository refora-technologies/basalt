//! Basalt Phase 0 measurement harness.
//!
//! Exposed as a library so the integration tests in `tests/` can drive the real
//! server and client rather than a reimplementation of them. A test that only
//! exercises a copy of the code proves nothing about what actually ships.

pub mod compress;
pub mod corpus;
// Unbuffered reads through Windows' own calls: measured on Windows only.
#[cfg(windows)]
pub mod disk;
pub mod lab;
pub mod net;
pub mod report;
pub mod setup;
pub mod smb;
pub mod stats;
pub mod verdict;
#[cfg(windows)]
pub mod winio;
