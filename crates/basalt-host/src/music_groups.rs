//! Devices playing one song together: the host keeps each group's state,
//! and every member plays that state. From 1.6.4.
//!
//! Before, the devices of a group each kept to one of them, "the anchor",
//! from its reports every few seconds; a command went to one device and the
//! others pulled it back; two devices whose song ended each moved the group
//! on. Now the state is the host's: the song, playing or paused, and where in
//! it at a moment on the host's clock. A change (play, pause, a seek, another
//! song) is stamped a moment ahead, so every member has time to hear of it
//! and acts at the same instant; each change has a version, so two devices
//! asking "next" as their song ends move it on once.
//!
//! Who is in a group goes by who is online (the device channel's presence),
//! not by reports: a phone whose screen is off stays in it.

use std::collections::HashMap;

use basalt_proto::msg::{GroupMember, Listening, MusicGroup, MusicGroupRequest};

/// The latest a change is stamped for, ahead: a song to open takes about
/// a second and a half on a slow phone.
pub const MOST_LEAD_MS: i64 = 3_000;

/// All the groups, by id. A device is in one group at most.
#[derive(Debug, Default)]
pub struct Groups {
    groups: HashMap<String, Group>,
    next_id: u64,
}

#[derive(Debug, Clone)]
struct Group {
    profile: String,
    state: MusicGroup,
}

/// What a change did: the group as it is now, for its members; and the
/// devices that are in it no more (told it's gone for them).
#[derive(Debug, Default, PartialEq)]
pub struct Changed {
    pub group: Option<MusicGroup>,
    pub left: Vec<String>,
    /// The group was ended ("Play here" elsewhere): its members stop, rather
    /// than play on alone.
    pub ended: bool,
}

impl Groups {
    /// The group `device` is in.
    pub fn of(&self, device: &str) -> Option<MusicGroup> {
        self.groups
            .values()
            .find(|g| g.state.members.iter().any(|m| m.device == device))
            .map(|g| g.state.clone())
    }

