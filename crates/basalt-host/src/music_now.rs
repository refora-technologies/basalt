//! What each profile's devices are playing, live, and what they ask of each
//! other: the host in the middle of "playing on the laptop", "play here"
//! and a phone pausing the laptop's music.
//!
//! In memory only: it is about this moment, and a host that restarts has
//! nobody playing until the devices tell it again, every few seconds while
//! they play. A device that stops telling (closed, gone to sleep, off the
//! network) is forgotten after [`STALE_MS`]. Only within a profile: a
//! device not signed in to one keeps its music to itself, as it does its
//! history and stars.

use std::collections::HashMap;

use basalt_proto::msg::{MusicCommand, MusicCommandRequest, NowReport, NowSession};

/// A device not heard from for this long is no longer playing anywhere.
pub const STALE_MS: i64 = 20_000;

/// A jump in a song bigger than this, against where it should be by now, is
/// a seek the others are told of. Less is the clocks wandering.
const JUMP_SECONDS: f64 = 3.0;

/// Commands kept for one device, at most: one that never asks again does not
/// pile them up.
const MAX_COMMANDS: usize = 16;

/// The actions a device may ask of another.
const ACTIONS: &[&str] = &[
    "play", "pause", "next", "previous", "seek", "stop", "load", "link", "unlink",
];

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    form: Option<String>,
    report: NowReport,
    /// When it told, host milliseconds.
    at: i64,
}

/// Everyone playing, by profile and then by device id.
#[derive(Debug, Default)]
pub struct Live {
    playing: HashMap<String, HashMap<String, Entry>>,
    commands: HashMap<String, Vec<MusicCommand>>,
    /// Devices playing in sync, by profile and then by device: the group
    /// each is in. A group is named after the device the first one joined,
    /// and any number of the profile's devices may be in it.
    groups: HashMap<String, HashMap<String, String>>,
}

impl Live {
    /// What `device` told: what it plays, or that it stopped. Whether the
    /// profile's other devices should hear of it now: something they would
    /// see change, not the second moving on as it should.
    #[allow(clippy::too_many_arguments)]
    pub fn report(
        &mut self,
        profile: &str,
        device: &str,
        name: &str,
        form: Option<String>,
        report: Option<NowReport>,
        stopped: bool,
        now: i64,
    ) -> bool {
        let devices = self.playing.entry(profile.to_string()).or_default();
        if stopped {
            let gone = devices.remove(device).is_some();
            return self.leave(profile, device) || gone;
        }
        let Some(report) = report else {
            return false;
        };
        let before = devices.get(device).cloned();
        devices.insert(
            device.to_string(),
            Entry {
                name: name.to_string(),
                form,
                report: report.clone(),
                at: now,
            },
        );
        match before {
            None => true,
            Some(before) => noticeable(&before, &report, now),
        }
    }

    /// The profile's devices playing, but `device`, the forgotten ones gone.
    pub fn others(&mut self, profile: &str, device: &str, now: i64) -> Vec<NowSession> {
        let Some(devices) = self.playing.get_mut(profile) else {
            return Vec::new();
        };
        let before: Vec<String> = devices.keys().cloned().collect();
        devices.retain(|_, e| now - e.at < STALE_MS);
        let gone: Vec<String> = before
            .into_iter()
            .filter(|d| !devices.contains_key(d))
            .collect();
        for device in &gone {
            self.leave(profile, device);
        }
        let groups = self.groups.get(profile);
        let Some(devices) = self.playing.get(profile) else {
            return Vec::new();
        };
        let mut sessions: Vec<NowSession> = devices
            .iter()
            .filter(|(id, _)| id.as_str() != device)
            .map(|(id, e)| NowSession {
                device: id.clone(),
                name: e.name.clone(),
                form: e.form.clone(),
                report: e.report.clone(),
                at: e.at,
                group: groups.and_then(|g| g.get(id)).cloned(),
            })
            .collect();
        // The most recently started first: the one somebody is likeliest
        // to be looking for.
        sessions.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.device.cmp(&b.device)));
        sessions
    }

    /// What `device` was asked to do, oldest first, now handed over.
    pub fn take_commands(&mut self, device: &str) -> Vec<MusicCommand> {
        self.commands.remove(device).unwrap_or_default()
    }

    /// `asked` of a device playing on the same profile, kept for it to
    /// collect. Refused for a device not playing there, or an action there is
    /// no such thing as.
    pub fn command(
        &mut self,
        profile: &str,
        from: &str,
        from_device: &str,
        asked: MusicCommandRequest,
        now: i64,
    ) -> Result<(), &'static str> {
        if !ACTIONS.contains(&asked.action.as_str()) {
            return Err("there is no such thing to ask of a device");
        }
        let playing = self
            .playing
            .get(profile)
            .and_then(|d| d.get(&asked.device))
            .is_some_and(|e| now - e.at < STALE_MS);
        if !playing {
            return Err("that device isn't playing anything for this profile now");
        }
        // Joining and leaving are the host's to keep, so every device of the
        // group knows every other, however many there are.
        match asked.action.as_str() {
            "link" if !from_device.is_empty() => self.join(profile, from_device, &asked.device),
            "unlink" if !from_device.is_empty() => {
                self.leave(profile, from_device);
            }
            _ => {}
        }
        let queue = self.commands.entry(asked.device).or_default();
        queue.push(MusicCommand {
            action: asked.action,
            position: asked.position,
            from: from.to_string(),
            from_device: from_device.to_string(),
            listening: asked.listening,
            clock: asked.clock,
        });
        if queue.len() > MAX_COMMANDS {
            queue.remove(0);
        }
        Ok(())
    }
}

