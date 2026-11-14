//! Where a shared file goes inside a shared folder (1.6.4).
//!
//! A folder is shared as its files, each with the folder it sat in, relative
//! to the folder chosen: `Holiday`, `Holiday/Day 1`. The receiving device
//! makes those folders under its own received folder. The path comes from
//! another device, so every device that touches it makes it safe the same
//! way first: what can't be made safe is dropped, and the file lands beside
//! the others rather than anywhere it shouldn't.

/// Folders inside folders, at most: deeper than this, the file lands at the top.
pub const MOST_FOLDER_DEPTH: usize = 16;
/// The longest a folder path may be, in characters.
pub const MOST_FOLDER_CHARS: usize = 400;
/// The longest one folder's name may be, in characters.
const MOST_NAME_CHARS: usize = 120;
/// The most files one share may hold.
pub const MOST_SHARE_FILES: usize = 1000;

/// `raw` made safe to create under a received folder on any system: its
/// folders joined by `/`, each without characters Windows refuses, without
/// trailing dots or spaces, and not a name Windows keeps for itself. Empty
/// when there is none, or when it can't be made safe: `..` anywhere, or too
/// deep or long.
pub fn clean_folder(raw: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in raw.split(['/', '\\']) {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return String::new();
        }
        let cleaned: String = part
            .chars()
            .map(|c| {
                if c.is_control() || "<>:\"|?*".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .take(MOST_NAME_CHARS)
            .collect();
        let cleaned = cleaned.trim_end_matches(['.', ' ']).trim_start();
        if cleaned.is_empty() {
            continue;
        }
        parts.push(if reserved(cleaned) {
            format!("_{cleaned}")
        } else {
            cleaned.to_string()
        });
    }
    if parts.len() > MOST_FOLDER_DEPTH {
        return String::new();
    }
    let joined = parts.join("/");
    if joined.chars().count() > MOST_FOLDER_CHARS {
        return String::new();
    }
    joined
}

/// The folder's own parts, made safe: what to create, in order.
pub fn folder_parts(raw: &str) -> Vec<String> {
    let clean = clean_folder(raw);
    if clean.is_empty() {
        Vec::new()
    } else {
        clean.split('/').map(str::to_string).collect()
    }
}

/// A name Windows keeps for its devices, whatever comes after its dot.
fn reserved(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_path_is_kept_as_it_was() {
        assert_eq!(clean_folder("Holiday"), "Holiday");
        assert_eq!(clean_folder("Holiday/Day 1"), "Holiday/Day 1");
        assert_eq!(clean_folder("Holiday\\Day 1\\"), "Holiday/Day 1");
        assert_eq!(clean_folder(""), "");
        assert_eq!(folder_parts("Holiday/Day 1"), vec!["Holiday", "Day 1"]);
        assert!(folder_parts("").is_empty());
    }

    #[test]
    fn a_folder_path_can_never_climb_out_or_be_absolute() {
        assert_eq!(clean_folder("../Startup"), "");
        assert_eq!(clean_folder("Holiday/../../Startup"), "");
        assert_eq!(clean_folder("/etc/cron.d"), "etc/cron.d");
        assert_eq!(clean_folder("C:\\Windows\\System32"), "C_/Windows/System32");
        assert_eq!(clean_folder("./Holiday/./Day 1"), "Holiday/Day 1");
    }

    #[test]
    fn names_windows_refuses_are_made_safe() {
        assert_eq!(clean_folder("What? Now*"), "What_ Now_");
        assert_eq!(clean_folder("Notes. /Drafts "), "Notes/Drafts");
        assert_eq!(clean_folder("CON/aux.old/Console"), "_CON/_aux.old/Console");
        assert_eq!(clean_folder("a\u{7}b"), "a_b");
    }

    #[test]
    fn too_deep_or_too_long_lands_at_the_top() {
        let deep = vec!["d"; MOST_FOLDER_DEPTH + 1].join("/");
        assert_eq!(clean_folder(&deep), "");
        let fine = vec!["d"; MOST_FOLDER_DEPTH].join("/");
        assert_eq!(clean_folder(&fine), fine);
        let long = vec!["x".repeat(100); 5].join("/");
        assert_eq!(clean_folder(&long), "");
        assert_eq!(clean_folder(&"y".repeat(500)).chars().count(), 120);
    }
}
