//! What the host says on people's behalf, and what it has taken back.
//!
//! Every person has a key, kept here and nowhere else: one for each profile,
//! and one for the household, which speaks for devices using the drive as
//! themselves. With them the host signs member statements: "this device acts
//! for me, at this host". A device is given one when it signs in with its key
//! and holds on to it; a new one is made when the last has a fortnight left.
//!
//! Nothing at home depends on them: the host knows its devices from its own
//! list. They are made and taken back now so they are proven by the time
//! something else relies on them. Taken back means listed by serial until the
//! statement would have expired anyway: when a device is removed, signs out of
//! a profile, or moves to a new key, and when a profile's PIN is reset or the
//! profile removed.

use basalt_proto::msg::SignedStatement;
use basalt_trust::revocation::RevocationList;
use basalt_trust::statement::MEMBER_RENEW_WITHIN;
use basalt_trust::{Kind, Payload, PublicKey, Signer, SoftwareKey};
use serde::{Deserialize, Serialize};

/// An owner's device vouching for this host's key, the newest there is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endorsement {
    pub statement: SignedStatement,
    /// The owner's device that signed it, by `Device::key`.
    pub by: String,
    pub iat: i64,
    pub exp: i64,
}

/// A member statement the host made and has not seen expire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issued {
    pub serial: String,
    /// The device, by `Device::key`: the same however often it pairs.
    pub device: String,
    /// The device's key the statement is about, hex.
    pub subject: String,
    /// The profile it speaks for; empty for the household.
    #[serde(default)]
    pub profile: String,
    pub exp: i64,
}

#[derive(Debug, Default)]
pub struct Authority {
    household: Option<SoftwareKey>,
    issued: Vec<Issued>,
    revoked: RevocationList,
    endorsement: Option<Endorsement>,
}

impl Authority {
    /// From what the config kept. A household key that does not read is
    /// replaced by [`Authority::ensure_household`]; nothing relies on it yet.
    pub fn new(
        household: &str,
        issued: Vec<Issued>,
        revoked: RevocationList,
        endorsement: Option<Endorsement>,
    ) -> Self {
        let household = (!household.is_empty())
            .then(|| basalt_proto::hex::decode(household).ok())
            .flatten()
            .and_then(|pkcs8| SoftwareKey::from_pkcs8(&pkcs8).ok());
        Self {
            household,
            issued,
            revoked,
            endorsement,
        }
    }

    // -----------------------------------------------------------------------
    // Endorsements
    // -----------------------------------------------------------------------

    pub fn endorsement(&self) -> Option<&Endorsement> {
        self.endorsement.as_ref()
    }

    /// Whether an owner's device signing in should be asked for a fresh
    /// endorsement: there is none, or it is a week old.
    pub fn endorse_due(&self, now: i64) -> bool {
        self.endorsement.as_ref().is_none_or(|e| {
            now - e.iat >= basalt_trust::statement::ENDORSE_RENEW_AFTER || e.exp <= now
        })
    }

    /// Keeps an endorsement, already checked, unless the one kept is newer.
    pub fn accept_endorsement(&mut self, endorsement: Endorsement) -> bool {
        if self
            .endorsement
            .as_ref()
            .is_some_and(|kept| kept.iat > endorsement.iat)
        {
            return false;
        }
        self.endorsement = Some(endorsement);
        true
    }

    /// Lets go of the endorsement a device signed: it is no longer an owner,
    /// was removed, or has a new key.
    pub fn drop_endorsement_by(&mut self, device: &str) -> bool {
        if self.endorsement.as_ref().is_some_and(|e| e.by == device) {
            self.endorsement = None;
            true
        } else {
            false
        }
    }

    /// Makes the household's key if there is none. Returns whether it did.
    pub fn ensure_household(&mut self) -> bool {
        if self.household.is_some() {
            return false;
        }
        match SoftwareKey::generate() {
            Ok(key) => {
                self.household = Some(key);
                true
            }
            Err(e) => {
                tracing::warn!("could not make the household's key: {e}");
                false
            }
        }
    }

