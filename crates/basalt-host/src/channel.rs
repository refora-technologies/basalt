//! The host's line between its devices: who is online, and the messages
//! they pass each other.
//!
//! A device is online while it holds a watch open that asked for the channel
//! (see [`basalt_proto::msg::WatchRequest::channel`]): the app keeps one open
//! for as long as it runs, in the background too. A message goes to the
//! devices it is for that are online at once; for one that is not, it waits
//! here until that device comes online or the message expires. In memory
//! only: a message is about the next minutes, and anything that must outlast
//! a restart (a file kept for someone) is kept elsewhere, on disk.
//!
//! The host passes messages on without reading what they say, and decides
//! only who may send what to whom, how much, and for how long.

use std::collections::{HashMap, HashSet, VecDeque};

use basalt_proto::msg::{
    Address, CHANNEL_MAX_BODY_BYTES, CHANNEL_MAX_TTL_MS, ChannelMessage, ChannelSendRequest,
};

/// Messages kept for one device, at most: past it, the oldest go.
const MAX_WAITING_PER_DEVICE: usize = 64;
/// Messages kept for profiles, all together.
const MAX_WAITING_FOR_PROFILES: usize = 256;
/// The longest a kind's name may be.
const MAX_KIND_CHARS: usize = 40;

/// Who sends.
#[derive(Debug, Clone)]
pub struct Sender {
    pub device: String,
    pub name: String,
    pub profile: Option<String>,
}

/// What became of a message just sent.
#[derive(Debug, Clone, PartialEq)]
pub struct Sent {
    pub message: ChannelMessage,
    /// Online devices it goes to now.
    pub now: Vec<String>,
    /// Kept for devices that come online later.
    pub waiting: bool,
}

#[derive(Debug, Default)]
struct Online {
    /// Watches open: the app may hold more than one for a moment while it
    /// reconnects.
    watches: u32,
    profile: Option<String>,
}

/// A message for a profile, and the devices that have had it.
#[derive(Debug)]
struct ForProfile {
    message: ChannelMessage,
    had: HashSet<String>,
}

#[derive(Debug, Default)]
pub struct Line {
    online: HashMap<String, Online>,
    /// When each device was last online, host milliseconds.
    seen: HashMap<String, i64>,
    for_device: HashMap<String, VecDeque<ChannelMessage>>,
    for_profile: VecDeque<ForProfile>,
    made: u64,
}

impl Line {
    /// A watch opened for `device`, signed in to `profile`. Whether it has
    /// just come online, and what was waiting for it, oldest first, now
    /// handed over.
    pub fn open(
        &mut self,
        device: &str,
        profile: Option<&str>,
        now: i64,
    ) -> (bool, Vec<ChannelMessage>) {
        let entry = self.online.entry(device.to_string()).or_default();
        let came = entry.watches == 0;
        entry.watches += 1;
        entry.profile = profile.map(str::to_string);
        self.seen.insert(device.to_string(), now);
        self.forget_expired(now);

        let mut waiting: Vec<ChannelMessage> = self
            .for_device
            .remove(device)
            .map(Vec::from)
            .unwrap_or_default();
        if let Some(profile) = profile {
            for kept in self.for_profile.iter_mut() {
                let ours =
                    matches!(&kept.message.to, Address::Profile { profile: p } if p == profile);
                if ours && kept.message.from_device != device && kept.had.insert(device.to_string())
                {
                    waiting.push(kept.message.clone());
                }
            }
        }
        waiting.sort_by_key(|m| m.sent);
        (came, waiting)
    }

    /// A watch for `device` closed. Whether it has gone offline.
    pub fn close(&mut self, device: &str, now: i64) -> bool {
        let Some(entry) = self.online.get_mut(device) else {
            return false;
        };
        entry.watches = entry.watches.saturating_sub(1);
        self.seen.insert(device.to_string(), now);
        if entry.watches == 0 {
            self.online.remove(device);
            return true;
        }
        false
    }

    pub fn is_online(&self, device: &str) -> bool {
        self.online.contains_key(device)
    }

    /// The profile an online device is signed in to.
    pub fn profile_of(&self, device: &str) -> Option<&str> {
        self.online.get(device).and_then(|o| o.profile.as_deref())
    }

    /// When a device was last online; 0 if not since the host started.
    pub fn last_seen(&self, device: &str) -> i64 {
        if self.is_online(device) {
            return self.seen.get(device).copied().unwrap_or(0).max(1);
        }
        self.seen.get(device).copied().unwrap_or(0)
    }

