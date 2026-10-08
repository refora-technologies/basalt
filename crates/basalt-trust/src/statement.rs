//! Statements: one key saying something about another, signed.
//!
//! Two are made today, and later features stand on both:
//!
//! - **member**: a person's key says "this device acts for me, at this host".
//!   A profile's key for devices signed in to it; the household's key for
//!   devices using the drive as themselves.
//! - **endorse**: an owner's device says "this is my host's key". Renewed in
//!   the background whenever an owner's device connects, so a host key that
//!   was copied stops being vouched for within days.
//!
//! Nothing at home depends on either yet: the host knows its devices from its
//! own list. They are made, renewed and checked now so that they are proven
//! by the time anything else relies on them.
//!
//! **The form.** `{ payload, signature }`, both hex. The signature covers a
//! label and the payload's exact bytes, which are JSON. The bytes are what is
//! signed, so there is no question of two programs writing the same JSON
//! differently; the JSON is only read to find the issuer and is believed only
//! once the issuer's signature checks out.

use basalt_proto::hex;
use serde::{Deserialize, Serialize};

use crate::key::{PublicKey, Signature, Signer};
use crate::{Result, TrustError};

const LABEL: &[u8] = b"basalt/statement/v1";
pub const VERSION: u32 = 1;

const DAY: i64 = 24 * 60 * 60;
/// How long a member statement lasts, and how close to its end it is renewed.
pub const MEMBER_LIFETIME: i64 = 30 * DAY;
pub const MEMBER_RENEW_WITHIN: i64 = 15 * DAY;
/// How long an endorsement lasts, and how old it gets before it is renewed.
pub const ENDORSE_LIFETIME: i64 = 30 * DAY;
pub const ENDORSE_RENEW_AFTER: i64 = 7 * DAY;
/// How far apart two clocks may be and still agree on a date.
pub const CLOCK_SKEW: i64 = 10 * 60;
/// Far more than any statement needs, and a bound on what is parsed.
const MAX_PAYLOAD_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Member,
    Endorse,
}

impl Kind {
    pub fn lifetime(self) -> i64 {
        match self {
            Kind::Member => MEMBER_LIFETIME,
            Kind::Endorse => ENDORSE_LIFETIME,
        }
    }
}

/// What a statement says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub v: u32,
    pub kind: Kind,
    /// Sixteen random bytes, hex: what a revocation names.
    pub serial: String,
    /// The key that signs, as SubjectPublicKeyInfo hex.
    pub issuer: String,
    /// The key it is about.
    pub subject: String,
    /// The host it is about, by id.
    pub host: String,
    /// For a member statement, the profile; empty for the household.
    #[serde(default)]
    pub profile: String,
    /// Issued and expires, unix seconds.
    pub iat: i64,
    pub exp: i64,
}

impl Payload {
    /// A fresh payload with a new serial, lasting the kind's full lifetime.
    pub fn new(
        kind: Kind,
        issuer: &PublicKey,
        subject: &PublicKey,
        host: &str,
        profile: &str,
        now: i64,
    ) -> Result<Self> {
        let serial = new_serial()?;
        let payload = Self {
            v: VERSION,
            kind,
            serial,
            issuer: issuer.to_hex(),
            subject: subject.to_hex(),
            host: host.to_ascii_lowercase(),
            profile: profile.to_string(),
            iat: now,
            exp: now + kind.lifetime(),
        };
        payload.check_shape()?;
        Ok(payload)
    }

    pub fn issuer_key(&self) -> Result<PublicKey> {
        PublicKey::from_hex(&self.issuer)
    }

    pub fn subject_key(&self) -> Result<PublicKey> {
        PublicKey::from_hex(&self.subject)
    }

    /// Everything that can be said about a payload without knowing what it
    /// is for: every field well formed, and dates that make sense.
    fn check_shape(&self) -> Result<()> {
        let bad = |why: String| Err(TrustError::Malformed(why));
        if self.v != VERSION {
            return bad(format!(
                "statement version {} is not one this reads",
                self.v
            ));
        }
        if self.serial.len() != 32 || !is_lower_hex(&self.serial) {
            return bad("a serial is sixteen bytes of hex".into());
        }
        self.issuer_key()?;
        self.subject_key()?;
        if self.host.len() != 64 || !is_lower_hex(&self.host) {
            return bad("a host id is 32 bytes of lower-case hex".into());
        }
        if self.profile.len() > 64 || !self.profile.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return bad("a profile id is a short run of letters and digits".into());
        }
        if self.kind == Kind::Endorse && !self.profile.is_empty() {
            return bad("an endorsement is not about a profile".into());
        }
        if self.exp <= self.iat {
            return bad("a statement must end after it starts".into());
        }
        if self.exp - self.iat > self.kind.lifetime() {
            return bad("a statement lasts longer than its kind may".into());
        }
        Ok(())
    }

    /// Seconds left before it expires, at `now`.
    pub fn remaining(&self, now: i64) -> i64 {
        self.exp - now
    }
}

