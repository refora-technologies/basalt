//! A key held in memory.
//!
//! What the host's own keys are, sealed on disk between runs, and what a device
//! falls back to when it has no chip to keep a key in. The private key is
//! PKCS#8, the form ring reads and writes; the caller decides where it is kept
//! and how it is sealed.

use crate::key::{PublicKey, Signature, Signer};
use crate::{Result, TrustError};

pub struct SoftwareKey {
    pair: ring::signature::EcdsaKeyPair,
    public: PublicKey,
    pkcs8: Vec<u8>,
}

impl std::fmt::Debug for SoftwareKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the private key, in any log.
        write!(f, "SoftwareKey({:?})", self.public)
    }
}

impl SoftwareKey {
    pub fn generate() -> Result<Self> {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &rng,
        )
        .map_err(|_| TrustError::Signing("could not make a key".into()))?;
        Self::from_pkcs8(pkcs8.as_ref())
    }

    /// Reads a key written by [`SoftwareKey::pkcs8`], or any P-256 PKCS#8 key,
    /// such as the host's TLS key.
    pub fn from_pkcs8(pkcs8: &[u8]) -> Result<Self> {
        let rng = ring::rand::SystemRandom::new();
        let pair = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8,
            &rng,
        )
        .map_err(|e| TrustError::Malformed(format!("not a P-256 private key: {e}")))?;
        let public = PublicKey::from_point(ring::signature::KeyPair::public_key(&pair).as_ref())?;
        Ok(Self {
            pair,
            public,
            pkcs8: pkcs8.to_vec(),
        })
    }

    /// The private key, for sealing and keeping. Handle as a secret.
    pub fn pkcs8(&self) -> &[u8] {
        &self.pkcs8
    }
}

impl Signer for SoftwareKey {
    fn public_key(&self) -> &PublicKey {
        &self.public
    }

    fn sign(&self, message: &[u8]) -> Result<Signature> {
        let rng = ring::rand::SystemRandom::new();
        let signature = self
            .pair
            .sign(&rng, message)
            .map_err(|_| TrustError::Signing("the key would not sign".into()))?;
        Signature::from_bytes(signature.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_survives_being_written_and_read_back() {
        let key = SoftwareKey::generate().unwrap();
        let back = SoftwareKey::from_pkcs8(key.pkcs8()).unwrap();
        assert_eq!(back.public_key(), key.public_key());
        let signature = back.sign(b"m").unwrap();
        assert!(key.public_key().verify(b"m", &signature));
    }

    #[test]
    fn two_keys_are_never_the_same() {
        let a = SoftwareKey::generate().unwrap();
        let b = SoftwareKey::generate().unwrap();
        assert_ne!(a.public_key(), b.public_key());
    }

    #[test]
    fn garbage_is_not_a_key() {
        assert!(SoftwareKey::from_pkcs8(b"no").is_err());
        assert!(SoftwareKey::from_pkcs8(&[]).is_err());
    }

    #[test]
    fn debug_output_never_shows_the_private_key() {
        let key = SoftwareKey::generate().unwrap();
        let shown = format!("{key:?}");
        let secret = basalt_proto::hex::encode(key.pkcs8());
        assert!(!shown.contains(&secret[secret.len() - 20..]));
        assert!(shown.starts_with("SoftwareKey(PublicKey("));
    }
}
