//! Profiles from other drives.
//!
//! Maya's profile lives on her home drive, which holds her person key and
//! checks her PIN. A device signed in to her there carries the statement her
//! key signed: "this device acts for me". Shown to another drive, that is what
//! lets her in there, once someone who manages that drive has approved "Maya
//! from Living Room Drive". She is then a profile there like any other, with
//! her own history and stars on that drive, and no PIN: this drive never sees
//! it, and never could sign for her.
//!
//! What is believed is the statement: signed by the person's key, about the
//! key this connection signed in with, for a profile on another host, in date.
//! The name, colour and home drive's name a device sends along are only shown
//! to whoever approves.
//!
//! On the local network only, as all pairing is (decided 2026-10-10).

use std::time::{Duration, Instant};

use basalt_proto::msg::{ProfileLinkRequest, ProfileView};

use crate::error::{HostError, Result};
use crate::profiles::Home;
use crate::server::Host;
use crate::ui::LinkView;

/// How long a request waits for someone who manages the drive.
pub const LINK_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Requests waiting at once.
pub const MAX_LINKS: usize = 6;

/// A profile from another drive, waiting to be approved here.
#[derive(Debug, Clone)]
pub struct LinkRequest {
    pub id: String,
    /// The device asking, as this host knows it.
    pub device_name: String,
    pub name: String,
    pub color: u8,
    pub home: Home,
    pub opened: Instant,
    /// Turned away: kept until it lapses, so the device asking again is told
    /// so rather than asking anew.
    pub refused: bool,
}

/// What asking to use a profile from another drive came to.
pub enum Linked {
    /// Approved before: signed in, with this sign-in's token.
    SignedIn(ProfileView, String),
    /// Waiting for someone who manages this drive.
    Waiting,
}

impl Host {
    /// A device asks to use a profile from another drive. `signed_key` is the
    /// key this connection signed in with, hex; `device_key` is what this
    /// host files the device's sign-ins under.
    pub fn link_profile(
        &self,
        request: ProfileLinkRequest,
        signed_key: &str,
        device_key: &str,
        device_name: &str,
    ) -> Result<Linked> {
        let now = crate::server::unix_now();
        let subject = basalt_trust::PublicKey::from_hex(signed_key)
            .map_err(|e| HostError::Denied(format!("this device's key is not readable: {e}")))?;
        let statement = basalt_trust::Statement {
            payload: request.statement.payload.clone(),
            signature: request.statement.signature.clone(),
        };
        let payload = basalt_trust::statement::verify(
            &statement,
            basalt_trust::statement::Expect {
                kind: basalt_trust::Kind::Member,
                issuer: None,
                subject: Some(&subject),
                host: None,
                now,
            },
        )
        .map_err(|e| {
            HostError::Denied(format!(
                "that profile's sign-in from its own drive does not check out ({e}). Sign in \
                 to it there again."
            ))
        })?;
        if payload.host.eq_ignore_ascii_case(self.host_id()) {
            return Err(HostError::Denied("that profile is this drive's own".into()));
        }
        if payload.profile.is_empty() {
            return Err(HostError::Denied("that is not a profile's sign-in".into()));
        }
        let home = Home {
            host_id: payload.host.clone(),
            label: label(&request.home),
            profile_id: payload.profile.clone(),
            person: payload.issuer.clone(),
        };

        // Approved before: in, as with a PIN, for no longer than the
        // statement says.
        let linked = self
            .profiles
            .lock()
            .expect("profiles lock")
            .find_linked(&home.host_id, &home.person)
            .map(|p| p.id.clone());
        if let Some(id) = linked {
            let (profile, token) = self
                .profiles
                .lock()
                .expect("profiles lock")
                .sign_in_linked(&id, device_key, request.remember, payload.exp, now)?;
            self.persist()?;
            return Ok(Linked::SignedIn(profile.view(), token));
        }

        let name = crate::profiles::clean_name(&request.name)?;
        let mut links = self.profile_links.lock().expect("links lock");
        links.retain(|l| l.opened.elapsed() < LINK_WINDOW);
        if let Some(waiting) = links
            .iter()
            .find(|l| l.home.host_id == home.host_id && l.home.person == home.person)
        {
            if waiting.refused {
                return Err(HostError::Denied(format!(
                    "someone who manages this drive turned {} from {} away",
                    waiting.name, waiting.home.label
                )));
            }
            return Ok(Linked::Waiting);
        }
        if links.len() >= MAX_LINKS {
            return Err(HostError::Denied(
                "too many profiles are waiting to be approved here; try again later".into(),
            ));
        }
        let id = basalt_net::pairing::random_token()
            .map_err(|e| HostError::Unavailable(format!("no randomness: {e}")))?[..16]
            .to_string();
        tracing::info!(
            "{device_name} asks to use {name} from {} here; waiting for someone who manages \
             this drive",
            home.label
        );
        links.push(LinkRequest {
            id,
            device_name: device_name.to_string(),
            name,
            color: request.color % crate::profiles::COLORS,
            home,
            opened: Instant::now(),
            refused: false,
        });
        drop(links);
        // Managers' screens show it at once.
        self.profiles_changed();
        Ok(Linked::Waiting)
    }