    /// Does what `device` of `profile` asked. `playing_there` is what the
    /// device it starts a group with plays now, from its last report: the
    /// group starts from it. `now` is the host's clock.
    pub fn ask(
        &mut self,
        profile: &str,
        device: GroupMember,
        asked: &MusicGroupRequest,
        playing_there: Option<(GroupMember, Listening, bool)>,
        now: i64,
    ) -> Result<Changed, &'static str> {
        let lead = asked.lead_ms.clamp(0, MOST_LEAD_MS);
        match asked.action.as_str() {
            "view" => Ok(Changed {
                group: self.of(&device.device),
                ..Changed::default()
            }),
            // Play together with another device: its group, or a new one
            // from what it plays. `playing` true starts both, even if it
            // was paused.
            "start" => {
                let (with, listening, playing) = playing_there
                    .ok_or("that device isn't playing anything for this profile now")?;
                if with.device == device.device {
                    return Err("a device plays together with another");
                }
                let mut left = self.leave_quietly(&device.device);
                let id = match self.id_of(&with.device) {
                    Some(id) => id,
                    None => {
                        self.next_id += 1;
                        let id = format!("g{}", self.next_id);
                        self.groups.insert(
                            id.clone(),
                            Group {
                                profile: profile.to_string(),
                                state: MusicGroup {
                                    id: id.clone(),
                                    members: vec![with.clone()],
                                    listening,
                                    playing,
                                    at: now,
                                    version: 1,
                                },
                            },
                        );
                        id
                    }
                };
                let group = self.groups.get_mut(&id).expect("just found or made");
                if group.profile != profile {
                    return Err("that device plays for another profile");
                }
                group.state.members.push(device);
                if asked.playing == Some(true) && !group.state.playing {
                    play(&mut group.state, now + lead);
                }
                group.state.version += 1;
                left.retain(|d| !group.state.members.iter().any(|m| &m.device == d));
                Ok(Changed {
                    group: Some(group.state.clone()),
                    left,
                    ended: false,
                })
            }
            "leave" => Ok(self.leave(&device.device)),
            // Ends the group for all its members: "Play here" from another
            // device, or the group stopped.
            "end" => {
                let id = self.target(profile, &device.device, &asked.group)?;
                let gone = self.groups.remove(&id).expect("target found it");
                Ok(Changed {
                    group: None,
                    left: gone.state.members.into_iter().map(|m| m.device).collect(),
                    ended: true,
                })
            }
            // A change to the group, by one of its members or another of the
            // profile's devices steering it.
            "set" => {
                let id = self.target(profile, &device.device, &asked.group)?;
                let group = self.groups.get_mut(&id).expect("target found it");
                if asked.expect.is_some_and(|v| v != group.state.version) {
                    return Err("the group has moved on");
                }
                let at = now + lead;
                let state = &mut group.state;
                if let Some(listening) = &asked.listening {
                    state.listening = listening.clone();
                    state.at = at;
                    state.playing = asked.playing.unwrap_or(true);
                } else {
                    if let Some(to) = asked.position {
                        state.listening.position = to.max(0.0);
                        state.at = at;
                    }
                    match asked.playing {
                        Some(true) if !state.playing => play(state, at),
                        Some(false) if state.playing => pause(state, at),
                        _ => {}
                    }
                }
                state.version += 1;
                Ok(Changed {
                    group: Some(state.clone()),
                    ..Changed::default()
                })
            }
            _ => Err("there is no such thing to ask of a group"),
        }
    }

    /// Devices that are no longer online leave their groups; a group left
    /// with one is no group. What changed, group by group.
    pub fn keep_online(&mut self, online: impl Fn(&str) -> bool) -> Vec<Changed> {
        let gone: Vec<String> = self
            .groups
            .values()
            .flat_map(|g| g.state.members.iter())
            .filter(|m| !online(&m.device))
            .map(|m| m.device.clone())
            .collect();
        gone.iter().map(|device| self.leave(device)).collect()
    }

    /// The group's id `device` may change: the one asked for, of its
    /// profile; or, none asked for, its own.
    fn target(&self, profile: &str, device: &str, asked: &str) -> Result<String, &'static str> {
        let id = if asked.is_empty() {
            self.id_of(device)
                .ok_or("this device isn't playing in a group")?
        } else {
            asked.to_string()
        };
        match self.groups.get(&id) {
            Some(g) if g.profile == profile => Ok(id),
            _ => Err("there is no such group for this profile"),
        }
    }

    fn id_of(&self, device: &str) -> Option<String> {
        self.groups
            .iter()
            .find(|(_, g)| g.state.members.iter().any(|m| m.device == device))
            .map(|(id, _)| id.clone())
    }

    /// `device` leaves its group: the others are told; one left alone too.
    fn leave(&mut self, device: &str) -> Changed {
        let Some(id) = self.id_of(device) else {
            return Changed::default();
        };
        let group = self.groups.get_mut(&id).expect("just found");
        group.state.members.retain(|m| m.device != device);
        let mut left = vec![device.to_string()];
        if group.state.members.len() < 2 {
            let gone = self.groups.remove(&id).expect("just found");
            left.extend(gone.state.members.into_iter().map(|m| m.device));
            return Changed {
                group: None,
                left,
                ended: false,
            };
        }
        group.state.version += 1;
        Changed {
            group: Some(group.state.clone()),
            left,
            ended: false,
        }
    }

    /// Leaves for another group: the devices that were left on their own
    /// by it (to be told).
    fn leave_quietly(&mut self, device: &str) -> Vec<String> {
        let changed = self.leave(device);
        changed.left.into_iter().filter(|d| d != device).collect()
    }
}

/// Where the group's song is at `at`, host milliseconds.
pub fn position_at(state: &MusicGroup, at: i64) -> f64 {
    if state.playing && at > state.at {
        state.listening.position + (at - state.at) as f64 / 1000.0
    } else {
        state.listening.position
    }
}

fn play(state: &mut MusicGroup, at: i64) {
    state.listening.position = position_at(state, at);
    state.at = at;
    state.playing = true;
}

