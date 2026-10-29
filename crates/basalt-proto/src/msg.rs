//! Control-message bodies.
//!
//! Control messages are JSON. They are small, infrequent, and being able to
//! read one in a log is worth more than the bytes a binary encoding would save
//! — the things that have to be fast (file bodies, batch streams, upload
//! chunks) never travel as JSON.
//!
//! Byte strings are carried as lowercase hex rather than base64, because they
//! turn up in logs and in the pairing UI and hex is unambiguous to read aloud.

use serde::{Deserialize, Serialize};

use crate::hex;
use crate::{ProtoError, Result};

/// Defaulting an absent boolean to true, for fields where the safe reading
/// of silence is "yes".
fn default_true() -> bool {
    true
}

/// Bumped on any breaking change to these bodies or to the op table.
///
/// 2 — pairing became a *request* the host displays, rather than a window the
/// host opens in advance, and the PIN became optional.
pub const PROTOCOL_VERSION: u16 = 3;

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloRequest {
    pub protocol: u16,
    /// Human name for the connecting machine, shown on the host's device list.
    ///
    /// Sent on every connection, so a renamed machine is shown under its new
    /// name the next time it connects.
    pub device_name: String,
    /// A random id the device made for itself once and keeps.
    ///
    /// What lets the host recognise a device that pairs again as the same
    /// device, rather than adding it to the list a second time — and what a
    /// per-device watch history is kept under. Empty from a client older than
    /// this field.
    #[serde(default)]
    pub device_id: String,
    /// What kind of device it is, for its picture in the host's device lists.
    /// Absent from a client older than this field, whose kind the lists
    /// guess from its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<DeviceForm>,
}

/// What kind of device a device is, as it says: shown, never relied on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceForm {
    Phone,
    Tablet,
    Tv,
    Computer,
    /// A kind added after this was written: read rather than refused, so a
    /// newer device can still sign in to an older host.
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloResponse {
    pub protocol: u16,
    /// What the user called this vault.
    pub vault: String,
    /// Hex SPKI SHA-256 of the host's certificate — its permanent identity.
    pub host_id: String,
    /// Whether the host is currently accepting new pairings.
    pub pairing_open: bool,
    pub host_name: String,
    /// Whether devices may sign in with a key instead of a token: see
    /// [`AuthRequest::key`]. Absent from a host from before keys.
    #[serde(default)]
    pub keys: bool,
    /// Whether this host can be managed from a device: see
    /// [`ManageRequest`]. Absent from a host from before that.
    #[serde(default)]
    pub manage: bool,
    /// Whether the host shares a drive yet. A host set up from a device has
    /// none until its manager chooses one. Absent from older hosts, which
    /// only ever answered with one.
    #[serde(default = "default_true")]
    pub has_vault: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairBeginRequest {
    /// 32 random bytes, hex.
    pub client_nonce: String,
    /// Shown on the host beside the PIN, so the person reading it can see
    /// which machine is asking.
    #[serde(default)]
    pub device_name: String,
    /// See [`HelloRequest::device_id`].
    #[serde(default)]
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairBeginResponse {
    /// 32 random bytes, hex.
    pub server_nonce: String,
    /// Identifies this attempt. The host has generated a PIN against it and is
    /// displaying both.
    pub request: String,
    /// Whether the host will check a PIN. When false the client may finish
    /// without one — the host has been set to let anyone on the network in.
    #[serde(default = "default_true")]
    pub requires_pin: bool,
    /// The host has no screen and nobody managing it yet: what it checks is
    /// its setup code, read on the machine itself, and the device that pairs
    /// with it becomes the host's first manager. Absent from older hosts.
    #[serde(default)]
    pub setup: bool,
    /// The host takes the PIN, or setup code, by SPAKE2: [`PairPakeRequest`]
    /// before `PairFinish`. Absent from older hosts, which take only the
    /// HMAC proof.
    #[serde(default)]
    pub pake: bool,
}

/// The device's SPAKE2 message for a pairing begun, made with the PIN as
/// typed. Answered with the host's; the proof in [`PairFinishRequest`] then
/// shows the device ended up with the same key. A wrong PIN means another
/// one of these, with the PIN typed again. See `basalt_net::pake`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairPakeRequest {
    /// The id from [`PairBeginResponse`].
    pub request: String,
    /// Hex.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairPakeResponse {
    /// The host's SPAKE2 message, hex.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairFinishRequest {
    /// The id from [`PairBeginResponse`].
    pub request: String,
    /// `HMAC-SHA256(pin, spki_hash ‖ client_nonce ‖ server_nonce)`, hex.
    /// Absent when the host said no PIN was required.
    #[serde(default)]
    pub proof: Option<String>,
    /// Ignored by current hosts, which record the name the device gave when
    /// it asked — the one shown beside the PIN. Clients once sent the *host's*
    /// name here, and every device was listed under it.
    #[serde(default)]
    pub device_name: String,
    /// The device's public key, when it pairs with one: SubjectPublicKeyInfo,
    /// hex. The host then issues no token, and the device signs in with the
    /// key from the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The key's signature of the pairing message, bound to this connection:
    /// proof the device holds the key it names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_signature: Option<String>,
    /// Where the device says it keeps the key: see [`KeyKind`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_kind: Option<KeyKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairFinishResponse {
    /// 32 random bytes, hex, which the device presents from then on. Empty
    /// when the device paired with a key.
    #[serde(default)]
    pub token: String,
    pub vault: String,
    /// The device manages the host from now on: it set up a host with no
    /// screen, with its setup code. Absent from older hosts.
    #[serde(default)]
    pub manages: bool,
    /// After pairing by SPAKE2, the host's proof that it has the same key,
    /// and so knew the PIN the device was shown. The device keeps the
    /// pairing only if it checks. Empty otherwise.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub confirm: String,
    /// See [`AuthResponse::addresses`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addresses: Vec<String>,
    /// See [`AuthResponse::machine`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub machine: String,
}

/// Where a device keeps its key, as it reports it. Shown on the host; nothing
/// is decided by it, since a device could say anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    /// A security chip: a computer's TPM, a phone's hardware key store.
    Chip,
    /// Sealed by the operating system for the person signed in.
    System,
    /// A file only the app reads.
    File,
}

