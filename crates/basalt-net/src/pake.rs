//! PIN pairing by SPAKE2: what [`crate::pairing`]'s proof becomes.
//!
//! The proof there is an HMAC keyed by the PIN, slowed by PBKDF2. Someone in
//! the middle of first contact who captures one can still search the million
//! PINs for the one that made it, offline, at leisure, and then pair a device
//! of their own. SPAKE2 leaves nothing to search: each side mixes the PIN into
//! a message, and only someone who knows the PIN ends up with the same key as
//! the other side, without either message saying anything about it. Someone
//! in the middle gets one guess per attempt, the same as anyone typing, and
//! the host already limits those.
//!
//! ```text
//! device → host   PairPake { A = SPAKE2-A(pin, device, host_id) }
//! host  → device  { B = SPAKE2-B(pin, device, host_id) }       both now have K
//! device → host   PairFinish { proof = HMAC(K, "device" ‖ nonces) }
//! host  → device  { confirm = HMAC(K, "host" ‖ nonces), token }
//! ```
//!
//! The host's id is SPAKE2's identity for the host, so the key is bound to
//! the certificate the device actually received, as the old proof's salt
//! was: a machine in the middle presenting its own certificate makes the
//! device derive a key nobody else has. And the host proves itself back,
//! which the old proof never did: a device only keeps a pairing with a host
//! that knew the PIN it was shown.

use basalt_proto::hex;
use ring::hmac;
use spake2::{Ed25519Group, Identity, Password, Spake2};

use crate::pairing::normalise_code;
use crate::{NetError, Result};

/// SPAKE2's identity for the device side: every device is the same "A", and
/// the host is told apart by its key.
const DEVICE: &[u8] = b"basalt device";

/// The shared key, once both sides have their message.
pub struct Key([u8; 32]);

impl Key {
    fn from(bytes: Vec<u8>) -> Result<Self> {
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| NetError::Crypto("a SPAKE2 key is 32 bytes".into()))?;
        Ok(Self(key))
    }

    /// What the device sends to show it has the key: the old proof's place.
    pub fn device_proof(&self, client_nonce: &str, server_nonce: &str) -> String {
        self.mac(b"basalt pake device", client_nonce, server_nonce)
    }

    /// What the host sends back to show it has it too.
    pub fn host_proof(&self, client_nonce: &str, server_nonce: &str) -> String {
        self.mac(b"basalt pake host", client_nonce, server_nonce)
    }

    fn mac(&self, side: &[u8], client_nonce: &str, server_nonce: &str) -> String {
        let key = hmac::Key::new(hmac::HMAC_SHA256, &self.0);
        let mut context = hmac::Context::with_key(&key);
        context.update(side);
        context.update(client_nonce.as_bytes());
        context.update(server_nonce.as_bytes());
        hex::encode(context.sign().as_ref())
    }
}

/// Whether a proof that arrived is the one expected, in constant time.
pub fn proof_matches(expected: &str, presented: &str) -> bool {
    hex::constant_time_eq(expected.as_bytes(), presented.as_bytes())
}

fn password(pin: &str) -> Result<Password> {
    let pin = normalise_code(pin);
    if pin.is_empty() {
        return Err(NetError::Crypto("no PIN to pair with".into()));
    }
    Ok(Password::new(pin.as_bytes()))
}

fn host_identity(host_id: &str) -> Result<Identity> {
    let id = hex::decode(host_id).map_err(|_| NetError::Crypto("host id is not hex".into()))?;
    if id.is_empty() {
        return Err(NetError::Crypto("host id is empty".into()));
    }
    Ok(Identity::new(&id))
}

/// The device's half, waiting for the host's message.
pub struct DeviceHalf(Spake2<Ed25519Group>);

impl DeviceHalf {
    /// Starts with the PIN as typed and the id of the host the device is
    /// talking to: the one its certificate proved. Returns the message to
    /// send, hex.
    pub fn start(pin: &str, host_id: &str) -> Result<(Self, String)> {
        let (state, message) = Spake2::<Ed25519Group>::start_a(
            &password(pin)?,
            &Identity::new(DEVICE),
            &host_identity(host_id)?,
        );
        Ok((Self(state), hex::encode(&message)))
    }

