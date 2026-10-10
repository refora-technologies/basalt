//! P-256 public keys and signatures.
//!
//! A public key arrives from the network, from a chip, or from a file, and is
//! accepted only in one exact shape: the 91-byte SubjectPublicKeyInfo of an
//! uncompressed P-256 point. Anything else, however close, is refused rather
//! than repaired, so there is exactly one way to write each key and its id
//! cannot be argued about.

use basalt_proto::hex;

use crate::{Result, TrustError};

/// The DER that precedes the point in every P-256 SubjectPublicKeyInfo:
/// `SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (0 unused) }`.
const SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// An uncompressed point: `0x04 ‖ x ‖ y`.
pub const POINT_BYTES: usize = 65;
pub const SPKI_BYTES: usize = SPKI_PREFIX.len() + POINT_BYTES;
pub const SIGNATURE_BYTES: usize = 64;

/// A P-256 public key.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PublicKey {
    spki: Vec<u8>,
}

impl std::fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PublicKey({}…)", &self.id()[..12])
    }
}

impl PublicKey {
    /// Accepts the exact SubjectPublicKeyInfo of an uncompressed P-256 point.
    ///
    /// Whether the point is on the curve is checked here too, by ring, so a
    /// key that could never verify anything is refused when it arrives rather
    /// than when it is first used.
    pub fn from_spki(spki: &[u8]) -> Result<Self> {
        if spki.len() != SPKI_BYTES {
            return Err(TrustError::Malformed(format!(
                "a P-256 public key is {SPKI_BYTES} bytes, not {}",
                spki.len()
            )));
        }
        if spki[..SPKI_PREFIX.len()] != SPKI_PREFIX {
            return Err(TrustError::Malformed("not a P-256 public key".into()));
        }
        Self::from_point(&spki[SPKI_PREFIX.len()..])
    }

    /// From the point alone, as a TPM reports it.
    pub fn from_point(point: &[u8]) -> Result<Self> {
        if point.len() != POINT_BYTES || point[0] != 0x04 {
            return Err(TrustError::Malformed(
                "a public key must be an uncompressed P-256 point".into(),
            ));
        }
        if !on_curve(point) {
            return Err(TrustError::Malformed(
                "that point is not on the P-256 curve".into(),
            ));
        }
        let mut spki = Vec::with_capacity(SPKI_BYTES);
        spki.extend_from_slice(&SPKI_PREFIX);
        spki.extend_from_slice(point);
        Ok(Self { spki })
    }

    pub fn from_hex(text: &str) -> Result<Self> {
        let bytes =
            hex::decode(text).map_err(|_| TrustError::Malformed("a key is not hex".into()))?;
        Self::from_spki(&bytes)
    }

    pub fn spki(&self) -> &[u8] {
        &self.spki
    }

    /// Lower-case hex of the SubjectPublicKeyInfo: how a key is written down.
    pub fn to_hex(&self) -> String {
        hex::encode(&self.spki)
    }

    /// `0x04 ‖ x ‖ y`.
    pub fn point(&self) -> &[u8] {
        &self.spki[SPKI_PREFIX.len()..]
    }

    /// Hex SHA-256 of the SubjectPublicKeyInfo: the same rule as a host id,
    /// so a device's key and a host's are named the same way.
    pub fn id(&self) -> String {
        hex::encode(ring::digest::digest(&ring::digest::SHA256, &self.spki).as_ref())
    }

    /// Whether `signature` is this key's signature of `message`.
    pub fn verify(&self, message: &[u8], signature: &Signature) -> bool {
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            self.point(),
        )
        .verify(message, &signature.0)
        .is_ok()
    }
}

/// Whether the point satisfies the curve equation, y² = x³ − 3x + b (mod p),
/// with both coordinates below p.
///
/// ring checks this too, but only inside a verification, where a bad point
/// and a bad signature are the same failure. Checked here directly, a key is
/// refused for what it is when it arrives.
fn on_curve(point: &[u8]) -> bool {
    let x = U256::from_be(&point[1..33]);
    let y = U256::from_be(&point[33..65]);
    if !x.lt(&P) || !y.lt(&P) {
        return false;
    }
    let y2 = mul_mod(&y, &y);
    let x3 = mul_mod(&mul_mod(&x, &x), &x);
    let three_x = add_mod(&add_mod(&x, &x), &x);
    let rhs = add_mod(&sub_mod(&x3, &three_x), &B);
    y2 == rhs
}

// ---------------------------------------------------------------------------
// Just enough 256-bit arithmetic to check a point is on the curve. Speed does
// not matter (it runs once per key received) and neither does constant time
// (public keys are public); being obviously right does.
// ---------------------------------------------------------------------------