/// Signs a connection in: with a token, or with a key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthRequest {
    /// The device token. Empty when signing in with a key.
    #[serde(default)]
    pub token: String,
    /// The device's public key, SubjectPublicKeyInfo hex. Only to a host that
    /// said [`HelloResponse::keys`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The signature of the sign-in message bound to this connection: by the
    /// key itself, or by the key `session` names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// The key's statement that a key in the device's memory signs in for it
    /// for a few hours: see `basalt_trust::statement`. When present, the
    /// signature is that key's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SignedStatement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub vault: String,
    pub device_name: String,
    /// Whether this device may write. Read-only devices are a host-side
    /// setting; the client uses this to grey out the actions rather than
    /// letting them fail at the end of a long upload.
    pub writable: bool,
    /// The host no longer accepts this device's token: it signs in with its
    /// key now, and may forget the token.
    #[serde(default)]
    pub retire_token: bool,
    /// The household's statement that this device is one of its own, when a
    /// new one is due. See `basalt_trust::statement`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<SignedStatement>,
    /// Whether the host's owner has made this device an owner.
    #[serde(default)]
    pub owner: bool,
    /// For an owner's device, an endorsement of the host's key to sign and
    /// return with [`EndorseRequest`], when one is due: the payload, hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endorse: Option<String>,
    /// Every address the host has, `ip:port`, for the device to try when
    /// the one it used stops working: after the router hands out a new one,
    /// say, on a network where searching is blocked. Only ever a hint, as the
    /// host is still known by its key. Empty from older hosts, and from one
    /// in a container, whose own addresses no device can reach.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addresses: Vec<String>,
    /// The computer's name, for finding it by name when none of its
    /// addresses answer. Empty when, as for `addresses`, there is none worth
    /// trying.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub machine: String,
}

/// A statement as it travels: the payload's bytes and the issuer's
/// signature, both hex. Read with `basalt_trust::statement`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedStatement {
    pub payload: String,
    pub signature: String,
}

/// A device paired with a token giving the host a key to use instead. Sent
/// on a connection already signed in with the token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrolRequest {
    /// SubjectPublicKeyInfo, hex.
    pub key: String,
    /// The key's signature of the enrolment message bound to this connection.
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_kind: Option<KeyKind>,
}

/// An owner's device returning the endorsement it was offered, signed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndorseRequest {
    pub statement: SignedStatement,
}

// ---------------------------------------------------------------------------
// Managing the host from a device
// ---------------------------------------------------------------------------

/// Something a device that manages the host asks it to do, as its own window
/// would. Only a device signed in with its own key, and marked as managing
/// the host, is answered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManageRequest {
    pub action: ManageAction,
}

/// What the host's window can do, and so a device that manages it: the same
/// things, by the same names, minus what belongs at that computer (starting
/// at login, opening a folder there, installing an update).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "do", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ManageAction {
    /// Nothing: only the host as it is.
    View,
    RenameDevice {
        id: String,
        name: String,
    },
    SetWritable {
        id: String,
        writable: bool,
    },
    /// Lets a device manage the host, or stops it.
    SetManages {
        id: String,
        manages: bool,
    },
    RemoveDevice {
        id: String,
    },
    DenyPairing {
        id: String,
    },
    SetRequirePin {
        require: bool,
    },
    SetHostName {
        name: String,
    },
    SetLibrary {
        enabled: bool,
    },
    Rescan,
    SetPosters {
        enabled: bool,
    },
    /// Timeline pictures on or off.
    SetPreviews {
        enabled: bool,
    },
    /// When timeline pictures are made. From 1.6.3.
    SetPreviewsWhen {
        when: PreviewsWhen,
    },
    /// Timeline pictures for every film and episode that has none, made now,
    /// one after another. From 1.6.3.
    MakeMissingPreviews,
    /// Album covers from the internet on or off.
    SetMusicCovers {
        enabled: bool,
    },
    SetTmdbKey {
        key: String,
    },
    /// A fanart.tv key of the owner's own, for artist photos; empty removes
    /// it. From 1.6.3.
    SetFanartKey {
        key: String,
    },
    /// An artist's photo taken down, as of somebody else of the same name;
    /// none is looked for again. From 1.6.3.
    RemoveArtistPhoto {
        name: String,
    },
    SetConversion {
        enabled: bool,
    },
    SetConversionAtOnce {
        at_once: Option<u32>,
    },
    MeasureConversion,
    SetSections {
        sections: Sections,
    },
    AddProfile {
        name: String,
        color: u8,
    },
    RemoveProfile {
        id: String,
    },
    ResetProfilePin {
        id: String,
    },
    SetRequireProfile {
        require: bool,
    },
    SetOwnerAddsProfiles {
        owner_only: bool,
    },
    /// Whether a profile with no PIN yet needs its code to be claimed.
    SetClaimCode {
        required: bool,
    },
    /// A new code for a profile with no PIN yet, in place of the last.
    NewClaimCode {
        id: String,
    },
    /// The drives the host's computer could share, in the answer.
    ListDrives,
    ChooseDrive {
        path: String,
        name: String,
    },
    /// What devices call the drive being shared; nothing on it changes.
    RenameDrive {
        name: String,
    },
    /// The folders at `path` on the host's computer, in the answer, to choose
    /// one to share. Empty starts at the top.
    ListFolders {
        path: String,
    },
    /// Looks for a new version of the host now.
    CheckForUpdate,
    /// Puts the newest official release in now. Never a chosen version: see
    /// `basalt_host::updates`.
    InstallUpdate,
    /// Whether the host updates itself when nothing is being watched.
    SetAutomaticUpdates {
        enabled: bool,
    },
    /// Lets a profile from another drive in: see [`ProfileLinkRequest`].
    ApproveProfileLink {
        id: String,
    },
    /// Turns one away.
    DenyProfileLink {
        id: String,
    },
}

impl ManageAction {
    /// What was asked, for the host's log: never a value that should not be
    /// written down, such as a TMDb key.
    pub fn describe(&self) -> String {
        match self {
            ManageAction::SetTmdbKey { key } if key.is_empty() => "removed the TMDb key".into(),
            ManageAction::SetTmdbKey { .. } => "set a TMDb key".into(),
            ManageAction::SetFanartKey { key } if key.is_empty() => {
                "removed the fanart.tv key".into()
            }
            ManageAction::SetFanartKey { .. } => "set a fanart.tv key".into(),
            other => format!("{other:?}"),
        }
    }
}

