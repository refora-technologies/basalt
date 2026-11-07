//! Files kept on the host for someone who is away: "Send through host".
//!
//! A share for a device that isn't online is held here until it comes
//! online and takes it. Kept apart from the shared drive (in the host's own
//! folder, which the drive's sharing never reaches), and locked: each file
//! with its own key, made from the host's share key, which lives in the
//! host's settings, sealed to this computer where the system can. A copy of
//! the drive, or of this folder without the settings, opens nothing. Whoever
//! sits at the host computer could read it, and that is all (decided with the
//! user, 2026-11-05).
//!
//! **The form of a file.** `BSS1`, then chunks of up to [`CHUNK`] bytes, each
//! `u32` length and the chunk sealed with ChaCha20-Poly1305. Its nonce is its
//! number; its associated data its number and whether it is the last, so a
//! chunk moved, changed or a file cut short is refused, not read. A chunk has
//! a fixed place, so any part of a file is read without the rest.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};
use ring::hkdf;
use serde::{Deserialize, Serialize};

use crate::error::{HostError, Result};

/// Plain bytes per chunk.
pub const CHUNK: usize = 1024 * 1024;
const TAG: usize = 16;
const MAGIC: &[u8; 4] = b"BSS1";
const SEALED_CHUNK: u64 = (4 + CHUNK + TAG) as u64;

/// Who a held share is from or for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub device: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldFile {
    pub name: String,
    pub size: u64,
    /// Where it is on the drive, in plain, when the host keeps shares there
    /// (secure mode off). None: locked in the store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plain: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeldState {
    /// Waiting for its device to come online and answer.
    Waiting,
    Accepted,
    Declined,
}

/// One share held for someone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub id: String,
    pub from: Party,
    /// The device it is for.
    pub to: Party,
    pub files: Vec<HeldFile>,
    /// Unix milliseconds.
    pub created: i64,
    /// Kept after it is answered, until its sender deletes it.
    pub keep: bool,
    pub state: HeldState,
}

impl Held {
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    held: Vec<Held>,
}

pub struct ShareStore {
    dir: PathBuf,
    master: [u8; 32],
    index: Mutex<Index>,
}

