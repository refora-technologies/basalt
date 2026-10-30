//! Small pictures along a film's timeline, for the player to show above the
//! seek bar while somebody drags or points along it.
//!
//! The host makes them, from the keyframes alone, which ffmpeg decodes far
//! faster than the film: one picture every [`INTERVAL`] seconds, 240 pixels
//! wide, packed a hundred to a JPEG "sheet". A device fetches a sheet when it
//! needs one and shows the right square of it, so a two-hour film is about ten
//! pictures to fetch, not seven hundred.
//!
//! They are kept in the host's own folder (never on the drive it shares, and
//! never reachable through it), keyed by the file's path, size and time, up
//! to [`BUDGET`] bytes; past that the ones made longest ago go first.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// Seconds between pictures, for anything up to [`MOST_PICTURES`] of them.
pub const INTERVAL: f64 = 10.0;
/// More than this many pictures, and the interval grows instead.
const MOST_PICTURES: f64 = 1000.0;
pub const COLUMNS: u32 = 10;
pub const ROWS: u32 = 10;
/// Each picture's width, in pixels.
const WIDTH: u32 = 240;
/// The most the pictures of all films may take on disk.
pub const BUDGET: u64 = 2 * 1024 * 1024 * 1024;

/// What a device needs to find a moment's picture.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// Seconds between pictures: picture `n` shows `n * interval`.
    pub interval: f64,
    pub columns: u32,
    pub rows: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    /// Pictures in all, and sheets they fill.
    pub count: u32,
    pub sheets: u32,
}

/// Where all films' pictures are kept: in the host's own folder.
pub fn root(config_dir: &Path) -> PathBuf {
    config_dir.join("previews")
}

/// Where one file's pictures are, as it is now.
pub fn dir_for(root: &Path, rel: &str, size: u64, mtime: i64) -> PathBuf {
    let key = blake3::hash(format!("{rel}\u{0}{size}\u{0}{mtime}").as_bytes()).to_hex();
    root.join(&key[..20])
}

/// The pictures already made for a file, if they are.
pub fn read_meta(dir: &Path) -> Option<Meta> {
    let bytes = std::fs::read(dir.join("meta.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// One sheet of pictures, as JPEG bytes.
pub fn sheet(dir: &Path, index: u32) -> Option<Vec<u8>> {
    std::fs::read(dir.join(format!("{:03}.jpg", index + 1))).ok()
}

/// Makes a file's pictures into `dir`. Blocking, and a minute or so for a
/// film on an ordinary computer; longer on a Raspberry Pi.
pub fn make(ffmpeg: &Path, video: &Path, duration: f64, dir: &Path) -> Result<Meta, String> {
    if duration <= 0.0 {
        return Err("no length known".into());
    }
    let interval = INTERVAL.max((duration / MOST_PICTURES / 5.0).ceil() * 5.0);
    let work = dir.with_extension("making");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let status = quiet(ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-skip_frame",
            "nokey",
            "-i",
        ])
        .arg(video)
        .args([
            "-an",
            "-sn",
            "-vf",
            &format!("fps=1/{interval},scale={WIDTH}:-2,tile={COLUMNS}x{ROWS}"),
            "-q:v",
            "6",
        ])
        .arg(work.join("%03d.jpg"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    let first = work.join("001.jpg");
    if !status.success() || !first.is_file() {
        let _ = std::fs::remove_dir_all(&work);
        return Err("ffmpeg made no pictures".into());
    }
    let (width, height) = image::image_dimensions(&first).map_err(|e| e.to_string())?;
    let sheets = std::fs::read_dir(&work)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jpg"))
        .count() as u32;
    let meta = Meta {
        interval,
        columns: COLUMNS,
        rows: ROWS,
        tile_width: width / COLUMNS,
        tile_height: height / ROWS,
        count: (duration / interval).ceil() as u32,
        sheets,
    };
    let json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    std::fs::write(work.join("meta.json"), json).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(dir);
    std::fs::rename(&work, dir).map_err(|e| e.to_string())?;
    Ok(meta)
}

/// The bytes all films' pictures take.
pub fn used(root: &Path) -> u64 {
    folders(root).iter().map(|(_, bytes, _)| bytes).sum()
}

/// Removes the pictures made longest ago until all of them fit `budget`.
pub fn trim(root: &Path, budget: u64) {
    let mut all = folders(root);
    let mut total: u64 = all.iter().map(|(_, bytes, _)| bytes).sum();
    all.sort_by_key(|(_, _, made)| *made);
    for (dir, bytes, _) in all {
        if total <= budget {
            break;
        }
        if std::fs::remove_dir_all(&dir).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
}

/// Each film's folder: its bytes, and when it was made.
fn folders(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir() && e.path().extension().is_none())
        .map(|e| {
            let dir = e.path();
            let bytes = std::fs::read_dir(&dir)
                .map(|files| {
                    files
                        .flatten()
                        .filter_map(|f| f.metadata().ok())
                        .map(|m| m.len())
                        .sum()
                })
                .unwrap_or(0);
            let made = std::fs::metadata(dir.join("meta.json"))
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (dir, bytes, made)
        })
        .collect()
}

/// A command that shows no console window on Windows.
fn quiet(program: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_changed_file_gets_new_pictures() {
        let root = Path::new("previews");
        assert_ne!(dir_for(root, "a.mkv", 1, 2), dir_for(root, "a.mkv", 1, 3));
        assert_eq!(dir_for(root, "a.mkv", 1, 2), dir_for(root, "a.mkv", 1, 2));
    }

    #[test]
    fn the_oldest_go_first_past_the_budget() {
        let root = std::env::temp_dir().join(format!("basalt-previews-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (name, bytes) in [("old", 600), ("new", 600)] {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("001.jpg"), vec![0u8; bytes]).unwrap();
            std::fs::write(dir.join("meta.json"), b"{}").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        trim(&root, 1000);
        assert!(!root.join("old").exists());
        assert!(root.join("new").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