/// The host as its window shows it, after the action: the window's own views,
/// as JSON, for the device to show in the same screens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManageResponse {
    pub view: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    /// Zero for directories: computing a directory's recursive size means
    /// walking it, which is not something a listing can afford.
    pub size: u64,
    /// Unix seconds. Negative for files dated before 1970, which do exist.
    pub mtime: i64,
    /// Windows' read-only attribute. Surfaced so the client can explain why a
    /// delete will fail before attempting it.
    #[serde(default)]
    pub readonly: bool,
    /// Windows' hidden or system attribute: `desktop.ini`, `Thumbs.db`, the
    /// Recycle Bin. Lists leave these out unless asked, as Explorer does, and
    /// the library never looks inside them. Left out of the message when
    /// false, and read as false from a host too old to send it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListRequest {
    /// Relative to the vault root. Empty means the root itself.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListResponse {
    pub entries: Vec<DirEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatResponse {
    pub entry: DirEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceResponse {
    pub free: u64,
    pub total: u64,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadRequest {
    pub path: String,
    pub offset: u64,
    /// Bytes wanted. The host may return fewer at the end of the file; it
    /// never returns more.
    pub length: u64,
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteBeginRequest {
    pub path: String,
    pub size: u64,
    /// Refuse rather than replace when the destination exists.
    #[serde(default)]
    pub overwrite: bool,
    /// Resume an upload from a previous session. The host answers with how
    /// many bytes it already holds.
    #[serde(default)]
    pub resume: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteBeginResponse {
    pub upload: String,
    /// Where to start sending. Non-zero when resuming.
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteCommitRequest {
    pub upload: String,
    /// BLAKE3 of the whole file, hex. The host recomputes it over what it
    /// actually received and refuses the commit on a mismatch, so a silently
    /// corrupted upload cannot replace a good file.
    pub blake3: String,
    pub mtime: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteAbortRequest {
    pub upload: String,
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkdirRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveRequest {
    pub path: String,
    /// Required for a non-empty directory, so a mis-click cannot erase a tree.
    #[serde(default)]
    pub recursive: bool,
}

// ---------------------------------------------------------------------------
// Upload chunks — binary, not JSON
// ---------------------------------------------------------------------------

/// Bytes of upload identifier at the head of a [`crate::ops::Op::WriteChunk`]
/// payload.
pub const UPLOAD_ID_BYTES: usize = 16;

/// Fixed-size prefix on a chunk: the upload id followed by the offset.
pub const CHUNK_HEADER_BYTES: usize = UPLOAD_ID_BYTES + 8;

/// Builds a `WriteChunk` payload.
///
/// This one message is binary rather than JSON because it is the only control
/// op that carries bulk data. Hex-encoding a 4 MiB chunk into a JSON string
/// would inflate it by a third and cost a copy in each direction, on the
/// machine measured at 260 MB/s of zstd — throwing that away on encoding would
/// be indefensible.
pub fn encode_chunk(upload: &[u8; UPLOAD_ID_BYTES], offset: u64, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CHUNK_HEADER_BYTES + data.len());
    out.extend_from_slice(upload);
    out.extend_from_slice(&offset.to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// Splits a `WriteChunk` payload back into its parts.
pub fn decode_chunk(payload: &[u8]) -> Result<([u8; UPLOAD_ID_BYTES], u64, &[u8])> {
    if payload.len() < CHUNK_HEADER_BYTES {
        return Err(ProtoError::Malformed(format!(
            "chunk payload is {} bytes, needs at least {CHUNK_HEADER_BYTES}",
            payload.len()
        )));
    }
    let mut upload = [0u8; UPLOAD_ID_BYTES];
    upload.copy_from_slice(&payload[..UPLOAD_ID_BYTES]);
    let offset = u64::from_le_bytes(
        payload[UPLOAD_ID_BYTES..CHUNK_HEADER_BYTES]
            .try_into()
            .expect("slice is 8 bytes"),
    );
    Ok((upload, offset, &payload[CHUNK_HEADER_BYTES..]))
}

/// Parses a hex upload id back into bytes.
pub fn parse_upload_id(s: &str) -> Result<[u8; UPLOAD_ID_BYTES]> {
    let bytes = hex::decode(s)?;
    if bytes.len() != UPLOAD_ID_BYTES {
        return Err(ProtoError::Malformed(format!(
            "upload id is {} bytes, expected {UPLOAD_ID_BYTES}",
            bytes.len()
        )));
    }
    let mut out = [0u8; UPLOAD_ID_BYTES];
    out.copy_from_slice(&bytes);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/// What happened to something on the drive.
///
/// Reported by watching the filesystem rather than by the host announcing its
/// own operations, and that is the important part: the drive is the truth. A
/// file deleted in Explorer, by another program, or by a second client all
/// arrive here identically, so no client can be looking at a listing the disk
/// has stopped agreeing with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    /// Something appeared. `path` is vault-relative.
    Created { path: String },
    /// Something is gone.
    Removed { path: String },
    /// Contents changed; the entry is still there.
    Modified { path: String },
    /// Moved or renamed within the vault.
    Renamed { from: String, to: String },
    /// Too many changes at once to report individually — reload everything.
    ///
    /// The watcher's buffer can overflow when something unpacks ten thousand
    /// files. Saying so plainly is far better than silently dropping events and
    /// leaving every client subtly wrong.
    Resynchronise,
    /// The media index finished changing.
    LibraryChanged,
    /// The profiles, or the owner's rules about them, changed on the host:
    /// ask again who may use this device and as whom. Only sent to a watch
    /// that asked for it.
    ProfilesChanged,
    /// What the profile's devices are playing changed: ask again with
    /// [`crate::ops::Op::MusicNow`]. Only sent to a watch that asked for it,
    /// signed in to that profile.
    MusicNow,
}

impl Change {
    /// The directory a client would need to refresh, if any.
    ///
    /// A client only cares about a change if it is looking at the folder the
    /// change happened in — this is what lets it ignore the rest cheaply.
    pub fn parent_dirs(&self) -> Vec<String> {
        fn parent(path: &str) -> String {
            match path.rfind('/') {
                Some(cut) => path[..cut].to_string(),
                None => String::new(),
            }
        }
        match self {
            Change::Created { path } | Change::Removed { path } | Change::Modified { path } => {
                vec![parent(path)]
            }
            Change::Renamed { from, to } => {
                let (a, b) = (parent(from), parent(to));
                if a == b { vec![a] } else { vec![a, b] }
            }
            Change::Resynchronise
            | Change::LibraryChanged
            | Change::ProfilesChanged
            | Change::MusicNow => Vec::new(),
        }
    }
}

/// Sent once to open a watch.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WatchRequest {
    /// Also tell this device when the profiles or the owner's rules about
    /// them change, as [`Change::ProfilesChanged`]. Asked for rather than
    /// always sent, because a device from before it would not understand it.
    #[serde(default)]
    pub profiles: bool,
    /// Also tell this device when what its profile's other devices are
    /// playing changes, as [`Change::MusicNow`].
    #[serde(default)]
    pub music: bool,
}

/// One streamed frame on a watch connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchEvent {
    pub change: Change,
}

// ---------------------------------------------------------------------------
// The media library
// ---------------------------------------------------------------------------

/// Asked for the whole index at once.
///
/// One request rather than paged: a personal library is thousands of items, not
/// millions, and the whole thing is a few hundred kilobytes of JSON. Paging
/// would cost a round trip per screen on a link where a round trip is 2.3 ms
/// and buy nothing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibraryRequest {
    /// Return nothing when the host's copy still matches this. Cheap polling.
    #[serde(default)]
    pub known_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResponse {
    /// Bumped on every reindex, so a client can tell nothing changed.
    pub revision: u64,
    /// False when the library is switched off on the host.
    pub enabled: bool,
    /// True while a scan is running.
    pub scanning: bool,
    /// Absent when `known_revision` already matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<LibraryItem>>,
    /// Which sections the host's owner wants devices to show.
    ///
    /// All of them from a host older than the setting.
    #[serde(default)]
    pub sections: Sections,
}

/// The library sections a device shows in its sidebar.
///
/// A presentation choice, not access control: every file is still under
/// Files. It exists so a household that keeps no music does not look at an
/// empty Music section on every device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sections {
    pub movies: bool,
    pub series: bool,
    pub videos: bool,
    pub music: bool,
    pub photos: bool,
}

impl Default for Sections {
    fn default() -> Self {
        Self {
            movies: true,
            series: true,
            videos: true,
            music: true,
            photos: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionsRequest {
    /// Return nothing when the host's copy still matches this.
    #[serde(default)]
    pub known_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionsResponse {
    /// Bumped whenever any collection changes.
    pub revision: u64,
    /// True while the host is walking the drive.
    pub scanning: bool,
    /// Absent when `known_revision` already matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collections: Option<Collections>,
}

/// Media on the drive, sorted into what it is, newest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Collections {
    pub videos: Vec<MediaFile>,
    pub music: Vec<MediaFile>,
    pub photos: Vec<MediaFile>,
    /// The most recently changed files of any kind, for Recent.
    pub recent: Vec<MediaFile>,
    /// True when a collection was cut short at its cap.
    pub truncated: bool,
}

/// One file in a collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    /// Vault-relative.
    pub path: String,
    pub size: u64,
    /// Unix seconds.
    pub mtime: i64,
    /// Pixels, as the photo is meant to be seen — already turned for its
    /// camera orientation. Photos only, and only when the header was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

/// Asks for the songs on the drive with their tags.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicRequest {
    /// Return no songs when the host's copy still matches this.
    #[serde(default)]
    pub known_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicResponse {
    /// Bumped whenever a song or its tags change.
    pub revision: u64,
    /// True while the host is still reading the tags of songs it found.
    pub reading: bool,
    /// Absent when `known_revision` already matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<MusicTrack>>,
    /// The artists the host has a photo of, sent with the songs. From 1.6.3.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artists: Vec<ArtistPhoto>,
}

/// An artist with a photo: asked for as a thumbnail with
/// [`ThumbnailRequest::artist`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArtistPhoto {
    pub name: String,
    /// Who took it and its licence, to show with it, when it asks for that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit: Option<String>,
}

/// One song, as its tags describe it. Every tag may be missing: a file with
/// none is still a song, shown by its file name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicTrack {
    /// Vault-relative.
    pub path: String,
    pub size: u64,
    /// Unix seconds.
    pub mtime: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// Who the album is by, which groups a compilation into one album.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// A cover to ask for with a thumbnail of this file: in the file, or a
    /// picture beside it in its folder.
    pub cover: bool,
}

/// A profile's own music: its playlists and where it was listening. Kept on
/// the host so they are the same on every device; a device used without a
/// profile keeps its own, as it does its stars.
///
/// Each part present in a request replaces the host's copy; absent, it is
/// only read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicMineRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playlists: Option<Vec<Playlist>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listening: Option<Listening>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicMine {
    pub playlists: Vec<Playlist>,
    /// Absent until something has been played.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listening: Option<Listening>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Playlist {
    /// Made by the device that made the playlist; never reused.
    pub id: String,
    pub name: String,
    /// The songs, vault-relative, in the order they play.
    pub songs: Vec<String>,
    /// Unix seconds.
    pub created: i64,
    pub updated: i64,
}

/// What was playing, so it carries on from any device.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Listening {
    /// The songs queued, vault-relative, in playing order.
    pub queue: Vec<String>,
    /// Which of them was playing.
    pub index: u32,
    /// Seconds into it.
    pub position: f64,
    pub shuffle: bool,
    /// `off`, `all` or `one`.
    pub repeat: String,
    /// What it was playing from, as the device that started it named it: an
    /// album, an artist, a playlist, Liked Songs.
    pub from: String,
    /// Unix seconds.
    pub updated: i64,
}

/// What this device is playing, for the profile's other devices to see, and
/// a question: what are they playing? A device not signed in to a profile
/// is answered with nothing; it keeps its music to itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicNowRequest {
    /// What it plays now. Absent with `stopped` false: only asking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<NowReport>,
    /// It has stopped playing: forgotten at once.
    #[serde(default)]
    pub stopped: bool,
}

/// What one device plays.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NowReport {
    /// The queue, the song in it and the second it is at.
    pub listening: Listening,
    /// Playing rather than paused.
    pub playing: bool,
    /// The song's length in seconds, when known.
    pub duration: f64,
    /// When the song was at `listening.position`, on the host's clock in Unix
    /// milliseconds, as the device worked it out. Devices playing in sync
    /// need it to the millisecond; without it, the moment the host heard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock: Option<i64>,
}

/// What the profile's other devices are playing, and what this one was asked
/// to do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicNowResponse {
    /// The host's clock, in Unix milliseconds: a device works out where a
    /// song is now from `at` with it, whatever its own clock says.
    pub now: i64,
    pub sessions: Vec<NowSession>,
    /// Asked of this device since it last asked, oldest first.
    pub commands: Vec<MusicCommand>,
}

/// One of the profile's devices, playing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NowSession {
    /// The device's id, to send it a command.
    pub device: String,
    /// Its name, as the host lists it.
    pub name: String,
    /// What kind of device it said it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    pub report: NowReport,
    /// When it last told, on the host's clock, in Unix milliseconds: the
    /// song's second was `report.listening.position` then.
    pub at: i64,
}