    /// Takes a message to pass on. `known` says whether a device id is one
    /// of the host's devices; `profiles` whether a profile id is one of its
    /// profiles. Refused: an unknown address, a message to itself, an
    /// oversized body or a kind that is no kind.
    pub fn send(
        &mut self,
        from: &Sender,
        asked: ChannelSendRequest,
        known: impl Fn(&str) -> bool,
        profiles: impl Fn(&str) -> bool,
        now: i64,
    ) -> Result<Sent, &'static str> {
        let kind = asked.kind.trim();
        if kind.is_empty()
            || kind.chars().count() > MAX_KIND_CHARS
            || !kind
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        {
            return Err("that is no kind of message");
        }
        let body_bytes = serde_json::to_vec(&asked.body)
            .map(|b| b.len())
            .unwrap_or(usize::MAX);
        if body_bytes > CHANNEL_MAX_BODY_BYTES {
            return Err("that message is too big to pass on");
        }
        match &asked.to {
            Address::Device { device } if device == &from.device => {
                return Err("a device can't send to itself");
            }
            Address::Device { device } if !known(device) => {
                return Err("there is no such device on this host");
            }
            Address::Profile { profile } if !profiles(profile) => {
                return Err("there is no such profile on this host");
            }
            _ => {}
        }
        self.forget_expired(now);
        self.made += 1;
        let ttl = asked.ttl_ms.clamp(0, CHANNEL_MAX_TTL_MS);
        let message = ChannelMessage {
            id: format!("{now:x}-{:x}", self.made),
            from_device: from.device.clone(),
            from_name: from.name.clone(),
            from_profile: from.profile.clone(),
            to: asked.to,
            kind: kind.to_string(),
            body: asked.body,
            sent: now,
            expires: now + ttl,
        };

