//! Statements taken back before their time.
//!
//! A member statement lasts a month. A device removed, or a profile signed out
//! of it, must stop being vouched for at once, so the host lists the serials it
//! has taken back. Each stays listed only until the statement would have
//! expired anyway: after that the date refuses it, and the list stays small.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revoked {
    pub serial: String,
    /// When the statement would have expired, unix seconds.
    pub until: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RevocationList(Vec<Revoked>);

impl RevocationList {
    pub fn new(entries: Vec<Revoked>) -> Self {
        Self(entries)
    }

    pub fn entries(&self) -> &[Revoked] {
        &self.0
    }

    /// Takes a statement back. Taking one back twice keeps one entry.
    pub fn revoke(&mut self, serial: &str, until: i64) {
        if !self.contains(serial) {
            self.0.push(Revoked {
                serial: serial.to_string(),
                until,
            });
        }
    }

    pub fn contains(&self, serial: &str) -> bool {
        self.0.iter().any(|r| r.serial == serial)
    }

    /// Lets go of entries whose statements have expired by themselves.
    /// Returns whether anything went.
    pub fn prune(&mut self, now: i64) -> bool {
        let before = self.0.len();
        self.0
            .retain(|r| r.until + crate::statement::CLOCK_SKEW > now);
        self.0.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statement::CLOCK_SKEW;

    #[test]
    fn a_revoked_serial_is_listed_once_until_it_would_have_expired() {
        let mut list = RevocationList::default();
        list.revoke("aa", 1000);
        list.revoke("aa", 1000);
        list.revoke("bb", 5000);
        assert_eq!(list.entries().len(), 2);
        assert!(list.contains("aa") && list.contains("bb"));
        assert!(!list.contains("cc"));

        assert!(!list.prune(1000 + CLOCK_SKEW - 1));
        assert!(list.contains("aa"));
        assert!(list.prune(1000 + CLOCK_SKEW));
        assert!(!list.contains("aa"));
        assert!(list.contains("bb"));
    }

    #[test]
    fn it_is_written_as_a_plain_list() {
        let mut list = RevocationList::default();
        list.revoke("aa", 7);
        let json = serde_json::to_string(&list).unwrap();
        assert_eq!(json, r#"[{"serial":"aa","until":7}]"#);
        assert_eq!(serde_json::from_str::<RevocationList>(&json).unwrap(), list);
    }
}