/// Something one device asks another to do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicCommand {
    /// `play`, `pause`, `next`, `previous`, `seek`, `stop`; or, between
    /// devices playing in sync, `load` (play `listening`, from its second),
    /// `link` and `unlink`.
    pub action: String,
    /// For `seek`: where to, in seconds.
    pub position: f64,
    /// The name of the device that asked.
    pub from: String,
    /// Its id: the device to keep in sync with, for `link`.
    pub from_device: String,
    /// For `load`: the queue and the second to play from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listening: Option<Listening>,
}

/// Asks another of the profile's devices, playing, to do something.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicCommandRequest {
    /// The device asked, by its id from [`NowSession::device`].
    pub device: String,
    pub action: String,
    #[serde(default)]
    pub position: f64,
    /// For `load`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listening: Option<Listening>,
}

/// Asks where a film's or an episode's intro and credits are.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentsRequest {
    /// Vault-relative.
    pub path: String,
}

/// Where they are, as far as the host has found: nothing yet, for a file it
/// has not looked at or found nothing in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SegmentsResponse {
    /// Start and end of the intro, in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intro: Option<[f64; 2]>,
    /// Where the credits start, in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<f64>,
}

/// A speed test's requests, which are not JSON: a byte saying which way, and
/// then either how much the host is to send (four bytes, little-endian), or
/// the bytes the device sends, which the host throws away.
///
/// Nothing touches the drive: it measures the network between the two, over
/// the same encrypted connection films and uploads use.
pub mod speed_test {
    /// The host sends `bytes` back.
    pub const DOWN: u8 = 0;
    /// The rest of the request is data to throw away.
    pub const UP: u8 = 1;
    /// The most the host sends for one request.
    pub const MAX_DOWN: u32 = 16 * 1024 * 1024;