impl ShareStore {
    /// The store in `dir`, locked with `master`, as it was left.
    pub fn open(dir: PathBuf, master: [u8; 32]) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let index = match std::fs::read(dir.join("index.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Index::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir,
            master,
            index: Mutex::new(index),
        })
    }

    /// Locks `files` (name, and the open file to read) into the store, for
    /// `to`. On a failure part-way nothing is kept.
    pub fn hold(
        &self,
        id: &str,
        from: Party,
        to: Party,
        keep: bool,
        files: Vec<(String, std::fs::File)>,
        now: i64,
    ) -> Result<Held> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(HostError::BadRequest("that is no share id".into()));
        }
        let folder = self.dir.join(id);
        if folder.exists() {
            return Err(HostError::BadRequest("that share is already held".into()));
        }
        std::fs::create_dir_all(&folder)?;
        let mut listed = Vec::new();
        for (n, (name, mut source)) in files.into_iter().enumerate() {
            let sealed = folder.join(format!("{n}.bss"));
            match self.seal(id, n, &mut source, &sealed) {
                Ok(size) => listed.push(HeldFile {
                    name,
                    size,
                    plain: None,
                }),
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&folder);
                    return Err(e);
                }
            }
        }
        let held = Held {
            id: id.to_string(),
            from,
            to,
            files: listed,
            created: now,
            keep,
            state: HeldState::Waiting,
        };
        self.change(|index| index.held.push(held.clone()))?;
        Ok(held)
    }

    /// Keeps a share in plain on the drive (secure mode off): each file
    /// copied from its source to the place chosen for it, which must not be
    /// there yet. On a failure part-way nothing is kept.
    pub fn hold_plain(
        &self,
        id: &str,
        from: Party,
        to: Party,
        keep: bool,
        files: Vec<(String, std::fs::File, PathBuf)>,
        now: i64,
    ) -> Result<Held> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(HostError::BadRequest("that is no share id".into()));
        }
        if self.get(id).is_some() {
            return Err(HostError::BadRequest("that share is already held".into()));
        }
        let mut listed: Vec<HeldFile> = Vec::new();
        for (name, mut source, dest) in files {
            match copy_new(&mut source, &dest) {
                Ok(size) => listed.push(HeldFile {
                    name,
                    size,
                    plain: Some(dest),
                }),
                Err(e) => {
                    for made in &listed {
                        if let Some(path) = &made.plain {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                    return Err(e);
                }
            }
        }
        let held = Held {
            id: id.to_string(),
            from,
            to,
            files: listed,
            created: now,
            keep,
            state: HeldState::Waiting,
        };
        self.change(|index| index.held.push(held.clone()))?;
        Ok(held)
    }

    /// Reads `length` plain bytes of file `n` of share `id` from `offset`:
    /// fewer at its end.
    pub fn read(&self, id: &str, n: usize, offset: u64, length: usize) -> Result<Vec<u8>> {
        let file = self
            .get(id)
            .and_then(|h| h.files.get(n).cloned())
            .ok_or_else(|| HostError::NotFound("that share".into()))?;
        let size = file.size;
        if offset >= size {
            return Ok(Vec::new());
        }
        let end = size.min(offset + length as u64);
        if let Some(path) = &file.plain {
            let mut plain = std::fs::File::open(path).map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    HostError::NotFound("it is no longer in the Basalt shares folder".into())
                }
                _ => e.into(),
            })?;
            plain.seek(SeekFrom::Start(offset))?;
            let mut out = vec![0u8; (end - offset) as usize];
            let got = read_full(&mut plain, &mut out)?;
            out.truncate(got);
            return Ok(out);
        }
        let mut file = std::fs::File::open(self.dir.join(id).join(format!("{n}.bss")))?;
        let key = self.key(id, n);
        let chunks = size.div_ceil(CHUNK as u64).max(1);
        let mut out = Vec::with_capacity((end - offset) as usize);
        let mut at = offset;
        while at < end {
            let k = at / CHUNK as u64;
            file.seek(SeekFrom::Start(MAGIC.len() as u64 + k * SEALED_CHUNK))?;
            let mut len = [0u8; 4];
            file.read_exact(&mut len)?;
            let len = u32::from_le_bytes(len) as usize;
            if !(TAG..=CHUNK + TAG).contains(&len) {
                return Err(HostError::Io(std::io::Error::other(
                    "a held file is damaged",
                )));
            }
            let mut sealed = vec![0u8; len];
            file.read_exact(&mut sealed)?;
            let plain = open_chunk(&key, k, k + 1 == chunks, &mut sealed)?;
            let from = (at - k * CHUNK as u64) as usize;
            let upto = ((end - k * CHUNK as u64) as usize).min(plain.len());
            out.extend_from_slice(&plain[from..upto]);
            at = k * CHUNK as u64 + upto as u64;
        }
        Ok(out)
    }

    /// Unlocks file `n` of share `id` into `dest`, whole: moving it onto the
    /// drive. Written beside it and renamed, so nothing half-made shows.
    pub fn unlock_into(&self, id: &str, n: usize, dest: &Path) -> Result<u64> {
        let size = self
            .get(id)
            .and_then(|h| h.files.get(n).map(|f| f.size))
            .ok_or_else(|| HostError::NotFound("that share".into()))?;
        let part = dest.with_extension("basalt-part");
        let mut out = std::fs::File::create(&part)?;
        let mut at = 0u64;
        while at < size {
            let piece = self.read(id, n, at, CHUNK)?;
            if piece.is_empty() {
                break;
            }
            out.write_all(&piece)?;
            at += piece.len() as u64;
        }
        out.sync_all()?;
        drop(out);
        std::fs::rename(&part, dest)?;
        Ok(at)
    }

    pub fn get(&self, id: &str) -> Option<Held> {
        self.index
            .lock()
            .expect("store lock")
            .held
            .iter()
            .find(|h| h.id == id)
            .cloned()
    }

    /// Every share held.
    pub fn all(&self) -> Vec<Held> {
        self.index.lock().expect("store lock").held.clone()
    }

    /// What waits for `device`, oldest first.
    pub fn waiting_for(&self, device: &str) -> Vec<Held> {
        let index = self.index.lock().expect("store lock");
        let mut held: Vec<Held> = index
            .held
            .iter()
            .filter(|h| h.state == HeldState::Waiting && h.to.device == device)
            .cloned()
            .collect();
        held.sort_by_key(|h| h.created);
        held
    }

    /// What a profile (or a device on its own) sent that is still held.
    pub fn sent_by(&self, profile: Option<&str>, device: &str) -> Vec<Held> {
        let index = self.index.lock().expect("store lock");
        let mut held: Vec<Held> = index
            .held
            .iter()
            .filter(|h| match profile {
                Some(p) => h.from.profile.as_deref() == Some(p),
                None => h.from.profile.is_none() && h.from.device == device,
            })
            .cloned()
            .collect();
        held.sort_by_key(|h| std::cmp::Reverse(h.created));
        held
    }

    /// Its receiver answered: gone, unless its sender asked to keep it.
    pub fn answered(&self, id: &str, accepted: bool) -> Result<()> {
        let keep = self.get(id).map(|h| h.keep).unwrap_or(false);
        if !keep {
            return self.delete(id);
        }
        self.change(|index| {
            if let Some(h) = index.held.iter_mut().find(|h| h.id == id) {
                h.state = if accepted {
                    HeldState::Accepted
                } else {
                    HeldState::Declined
                };
            }
        })
    }

    /// Lets a share go without deleting what it kept in plain on the drive,
    /// which stays there as the drive's own: its locked files go.
    pub fn forget(&self, id: &str) -> Result<()> {
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            let _ = std::fs::remove_dir_all(self.dir.join(id));
        }
        self.change(|index| index.held.retain(|h| h.id != id))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        // A plain share's copies on the drive are its own, made for it.
        if let Some(held) = self.get(id) {
            for file in &held.files {
                if let Some(path) = &file.plain {
                    let _ = std::fs::remove_file(path);
                    // Its profile's folder, and "Basalt shares", once empty:
                    // `remove_dir` takes only an empty folder.
                    if let Some(folder) = path.parent() {
                        let _ = std::fs::remove_dir(folder);
                        if let Some(shares) = folder.parent() {
                            let _ = std::fs::remove_dir(shares);
                        }
                    }
                }
            }
        }
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            let _ = std::fs::remove_dir_all(self.dir.join(id));
        }
        self.change(|index| index.held.retain(|h| h.id != id))
    }

    /// Every share held, deleted: "Clear share files".
    pub fn clear(&self) -> Result<usize> {
        let ids: Vec<String> = self
            .index
            .lock()
            .expect("store lock")
            .held
            .iter()
            .map(|h| h.id.clone())
            .collect();
        for id in &ids {
            self.delete(id)?;
        }
        Ok(ids.len())
    }

    /// Bytes held, and per sending profile (or device on its own).
    pub fn usage(&self) -> (u64, usize, HashMap<String, u64>) {
        let index = self.index.lock().expect("store lock");
        let mut by = HashMap::new();
        let mut total = 0;
        for h in &index.held {
            let who = h
                .from
                .profile
                .clone()
                .unwrap_or_else(|| h.from.device.clone());
            *by.entry(who).or_insert(0) += h.bytes();
            total += h.bytes();
        }
        (total, index.held.len(), by)
    }

    /// Bytes locked in the store itself, not counting shares kept in plain
    /// on the drive: what the host's own folder holds.
    pub fn locked_bytes(&self) -> u64 {
        let index = self.index.lock().expect("store lock");
        index
            .held
            .iter()
            .flat_map(|h| &h.files)
            .filter(|f| f.plain.is_none())
            .map(|f| f.size)
            .sum()
    }

    /// Where the store keeps its files.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn key(&self, id: &str, n: usize) -> LessSafeKey {
        let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"basalt/share/v1");
        let prk = salt.extract(&self.master);
        let number = n.to_string();
        let info = [id.as_bytes(), b"/", number.as_bytes()];
        let okm = prk
            .expand(&info, &CHACHA20_POLY1305)
            .expect("a key's length");
        LessSafeKey::new(UnboundKey::from(okm))
    }

    fn seal(&self, id: &str, n: usize, source: &mut std::fs::File, dest: &Path) -> Result<u64> {
        let key = self.key(id, n);
        let mut out = std::io::BufWriter::new(std::fs::File::create(dest)?);
        out.write_all(MAGIC)?;
        let mut size = 0u64;
        let mut buffer = vec![0u8; CHUNK];
        let mut next = read_full(source, &mut buffer)?;
        let mut k = 0u64;
        loop {
            let current = next;
            let mut chunk = buffer[..current].to_vec();
            // Read ahead to know whether this chunk is the last.
            next = if current == CHUNK {
                read_full(source, &mut buffer)?
            } else {
                0
            };
            let last = next == 0;
            key.seal_in_place_append_tag(nonce(k), Aad::from(aad(k, last)), &mut chunk)
                .map_err(|_| HostError::Io(std::io::Error::other("a file couldn't be locked")))?;
            out.write_all(&(chunk.len() as u32).to_le_bytes())?;
            out.write_all(&chunk)?;
            size += current as u64;
            k += 1;
            if last {
                break;
            }
        }
        out.flush()?;
        out.get_ref().sync_all()?;
        Ok(size)
    }

    fn change(&self, f: impl FnOnce(&mut Index)) -> Result<()> {
        let mut index = self.index.lock().expect("store lock");
        f(&mut index);
        let bytes = serde_json::to_vec_pretty(&*index)
            .map_err(|e| HostError::Io(std::io::Error::other(e.to_string())))?;
        let part = self.dir.join("index.json.part");
        std::fs::write(&part, bytes)?;
        std::fs::rename(&part, self.dir.join("index.json"))?;
        Ok(())
    }
}