impl Live {
    /// The group `device` plays in sync in, and the one in it all keep to
    /// (None when that is `device` itself).
    pub fn group_of(&self, profile: &str, device: &str) -> (Option<String>, Option<String>) {
        let Some(groups) = self.groups.get(profile) else {
            return (None, None);
        };
        let Some(group) = groups.get(device) else {
            return (None, None);
        };
        let mut members: Vec<&String> = groups
            .iter()
            .filter(|(_, g)| *g == group)
            .map(|(d, _)| d)
            .collect();
        members.sort();
        // The one the group is named after while it is in it; else the first
        // by id. Every member works it out the same.
        let anchor = if members.contains(&group) {
            group.clone()
        } else {
            members.first().map(|d| (*d).clone()).unwrap_or_default()
        };
        let anchor = (anchor != device).then_some(anchor);
        (Some(group.clone()), anchor)
    }

    /// `device` joins the group `to` is in; or the two make one, named after `to`.
    fn join(&mut self, profile: &str, device: &str, to: &str) {
        let groups = self.groups.entry(profile.to_string()).or_default();
        let group = groups.get(to).cloned().unwrap_or_else(|| to.to_string());
        // Leaving another group first: one group at a time.
        if groups.get(device).is_some_and(|g| *g != group) {
            self.leave(profile, device);
        }
        let groups = self.groups.entry(profile.to_string()).or_default();
        groups.insert(to.to_string(), group.clone());
        groups.insert(device.to_string(), group);
    }

    /// `device` leaves its group; one left on its own is in none. Whether
    /// anything changed.
    fn leave(&mut self, profile: &str, device: &str) -> bool {
        let Some(groups) = self.groups.get_mut(profile) else {
            return false;
        };
        let Some(group) = groups.remove(device) else {
            return false;
        };
        let left: Vec<String> = groups
            .iter()
            .filter(|(_, g)| **g == group)
            .map(|(d, _)| d.clone())
            .collect();
        if left.len() == 1 {
            groups.remove(&left[0]);
        }
        true
    }
}