    /// A request for the host to send `bytes`.
    pub fn down(bytes: u32) -> Vec<u8> {
        let mut out = vec![DOWN];
        out.extend_from_slice(&bytes.min(MAX_DOWN).to_le_bytes());
        out
    }

    /// A request carrying `data` up.
    pub fn up(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 1);
        out.push(UP);
        out.extend_from_slice(data);
        out
    }
}

/// When a host makes a film's timeline pictures. However it is set, a film
/// played for the first time gets them then.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewsWhen {
    /// As soon as a film or episode arrives on the drive.
    Arrive,
    /// While nothing is being watched or converted.
    #[default]
    Idle,
    /// Only when somebody first plays it.
    Play,
}

/// Asks for a film's timeline pictures.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewsRequest {
    /// Vault-relative.
    pub path: String,
}

/// How a film's timeline pictures are laid out: picture `n` shows second
/// `n * interval`, and is square `n % (columns * rows)` of sheet
/// `n / (columns * rows)`, counted along the rows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMeta {
    pub interval: f64,
    pub columns: u32,
    pub rows: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub count: u32,
    pub sheets: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewsResponse {
    /// Absent while they are being made, when they are switched off, or for
    /// a file the host cannot make them for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<PreviewMeta>,
    /// Being made now: worth asking again in a while.
    #[serde(default)]
    pub making: bool,
}

/// Asks for one sheet of a film's timeline pictures.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSheetRequest {
    pub path: String,
    pub index: u32,
}

/// What a speed test measured.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    /// From the host to this device, in megabits a second.
    pub down_mbps: f64,
    /// From this device to the host.
    pub up_mbps: f64,
    /// The time a request takes to come back, in milliseconds.
    pub delay_ms: f64,
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/// A profile as any device may see it: a name and a colour, never its PIN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    /// Which of the avatar colours, 0 to 7.
    pub color: u8,
    /// False after the host's owner reset the PIN: the next sign-in sets one.
    pub has_pin: bool,
    /// Unix seconds of the last sign-in anywhere, zero if never.
    pub last_used: i64,
    /// A profile made on another drive, used here too: it signs in with the
    /// statement its home drive gave the device, never a PIN here. Absent for
    /// a profile of this drive, and from older hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<ProfileHome>,
}

/// Where a profile from another drive lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileHome {
    /// The home host's id.
    pub host_id: String,
    /// What it is called there, as people know it: "Living Room Drive".
    pub label: String,
    /// The profile's id on its home host.
    pub profile_id: String,
}

/// Asks to use, on this drive, a profile made on another one.
///
/// What proves it is the member statement the profile's home host signed for
/// this device: the person's key saying "this device acts for me". The name,
/// colour and home label are only for showing to whoever approves it; what is
/// believed is the statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLinkRequest {
    pub statement: SignedStatement,
    pub name: String,
    pub color: u8,
    /// The home drive's name, for "Maya from Living Room Drive".
    pub home: String,
    /// Stay signed in, as with a PIN.
    #[serde(default)]
    pub remember: bool,
}

/// Signed in, or waiting for someone who manages this drive to approve it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLinkResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<ProfileSession>,
    /// Waiting for approval: asked again once the profiles change.
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesResponse {
    pub profiles: Vec<ProfileView>,
    /// What the host's owner allows. Missing from a host that predates the
    /// rules, which then reads as both off: the way every host behaved.
    #[serde(default)]
    pub rules: ProfileRules,
}

/// The host owner's rules about profiles, for a drive kept private.
///
/// Both off by default, which is how a household drive has always worked:
/// anyone using it may add a profile, and a device may use it as itself.
/// The host enforces both; devices only follow them in what they offer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRules {
    /// Every device must sign in to a profile: none uses the drive as itself.
    #[serde(default)]
    pub require_profile: bool,
    /// Only the host's owner adds profiles; devices cannot.
    #[serde(default)]
    pub owner_adds_profiles: bool,
    /// A profile with no PIN yet is claimed with the code its host shows,
    /// typed with the new PIN, rather than by whichever paired device signs
    /// in first. Absent from older hosts, which have no codes.
    #[serde(default)]
    pub claim_code: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCreateRequest {
    pub name: String,
    pub pin: String,
    #[serde(default)]
    pub color: u8,
    /// Keep this device signed in. Otherwise the sign-in lasts until the app
    /// closes.
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSignInRequest {
    pub id: String,
    /// The PIN, or the new one for a profile whose PIN was reset.
    pub pin: String,
    /// The code that claims a profile with no PIN yet, when the host asks
    /// for one: see [`ProfileRules::claim_code`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default)]
    pub remember: bool,
}

/// A sign-in: the profile, and the token that stands for it from now on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSession {
    pub profile: ProfileView,
    /// 32 random bytes, hex. Presented with [`ProfileUseRequest`].
    pub token: String,
    /// The profile's statement that this device acts for it, for a device
    /// signed in with a key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<SignedStatement>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUseRequest {
    /// None to act as the device itself.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUseResponse {
    #[serde(default)]
    pub profile: Option<ProfileView>,
    /// A new statement from the profile, when one is due. See
    /// [`ProfileSession::member`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<SignedStatement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSignOutRequest {
    pub token: String,
}