    /// The key, from the host's message.
    pub fn finish(self, host_message: &str) -> Result<Key> {
        let message = hex::decode(host_message)
            .map_err(|_| NetError::Crypto("the host's SPAKE2 message is not hex".into()))?;
        let key = self
            .0
            .finish(&message)
            .map_err(|e| NetError::Crypto(format!("SPAKE2: {e:?}")))?;
        Key::from(key)
    }
}

/// The host's half, all at once: it has the device's message already. Takes
/// the PIN it is showing and its own id, never one that arrived. Returns its
/// message, hex, and the key, which matches the device's only if the device
/// used the same PIN and saw this host's certificate.
pub fn host_answer(pin: &str, host_id: &str, device_message: &str) -> Result<(String, Key)> {
    let message = hex::decode(device_message)
        .map_err(|_| NetError::Crypto("the device's SPAKE2 message is not hex".into()))?;
    let (state, answer) = Spake2::<Ed25519Group>::start_b(
        &password(pin)?,
        &Identity::new(DEVICE),
        &host_identity(host_id)?,
    );
    let key = state
        .finish(&message)
        .map_err(|e| NetError::Crypto(format!("SPAKE2: {e:?}")))?;
    Ok((hex::encode(&answer), Key::from(key)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "c3228c6a5b8df628bb71bcef3912c7ee0adff2f8e4386512a928c771c06791bf";
    const OTHER: &str = "d30f25420000000000000000000000000000000000000000000000000000ffff";
    const NONCES: (&str, &str) = ("aa", "bb");

    fn pair(device_pin: &str, device_saw: &str, host_pin: &str) -> (Key, Key) {
        let (device, a) = DeviceHalf::start(device_pin, device_saw).unwrap();
        let (b, host_key) = host_answer(host_pin, HOST, &a).unwrap();
        (device.finish(&b).unwrap(), host_key)
    }

    #[test]
    fn the_same_pin_gives_both_sides_the_same_key() {
        let (device, host) = pair("482915", HOST, "482915");
        let device_proof = device.device_proof(NONCES.0, NONCES.1);
        assert!(proof_matches(
            &host.device_proof(NONCES.0, NONCES.1),
            &device_proof
        ));
        assert!(proof_matches(
            &device.host_proof(NONCES.0, NONCES.1),
            &host.host_proof(NONCES.0, NONCES.1)
        ));
        assert_ne!(
            device_proof,
            device.host_proof(NONCES.0, NONCES.1),
            "the two sides' proofs differ, so one cannot be sent back as the other"
        );
    }

    #[test]
    fn a_wrong_pin_gives_a_key_nobody_else_has() {
        let (device, host) = pair("482916", HOST, "482915");
        assert!(!proof_matches(
            &host.device_proof(NONCES.0, NONCES.1),
            &device.device_proof(NONCES.0, NONCES.1)
        ));
    }

    // A machine in the middle shows the device its own certificate: the
    // device's key is bound to that one, and the real host's is not.
    #[test]
    fn a_device_that_saw_another_certificate_gets_another_key() {
        let (device, host) = pair("482915", OTHER, "482915");
        assert!(!proof_matches(
            &host.device_proof(NONCES.0, NONCES.1),
            &device.device_proof(NONCES.0, NONCES.1)
        ));
    }

    #[test]
    fn proofs_are_bound_to_the_attempt() {
        let (device, host) = pair("482915", HOST, "482915");
        assert!(!proof_matches(
            &host.device_proof("aa", "cc"),
            &device.device_proof(NONCES.0, NONCES.1)
        ));
    }

    #[test]
    fn a_setup_code_pairs_as_typed() {
        let (device, host) = pair("k7qm-4xpr", HOST, "K7QM4XPR");
        assert!(proof_matches(
            &host.device_proof(NONCES.0, NONCES.1),
            &device.device_proof(NONCES.0, NONCES.1)
        ));
    }

    #[test]
    fn nonsense_from_the_other_side_is_an_error_not_a_key() {
        let (device, _) = DeviceHalf::start("482915", HOST).unwrap();
        assert!(device.finish("zz").is_err());
        assert!(host_answer("482915", HOST, "00").is_err());
    }
}