/// A signed payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Statement {
    /// The payload's JSON bytes, hex.
    pub payload: String,
    /// The issuer's signature of `label ‖ 0 ‖ payload bytes`, hex.
    pub signature: String,
}

fn signed_bytes(payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(LABEL.len() + 1 + payload.len());
    bytes.extend_from_slice(LABEL);
    bytes.push(0);
    bytes.extend_from_slice(payload);
    bytes
}

/// Signs a payload. The signer must be the payload's issuer.
pub fn sign(signer: &dyn Signer, payload: &Payload) -> Result<Statement> {
    payload.check_shape()?;
    if payload.issuer_key()? != *signer.public_key() {
        return Err(TrustError::Rejected(
            "a statement is signed by its own issuer".into(),
        ));
    }
    let bytes = serde_json::to_vec(payload)
        .map_err(|e| TrustError::Malformed(format!("could not write the payload: {e}")))?;
    let signature = signer.sign(&signed_bytes(&bytes))?;
    Ok(Statement {
        payload: hex::encode(&bytes),
        signature: signature.to_hex(),
    })
}

/// Signs a payload somebody else wrote, after the caller has decided it may.
/// The bytes signed are exactly the payload's, as received.
pub fn sign_offered(signer: &dyn Signer, payload_hex: &str) -> Result<Statement> {
    let bytes = payload_bytes(payload_hex)?;
    let signature = signer.sign(&signed_bytes(&bytes))?;
    Ok(Statement {
        payload: hex::encode(&bytes),
        signature: signature.to_hex(),
    })
}

fn payload_bytes(payload_hex: &str) -> Result<Vec<u8>> {
    if payload_hex.len() > MAX_PAYLOAD_BYTES * 2 {
        return Err(TrustError::Malformed("a statement is too long".into()));
    }
    hex::decode(payload_hex).map_err(|_| TrustError::Malformed("a payload is not hex".into()))
}

/// Reads a payload without believing it: for a device deciding whether to
/// sign one it was offered. See [`check_endorse_offer`].
pub fn read_offer(payload_hex: &str) -> Result<Payload> {
    let bytes = payload_bytes(payload_hex)?;
    let payload: Payload = serde_json::from_slice(&bytes)
        .map_err(|e| TrustError::Malformed(format!("a payload did not parse: {e}")))?;
    payload.check_shape()?;
    Ok(payload)
}

/// Checks the issuer's signature and the payload's shape, and returns it.
///
/// Says nothing about whether the issuer is anyone to believe: that is
/// [`verify`]'s `Expect`.
pub fn open(statement: &Statement) -> Result<Payload> {
    let payload = read_offer(&statement.payload)?;
    let signature = Signature::from_hex(&statement.signature)?;
    let bytes = payload_bytes(&statement.payload)?;
    if !payload
        .issuer_key()?
        .verify(&signed_bytes(&bytes), &signature)
    {
        return Err(TrustError::BadSignature);
    }
    Ok(payload)
}

/// What a statement has to be, for whoever is checking it.
#[derive(Debug, Clone, Copy)]
pub struct Expect<'a> {
    pub kind: Kind,
    pub issuer: Option<&'a PublicKey>,
    pub subject: Option<&'a PublicKey>,
    pub host: Option<&'a str>,
    pub now: i64,
}

/// Opens a statement and checks it is what was expected, in date.
pub fn verify(statement: &Statement, expect: Expect<'_>) -> Result<Payload> {
    let payload = open(statement)?;
    let reject = |why: &str| Err(TrustError::Rejected(why.to_string()));
    if payload.kind != expect.kind {
        return reject("it is a different kind of statement");
    }
    if let Some(issuer) = expect.issuer
        && payload.issuer_key()? != *issuer
    {
        return reject("it was signed by a different key");
    }
    if let Some(subject) = expect.subject
        && payload.subject_key()? != *subject
    {
        return reject("it is about a different key");
    }
    if let Some(host) = expect.host
        && !payload.host.eq_ignore_ascii_case(host)
    {
        return reject("it is about a different host");
    }
    if payload.iat > expect.now + CLOCK_SKEW {
        return reject("it is not valid yet");
    }
    if payload.exp + CLOCK_SKEW <= expect.now {
        return reject("it has expired");
    }
    Ok(payload)
}