/// One starred file or folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Star {
    /// Vault-relative.
    pub path: String,
    pub name: String,
    /// `file` or `dir`.
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarsRequest {
    /// Replaces the list first, when given. The list is small, so it goes
    /// whole rather than as additions and removals that could cross.
    #[serde(default)]
    pub set: Option<Vec<Star>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarsResponse {
    pub stars: Vec<Star>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequest {
    /// Vault-relative path of a video or photo.
    pub path: String,
    /// The longest side wanted, in pixels. The host picks the nearest size it
    /// makes: a small one for grids and a large one for viewing a photo whose
    /// format the device cannot show itself.
    #[serde(default)]
    pub size: u32,
    /// The photo of this artist instead, from 1.6.3. `path` is one of their
    /// songs, so a host from before shows that song's cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
}

/// A film or a series. Episodes hang off the series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    /// Stable across rescans: derived from the title and year, not the path, so
    /// moving a file does not orphan its artwork or its resume point.
    pub id: String,
    pub kind: LibraryKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<u16>,
    /// Vault-relative path of the file, for a film.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub size: u64,
    /// Unix seconds of the newest file in this item, for "recently added".
    #[serde(default)]
    pub added: i64,
    /// Seasons, for a series. Empty for a film.
    ///
    /// Always sent, empty list and all. Skipping it saved a dozen bytes per
    /// film and cost the client its whole Movies screen: the field is read
    /// unconditionally there, so an absent one threw rather than counted
    /// zero. A field a reader treats as always present should be written
    /// that way.
    #[serde(default)]
    pub seasons: Vec<Season>,
    /// How sure the parser is, 0–100. Below `CONFIDENT` the interface should
    /// offer the user a chance to correct it rather than assert it.
    #[serde(default)]
    pub confidence: u8,
    /// Subtitle files on the drive that belong to this film.
    ///
    /// Empty for a series: an episode's subtitles belong to the episode, and
    /// there is nothing a series-level list could usefully mean.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtitles: Vec<SubtitleTrack>,
    /// Whether the host has a poster cached for this item.
    ///
    /// Here so a client knows whether to ask at all: without it, a library of
    /// five hundred with no artwork would be five hundred requests that all
    /// come back empty.
    #[serde(default)]
    pub has_art: bool,
    /// The film's picture size, for a film. For a series, see each episode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
}

/// A video's picture size in pixels, as the host measured it.
///
/// Measured from the file itself, not read off its name: names are often
/// wrong or say nothing. The name is only the fallback for a file the host
/// could not read. Devices turn this into a tag — HD, FHD, 2K, 4K.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

/// Below this, a match is a guess worth showing the user.
pub const CONFIDENT: u8 = 70;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryKind {
    Film,
    Series,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub number: u16,
    pub episodes: Vec<Episode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub number: u16,
    /// Vault-relative path.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub added: i64,
    /// Subtitle files on the drive that belong to this episode.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtitles: Vec<SubtitleTrack>,
    /// See [`Resolution`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
}

/// A subtitle file sitting beside a film or an episode.
///
/// Only the ones found on the drive. Tracks *inside* the video are not listed
/// here: the player reads those from the file itself when it opens it, and
/// duplicating them would mean the host guessing at something mpv already
/// knows exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    /// Vault-relative path.
    pub path: String,
    /// `English`, `Spanish forced`, or `Subtitles` when the name says nothing.
    pub label: String,
}

/// A video to convert as it is watched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    /// Vault-relative path of the video.
    pub path: String,
    /// Seconds into it to start from.
    #[serde(default)]
    pub start: f64,
    /// Only whether it could be converted now, answered without starting:
    /// asked while the file still plays, so a host that cannot convert costs
    /// nothing but the question.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub check: bool,
}

/// The first answer to a conversion, before the film itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertStarted {
    /// What is doing the converting, as people say it: "NVIDIA graphics".
    pub by: String,
    /// How long the film is, in seconds, when the host could tell. A stream
    /// made as it is sent cannot say, and a player starting on one needs to
    /// know to draw its timeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

/// The subtitles for one video, asked for when it is played.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesRequest {
    /// Vault-relative path of the video.
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesResponse {
    /// The subtitle files that belong to the video, by the same rules the
    /// library uses.
    pub tracks: Vec<SubtitleTrack>,
    /// Others nearby or for something of the same title, labelled with their
    /// file names, for choosing one by hand.
    pub others: Vec<SubtitleTrack>,
}

/// Artwork for one item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtRequest {
    pub id: String,
}

// ---------------------------------------------------------------------------
// Where things have been watched to
// ---------------------------------------------------------------------------

/// How far through a file somebody got.
///
/// **A fraction, not a timestamp.** The in-app player knows its position in
/// seconds; an external player does not report anything at all, and the only
/// signal available there is how far through the file it has read. Storing a
/// fraction makes both sources the same kind of answer, and seconds — when
/// they are known — come along beside it for the interface to display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watched {
    /// Vault-relative path of the file itself, not the library item: an
    /// episode is watched, a series is not.
    pub path: String,
    /// 0.0–1.0 through the file. Always present.
    pub fraction: f64,
    /// Seconds in. Zero when an external player was used and only the byte
    /// offset was observable.
    #[serde(default)]
    pub position: f64,
    /// Total seconds. Zero when unknown.
    #[serde(default)]
    pub duration: f64,
    /// Unix seconds of the last update, for ordering Continue watching.
    pub updated_at: i64,
}

/// Past this, the file counts as watched rather than in progress.
///
/// Credits run long. Stopping at 94% is finishing something, and offering to
/// resume it two minutes from the end is worse than offering nothing.
pub const FINISHED_AT: f64 = 0.94;