/// Little-endian 64-bit limbs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct U256([u64; 4]);

const P: U256 = U256([
    0xffff_ffff_ffff_ffff,
    0x0000_0000_ffff_ffff,
    0x0000_0000_0000_0000,
    0xffff_ffff_0000_0001,
]);
const B: U256 = U256([
    0x3bce_3c3e_27d2_604b,
    0x651d_06b0_cc53_b0f6,
    0xb3eb_bd55_7698_86bc,
    0x5ac6_35d8_aa3a_93e7,
]);

impl U256 {
    fn from_be(bytes: &[u8]) -> Self {
        let mut limbs = [0u64; 4];
        for (i, limb) in limbs.iter_mut().enumerate() {
            let start = 32 - (i + 1) * 8;
            *limb = u64::from_be_bytes(bytes[start..start + 8].try_into().expect("8 bytes"));
        }
        U256(limbs)
    }

    fn lt(&self, other: &U256) -> bool {
        for i in (0..4).rev() {
            if self.0[i] != other.0[i] {
                return self.0[i] < other.0[i];
            }
        }
        false
    }

    /// `self + other`, with the carry out.
    fn add(&self, other: &U256) -> (U256, bool) {
        let mut out = [0u64; 4];
        let mut carry = false;
        for (i, slot) in out.iter_mut().enumerate() {
            let (a, c1) = self.0[i].overflowing_add(other.0[i]);
            let (b, c2) = a.overflowing_add(carry as u64);
            *slot = b;
            carry = c1 || c2;
        }
        (U256(out), carry)
    }

    /// `self - other`, with the borrow out.
    fn sub(&self, other: &U256) -> (U256, bool) {
        let mut out = [0u64; 4];
        let mut borrow = false;
        for (i, slot) in out.iter_mut().enumerate() {
            let (a, b1) = self.0[i].overflowing_sub(other.0[i]);
            let (b, b2) = a.overflowing_sub(borrow as u64);
            *slot = b;
            borrow = b1 || b2;
        }
        (U256(out), borrow)
    }
}

/// `(a + b) mod p`, for `a, b < p`.
fn add_mod(a: &U256, b: &U256) -> U256 {
    let (sum, carry) = a.add(b);
    if carry || !sum.lt(&P) {
        sum.sub(&P).0
    } else {
        sum
    }
}

/// `(a - b) mod p`, for `a, b < p`.
fn sub_mod(a: &U256, b: &U256) -> U256 {
    let (diff, borrow) = a.sub(b);
    if borrow { diff.add(&P).0 } else { diff }
}

/// `(a * b) mod p`, by double-and-add: 256 steps, each staying below p.
fn mul_mod(a: &U256, b: &U256) -> U256 {
    let mut result = U256([0; 4]);
    for i in (0..256).rev() {
        result = add_mod(&result, &result);
        if (b.0[i / 64] >> (i % 64)) & 1 == 1 {
            result = add_mod(&result, a);
        }
    }
    result
}

/// A P-256 signature as the fixed `r ‖ s`.
#[derive(Clone, PartialEq, Eq)]
pub struct Signature(pub [u8; SIGNATURE_BYTES]);

impl std::fmt::Debug for Signature {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Signature({}…)", hex::encode(&self.0[..6]))
    }
}

impl Signature {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let fixed: [u8; SIGNATURE_BYTES] = bytes.try_into().map_err(|_| {
            TrustError::Malformed(format!(
                "a signature is {SIGNATURE_BYTES} bytes, not {}",
                bytes.len()
            ))
        })?;
        Ok(Self(fixed))
    }

    pub fn from_hex(text: &str) -> Result<Self> {
        let bytes = hex::decode(text)
            .map_err(|_| TrustError::Malformed("a signature is not hex".into()))?;
        Self::from_bytes(&bytes)
    }

    pub fn to_hex(&self) -> String {
        hex::encode(&self.0)
    }
}

/// Something holding a private key: a chip, or a key in memory.
///
/// Signing may block: a TPM takes tens of milliseconds and serialises its
/// callers. Call it off the async runtime's threads.
pub trait Signer: Send + Sync {
    fn public_key(&self) -> &PublicKey;
    fn sign(&self, message: &[u8]) -> Result<Signature>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::soft::SoftwareKey;

    /// The P-256 generator: a point certainly on the curve.
    const G: &str = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";

    fn spki_hex(point: &str) -> String {
        format!("{}{point}", hex::encode(&SPKI_PREFIX))
    }

    #[test]
    fn the_generator_is_on_the_curve() {
        let key = PublicKey::from_hex(&spki_hex(G)).unwrap();
        assert_eq!(key.point(), &hex::decode(G).unwrap()[..]);
        assert_eq!(key.spki().len(), SPKI_BYTES);
    }

