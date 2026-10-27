//! The songs on the drive, as their tags describe them.
//!
//! The Music section used to be a list of file names. Each song's tags say
//! far more — its title, who it is by, the album and its place on it, the
//! year, how long it is — and most carry a cover. They are read here, on the
//! host, because the host has the files: a phone would have to fetch the start
//! of every song across the Wi-Fi to read them.
//!
//! **Read once.** Tags are kept per drive, with each file's size and
//! modification time; a song is read again only when it changes. The list of
//! songs is the collections' (see [`super::collect`]), so this never walks
//! the drive itself: it follows the walk and the watcher.
//!
//! **Nothing is sent anywhere.** Every tag and cover comes from the files and
//! their folders. Artwork from the internet is a separate, opt-in step.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use basalt_proto::msg::{MediaFile, MusicTrack};
use lofty::prelude::*;
use serde::{Deserialize, Serialize};

/// Pictures in an album's folder that are its cover, in the order they are
/// looked for. Matched without regard to case.
const FOLDER_COVERS: [&str; 6] = [
    "cover",
    "folder",
    "front",
    "album",
    "albumart",
    "albumartsmall",
];

/// The kinds of picture a folder cover may be.
const COVER_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

/// The music of one drive as kept on disk, with the revision clients poll
/// against.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stored {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub tracks: Vec<MusicTrack>,
}

impl Stored {
    pub fn load(path: &Path) -> Self {
        let mut stored: Self = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        stored.revision = super::reloaded_revision(stored.revision);
        stored
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(&tmp, path)
    }
}

/// Where a drive's music is kept: beside its collections, one file per drive.
pub fn stored_path(config_dir: &Path, vault_root: &Path) -> PathBuf {
    let key = blake3::hash(vault_root.to_string_lossy().as_bytes()).to_hex();
    config_dir.join(format!("music-{}.json", &key[..16]))
}

/// The songs `files` lists, with tags: those already read kept as they are,
/// the rest read now. `None` when nothing changed.
///
/// `resolve` turns a vault-relative path into the file on disk. Blocking:
/// call from a blocking thread.
pub fn refresh(
    stored: &Stored,
    files: &[MediaFile],
    resolve: impl Fn(&str) -> Option<PathBuf>,
) -> Option<Stored> {
    let known: HashMap<&str, &MusicTrack> =
        stored.tracks.iter().map(|t| (t.path.as_str(), t)).collect();
    let mut changed = files.len() != stored.tracks.len();
    let mut tracks = Vec::with_capacity(files.len());
    for file in files {
        match known.get(file.path.as_str()) {
            Some(track) if track.size == file.size && track.mtime == file.mtime => {
                tracks.push((*track).clone());
            }
            _ => {
                changed = true;
                let mut track = match resolve(&file.path) {
                    Some(path) => read(&path),
                    None => MusicTrack::default(),
                };
                track.path = file.path.clone();
                track.size = file.size;
                track.mtime = file.mtime;
                tracks.push(track);
            }
        }
    }
    changed.then(|| Stored {
        revision: super::next_revision(stored.revision),
        tracks,
    })
}

/// A song's tags, and whether it has a cover. A file whose tags cannot be
/// read is still a song: everything is left empty, and it is shown by name.
pub fn read(path: &Path) -> MusicTrack {
    let mut track = MusicTrack {
        cover: folder_cover(path).is_some(),
        ..MusicTrack::default()
    };
    let Ok(file) = lofty::read_from_path(path) else {
        return track;
    };
    let duration = file.properties().duration();
    if !duration.is_zero() {
        track.duration_ms = Some(duration.as_millis() as u64);
    }
    let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) else {
        return track;
    };
    let text = |value: Option<std::borrow::Cow<'_, str>>| {
        value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    track.title = text(tag.title());
    track.artist = text(tag.artist());
    track.album = text(tag.album());
    track.genre = text(tag.genre());
    track.album_artist = tag
        .get_string(&ItemKey::AlbumArtist)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    track.track = tag.track().filter(|&n| n > 0);
    track.disc = tag.disk().filter(|&n| n > 0);
    track.year = tag.year().filter(|&y| y > 0);
    track.cover |= !tag.pictures().is_empty();
    track
}