/// Before this, there is nothing worth resuming.
///
/// Opening something, watching the first minute of a two-hour film and
/// stopping is not a thing to be reminded of later.
pub const STARTED_AFTER: f64 = 0.01;

impl Watched {
    pub fn finished(&self) -> bool {
        self.fraction >= FINISHED_AT
    }

    /// Whether this belongs in Continue watching.
    pub fn in_progress(&self) -> bool {
        self.fraction > STARTED_AFTER && !self.finished()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRequest {
    /// Recorded before the answer is built, so a client that reports and reads
    /// in one call sees its own update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<Watched>,
    /// Forget this path entirely — "watched" or "start again".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forget: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressResponse {
    pub entries: Vec<Watched>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_to_make_timeline_pictures_travels_as_a_word() {
        let set: ManageAction =
            serde_json::from_str(r#"{"do":"setPreviewsWhen","when":"arrive"}"#).unwrap();
        assert!(matches!(
            set,
            ManageAction::SetPreviewsWhen {
                when: PreviewsWhen::Arrive
            }
        ));
        let all: ManageAction = serde_json::from_str(r#"{"do":"makeMissingPreviews"}"#).unwrap();
        assert!(matches!(all, ManageAction::MakeMissingPreviews));
        assert_eq!(
            serde_json::to_string(&PreviewsWhen::Play).unwrap(),
            r#""play""#
        );
        assert_eq!(PreviewsWhen::default(), PreviewsWhen::Idle);
    }

    #[test]
    fn chunks_round_trip() {
        let id = [7u8; UPLOAD_ID_BYTES];
        let data = vec![9u8; 1000];
        let encoded = encode_chunk(&id, 4096, &data);
        let (back_id, offset, back_data) = decode_chunk(&encoded).unwrap();
        assert_eq!(back_id, id);
        assert_eq!(offset, 4096);
        assert_eq!(back_data, &data[..]);
    }

    #[test]
    fn an_empty_chunk_is_legal() {
        // The last chunk of a file whose size is an exact multiple of the chunk
        // size carries no data, and must not be treated as malformed.
        let encoded = encode_chunk(&[1u8; UPLOAD_ID_BYTES], 0, &[]);
        let (_, offset, data) = decode_chunk(&encoded).unwrap();
        assert_eq!(offset, 0);
        assert!(data.is_empty());
    }

    #[test]
    fn a_truncated_chunk_is_rejected_rather_than_panicking() {
        for len in 0..CHUNK_HEADER_BYTES {
            assert!(
                decode_chunk(&vec![0u8; len]).is_err(),
                "{len}-byte payload must be rejected"
            );
        }
    }

    #[test]
    fn upload_ids_parse_from_hex_and_reject_the_wrong_length() {
        let id = [0xABu8; UPLOAD_ID_BYTES];
        assert_eq!(parse_upload_id(&hex::encode(&id)).unwrap(), id);
        assert!(parse_upload_id("abcd").is_err());
        assert!(parse_upload_id("").is_err());
        assert!(parse_upload_id("zz").is_err());
    }

    // A host from before the hidden flag, and one leaving it out for the
    // usual case: both read as not hidden, and false is never sent.
    #[test]
    fn the_hidden_flag_is_optional_both_ways() {
        let old: DirEntry =
            serde_json::from_str(r#"{"name":"a","kind":"file","size":1,"mtime":0}"#).unwrap();
        assert!(!old.hidden);
        let json = serde_json::to_string(&old).unwrap();
        assert!(!json.contains("hidden"), "{json}");
    }

    #[test]
    fn a_listing_round_trips_through_json() {
        let response = ListResponse {
            entries: vec![
                DirEntry {
                    name: "Films".into(),
                    kind: EntryKind::Dir,
                    size: 0,
                    mtime: 1_700_000_000,
                    readonly: false,
                    hidden: false,
                },
                DirEntry {
                    name: "notes.txt".into(),
                    kind: EntryKind::File,
                    size: 1024,
                    mtime: -86_400,
                    readonly: true,
                    hidden: true,
                },
            ],
        };
        let json = serde_json::to_string(&response).unwrap();
        let back: ListResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries, response.entries);
    }

    #[test]
    fn optional_write_fields_default_when_an_older_client_omits_them() {
        let req: WriteBeginRequest = serde_json::from_str(r#"{"path":"a.bin","size":10}"#).unwrap();
        assert!(!req.overwrite);
        assert_eq!(req.resume, None);
    }

    #[test]
    fn a_change_names_the_folder_that_has_to_be_refreshed() {
        assert_eq!(
            Change::Created {
                path: "films/a.mkv".into()
            }
            .parent_dirs(),
            ["films"]
        );
        assert_eq!(
            Change::Removed {
                path: "a.mkv".into()
            }
            .parent_dirs(),
            [""],
            "something in the root belongs to the root"
        );
    }

    // A move between folders changes two listings, and a client looking at
    // either one is now wrong.
    #[test]
    fn a_move_between_folders_touches_both_of_them() {
        let change = Change::Renamed {
            from: "films/a.mkv".into(),
            to: "archive/a.mkv".into(),
        };
        assert_eq!(change.parent_dirs(), ["films", "archive"]);
    }

    #[test]
    fn a_rename_in_place_touches_one_folder_once() {
        let change = Change::Renamed {
            from: "films/a.mkv".into(),
            to: "films/b.mkv".into(),
        };
        assert_eq!(change.parent_dirs(), ["films"]);
    }

    #[test]
    fn a_resynchronise_belongs_to_no_particular_folder() {
        assert!(Change::Resynchronise.parent_dirs().is_empty());
        assert!(Change::LibraryChanged.parent_dirs().is_empty());
    }

    /// A hello says what kind of device it comes from; one from an older app
    /// says nothing, and a kind added later is read rather than refused, so a
    /// newer device can still sign in to an older host.
    #[test]
    fn a_hello_reads_with_or_without_a_known_device_kind() {
        let tv: HelloRequest =
            serde_json::from_str(r#"{"protocol":3,"device_name":"TV","form":"tv"}"#).unwrap();
        assert_eq!(tv.form, Some(DeviceForm::Tv));
        let old: HelloRequest =
            serde_json::from_str(r#"{"protocol":3,"device_name":"Laptop"}"#).unwrap();
        assert_eq!(old.form, None);
        let later: HelloRequest =
            serde_json::from_str(r#"{"protocol":3,"device_name":"Watch","form":"watch"}"#).unwrap();
        assert_eq!(later.form, Some(DeviceForm::Other));
        let said = serde_json::to_string(&HelloRequest { form: None, ..tv }).unwrap();
        assert!(!said.contains("form"), "{said}");
    }

    #[test]
    fn changes_round_trip_with_their_kind_tagged() {
        let change = Change::Renamed {
            from: "a".into(),
            to: "b".into(),
        };
        let json = serde_json::to_string(&change).unwrap();
        assert!(json.contains(r#""kind":"renamed""#), "{json}");
        assert_eq!(serde_json::from_str::<Change>(&json).unwrap(), change);
    }

    #[test]
    fn a_library_response_can_say_nothing_changed_without_sending_the_index() {
        let response = LibraryResponse {
            revision: 7,
            enabled: true,
            scanning: false,
            items: None,
            sections: Sections::default(),
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(!json.contains("items"), "an unchanged index sends no items");
    }

    #[test]
    fn a_film_and_a_series_round_trip() {
        let items = vec![
            LibraryItem {
                resolution: None,
                id: "f1".into(),
                kind: LibraryKind::Film,
                title: "Arrival".into(),
                year: Some(2016),
                path: Some("films/Arrival.mkv".into()),
                size: 10,
                added: 1,
                seasons: Vec::new(),
                subtitles: Vec::new(),
                confidence: 95,
                has_art: false,
            },
            LibraryItem {
                resolution: None,
                id: "s1".into(),
                kind: LibraryKind::Series,
                title: "Breaking Bad".into(),
                year: Some(2008),
                path: None,
                size: 20,
                added: 2,
                subtitles: Vec::new(),
                seasons: vec![Season {
                    number: 1,
                    episodes: vec![Episode {
                        resolution: None,
                        number: 1,
                        path: "shows/BB/S01/e1.mkv".into(),
                        title: None,
                        size: 20,
                        added: 2,
                        subtitles: Vec::new(),
                    }],
                }],
                confidence: 88,
                has_art: false,
            },
        ];
        let json = serde_json::to_string(&items).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<LibraryItem>>(&json).unwrap(),
            items
        );
    }

    /// A film has no seasons, and must say so rather than stay silent.
    ///
    /// The interface reads `seasons` on every card without checking, because
    /// the type says it is always there. Omitting it for a film — which is
    /// what `skip_serializing_if` did — threw out of render and left the
    /// whole Movies screen black.
    #[test]
    fn a_film_still_carries_an_empty_seasons_list() {
        let film = LibraryItem {
            resolution: None,
            id: "f1".into(),
            kind: LibraryKind::Film,
            title: "Arrival".into(),
            year: Some(2016),
            path: Some("films/Arrival.mkv".into()),
            size: 10,
            added: 1,
            seasons: Vec::new(),
            subtitles: Vec::new(),
            confidence: 95,
            has_art: false,
        };

        let value: serde_json::Value = serde_json::to_value(&film).unwrap();
        assert_eq!(
            value.get("seasons"),
            Some(&serde_json::json!([])),
            "a film must send `seasons: []`, not leave the key out",
        );
    }

    /// These cross into JavaScript, where a snake_case key silently reads as
    /// `undefined`. They happen to be single words today; this makes that a
    /// rule rather than an accident, because adding `episode_title` later
    /// would break the interface with no error anywhere.
    #[test]
    fn nothing_the_interface_reads_is_snake_case() {
        fn keys(value: serde_json::Value) -> Vec<String> {
            value
                .as_object()
                .expect("an object")
                .keys()
                .cloned()
                .collect()
        }

        let item = LibraryItem {
            resolution: None,
            id: "f1".into(),
            kind: LibraryKind::Film,
            title: "Arrival".into(),
            year: Some(2016),
            path: Some("a.mkv".into()),
            size: 1,
            added: 2,
            subtitles: Vec::new(),
            seasons: vec![Season {
                number: 1,
                episodes: vec![Episode {
                    resolution: None,
                    number: 1,
                    path: "b.mkv".into(),
                    title: Some("Pilot".into()),
                    size: 3,
                    added: 4,
                    subtitles: Vec::new(),
                }],
            }],
            confidence: 90,
            has_art: true,
        };
        let response = LibraryResponse {
            revision: 1,
            enabled: true,
            scanning: false,
            items: Some(vec![item.clone()]),
            sections: Sections::default(),
        };

        let mut all = keys(serde_json::to_value(&item).unwrap());
        all.extend(keys(serde_json::to_value(&response).unwrap()));
        all.extend(keys(
            serde_json::to_value(&item.seasons[0].episodes[0]).unwrap(),
        ));
        all.extend(keys(serde_json::to_value(&item.seasons[0]).unwrap()));
        all.extend(keys(
            serde_json::to_value(Change::Renamed {
                from: "a".into(),
                to: "b".into(),
            })
            .unwrap(),
        ));

        for key in all {
            assert!(
                !key.contains('_'),
                "{key} would arrive undefined in JavaScript"
            );
        }
    }

    fn watched(fraction: f64) -> Watched {
        Watched {
            path: "films/a.mkv".into(),
            fraction,
            position: 0.0,
            duration: 0.0,
            updated_at: 0,
        }
    }

    /// Credits run long, and offering to resume something two minutes from the
    /// end is worse than offering nothing at all.
    #[test]
    fn something_watched_to_the_credits_counts_as_finished() {
        assert!(watched(0.95).finished());
        assert!(watched(1.0).finished());
        assert!(!watched(0.5).finished());
        assert!(!watched(0.95).in_progress());
    }

    /// Opening a film, watching a minute and stopping is not something to be
    /// reminded about later.
    #[test]
    fn barely_started_is_not_in_progress() {
        assert!(!watched(0.0).in_progress());
        assert!(!watched(0.005).in_progress());
        assert!(watched(0.05).in_progress());
    }

    #[test]
    fn progress_is_camel_case_on_the_wire() {
        let json = serde_json::to_string(&watched(0.5)).unwrap();
        assert!(json.contains("updatedAt"), "{json}");
        assert!(!json.contains("updated_at"), "{json}");
    }

    #[test]
    fn a_progress_request_that_only_reads_sends_nothing_extra() {
        let json = serde_json::to_string(&ProgressRequest::default()).unwrap();
        assert_eq!(json, "{}", "reading is the common case and should be empty");
    }

    #[test]
    fn a_listing_entry_survives_a_missing_readonly_flag() {
        let e: DirEntry =
            serde_json::from_str(r#"{"name":"a","kind":"file","size":1,"mtime":0}"#).unwrap();
        assert!(!e.readonly);
    }
}