/// Whether an owner's device should sign the endorsement its host offers.
///
/// The host writes the payload and the device signs it, so the device checks
/// every word first: it is an endorsement, by this device's own key, of the
/// very host the device pinned, starting now, for no longer than an
/// endorsement may last. A host that asked for anything else, by mistake or
/// because it is not what it seems, is refused.
pub fn check_endorse_offer(
    payload: &Payload,
    own_key: &PublicKey,
    pinned_host: &str,
    now: i64,
) -> Result<()> {
    let reject = |why: &str| Err(TrustError::Rejected(why.to_string()));
    payload.check_shape()?;
    if payload.kind != Kind::Endorse {
        return reject("only an endorsement is signed when offered");
    }
    if payload.issuer_key()? != *own_key {
        return reject("the offer names another key as its signer");
    }
    if !payload.host.eq_ignore_ascii_case(pinned_host) {
        return reject("the offer is about another host");
    }
    if !payload
        .subject_key()?
        .id()
        .eq_ignore_ascii_case(pinned_host)
    {
        return reject("the offer endorses a key that is not the host's");
    }
    if (payload.iat - now).abs() > CLOCK_SKEW {
        return reject("the offer's date is not today's");
    }
    Ok(())
}

/// Sixteen random bytes, hex.
pub fn new_serial() -> Result<String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| TrustError::Signing("no randomness available".into()))?;
    Ok(hex::encode(&bytes))
}

