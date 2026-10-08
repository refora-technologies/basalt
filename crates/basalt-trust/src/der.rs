//! ECDSA signatures in DER, turned into the fixed `r ‖ s`.
//!
//! A phone's Keystore signs in DER, `SEQUENCE { INTEGER r, INTEGER s }`; Basalt
//! sends signatures as 64 fixed bytes. The conversion accepts only what a
//! correct signer produces: minimal integers, positive, at most 32 bytes of
//! value, and nothing before or after. A parser that tolerated more would be a
//! second way of writing the same signature, and there is no reason to have one.

use crate::key::{SIGNATURE_BYTES, Signature};
use crate::{Result, TrustError};

const SEQUENCE: u8 = 0x30;
const INTEGER: u8 = 0x02;
const SCALAR_BYTES: usize = 32;

/// Converts a DER ECDSA signature over P-256 to the fixed form.
pub fn signature_from_der(der: &[u8]) -> Result<Signature> {
    let bad = |why: &str| TrustError::Malformed(format!("a DER signature {why}"));

    let (&tag, rest) = der.split_first().ok_or_else(|| bad("is empty"))?;
    if tag != SEQUENCE {
        return Err(bad("does not start with a sequence"));
    }
    let (&length, body) = rest.split_first().ok_or_else(|| bad("is truncated"))?;
    // Two integers of at most 33 bytes each with their headers is 70 bytes:
    // always the short length form, so the long form is not accepted at all.
    if length & 0x80 != 0 {
        return Err(bad("uses a long length"));
    }
    if body.len() != length as usize {
        return Err(bad("has the wrong length"));
    }

    let (r, body) = integer(body)?;
    let (s, body) = integer(body)?;
    if !body.is_empty() {
        return Err(bad("has bytes after its integers"));
    }

    let mut fixed = [0u8; SIGNATURE_BYTES];
    fixed[SCALAR_BYTES - r.len()..SCALAR_BYTES].copy_from_slice(r);
    fixed[SIGNATURE_BYTES - s.len()..].copy_from_slice(s);
    Ok(Signature(fixed))
}