/// Whether a report differs from the last in a way others would see: another
/// song, played or paused, or a jump in it.
fn noticeable(before: &Entry, now_told: &NowReport, now: i64) -> bool {
    let (a, b) = (&before.report.listening, &now_told.listening);
    let song = |l: &basalt_proto::msg::Listening| l.queue.get(l.index as usize).cloned();
    if song(a) != song(b) || a.index != b.index || before.report.playing != now_told.playing {
        return true;
    }
    let expected = if before.report.playing {
        a.position + (now - before.at) as f64 / 1000.0
    } else {
        a.position
    };
    (b.position - expected).abs() > JUMP_SECONDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use basalt_proto::msg::Listening;

    fn playing(song: &str, position: f64, on: bool) -> NowReport {
        NowReport {
            listening: Listening {
                queue: vec!["a.mp3".into(), song.into()],
                index: 1,
                position,
                ..Listening::default()
            },
            playing: on,
            duration: 200.0,
            clock: None,
        }
    }

    #[test]
    fn a_profiles_devices_see_each_other_and_not_themselves() {
        let mut live = Live::default();
        assert!(live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 10.0, true)),
            false,
            0
        ));
        assert!(live.others("maya", "laptop", 1_000).is_empty());
        let seen = live.others("maya", "phone", 1_000);
        assert_eq!(seen.len(), 1);
        assert_eq!(
            (seen[0].device.as_str(), seen[0].name.as_str()),
            ("laptop", "Laptop")
        );
        // Another profile sees nothing of it.
        assert!(live.others("sam", "tablet", 1_000).is_empty());
    }

    #[test]
    fn only_what_others_would_notice_is_told() {
        let mut live = Live::default();
        live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 10.0, true)),
            false,
            0,
        );
        // Five seconds on, five seconds further: as expected.
        assert!(!live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 15.0, true)),
            false,
            5_000
        ));
        // Paused.
        assert!(live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 15.0, false)),
            false,
            5_500
        ));
        // A seek.
        assert!(live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 90.0, false)),
            false,
            6_000
        ));
        // Another song.
        assert!(live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("c.mp3", 0.0, true)),
            false,
            7_000
        ));
        // Stopped, and gone.
        assert!(live.report("maya", "laptop", "Laptop", None, None, true, 8_000));
        assert!(live.others("maya", "phone", 8_000).is_empty());
    }

    #[test]
    fn a_device_not_heard_from_is_forgotten() {
        let mut live = Live::default();
        live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 10.0, true)),
            false,
            0,
        );
        assert_eq!(live.others("maya", "phone", STALE_MS - 1).len(), 1);
        assert!(live.others("maya", "phone", STALE_MS).is_empty());
    }

    #[test]
    fn any_number_of_devices_play_in_one_group_keeping_to_one() {
        let mut live = Live::default();
        for device in ["laptop", "phone", "tablet"] {
            live.report(
                "maya",
                device,
                device,
                None,
                Some(playing("b.mp3", 10.0, true)),
                false,
                0,
            );
        }
        let link = |to: &str| MusicCommandRequest {
            device: to.into(),
            action: "link".into(),
            position: 0.0,
            listening: None,
            clock: None,
        };
        // The phone joins the laptop; then the tablet joins the phone.
        live.command("maya", "Phone", "phone", link("laptop"), 100)
            .unwrap();
        live.command("maya", "Tablet", "tablet", link("phone"), 200)
            .unwrap();
        for device in ["laptop", "phone", "tablet"] {
            let (group, _) = live.group_of("maya", device);
            assert_eq!(
                group.as_deref(),
                Some("laptop"),
                "{device} is in the one group"
            );
        }
        // All keep to the laptop, which keeps to nobody.
        assert_eq!(live.group_of("maya", "tablet").1.as_deref(), Some("laptop"));
        assert_eq!(live.group_of("maya", "phone").1.as_deref(), Some("laptop"));
        assert_eq!(live.group_of("maya", "laptop").1, None);
        // Each sees the others in it.
        let seen = live.others("maya", "tablet", 300);
        assert!(seen.iter().all(|s| s.group.as_deref() == Some("laptop")));

        // The laptop leaves: the other two keep each other, and keep to one.
        live.command(
            "maya",
            "Laptop",
            "laptop",
            MusicCommandRequest {
                action: "unlink".into(),
                ..link("phone")
            },
            400,
        )
        .unwrap();
        assert_eq!(live.group_of("maya", "laptop"), (None, None));
        assert_eq!(
            live.group_of("maya", "phone").1,
            None,
            "the first by id is followed"
        );
        assert_eq!(live.group_of("maya", "tablet").1.as_deref(), Some("phone"));

        // The phone stops: the tablet is on its own.
        live.report("maya", "phone", "phone", None, None, true, 500);
        assert_eq!(live.group_of("maya", "tablet"), (None, None));
    }

    #[test]
    fn a_device_forgotten_leaves_its_group() {
        let mut live = Live::default();
        live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 1.0, true)),
            false,
            0,
        );
        live.report(
            "maya",
            "phone",
            "Phone",
            None,
            Some(playing("b.mp3", 1.0, true)),
            false,
            STALE_MS,
        );
        live.command(
            "maya",
            "Phone",
            "phone",
            MusicCommandRequest {
                device: "laptop".into(),
                action: "link".into(),
                position: 0.0,
                listening: None,
                clock: None,
            },
            STALE_MS,
        )
        .unwrap_err();
        // The laptop is forgotten by then: no group was made with it.
        assert_eq!(live.group_of("maya", "phone"), (None, None));
    }

    #[test]
    fn commands_reach_only_a_device_playing_on_the_profile() {
        let mut live = Live::default();
        live.report(
            "maya",
            "laptop",
            "Laptop",
            None,
            Some(playing("b.mp3", 10.0, true)),
            false,
            0,
        );
        let ask = |device: &str, action: &str| MusicCommandRequest {
            device: device.into(),
            action: action.into(),
            position: 0.0,
            listening: None,
            clock: None,
        };
        assert!(
            live.command("maya", "Phone", "phone", ask("laptop", "pause"), 1_000)
                .is_ok()
        );
        assert!(
            live.command("sam", "Tablet", "tablet", ask("laptop", "pause"), 1_000)
                .is_err()
        );
        assert!(
            live.command("maya", "Phone", "phone", ask("nobody", "pause"), 1_000)
                .is_err()
        );
        assert!(
            live.command(
                "maya",
                "Phone",
                "phone",
                ask("laptop", "format the drive"),
                1_000
            )
            .is_err()
        );
        let got = live.take_commands("laptop");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].from_device, "phone", "who to keep in sync with");
        assert_eq!(
            (got[0].action.as_str(), got[0].from.as_str()),
            ("pause", "Phone")
        );
        assert!(live.take_commands("laptop").is_empty(), "handed over once");
    }
}