    /// The household's key, PKCS#8 hex, for the config. Empty without one.
    pub fn household_pkcs8(&self) -> String {
        self.household
            .as_ref()
            .map(|k| basalt_proto::hex::encode(k.pkcs8()))
            .unwrap_or_default()
    }

    pub fn household_key(&self) -> Option<&PublicKey> {
        self.household.as_ref().map(|k| k.public_key())
    }

    pub fn issued(&self) -> &[Issued] {
        &self.issued
    }

    pub fn revoked(&self) -> &RevocationList {
        &self.revoked
    }

    /// Whether `device` holding `subject` needs a new statement for
    /// `profile`: none, one about another key, or one near its end.
    pub fn due(&self, device: &str, subject: &str, profile: &str, now: i64) -> bool {
        !self.issued.iter().any(|i| {
            i.device == device
                && i.profile == profile
                && i.subject == subject
                && !self.revoked.contains(&i.serial)
                && i.exp - now > MEMBER_RENEW_WITHIN
        })
    }

    /// A member statement from the household, for a device acting as itself.
    pub fn issue_household(
        &mut self,
        device: &str,
        subject: &PublicKey,
        host_id: &str,
        now: i64,
    ) -> Option<SignedStatement> {
        let issuer = self.household.as_ref()?;
        let statement = make(issuer, subject, host_id, "", now)?;
        self.record(device, subject, "", &statement, now);
        Some(statement)
    }

    /// A member statement from a profile's key, for a device signed in to it.
    pub fn issue_profile(
        &mut self,
        issuer: &SoftwareKey,
        device: &str,
        subject: &PublicKey,
        host_id: &str,
        profile: &str,
        now: i64,
    ) -> Option<SignedStatement> {
        let statement = make(issuer, subject, host_id, profile, now)?;
        self.record(device, subject, profile, &statement, now);
        Some(statement)
    }

    /// Keeps a statement just made, taking back any it replaces: the same
    /// device, the same profile, an older one.
    fn record(
        &mut self,
        device: &str,
        subject: &PublicKey,
        profile: &str,
        statement: &SignedStatement,
        now: i64,
    ) {
        let Ok(payload) = basalt_trust::statement::read_offer(&statement.payload) else {
            return;
        };
        self.take_back(|i| i.device == device && i.profile == profile);
        self.issued.push(Issued {
            serial: payload.serial,
            device: device.to_string(),
            subject: subject.to_hex(),
            profile: profile.to_string(),
            exp: payload.exp,
        });
        self.prune(now);
    }

    /// Takes back every statement about a device: it was removed.
    pub fn revoke_device(&mut self, device: &str) -> bool {
        self.take_back(|i| i.device == device)
    }

    /// Takes back a device's statements about any key but `current`: it moved
    /// to a new one.
    pub fn revoke_other_keys(&mut self, device: &str, current: &str) -> bool {
        self.take_back(|i| i.device == device && i.subject != current)
    }

    /// Takes back every statement from a profile: its PIN was reset, or it
    /// was removed.
    pub fn revoke_profile(&mut self, profile: &str) -> bool {
        self.take_back(|i| !profile.is_empty() && i.profile == profile)
    }

    /// Takes back one device's statement from one profile: it signed out.
    pub fn revoke_sign_in(&mut self, device: &str, profile: &str) -> bool {
        self.take_back(|i| i.device == device && !profile.is_empty() && i.profile == profile)
    }

    fn take_back(&mut self, matches: impl Fn(&Issued) -> bool) -> bool {
        let mut changed = false;
        let revoked = &mut self.revoked;
        self.issued.retain(|i| {
            if matches(i) {
                revoked.revoke(&i.serial, i.exp);
                changed = true;
                false
            } else {
                true
            }
        });
        changed
    }

    /// Lets go of what has expired, issued and revoked alike.
    pub fn prune(&mut self, now: i64) -> bool {
        let before = self.issued.len();
        self.issued
            .retain(|i| i.exp + basalt_trust::statement::CLOCK_SKEW > now);
        let pruned = self.revoked.prune(now);
        let lapsed = self.endorsement.as_ref().is_some_and(|e| e.exp <= now);
        if lapsed {
            self.endorsement = None;
        }
        pruned || lapsed || self.issued.len() != before
    }
}

