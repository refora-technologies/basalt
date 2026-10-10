//! What a device signs to prove it is itself.
//!
//! A device never sends anything a listener could use again. It signs a
//! message made of a label naming the purpose, the TLS session's exporter, and
//! the host's id, and the host checks that against the key it has on record.
//!
//! **The exporter is what makes it worthless to anyone else.** Both ends of a
//! TLS 1.3 session can derive the same 32 bytes from its keys, and nobody else
//! can. A machine in the middle has two sessions, one with each side, with two
//! different exporters, so a signature it collects from the device is for its
//! own session and is refused at the real host. The same goes for a signature
//! seen once and tried again: the next session's exporter is different.
//!
//! Only TLS 1.3: its exporter is bound to the whole handshake. Both ends refuse
//! to sign or accept a signature on anything older.

use basalt_proto::hex;

use crate::{Result, TrustError};

/// The label both ends pass to TLS when exporting the session's material.
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-basalt-device-auth-v1";
/// Bytes of exporter material signed.
pub const EXPORTER_BYTES: usize = 32;

/// Why a device is signing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Signing in to a host it is paired with.
    Auth,
    /// Pairing with a host for the first time, with a new key.
    Pair,
    /// Giving a host it is paired with by token a key to use instead.
    Enrol,
}

impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Purpose::Auth => b"basalt/device-auth/v1",
            Purpose::Pair => b"basalt/device-pair/v1",
            Purpose::Enrol => b"basalt/device-enrol/v1",
        }
    }
}

/// The exact bytes a device signs: `label ‖ 0 ‖ exporter ‖ host id`.
///
/// `host_id` is the hex id the device pinned (or, while pairing, the id of the
/// key the host actually presented), never one taken from a message.
pub fn device_message(
    purpose: Purpose,
    exporter: &[u8; EXPORTER_BYTES],
    host_id: &str,
) -> Result<Vec<u8>> {
    let host = hex::decode(host_id)
        .ok()
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| TrustError::Malformed("a host id is 32 bytes of hex".into()))?;
    let label = purpose.label();
    let mut message = Vec::with_capacity(label.len() + 1 + EXPORTER_BYTES + 32);
    message.extend_from_slice(label);
    message.push(0);
    message.extend_from_slice(exporter);
    message.extend_from_slice(&host);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Signer, SoftwareKey};

    const HOST: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
    const OTHER: &str = "bb00000000000000000000000000000000000000000000000000000000000002";

    #[test]
    fn the_message_is_label_zero_exporter_host() {
        let exporter = [7u8; 32];
        let message = device_message(Purpose::Auth, &exporter, HOST).unwrap();
        let label = b"basalt/device-auth/v1";
        assert_eq!(&message[..label.len()], label);
        assert_eq!(message[label.len()], 0);
        assert_eq!(&message[label.len() + 1..label.len() + 33], &exporter);
        assert_eq!(
            &message[label.len() + 33..],
            &hex::decode(HOST).unwrap()[..]
        );
    }

    #[test]
    fn a_signature_for_one_purpose_session_or_host_is_good_for_no_other() {
        let key = SoftwareKey::generate().unwrap();
        let exporter = [1u8; 32];
        let signed = device_message(Purpose::Auth, &exporter, HOST).unwrap();
        let signature = key.sign(&signed).unwrap();
        assert!(key.public_key().verify(&signed, &signature));

        for purpose in [Purpose::Pair, Purpose::Enrol] {
            let other = device_message(purpose, &exporter, HOST).unwrap();
            assert!(!key.public_key().verify(&other, &signature), "{purpose:?}");
        }
        let other_session = device_message(Purpose::Auth, &[2u8; 32], HOST).unwrap();
        assert!(!key.public_key().verify(&other_session, &signature));
        let other_host = device_message(Purpose::Auth, &exporter, OTHER).unwrap();
        assert!(!key.public_key().verify(&other_host, &signature));
    }

    #[test]
    fn no_label_is_a_prefix_of_another() {
        let labels = [Purpose::Auth, Purpose::Pair, Purpose::Enrol].map(Purpose::label);
        for a in labels {
            for b in labels {
                if a != b {
                    assert!(!b.starts_with(a));
                }
            }
        }
    }

    #[test]
    fn a_host_id_must_be_thirty_two_bytes_of_hex() {
        assert!(device_message(Purpose::Auth, &[0; 32], "").is_err());
        assert!(device_message(Purpose::Auth, &[0; 32], "abcd").is_err());
        assert!(device_message(Purpose::Auth, &[0; 32], &format!("{HOST}00")).is_err());
        assert!(device_message(Purpose::Auth, &[0; 32], &HOST.replace('a', "g")).is_err());
    }
}