    /// Requests waiting to be approved, newest last.
    pub fn profile_links(&self) -> Vec<LinkView> {
        let mut links = self.profile_links.lock().expect("links lock");
        links.retain(|l| l.opened.elapsed() < LINK_WINDOW);
        links
            .iter()
            .filter(|l| !l.refused)
            .map(|l| LinkView {
                id: l.id.clone(),
                device_name: l.device_name.clone(),
                name: l.name.clone(),
                color: l.color,
                home: l.home.label.clone(),
                seconds_left: LINK_WINDOW.saturating_sub(l.opened.elapsed()).as_secs(),
            })
            .collect()
    }

    /// Lets a profile from another drive in. The device that asked is told
    /// the profiles changed, and signs in by itself.
    pub fn approve_profile_link(&self, id: &str) -> Result<()> {
        let request = {
            let mut links = self.profile_links.lock().expect("links lock");
            let index = links
                .iter()
                .position(|l| l.id == id && !l.refused)
                .ok_or_else(|| HostError::NotFound("that request (it may have lapsed)".into()))?;
            links.remove(index)
        };
        self.profiles.lock().expect("profiles lock").add_linked(
            &request.name,
            request.color,
            request.home.clone(),
            crate::server::unix_now(),
        )?;
        self.persist()?;
        tracing::info!(
            "{} from {} may use this drive now",
            request.name,
            request.home.label
        );
        self.profiles_changed();
        Ok(())
    }

    /// Turns a request away. Asking again is refused until it would have lapsed.
    pub fn deny_profile_link(&self, id: &str) -> bool {
        let mut links = self.profile_links.lock().expect("links lock");
        let Some(request) = links.iter_mut().find(|l| l.id == id && !l.refused) else {
            return false;
        };
        request.refused = true;
        drop(links);
        self.profiles_changed();
        true
    }
}