fn is_lower_hex(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SoftwareKey;

    const NOW: i64 = 1_791_500_000;

    fn host_key() -> SoftwareKey {
        SoftwareKey::generate().unwrap()
    }

    fn member(issuer: &SoftwareKey, subject: &PublicKey, host: &str) -> Statement {
        let payload = Payload::new(
            Kind::Member,
            issuer.public_key(),
            subject,
            host,
            "a1b2c3d4e5f60718",
            NOW,
        )
        .unwrap();
        sign(issuer, &payload).unwrap()
    }

    fn expect<'a>(issuer: &'a PublicKey, subject: &'a PublicKey, host: &'a str) -> Expect<'a> {
        Expect {
            kind: Kind::Member,
            issuer: Some(issuer),
            subject: Some(subject),
            host: Some(host),
            now: NOW + 60,
        }
    }

    #[test]
    fn a_signed_statement_verifies_as_what_it_says() {
        let person = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let statement = member(&person, device.public_key(), &host);
        let payload = verify(
            &statement,
            expect(person.public_key(), device.public_key(), &host),
        )
        .unwrap();
        assert_eq!(payload.kind, Kind::Member);
        assert_eq!(payload.profile, "a1b2c3d4e5f60718");
        assert_eq!(payload.exp - payload.iat, MEMBER_LIFETIME);
    }

    #[test]
    fn a_changed_payload_or_signature_is_refused() {
        let person = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let statement = member(&person, device.public_key(), &host);

        // Every single byte of the payload changed, one at a time.
        let bytes = hex::decode(&statement.payload).unwrap();
        for i in 0..bytes.len() {
            let mut bent = bytes.clone();
            bent[i] ^= 0x01;
            let changed = Statement {
                payload: hex::encode(&bent),
                signature: statement.signature.clone(),
            };
            assert!(open(&changed).is_err(), "byte {i}");
        }

        let mut signature = hex::decode(&statement.signature).unwrap();
        signature[5] ^= 0x10;
        let changed = Statement {
            payload: statement.payload.clone(),
            signature: hex::encode(&signature),
        };
        assert_eq!(open(&changed), Err(TrustError::BadSignature));
    }

    #[test]
    fn a_statement_rewritten_to_name_another_issuer_fails_its_signature() {
        let person = SoftwareKey::generate().unwrap();
        let impostor = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let statement = member(&person, device.public_key(), &host);

        let mut payload = open(&statement).unwrap();
        payload.issuer = impostor.public_key().to_hex();
        let rewritten = Statement {
            payload: hex::encode(&serde_json::to_vec(&payload).unwrap()),
            signature: statement.signature,
        };
        assert_eq!(open(&rewritten), Err(TrustError::BadSignature));
    }

    #[test]
    fn the_wrong_kind_issuer_subject_or_host_is_refused() {
        let person = SoftwareKey::generate().unwrap();
        let other = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let other_host = host_key().public_key().id();
        let statement = member(&person, device.public_key(), &host);

        let mut e = expect(person.public_key(), device.public_key(), &host);
        e.kind = Kind::Endorse;
        assert!(matches!(
            verify(&statement, e),
            Err(TrustError::Rejected(_))
        ));

        let e = expect(other.public_key(), device.public_key(), &host);
        assert!(matches!(
            verify(&statement, e),
            Err(TrustError::Rejected(_))
        ));

        let e = expect(person.public_key(), other.public_key(), &host);
        assert!(matches!(
            verify(&statement, e),
            Err(TrustError::Rejected(_))
        ));

        let e = expect(person.public_key(), device.public_key(), &other_host);
        assert!(matches!(
            verify(&statement, e),
            Err(TrustError::Rejected(_))
        ));

        // The host compared without regard to case, since ids are hex.
        let upper = host.to_uppercase();
        let e = expect(person.public_key(), device.public_key(), &upper);
        assert!(verify(&statement, e).is_ok());
    }

    #[test]
    fn dates_are_kept_with_ten_minutes_of_grace() {
        let person = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let statement = member(&person, device.public_key(), &host);
        let at = |now| Expect {
            now,
            ..expect(person.public_key(), device.public_key(), &host)
        };

        assert!(verify(&statement, at(NOW - CLOCK_SKEW)).is_ok());
        assert!(verify(&statement, at(NOW - CLOCK_SKEW - 1)).is_err());
        let exp = NOW + MEMBER_LIFETIME;
        assert!(verify(&statement, at(exp + CLOCK_SKEW - 1)).is_ok());
        assert!(verify(&statement, at(exp + CLOCK_SKEW)).is_err());
    }

    #[test]
    fn malformed_payloads_are_refused_before_anything_is_believed() {
        let person = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let good = Payload::new(
            Kind::Member,
            person.public_key(),
            device.public_key(),
            &host,
            "",
            NOW,
        )
        .unwrap();

        let cases: Vec<(&str, Payload)> = vec![
            (
                "version",
                Payload {
                    v: 2,
                    ..good.clone()
                },
            ),
            (
                "short serial",
                Payload {
                    serial: "ab".into(),
                    ..good.clone()
                },
            ),
            (
                "upper serial",
                Payload {
                    serial: good.serial.to_uppercase(),
                    ..good.clone()
                },
            ),
            (
                "issuer",
                Payload {
                    issuer: "00".into(),
                    ..good.clone()
                },
            ),
            (
                "subject",
                Payload {
                    subject: String::new(),
                    ..good.clone()
                },
            ),
            (
                "host",
                Payload {
                    host: "abc".into(),
                    ..good.clone()
                },
            ),
            (
                "upper host",
                Payload {
                    host: host.to_uppercase(),
                    ..good.clone()
                },
            ),
            (
                "profile",
                Payload {
                    profile: "../x".into(),
                    ..good.clone()
                },
            ),
            (
                "long profile",
                Payload {
                    profile: "a".repeat(65),
                    ..good.clone()
                },
            ),
            (
                "backwards",
                Payload {
                    exp: good.iat,
                    ..good.clone()
                },
            ),
            (
                "too long",
                Payload {
                    exp: good.iat + MEMBER_LIFETIME + 1,
                    ..good.clone()
                },
            ),
            (
                "endorse with profile",
                Payload {
                    kind: Kind::Endorse,
                    profile: "p1".into(),
                    ..good.clone()
                },
            ),
        ];
        for (name, payload) in cases {
            assert!(sign(&person, &payload).is_err(), "{name} was signed");
            // And one signed regardless, by hand, is refused when opened.
            let bytes = serde_json::to_vec(&payload).unwrap();
            let signature = person.sign(&signed_bytes(&bytes)).unwrap();
            let forced = Statement {
                payload: hex::encode(&bytes),
                signature: signature.to_hex(),
            };
            assert!(open(&forced).is_err(), "{name} was opened");
        }
    }

    #[test]
    fn unknown_fields_and_oversized_or_broken_statements_are_refused() {
        let person = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let statement = member(&person, device.public_key(), &host);

        let mut value: serde_json::Value =
            serde_json::from_slice(&hex::decode(&statement.payload).unwrap()).unwrap();
        value["extra"] = serde_json::json!(true);
        let bytes = serde_json::to_vec(&value).unwrap();
        let signature = person.sign(&signed_bytes(&bytes)).unwrap();
        let extra = Statement {
            payload: hex::encode(&bytes),
            signature: signature.to_hex(),
        };
        assert!(open(&extra).is_err());

        let huge = Statement {
            payload: "00".repeat(MAX_PAYLOAD_BYTES + 1),
            signature: statement.signature.clone(),
        };
        assert!(open(&huge).is_err());
        let not_hex = Statement {
            payload: "zz".into(),
            signature: statement.signature.clone(),
        };
        assert!(open(&not_hex).is_err());
        let not_json = Statement {
            payload: hex::encode(b"{"),
            signature: statement.signature.clone(),
        };
        assert!(open(&not_json).is_err());
        let short_signature = Statement {
            payload: statement.payload.clone(),
            signature: "00".into(),
        };
        assert!(open(&short_signature).is_err());
    }

    #[test]
    fn only_the_issuer_can_sign_a_payload() {
        let person = SoftwareKey::generate().unwrap();
        let other = SoftwareKey::generate().unwrap();
        let device = SoftwareKey::generate().unwrap();
        let host = host_key().public_key().id();
        let payload = Payload::new(
            Kind::Member,
            person.public_key(),
            device.public_key(),
            &host,
            "",
            NOW,
        )
        .unwrap();
        assert!(matches!(
            sign(&other, &payload),
            Err(TrustError::Rejected(_))
        ));
    }

    #[test]
    fn serials_are_fresh_every_time() {
        let a = new_serial().unwrap();
        let b = new_serial().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
    }

    mod endorse {
        use super::*;

        struct Case {
            owner: SoftwareKey,
            host: SoftwareKey,
        }

        fn case() -> Case {
            Case {
                owner: SoftwareKey::generate().unwrap(),
                host: SoftwareKey::generate().unwrap(),
            }
        }

        fn offer(c: &Case) -> Payload {
            Payload::new(
                Kind::Endorse,
                c.owner.public_key(),
                c.host.public_key(),
                &c.host.public_key().id(),
                "",
                NOW,
            )
            .unwrap()
        }

        #[test]
        fn a_fair_offer_is_accepted_signed_and_verified() {
            let c = case();
            let payload = offer(&c);
            let pinned = c.host.public_key().id();
            check_endorse_offer(&payload, c.owner.public_key(), &pinned, NOW + 5).unwrap();

            let offered = hex::encode(&serde_json::to_vec(&payload).unwrap());
            let statement = sign_offered(&c.owner, &offered).unwrap();
            let read = verify(
                &statement,
                Expect {
                    kind: Kind::Endorse,
                    issuer: Some(c.owner.public_key()),
                    subject: Some(c.host.public_key()),
                    host: Some(&pinned),
                    now: NOW + 5,
                },
            )
            .unwrap();
            assert_eq!(read, payload);
        }

        #[test]
        fn every_unfair_offer_is_refused() {
            let c = case();
            let pinned = c.host.public_key().id();
            let other = SoftwareKey::generate().unwrap();
            let fair = offer(&c);
            let check =
                |p: &Payload, now| check_endorse_offer(p, c.owner.public_key(), &pinned, now);

            // A member statement dressed up as an offer.
            let member = Payload {
                kind: Kind::Member,
                ..fair.clone()
            };
            assert!(check(&member, NOW).is_err());
            // Someone else's key as the signer.
            let not_mine = Payload {
                issuer: other.public_key().to_hex(),
                ..fair.clone()
            };
            assert!(check(&not_mine, NOW).is_err());
            // Another host.
            let elsewhere = Payload {
                host: other.public_key().id(),
                ..fair.clone()
            };
            assert!(check(&elsewhere, NOW).is_err());
            // The right host named, and a different key endorsed.
            let wrong_key = Payload {
                subject: other.public_key().to_hex(),
                ..fair.clone()
            };
            assert!(check(&wrong_key, NOW).is_err());
            // Dated in the past or the future beyond the grace.
            assert!(check(&fair, NOW + CLOCK_SKEW + 1).is_err());
            assert!(check(&fair, NOW - CLOCK_SKEW - 1).is_err());
            assert!(check(&fair, NOW + CLOCK_SKEW).is_ok());
            // Longer than an endorsement may last.
            let long = Payload {
                exp: fair.iat + ENDORSE_LIFETIME + 1,
                ..fair.clone()
            };
            assert!(check(&long, NOW).is_err());
        }

        #[test]
        fn an_offer_that_is_not_a_payload_is_refused_when_read() {
            assert!(read_offer("zz").is_err());
            assert!(read_offer(&hex::encode(b"[]")).is_err());
            assert!(read_offer(&"00".repeat(MAX_PAYLOAD_BYTES + 1)).is_err());
        }
    }
}
