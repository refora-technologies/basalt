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
const ACTIONS: &[&str] = &["play", "pause", "next", "previous", "seek", "stop"];

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
            return devices.remove(device).is_some();
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
        devices.retain(|_, e| now - e.at < STALE_MS);
        let mut sessions: Vec<NowSession> = devices
            .iter()
            .filter(|(id, _)| id.as_str() != device)
            .map(|(id, e)| NowSession {
                device: id.clone(),
                name: e.name.clone(),
                form: e.form.clone(),
                report: e.report.clone(),
                at: e.at,
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
        let queue = self.commands.entry(asked.device).or_default();
        queue.push(MusicCommand {
            action: asked.action,
            position: asked.position,
            from: from.to_string(),
        });
        if queue.len() > MAX_COMMANDS {
            queue.remove(0);
        }
        Ok(())
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
        };
        assert!(
            live.command("maya", "Phone", ask("laptop", "pause"), 1_000)
                .is_ok()
        );
        assert!(
            live.command("sam", "Tablet", ask("laptop", "pause"), 1_000)
                .is_err()
        );
        assert!(
            live.command("maya", "Phone", ask("nobody", "pause"), 1_000)
                .is_err()
        );
        assert!(
            live.command("maya", "Phone", ask("laptop", "format the drive"), 1_000)
                .is_err()
        );
        let got = live.take_commands("laptop");
        assert_eq!(got.len(), 1);
        assert_eq!(
            (got[0].action.as_str(), got[0].from.as_str()),
            ("pause", "Phone")
        );
        assert!(live.take_commands("laptop").is_empty(), "handed over once");
    }
}
