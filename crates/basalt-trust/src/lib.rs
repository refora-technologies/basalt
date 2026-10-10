//! Keys, and what they sign.
//!
//! Everything here is pure: no files, no sockets, no clock of its own. That is
//! what lets every rule be tested exhaustively, and these rules are what stand
//! between a device and anyone pretending to be it.
//!
//! **One algorithm.** ECDSA over P-256 with SHA-256, for every key: the
//! security chips Basalt keeps device keys in (a computer's TPM, a phone's
//! Keystore) all do it, and the host's TLS key already is one. Signatures
//! travel as the fixed 64 bytes `r ‖ s`; public keys as their SubjectPublicKeyInfo.
//!
//! **Nothing signed means two things.** Every message a key signs begins with
//! a label naming its purpose, so a signature made for one purpose is never
//! valid for another. See [`message`] and [`statement`].

pub mod der;
pub mod key;
pub mod message;
pub mod revocation;
pub mod soft;
pub mod statement;

pub use key::{PublicKey, Signature, Signer};
pub use soft::SoftwareKey;
pub use statement::{Kind, Payload, Statement};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TrustError {
    /// A key, a signature or a statement that is not well formed.
    #[error("malformed: {0}")]
    Malformed(String),
    /// Well formed, and the signature does not check out.
    #[error("the signature does not match")]
    BadSignature,
    /// Signed properly, and not what was expected: the wrong kind, key, host,
    /// or outside its dates.
    #[error("not accepted: {0}")]
    Rejected(String),
    /// Signing failed: the key is gone, or the chip holding it said no.
    #[error("could not sign: {0}")]
    Signing(String),
}

pub type Result<T> = std::result::Result<T, TrustError>;