    #[test]
    fn generated_keys_round_trip_through_hex_and_point() {
        for _ in 0..20 {
            let soft = SoftwareKey::generate().unwrap();
            let key = soft.public_key();
            assert_eq!(PublicKey::from_hex(&key.to_hex()).unwrap(), *key);
            assert_eq!(PublicKey::from_point(key.point()).unwrap(), *key);
            assert_eq!(key.id().len(), 64);
        }
    }

    #[test]
    fn a_point_off_the_curve_is_refused() {
        let mut point = hex::decode(G).unwrap();
        point[64] ^= 1;
        assert!(matches!(
            PublicKey::from_point(&point),
            Err(TrustError::Malformed(_))
        ));
    }

    #[test]
    fn coordinates_at_or_above_the_prime_are_refused() {
        let mut point = vec![0x04];
        point.extend_from_slice(&[0xff; 32]);
        point.extend_from_slice(&hex::decode(&G[66..]).unwrap());
        assert!(PublicKey::from_point(&point).is_err());
    }

    #[test]
    fn the_point_at_infinity_and_zero_are_refused() {
        assert!(PublicKey::from_point(&[0u8; 65]).is_err());
        let mut zero = vec![0x04];
        zero.extend_from_slice(&[0u8; 64]);
        assert!(PublicKey::from_point(&zero).is_err());
    }

    #[test]
    fn compressed_points_are_refused() {
        let mut compressed = vec![0x03];
        compressed.extend_from_slice(&hex::decode(&G[2..66]).unwrap());
        assert!(PublicKey::from_point(&compressed).is_err());
    }

    #[test]
    fn other_curves_and_shapes_are_refused() {
        // P-384's OID in place of P-256's.
        let mut spki = hex::decode(&spki_hex(G)).unwrap();
        spki[22] = 0x22;
        assert!(PublicKey::from_spki(&spki).is_err());
        // One byte short, one byte long.
        let spki = hex::decode(&spki_hex(G)).unwrap();
        assert!(PublicKey::from_spki(&spki[..90]).is_err());
        let mut long = spki.clone();
        long.push(0);
        assert!(PublicKey::from_spki(&long).is_err());
        assert!(PublicKey::from_spki(&[]).is_err());
        assert!(PublicKey::from_hex("not hex").is_err());
        assert!(PublicKey::from_hex("abc").is_err());
    }

    #[test]
    fn upper_case_hex_names_the_same_key() {
        let soft = SoftwareKey::generate().unwrap();
        let upper = soft.public_key().to_hex().to_uppercase();
        let key = PublicKey::from_hex(&upper).unwrap();
        assert_eq!(key, *soft.public_key());
        assert_eq!(key.to_hex(), soft.public_key().to_hex());
    }

    #[test]
    fn signatures_verify_only_for_their_message_and_key() {
        let a = SoftwareKey::generate().unwrap();
        let b = SoftwareKey::generate().unwrap();
        let signature = a.sign(b"hello").unwrap();
        assert!(a.public_key().verify(b"hello", &signature));
        assert!(!a.public_key().verify(b"hellp", &signature));
        assert!(!b.public_key().verify(b"hello", &signature));

        let mut bent = signature.clone();
        bent.0[10] ^= 0x40;
        assert!(!a.public_key().verify(b"hello", &bent));
        assert!(!a.public_key().verify(b"hello", &Signature([0; 64])));
    }

    #[test]
    fn signatures_are_exactly_sixty_four_bytes() {
        assert!(Signature::from_bytes(&[1; 63]).is_err());
        assert!(Signature::from_bytes(&[1; 65]).is_err());
        assert!(Signature::from_hex("zz").is_err());
        let s = Signature::from_bytes(&[7; 64]).unwrap();
        assert_eq!(Signature::from_hex(&s.to_hex()).unwrap(), s);
    }

    // The field arithmetic against values worked out independently: on the
    // curve for every generated key, and the sum and product of the prime's
    // edges.
    #[test]
    fn the_field_arithmetic_wraps_at_the_prime() {
        let one = U256([1, 0, 0, 0]);
        let p_minus_one = P.sub(&one).0;
        assert_eq!(add_mod(&p_minus_one, &one), U256([0; 4]));
        assert_eq!(sub_mod(&U256([0; 4]), &one), p_minus_one);
        // (p - 1)² = 1 (mod p).
        assert_eq!(mul_mod(&p_minus_one, &p_minus_one), one);
        let two = U256([2, 0, 0, 0]);
        assert_eq!(mul_mod(&two, &two), U256([4, 0, 0, 0]));
    }
}