        let (now_to, waiting) = match &message.to {
            Address::Device { device } => {
                if self.is_online(device) {
                    (vec![device.clone()], false)
                } else if ttl > 0 {
                    let queue = self.for_device.entry(device.clone()).or_default();
                    queue.push_back(message.clone());
                    while queue.len() > MAX_WAITING_PER_DEVICE {
                        queue.pop_front();
                    }
                    (Vec::new(), true)
                } else {
                    (Vec::new(), false)
                }
            }
            Address::Profile { profile } => {
                let mut to: Vec<String> = self
                    .online
                    .iter()
                    .filter(|(d, o)| {
                        o.profile.as_deref() == Some(profile.as_str()) && **d != from.device
                    })
                    .map(|(d, _)| d.clone())
                    .collect();
                to.sort();
                let waiting = ttl > 0;
                if waiting {
                    self.for_profile.push_back(ForProfile {
                        message: message.clone(),
                        had: to.iter().cloned().collect(),
                    });
                    while self.for_profile.len() > MAX_WAITING_FOR_PROFILES {
                        self.for_profile.pop_front();
                    }
                }
                (to, waiting)
            }
        };
        Ok(Sent {
            message,
            now: now_to,
            waiting,
        })
    }

    /// A device that no longer belongs to the host: nothing more waits for it.
    pub fn forget_device(&mut self, device: &str) {
        self.for_device.remove(device);
        self.seen.remove(device);
    }

    fn forget_expired(&mut self, now: i64) {
        for queue in self.for_device.values_mut() {
            queue.retain(|m| m.expires > now);
        }
        self.for_device.retain(|_, q| !q.is_empty());
        self.for_profile.retain(|k| k.message.expires > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(device: &str, profile: Option<&str>) -> Sender {
        Sender {
            device: device.into(),
            name: device.to_uppercase(),
            profile: profile.map(str::to_string),
        }
    }

    fn to_device(device: &str, ttl_ms: i64) -> ChannelSendRequest {
        ChannelSendRequest {
            to: Address::Device {
                device: device.into(),
            },
            kind: "offer".into(),
            body: serde_json::json!({ "name": "Holiday.mkv" }),
            ttl_ms,
        }
    }

    fn to_profile(profile: &str, ttl_ms: i64) -> ChannelSendRequest {
        ChannelSendRequest {
            to: Address::Profile {
                profile: profile.into(),
            },
            ..to_device("x", ttl_ms)
        }
    }

    const ANY: fn(&str) -> bool = |_| true;

    #[test]
    fn a_device_is_online_while_any_of_its_watches_is_open() {
        let mut line = Line::default();
        assert!(line.open("phone", Some("maya"), 10).0, "came online");
        assert!(
            !line.open("phone", Some("maya"), 20).0,
            "a second watch, while reconnecting"
        );
        assert!(!line.close("phone", 30), "one still open");
        assert!(line.is_online("phone"));
        assert!(line.close("phone", 40), "now gone");
        assert!(!line.is_online("phone"));
        assert_eq!(line.last_seen("phone"), 40);
        assert_eq!(line.last_seen("never"), 0);
    }

    #[test]
    fn a_message_reaches_an_online_device_at_once() {
        let mut line = Line::default();
        line.open("laptop", Some("maya"), 0);
        let sent = line
            .send(
                &me("phone", Some("maya")),
                to_device("laptop", 60_000),
                ANY,
                ANY,
                100,
            )
            .unwrap();
        assert_eq!(sent.now, vec!["laptop".to_string()]);
        assert!(!sent.waiting);
        assert_eq!(sent.message.from_device, "phone");
        assert_eq!(sent.message.expires, 60_100);
        // Nothing is kept for later: it was delivered.
        line.close("laptop", 200);
        assert!(line.open("laptop", Some("maya"), 300).1.is_empty());
    }

    #[test]
    fn a_message_waits_for_an_offline_device_until_it_expires() {
        let mut line = Line::default();
        let sent = line
            .send(&me("phone", None), to_device("tablet", 1_000), ANY, ANY, 0)
            .unwrap();
        assert!(sent.now.is_empty() && sent.waiting);
        let (_, waiting) = line.open("tablet", None, 500);
        assert_eq!(waiting.len(), 1, "came in time");
        assert_eq!(waiting[0].id, sent.message.id);
        assert!(
            line.open("tablet", None, 600).1.is_empty(),
            "handed over once"
        );

        line.send(&me("phone", None), to_device("tv", 1_000), ANY, ANY, 0)
            .unwrap();
        assert!(
            line.open("tv", None, 1_000).1.is_empty(),
            "too late: expired"
        );

        let now_or_never = line
            .send(&me("phone", None), to_device("lamp", 0), ANY, ANY, 0)
            .unwrap();
        assert!(!now_or_never.waiting, "no ttl: now or never");
        assert!(line.open("lamp", None, 1).1.is_empty());
    }

    #[test]
    fn a_profile_message_reaches_each_of_its_devices_once() {
        let mut line = Line::default();
        line.open("sam-phone", Some("sam"), 0);
        line.open("maya-phone", Some("maya"), 0);
        let sent = line
            .send(
                &me("maya-phone", Some("maya")),
                to_profile("sam", 60_000),
                ANY,
                ANY,
                10,
            )
            .unwrap();
        assert_eq!(
            sent.now,
            vec!["sam-phone".to_string()],
            "only Sam's online devices"
        );
        assert!(sent.waiting, "kept for Sam's devices to come");
        // Sam's laptop comes online: it gets it; the phone, reconnecting, doesn't again.
        assert_eq!(line.open("sam-laptop", Some("sam"), 20).1.len(), 1);
        assert!(line.open("sam-phone", Some("sam"), 30).1.is_empty());
        assert!(line.open("sam-laptop", Some("sam"), 40).1.is_empty());
        // A device of another profile never sees it.
        assert!(line.open("amma-phone", Some("amma"), 50).1.is_empty());
    }

    #[test]
    fn what_is_not_passed_on() {
        let mut line = Line::default();
        let none: fn(&str) -> bool = |_| false;
        let from = me("phone", Some("maya"));
        assert!(
            line.send(&from, to_device("phone", 0), ANY, ANY, 0)
                .is_err(),
            "itself"
        );
        assert!(
            line.send(&from, to_device("ghost", 0), none, ANY, 0)
                .is_err(),
            "unknown device"
        );
        assert!(
            line.send(&from, to_profile("ghost", 0), ANY, none, 0)
                .is_err(),
            "unknown profile"
        );
        let mut odd = to_device("laptop", 0);
        odd.kind = "rm -rf".into();
        assert!(
            line.send(&from, odd, ANY, ANY, 0).is_err(),
            "no kind of message"
        );
        let mut big = to_device("laptop", 0);
        big.body = serde_json::Value::String("x".repeat(CHANNEL_MAX_BODY_BYTES + 1));
        assert!(line.send(&from, big, ANY, ANY, 0).is_err(), "too big");
    }

    #[test]
    fn waiting_is_bounded_and_the_ttl_is_capped() {
        let mut line = Line::default();
        let from = me("phone", None);
        for _ in 0..(MAX_WAITING_PER_DEVICE + 10) {
            line.send(&from, to_device("tablet", 60_000), ANY, ANY, 0)
                .unwrap();
        }
        let (_, waiting) = line.open("tablet", None, 1);
        assert_eq!(waiting.len(), MAX_WAITING_PER_DEVICE, "the oldest went");

        let long = line
            .send(&from, to_device("tv", i64::MAX), ANY, ANY, 0)
            .unwrap();
        assert_eq!(long.message.expires, CHANNEL_MAX_TTL_MS);
    }

    #[test]
    fn a_removed_device_has_nothing_waiting() {
        let mut line = Line::default();
        line.send(&me("phone", None), to_device("tablet", 60_000), ANY, ANY, 0)
            .unwrap();
        line.forget_device("tablet");
        assert!(line.open("tablet", None, 1).1.is_empty());
    }
}