/// A song's cover: the picture in the file (the front cover if it says
/// which), else one beside it in its folder.
///
/// Blocking: call from a blocking thread.
pub fn cover(path: &Path) -> Option<image::DynamicImage> {
    embedded_cover(path)
        .and_then(|bytes| image::load_from_memory(&bytes).ok())
        .or_else(|| folder_cover(path).and_then(|p| image::open(p).ok()))
}

fn embedded_cover(path: &Path) -> Option<Vec<u8>> {
    let file = lofty::read_from_path(path).ok()?;
    let mut pictures = file.tags().iter().flat_map(|tag| tag.pictures().iter());
    let all: Vec<&lofty::picture::Picture> = pictures.by_ref().collect();
    all.iter()
        .find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront)
        .or_else(|| all.first())
        .map(|p| p.data().to_vec())
}

/// A picture of the album in the song's folder, by the names music players
/// use for one.
pub fn folder_cover(song: &Path) -> Option<PathBuf> {
    let folder = song.parent()?;
    let mut pictures: Vec<(usize, PathBuf)> = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_string_lossy().to_lowercase();
            let extension = path.extension()?.to_string_lossy().to_lowercase();
            if !COVER_EXTENSIONS.contains(&extension.as_str()) {
                return None;
            }
            let rank = FOLDER_COVERS.iter().position(|name| *name == stem)?;
            Some((rank, path))
        })
        .collect();
    pictures.sort();
    pictures.into_iter().next().map(|(_, path)| path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test, removed after it.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("basalt-music-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn file(path: &str, size: u64, mtime: i64) -> MediaFile {
        MediaFile {
            path: path.into(),
            size,
            mtime,
            width: None,
            height: None,
        }
    }

    #[test]
    fn a_song_without_tags_is_still_a_song() {
        let dir = Scratch::new("untagged");
        let song = dir.0.join("01 Opening.mp3");
        std::fs::write(&song, b"not really an mp3").unwrap();
        let track = read(&song);
        assert_eq!(track.title, None);
        assert!(!track.cover);
    }

    #[test]
    fn a_folder_cover_is_found_by_its_usual_names() {
        let dir = Scratch::new("covers");
        let song = dir.0.join("01 Opening.flac");
        std::fs::write(&song, b"").unwrap();
        assert_eq!(folder_cover(&song), None);
        std::fs::write(dir.0.join("Folder.JPG"), b"").unwrap();
        std::fs::write(dir.0.join("notes.jpg"), b"").unwrap();
        assert_eq!(folder_cover(&song), Some(dir.0.join("Folder.JPG")));
        // `cover` comes before `folder` when both are there.
        std::fs::write(dir.0.join("cover.png"), b"").unwrap();
        assert_eq!(folder_cover(&song), Some(dir.0.join("cover.png")));
        assert!(read(&song).cover);
    }

    #[test]
    fn songs_are_read_once_and_again_only_when_they_change() {
        let dir = Scratch::new("refresh");
        std::fs::write(dir.0.join("a.mp3"), b"").unwrap();
        std::fs::write(dir.0.join("b.mp3"), b"").unwrap();
        let resolve = |rel: &str| Some(dir.0.join(rel));
        let reads = std::cell::Cell::new(0);
        let counting = |rel: &str| {
            reads.set(reads.get() + 1);
            resolve(rel)
        };

        let first = refresh(
            &Stored::default(),
            &[file("a.mp3", 1, 10), file("b.mp3", 1, 10)],
            counting,
        )
        .unwrap();
        assert_eq!(first.tracks.len(), 2);
        assert_eq!(reads.get(), 2);
        assert!(first.revision > 0);

        // Nothing changed: nothing read, nothing new to send.
        reads.set(0);
        assert!(
            refresh(
                &first,
                &[file("a.mp3", 1, 10), file("b.mp3", 1, 10)],
                counting
            )
            .is_none()
        );
        assert_eq!(reads.get(), 0);

        // One changed, one went: one read, a new revision.
        let next = refresh(&first, &[file("a.mp3", 2, 11)], counting).unwrap();
        assert_eq!(reads.get(), 1);
        assert_eq!(next.tracks.len(), 1);
        assert_eq!((next.tracks[0].size, next.tracks[0].mtime), (2, 11));
        assert!(next.revision > first.revision);
    }
}