fn pause(state: &mut MusicGroup, at: i64) {
    state.listening.position = position_at(state, at);
    state.at = at;
    state.playing = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(device: &str) -> GroupMember {
        GroupMember {
            device: device.into(),
            name: device.into(),
            form: None,
        }
    }

    fn song(path: &str, position: f64) -> Listening {
        Listening {
            queue: vec![path.into(), "next.mp3".into()],
            index: 0,
            position,
            ..Listening::default()
        }
    }

    fn ask(action: &str) -> MusicGroupRequest {
        MusicGroupRequest {
            action: action.into(),
            lead_ms: 500,
            ..MusicGroupRequest::default()
        }
    }

    /// The laptop plays; the phone starts playing together with it.
    fn laptop_and_phone(groups: &mut Groups, laptop_playing: bool) -> MusicGroup {
        groups
            .ask(
                "maya",
                member("phone"),
                &ask("start"),
                Some((member("laptop"), song("a.mp3", 30.0), laptop_playing)),
                1_000,
            )
            .unwrap()
            .group
            .unwrap()
    }

    #[test]
    fn a_group_starts_from_what_the_other_plays_and_holds_both() {
        let mut groups = Groups::default();
        let group = laptop_and_phone(&mut groups, true);
        let names: Vec<&str> = group.members.iter().map(|m| m.device.as_str()).collect();
        assert_eq!(names, ["laptop", "phone"]);
        assert!(group.playing);
        assert_eq!(
            position_at(&group, 3_000),
            32.0,
            "two seconds on, two seconds in"
        );
        assert_eq!(groups.of("laptop").unwrap().id, group.id);
        assert_eq!(groups.of("phone").unwrap().id, group.id);
    }

    #[test]
    fn play_together_starts_a_paused_one_too() {
        let mut groups = Groups::default();
        let group = groups
            .ask(
                "maya",
                member("phone"),
                &MusicGroupRequest {
                    playing: Some(true),
                    ..ask("start")
                },
                Some((member("laptop"), song("a.mp3", 30.0), false)),
                1_000,
            )
            .unwrap()
            .group
            .unwrap();
        assert!(group.playing, "both play, the paused one too (F7)");
        assert_eq!(group.at, 1_500, "a moment ahead, for both to start then");
        assert_eq!(position_at(&group, 1_500), 30.0, "from where it was paused");
    }

    #[test]
    fn a_change_is_stamped_ahead_and_counted_once() {
        let mut groups = Groups::default();
        let group = laptop_and_phone(&mut groups, true);
        // The phone pauses: at 2.5 s, everyone pauses at the same second.
        let paused = groups
            .ask(
                "maya",
                member("phone"),
                &MusicGroupRequest {
                    playing: Some(false),
                    ..ask("set")
                },
                None,
                2_000,
            )
            .unwrap()
            .group
            .unwrap();
        assert!(!paused.playing);
        assert_eq!(paused.at, 2_500);
        assert_eq!(paused.listening.position, 31.5);
        assert_eq!(paused.version, group.version + 1);
        // Both songs end; both ask for the next as of the version they had:
        // the first moves it on, the second is refused.
        let next = MusicGroupRequest {
            listening: Some(Listening {
                index: 1,
                position: 0.0,
                ..song("a.mp3", 0.0)
            }),
            expect: Some(paused.version),
            ..ask("set")
        };
        let moved = groups
            .ask("maya", member("laptop"), &next, None, 5_000)
            .unwrap()
            .group
            .unwrap();
        assert_eq!(moved.listening.index, 1);
        assert!(moved.playing);
        assert!(
            groups
                .ask("maya", member("phone"), &next, None, 5_010)
                .is_err()
        );
    }

    #[test]
    fn another_device_steers_the_group_and_play_here_ends_it_for_all() {
        let mut groups = Groups::default();
        let group = laptop_and_phone(&mut groups, true);
        // The tablet, not in it, seeks the group.
        let seeked = groups
            .ask(
                "maya",
                member("tablet"),
                &MusicGroupRequest {
                    group: group.id.clone(),
                    position: Some(90.0),
                    ..ask("set")
                },
                None,
                2_000,
            )
            .unwrap()
            .group
            .unwrap();
        assert_eq!(position_at(&seeked, 2_500), 90.0);
        // Another profile can't touch it.
        assert!(
            groups
                .ask(
                    "sam",
                    member("sam-phone"),
                    &MusicGroupRequest {
                        group: group.id.clone(),
                        ..ask("end")
                    },
                    None,
                    2_000
                )
                .is_err()
        );
        // Play here on the tablet: the group ends, both told (U12).
        let ended = groups
            .ask(
                "maya",
                member("tablet"),
                &MusicGroupRequest {
                    group: group.id.clone(),
                    ..ask("end")
                },
                None,
                3_000,
            )
            .unwrap();
        assert_eq!(ended.group, None);
        assert_eq!(ended.left, ["laptop", "phone"]);
        assert!(ended.ended, "they stop, not play on alone");
        assert!(groups.of("laptop").is_none());
    }

    #[test]
    fn a_device_gone_leaves_and_one_left_alone_is_no_group() {
        let mut groups = Groups::default();
        let group = laptop_and_phone(&mut groups, true);
        // A third joins through the phone.
        let three = groups
            .ask(
                "maya",
                member("tablet"),
                &ask("start"),
                Some((member("phone"), song("a.mp3", 31.0), true)),
                2_000,
            )
            .unwrap()
            .group
            .unwrap();
        assert_eq!(three.id, group.id, "the phone's group, not a new one");
        assert_eq!(three.members.len(), 3);
        // The tablet goes off the network: the other two stay together.
        let changed = groups.keep_online(|d| d != "tablet");
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].group.as_ref().unwrap().members.len(), 2);
        assert_eq!(changed[0].left, ["tablet"]);
        // Online, nothing changes.
        assert!(groups.keep_online(|_| true).is_empty());
        // The phone leaves: the laptop alone is no group.
        let gone = groups
            .ask("maya", member("phone"), &ask("leave"), None, 4_000)
            .unwrap();
        assert_eq!(gone.group, None);
        assert_eq!(gone.left, ["phone", "laptop"]);
        assert!(groups.of("laptop").is_none());
    }
}