/// The home drive's name as a device gave it, fit to show.
fn label(given: &str) -> String {
    let label: String = given
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(48)
        .collect();
    if label.is_empty() {
        "another drive".to_string()
    } else {
        label
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use basalt_proto::msg::SignedStatement;
    use basalt_trust::{Kind, Signer, SoftwareKey};

    use super::*;
    use crate::config::HostConfig;

    const HOME: &str = "aa00000000000000000000000000000000000000000000000000000000000001";

    struct Fixture {
        dir: std::path::PathBuf,
        host: Arc<Host>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn host(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("basalt-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("host.json");
        let config = HostConfig::create("Study Drive").unwrap();
        config.save(&path).unwrap();
        let host = Host::new(config, path).unwrap();
        Fixture { dir, host }
    }

    /// A member statement, `person` saying `device` acts for it.
    fn statement(
        person: &SoftwareKey,
        device: &SoftwareKey,
        host: &str,
        profile: &str,
        issued: i64,
    ) -> SignedStatement {
        let payload = basalt_trust::statement::Payload::new(
            Kind::Member,
            person.public_key(),
            device.public_key(),
            host,
            profile,
            issued,
        )
        .unwrap();
        let signed = basalt_trust::statement::sign(person, &payload).unwrap();
        SignedStatement {
            payload: signed.payload,
            signature: signed.signature,
        }
    }

    fn ask(statement: SignedStatement) -> ProfileLinkRequest {
        ProfileLinkRequest {
            statement,
            name: "Maya".into(),
            color: 3,
            home: "Living Room Drive".into(),
            remember: false,
        }
    }

    fn now() -> i64 {
        crate::server::unix_now()
    }

    #[test]
    fn a_good_statement_waits_for_approval() {
        let f = host("good");
        let (maya, phone) = (
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
        );
        let asked = f
            .host
            .link_profile(
                ask(statement(&maya, &phone, HOME, "0a1b2c3d4e5f6071", now())),
                &phone.public_key().to_hex(),
                "phone",
                "Maya's phone",
            )
            .unwrap();
        assert!(matches!(asked, Linked::Waiting));
        assert_eq!(f.host.profile_links().len(), 1);
    }

    // Someone who copied Maya's phone's statement cannot use it from their
    // own device: it is about the phone's key, not theirs.
    #[test]
    fn a_statement_about_another_device_is_refused() {
        let f = host("other-device");
        let (maya, phone, thief) = (
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
        );
        let refused = f.host.link_profile(
            ask(statement(&maya, &phone, HOME, "0a1b2c3d4e5f6071", now())),
            &thief.public_key().to_hex(),
            "thief",
            "Laptop",
        );
        assert!(matches!(refused, Err(HostError::Denied(_))));
        assert!(f.host.profile_links().is_empty());
    }

    #[test]
    fn an_expired_statement_is_refused() {
        let f = host("expired");
        let (maya, phone) = (
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
        );
        let long_ago = now() - basalt_trust::statement::MEMBER_LIFETIME - 24 * 60 * 60;
        let refused = f.host.link_profile(
            ask(statement(&maya, &phone, HOME, "0a1b2c3d4e5f6071", long_ago)),
            &phone.public_key().to_hex(),
            "phone",
            "Maya's phone",
        );
        assert!(matches!(refused, Err(HostError::Denied(_))));
    }

    #[test]
    fn a_statement_for_this_drive_or_for_no_profile_is_refused() {
        let f = host("own");
        let (maya, phone) = (
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
        );
        let own = f.host.host_id().to_string();
        let refused = f.host.link_profile(
            ask(statement(&maya, &phone, &own, "0a1b2c3d4e5f6071", now())),
            &phone.public_key().to_hex(),
            "phone",
            "Maya's phone",
        );
        assert!(matches!(refused, Err(HostError::Denied(m)) if m.contains("this drive's own")));
        let household = f.host.link_profile(
            ask(statement(&maya, &phone, HOME, "", now())),
            &phone.public_key().to_hex(),
            "phone",
            "Maya's phone",
        );
        assert!(matches!(household, Err(HostError::Denied(m)) if m.contains("not a profile")));
    }

    #[test]
    fn a_tampered_statement_is_refused() {
        let f = host("tampered");
        let (maya, phone) = (
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
        );
        let mut signed = statement(&maya, &phone, HOME, "0a1b2c3d4e5f6071", now());
        let other = statement(&maya, &phone, HOME, "9a8b7c6d5e4f3021", now());
        signed.payload = other.payload;
        let refused = f.host.link_profile(
            ask(signed),
            &phone.public_key().to_hex(),
            "phone",
            "Maya's phone",
        );
        assert!(matches!(refused, Err(HostError::Denied(_))));
    }

    #[test]
    fn approved_once_the_same_person_signs_in_from_any_of_their_devices() {
        let f = host("approved");
        let maya = SoftwareKey::generate().unwrap();
        let (phone, laptop) = (
            SoftwareKey::generate().unwrap(),
            SoftwareKey::generate().unwrap(),
        );
        f.host
            .link_profile(
                ask(statement(&maya, &phone, HOME, "0a1b2c3d4e5f6071", now())),
                &phone.public_key().to_hex(),
                "phone",
                "Maya's phone",
            )
            .unwrap();
        let id = f.host.profile_links()[0].id.clone();
        f.host.approve_profile_link(&id).unwrap();
        let signed_in = f
            .host
            .link_profile(
                ask(statement(&maya, &laptop, HOME, "0a1b2c3d4e5f6071", now())),
                &laptop.public_key().to_hex(),
                "laptop",
                "Maya's laptop",
            )
            .unwrap();
        assert!(matches!(signed_in, Linked::SignedIn(ref p, _) if p.name == "Maya"));
        // Someone else from the same drive still waits.
        let leo = SoftwareKey::generate().unwrap();
        let waiting = f
            .host
            .link_profile(
                ask(statement(&leo, &laptop, HOME, "9a8b7c6d5e4f3021", now())),
                &laptop.public_key().to_hex(),
                "laptop",
                "Maya's laptop",
            )
            .unwrap();
        assert!(matches!(waiting, Linked::Waiting));
    }
}