/// One positive, minimally encoded INTEGER of at most 32 value bytes. Returns
/// its value without any leading zero, and what follows it.
fn integer(input: &[u8]) -> Result<(&[u8], &[u8])> {
    let bad = |why: &str| TrustError::Malformed(format!("a DER integer {why}"));

    let (&tag, rest) = input.split_first().ok_or_else(|| bad("is missing"))?;
    if tag != INTEGER {
        return Err(bad("has the wrong tag"));
    }
    let (&length, rest) = rest.split_first().ok_or_else(|| bad("is truncated"))?;
    let length = length as usize;
    if length == 0 || length > SCALAR_BYTES + 1 || length & 0x80 != 0 {
        return Err(bad("has an impossible length"));
    }
    if rest.len() < length {
        return Err(bad("is truncated"));
    }
    let (value, rest) = rest.split_at(length);

    if value[0] & 0x80 != 0 {
        return Err(bad("is negative"));
    }
    let value = if value[0] == 0 {
        // A leading zero is only there to keep a high bit from reading as a
        // sign, and is wrong anywhere else.
        if value.len() == 1 || value[1] & 0x80 == 0 {
            return Err(bad("is not minimal"));
        }
        &value[1..]
    } else {
        value
    };
    if value.len() > SCALAR_BYTES {
        return Err(bad("is longer than 32 bytes"));
    }
    Ok((value, rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Signer, SoftwareKey};

    fn der(r: &[u8], s: &[u8]) -> Vec<u8> {
        let mut body = vec![INTEGER, r.len() as u8];
        body.extend_from_slice(r);
        body.extend_from_slice(&[INTEGER, s.len() as u8]);
        body.extend_from_slice(s);
        let mut out = vec![SEQUENCE, body.len() as u8];
        out.extend(body);
        out
    }

    /// The minimal DER form of a 32-byte scalar.
    fn minimal(scalar: &[u8]) -> Vec<u8> {
        let mut v: Vec<u8> = scalar.iter().copied().skip_while(|b| *b == 0).collect();
        if v.is_empty() {
            v.push(0);
        }
        if v[0] & 0x80 != 0 {
            v.insert(0, 0);
        }
        v
    }

    #[test]
    fn a_real_signature_survives_the_round_trip() {
        let key = SoftwareKey::generate().unwrap();
        for i in 0..50u8 {
            let message = [i; 9];
            let signature = key.sign(&message).unwrap();
            let encoded = der(&minimal(&signature.0[..32]), &minimal(&signature.0[32..]));
            let back = signature_from_der(&encoded).unwrap();
            assert_eq!(back, signature);
            assert!(key.public_key().verify(&message, &back));
        }
    }

    // Against an encoder that is not this file's: ring writing DER, as a
    // phone's Keystore does, with the same key. Many signatures, so the ones
    // with a high bit or a short value turn up.
    #[test]
    fn signatures_ring_writes_in_der_convert_and_verify() {
        let key = SoftwareKey::generate().unwrap();
        let rng = ring::rand::SystemRandom::new();
        let der_signer = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            key.pkcs8(),
            &rng,
        )
        .unwrap();
        let mut lengths = std::collections::HashSet::new();
        for i in 0..400u32 {
            let message = i.to_le_bytes();
            let der = der_signer.sign(&rng, &message).unwrap();
            lengths.insert(der.as_ref().len());
            let fixed = signature_from_der(der.as_ref()).unwrap();
            assert!(key.public_key().verify(&message, &fixed), "signature {i}");
        }
        // 70, 71 and 72 bytes all seen: values with and without leading zeros.
        assert!(lengths.len() >= 3, "{lengths:?}");
    }

    #[test]
    fn high_bits_take_a_leading_zero_and_short_values_are_padded() {
        let mut r = [0u8; 32];
        r[0] = 0x80;
        let s = [0x01];
        let fixed = signature_from_der(&der(&minimal(&r), &s)).unwrap();
        assert_eq!(&fixed.0[..32], &r);
        assert_eq!(fixed.0[63], 1);
        assert!(fixed.0[32..63].iter().all(|b| *b == 0));
    }

    #[test]
    fn anything_but_the_one_correct_form_is_refused() {
        let ok_r = vec![0x11; 32];
        let ok_s = vec![0x22; 32];
        let good = der(&ok_r, &ok_s);
        assert!(signature_from_der(&good).is_ok());

        // Empty, wrong outer tag, truncated, trailing bytes.
        assert!(signature_from_der(&[]).is_err());
        let mut wrong_tag = good.clone();
        wrong_tag[0] = 0x31;
        assert!(signature_from_der(&wrong_tag).is_err());
        assert!(signature_from_der(&good[..good.len() - 1]).is_err());
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(signature_from_der(&trailing).is_err());

        // A long-form length, even one that is right.
        let mut long_form = vec![SEQUENCE, 0x81, good[1]];
        long_form.extend_from_slice(&good[2..]);
        assert!(signature_from_der(&long_form).is_err());

        // A negative integer, a needless leading zero, a lone zero.
        assert!(signature_from_der(&der(&[0x80; 32], &ok_s)).is_err());
        let mut padded = vec![0x00];
        padded.extend_from_slice(&[0x11; 31]);
        assert!(signature_from_der(&der(&padded, &ok_s)).is_err());
        assert!(signature_from_der(&der(&[0x00], &ok_s)).is_err());

        // Thirty-three bytes of value, and an empty integer.
        let mut big = vec![0x00, 0x80];
        big.extend_from_slice(&[0x11; 32]);
        assert!(signature_from_der(&der(&big, &ok_s)).is_err());
        assert!(signature_from_der(&der(&[], &ok_s)).is_err());

        // A third integer, and the second missing.
        let mut three = der(&ok_r, &ok_s);
        three.extend_from_slice(&[INTEGER, 1, 5]);
        three[1] += 3;
        assert!(signature_from_der(&three).is_err());
        let mut one = vec![SEQUENCE, 34, INTEGER, 32];
        one.extend_from_slice(&ok_r);
        assert!(signature_from_der(&one).is_err());

        // The wrong inner tag.
        let mut wrong_inner = good.clone();
        wrong_inner[2] = 0x04;
        assert!(signature_from_der(&wrong_inner).is_err());
    }

    #[test]
    fn every_truncation_of_a_real_signature_is_refused_without_panicking() {
        let key = SoftwareKey::generate().unwrap();
        let signature = key.sign(b"x").unwrap();
        let encoded = der(&minimal(&signature.0[..32]), &minimal(&signature.0[32..]));
        for cut in 0..encoded.len() {
            assert!(signature_from_der(&encoded[..cut]).is_err(), "cut at {cut}");
        }
        // And every single-byte change either fails or yields something else.
        for i in 0..encoded.len() {
            for bit in 0..8 {
                let mut bent = encoded.clone();
                bent[i] ^= 1 << bit;
                if let Ok(other) = signature_from_der(&bent) {
                    assert!(!key.public_key().verify(b"x", &other) || other == signature);
                }
            }
        }
    }
}