/// Copies `source` to `dest`, which must not be there yet: written beside it
/// and renamed, so nothing half-made shows.
fn copy_new(source: &mut std::fs::File, dest: &Path) -> Result<u64> {
    if dest.exists() {
        return Err(HostError::Exists(dest.display().to_string()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = dest.with_extension("basalt-part");
    let copied = (|| -> Result<u64> {
        let mut out = std::fs::File::create(&part)?;
        let size = std::io::copy(source, &mut out)?;
        out.sync_all()?;
        Ok(size)
    })();
    match copied {
        Ok(size) => {
            std::fs::rename(&part, dest)?;
            Ok(size)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn read_full(source: &mut impl Read, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let n = source.read(&mut buffer[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

fn nonce(k: u64) -> Nonce {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&k.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

fn aad(k: u64, last: bool) -> [u8; 9] {
    let mut bytes = [0u8; 9];
    bytes[..8].copy_from_slice(&k.to_be_bytes());
    bytes[8] = u8::from(last);
    bytes
}

fn open_chunk(key: &LessSafeKey, k: u64, last: bool, sealed: &mut [u8]) -> Result<Vec<u8>> {
    key.open_in_place(nonce(k), Aad::from(aad(k, last)), sealed)
        .map(|plain| plain.to_vec())
        .map_err(|_| {
            HostError::Io(std::io::Error::other(
                "a held file is damaged or not this host's",
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("basalt-shares-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn party(device: &str, profile: Option<&str>) -> Party {
        Party {
            device: device.into(),
            name: device.into(),
            profile: profile.map(str::to_string),
        }
    }

    fn source(dir: &Path, name: &str, bytes: &[u8]) -> std::fs::File {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        std::fs::File::open(path).unwrap()
    }

    fn sample(size: usize) -> Vec<u8> {
        (0..size).map(|i| (i * 7 % 251) as u8).collect()
    }

    #[test]
    fn a_held_file_reads_back_whole_and_in_any_part() {
        let dir = temp("whole");
        let store = ShareStore::open(dir.join("store"), [7; 32]).unwrap();
        let body = sample(CHUNK * 2 + 12_345);
        let held = store
            .hold(
                "s1",
                party("phone", Some("maya")),
                party("laptop", Some("maya")),
                false,
                vec![("film.mkv".into(), source(&dir, "film.mkv", &body))],
                1,
            )
            .unwrap();
        assert_eq!(held.files[0].size, body.len() as u64);
        assert_eq!(store.read("s1", 0, 0, body.len()).unwrap(), body);
        // Across a chunk's edge, and past the end.
        let at = CHUNK as u64 - 10;
        assert_eq!(
            store.read("s1", 0, at, 30).unwrap(),
            body[at as usize..at as usize + 30]
        );
        assert_eq!(
            store.read("s1", 0, body.len() as u64 - 5, 100).unwrap(),
            body[body.len() - 5..]
        );
        assert!(
            store
                .read("s1", 0, body.len() as u64, 10)
                .unwrap()
                .is_empty()
        );
        // Nothing of it readable as it lies on the disk.
        let raw = std::fs::read(dir.join("store").join("s1").join("0.bss")).unwrap();
        assert!(!raw.windows(64).any(|w| w == &body[1000..1064]), "locked");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_empty_file_is_held_too() {
        let dir = temp("empty");
        let store = ShareStore::open(dir.join("store"), [7; 32]).unwrap();
        store
            .hold(
                "s2",
                party("a", None),
                party("b", None),
                false,
                vec![("empty.txt".into(), source(&dir, "e", b""))],
                1,
            )
            .unwrap();
        assert!(store.read("s2", 0, 0, 10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn another_host_key_or_a_changed_byte_reads_nothing() {
        let dir = temp("tamper");
        let store = ShareStore::open(dir.join("store"), [7; 32]).unwrap();
        let body = sample(5000);
        store
            .hold(
                "s3",
                party("a", None),
                party("b", None),
                false,
                vec![("x".into(), source(&dir, "x", &body))],
                1,
            )
            .unwrap();
        let other = ShareStore::open(dir.join("store"), [8; 32]).unwrap();
        assert!(other.read("s3", 0, 0, 100).is_err(), "another host's key");
        let path = dir.join("store").join("s3").join("0.bss");
        let mut raw = std::fs::read(&path).unwrap();
        raw[20] ^= 1;
        std::fs::write(&path, raw).unwrap();
        assert!(store.read("s3", 0, 0, 100).is_err(), "a changed byte");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn with_secure_mode_off_a_share_is_kept_in_plain_and_goes_with_it() {
        let dir = temp("plain");
        let store = ShareStore::open(dir.join("store"), [7; 32]).unwrap();
        let body = sample(CHUNK + 33);
        let on_drive = dir
            .join("drive")
            .join("Basalt shares")
            .join("Maya")
            .join("a.bin");
        let held = store
            .hold_plain(
                "p1",
                party("a", Some("maya")),
                party("b", None),
                false,
                vec![("a.bin".into(), source(&dir, "a", &body), on_drive.clone())],
                1,
            )
            .unwrap();
        assert_eq!(held.bytes(), body.len() as u64);
        assert_eq!(
            std::fs::read(&on_drive).unwrap(),
            body,
            "plain, where it was put"
        );
        assert_eq!(store.read("p1", 0, 10, 20).unwrap(), body[10..30]);
        assert_eq!(store.usage().0, body.len() as u64);
        assert_eq!(store.locked_bytes(), 0, "nothing in the store's own folder");
        // Never over a file already there.
        let again = store.hold_plain(
            "p2",
            party("a", Some("maya")),
            party("b", None),
            false,
            vec![("a.bin".into(), source(&dir, "a2", b"x"), on_drive.clone())],
            2,
        );
        assert!(again.is_err());
        assert_eq!(std::fs::read(&on_drive).unwrap(), body, "left as it was");
        store.answered("p1", true).unwrap();
        assert!(!on_drive.exists(), "its copy goes with it");
        assert!(
            !dir.join("drive").join("Basalt shares").exists(),
            "and the folders made for it, once empty"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn answered_shares_go_unless_kept_and_the_index_survives_a_restart() {
        let dir = temp("answer");
        let at = dir.join("store");
        let store = ShareStore::open(at.clone(), [7; 32]).unwrap();
        store
            .hold(
                "gone",
                party("phone", Some("maya")),
                party("tv", None),
                false,
                vec![("a".into(), source(&dir, "a", b"1"))],
                1,
            )
            .unwrap();
        store
            .hold(
                "kept",
                party("phone", Some("maya")),
                party("tablet", None),
                true,
                vec![("b".into(), source(&dir, "b", b"22"))],
                2,
            )
            .unwrap();
        assert_eq!(store.waiting_for("tablet").len(), 1);
        store.answered("gone", true).unwrap();
        store.answered("kept", false).unwrap();
        assert!(store.get("gone").is_none() && !at.join("gone").exists());
        assert_eq!(store.get("kept").unwrap().state, HeldState::Declined);
        assert!(
            store.waiting_for("tablet").is_empty(),
            "answered: no longer waiting"
        );

        let again = ShareStore::open(at.clone(), [7; 32]).unwrap();
        assert_eq!(again.sent_by(Some("maya"), "phone").len(), 1);
        assert_eq!(again.read("kept", 0, 0, 10).unwrap(), b"22");
        let (bytes, count, by) = again.usage();
        assert_eq!((bytes, count, by.get("maya").copied()), (2, 1, Some(2)));

        let dest = dir.join("onto-drive.txt");
        assert_eq!(again.unlock_into("kept", 0, &dest).unwrap(), 2);
        assert_eq!(std::fs::read(dest).unwrap(), b"22");
        assert_eq!(again.clear().unwrap(), 1);
        assert_eq!(again.usage().1, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_share_id_is_never_a_path() {
        let dir = temp("ids");
        let store = ShareStore::open(dir.join("store"), [7; 32]).unwrap();
        assert!(
            store
                .hold("../x", party("a", None), party("b", None), false, vec![], 1)
                .is_err()
        );
        assert!(
            store
                .hold("", party("a", None), party("b", None), false, vec![], 1)
                .is_err()
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