fn make(
    issuer: &SoftwareKey,
    subject: &PublicKey,
    host_id: &str,
    profile: &str,
    now: i64,
) -> Option<SignedStatement> {
    let made = Payload::new(
        Kind::Member,
        issuer.public_key(),
        subject,
        host_id,
        profile,
        now,
    )
    .and_then(|payload| basalt_trust::statement::sign(issuer, &payload));
    match made {
        Ok(statement) => Some(SignedStatement {
            payload: statement.payload,
            signature: statement.signature,
        }),
        Err(e) => {
            tracing::warn!("could not make a member statement: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use basalt_trust::statement::{Expect, MEMBER_LIFETIME, verify};

    const NOW: i64 = 1_800_000_000;

    fn host() -> String {
        SoftwareKey::generate().unwrap().public_key().id()
    }

    fn key() -> PublicKey {
        SoftwareKey::generate().unwrap().public_key().clone()
    }

    fn opened(statement: &SignedStatement) -> basalt_trust::Statement {
        basalt_trust::Statement {
            payload: statement.payload.clone(),
            signature: statement.signature.clone(),
        }
    }

    #[test]
    fn the_household_speaks_for_a_device_and_says_so_verifiably() {
        let mut authority = Authority::default();
        assert!(authority.ensure_household());
        assert!(!authority.ensure_household(), "once");
        let (device, host) = (key(), host());
        let statement = authority
            .issue_household("dev-a", &device, &host, NOW)
            .unwrap();
        let payload = verify(
            &opened(&statement),
            Expect {
                kind: Kind::Member,
                issuer: authority.household_key(),
                subject: Some(&device),
                host: Some(&host),
                now: NOW,
            },
        )
        .unwrap();
        assert_eq!(payload.profile, "");
        assert_eq!(authority.issued().len(), 1);
    }

    #[test]
    fn a_new_statement_is_due_only_when_the_last_nears_its_end() {
        let mut authority = Authority::default();
        authority.ensure_household();
        let (device, host) = (key(), host());
        let subject = device.to_hex();
        assert!(authority.due("dev-a", &subject, "", NOW));
        authority.issue_household("dev-a", &device, &host, NOW);
        assert!(!authority.due("dev-a", &subject, "", NOW + 60));
        let late = NOW + MEMBER_LIFETIME - MEMBER_RENEW_WITHIN;
        assert!(authority.due("dev-a", &subject, "", late));
        // Another key, profile or device: due.
        assert!(authority.due("dev-a", &key().to_hex(), "", NOW));
        assert!(authority.due("dev-a", &subject, "p1", NOW));
        assert!(authority.due("dev-b", &subject, "", NOW));
    }

    #[test]
    fn a_renewed_statement_takes_back_the_one_it_replaces() {
        let mut authority = Authority::default();
        authority.ensure_household();
        let (device, host) = (key(), host());
        let first = authority
            .issue_household("dev-a", &device, &host, NOW)
            .unwrap();
        let first = basalt_trust::statement::read_offer(&first.payload).unwrap();
        authority.issue_household("dev-a", &device, &host, NOW + 1);
        assert!(authority.revoked().contains(&first.serial));
        assert_eq!(authority.issued().len(), 1);
    }

    #[test]
    fn statements_are_taken_back_for_every_reason_and_only_those() {
        let mut authority = Authority::default();
        authority.ensure_household();
        let person = SoftwareKey::generate().unwrap();
        let host = host();
        let (a, b) = (key(), key());
        let serial = |s: Option<SignedStatement>| {
            basalt_trust::statement::read_offer(&s.unwrap().payload)
                .unwrap()
                .serial
        };

        let a_home = serial(authority.issue_household("dev-a", &a, &host, NOW));
        let a_maya = serial(authority.issue_profile(&person, "dev-a", &a, &host, "maya", NOW));
        let b_maya = serial(authority.issue_profile(&person, "dev-b", &b, &host, "maya", NOW));
        let b_home = serial(authority.issue_household("dev-b", &b, &host, NOW));

        // Device A signs out of Maya: only that one.
        assert!(authority.revoke_sign_in("dev-a", "maya"));
        assert!(authority.revoked().contains(&a_maya));
        assert!(!authority.revoked().contains(&a_home));
        assert!(!authority.revoked().contains(&b_maya));

        // Maya's PIN is reset: B's statement from her too.
        assert!(authority.revoke_profile("maya"));
        assert!(authority.revoked().contains(&b_maya));
        assert!(
            !authority.revoke_profile(""),
            "the household is not a profile"
        );

        // B moves to a new key: its household statement about the old one.
        assert!(authority.revoke_other_keys("dev-b", &key().to_hex()));
        assert!(authority.revoked().contains(&b_home));

        // A is removed.
        assert!(authority.revoke_device("dev-a"));
        assert!(authority.revoked().contains(&a_home));
        assert!(authority.issued().is_empty());
    }

    fn endorsement(by: &str, iat: i64) -> Endorsement {
        Endorsement {
            statement: SignedStatement {
                payload: String::new(),
                signature: String::new(),
            },
            by: by.into(),
            iat,
            exp: iat + basalt_trust::statement::ENDORSE_LIFETIME,
        }
    }

    #[test]
    fn an_endorsement_is_asked_for_when_there_is_none_or_it_is_a_week_old() {
        let mut authority = Authority::default();
        assert!(authority.endorse_due(NOW));
        assert!(authority.accept_endorsement(endorsement("phone", NOW)));
        assert!(!authority.endorse_due(NOW + 60));
        let week = basalt_trust::statement::ENDORSE_RENEW_AFTER;
        assert!(!authority.endorse_due(NOW + week - 1));
        assert!(authority.endorse_due(NOW + week));
    }

    #[test]
    fn an_older_endorsement_never_replaces_a_newer_one() {
        let mut authority = Authority::default();
        authority.accept_endorsement(endorsement("phone", NOW));
        assert!(!authority.accept_endorsement(endorsement("laptop", NOW - 10)));
        assert_eq!(authority.endorsement().unwrap().by, "phone");
        assert!(authority.accept_endorsement(endorsement("laptop", NOW + 10)));
        assert_eq!(authority.endorsement().unwrap().by, "laptop");
    }

    #[test]
    fn an_endorsement_goes_with_its_owner_and_its_date() {
        let mut authority = Authority::default();
        authority.accept_endorsement(endorsement("phone", NOW));
        assert!(!authority.drop_endorsement_by("laptop"));
        assert!(authority.drop_endorsement_by("phone"));
        assert!(authority.endorsement().is_none());

        authority.accept_endorsement(endorsement("phone", NOW));
        assert!(authority.prune(NOW + basalt_trust::statement::ENDORSE_LIFETIME));
        assert!(authority.endorsement().is_none());
    }

    #[test]
    fn expired_statements_and_revocations_are_let_go() {
        let mut authority = Authority::default();
        authority.ensure_household();
        let host = host();
        authority.issue_household("dev-a", &key(), &host, NOW);
        authority.issue_household("dev-b", &key(), &host, NOW);
        authority.revoke_device("dev-a");
        let after = NOW + MEMBER_LIFETIME + basalt_trust::statement::CLOCK_SKEW;
        assert!(authority.prune(after));
        assert!(authority.issued().is_empty());
        assert!(authority.revoked().entries().is_empty());
    }

    #[test]
    fn the_household_key_survives_being_written_and_read() {
        let mut authority = Authority::default();
        authority.ensure_household();
        let kept = authority.household_pkcs8();
        let back = Authority::new(&kept, Vec::new(), RevocationList::default(), None);
        assert_eq!(back.household_key(), authority.household_key());
        // Unreadable reads as none, to be made again.
        let none = Authority::new("zz", Vec::new(), RevocationList::default(), None);
        assert!(none.household_key().is_none());
    }
}
