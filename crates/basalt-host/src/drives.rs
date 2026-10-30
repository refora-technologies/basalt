//! The drives this machine could share.
//!
//! The setup screen asks one question — which drive? — and a question is much
//! easier to answer from a list than from a file picker. So the host enumerates
//! volumes itself and shows them with their labels and sizes, and the picker is
//! only there for the case the list cannot cover: a folder on a drive rather
//! than the whole of it.
//!
//! Windows only in substance. The non-Windows arm returns nothing so the crate
//! still builds and tests elsewhere.

use std::path::{Path, PathBuf};

/// A volume offered on the setup screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drive {
    /// `E:\`, ready to hand to [`crate::vault::Vault::open`].
    pub path: PathBuf,
    /// The volume label, or an empty string if it has none.
    pub label: String,
    /// `fixed`, `removable`, `network`, `cdrom`, or `other`.
    pub kind: &'static str,
    pub free: u64,
    pub total: u64,
}

impl Drive {
    /// What to call this drive when it has nothing better.
    ///
    /// A blank label is common on a freshly formatted USB stick, and "Local
    /// Disk (E:)" reads better than "(E:)" on its own.
    pub fn display_name(&self) -> String {
        if !cfg!(windows) {
            return linux_name(&self.path, &self.label);
        }
        let letter = self
            .path
            .to_string_lossy()
            .chars()
            .next()
            .unwrap_or('?')
            .to_string();
        if self.label.trim().is_empty() {
            let noun = match self.kind {
                "removable" => "Removable Disk",
                "network" => "Network Drive",
                "cdrom" => "Disc Drive",
                _ => "Local Disk",
            };
            format!("{noun} ({letter}:)")
        } else {
            format!("{} ({}:)", self.label.trim(), letter)
        }
    }
}

/// Every mounted volume, in drive-letter order.
///
/// Volumes that will not report a size are still listed: an empty card reader
/// slot is worth showing as unavailable rather than silently omitting, because
/// a user who expects to see E: and does not would otherwise have no idea why.
pub fn list() -> Vec<Drive> {
    #[cfg(windows)]
    {
        windows_drives()
    }
    #[cfg(target_os = "linux")]
    {
        let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
        if in_container() {
            container_drives(&mounts)
        } else {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|home| home.is_dir());
            linux_drives(&mounts, user_name().as_deref(), home.as_deref())
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Vec::new()
    }
}

/// What a Linux volume is called: its label, or the folder it is mounted
/// on, and the system's own disk "Computer", as a file manager says it.
fn linux_name(path: &Path, label: &str) -> String {
    if !label.trim().is_empty() {
        return label.trim().to_string();
    }
    match path.to_str() {
        Some("/") => "Computer".to_string(),
        Some("/home") => "Home".to_string(),
        _ => path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
    }
}

/// Running in a container: the image says so, and Docker leaves its mark.
#[cfg(target_os = "linux")]
fn in_container() -> bool {
    std::env::var_os("BASALT_CONTAINER").is_some() || Path::new("/.dockerenv").exists()
}

/// The drives a host in a container can share: whatever was mounted into it
/// under `/media`, and `/media` itself when that is the mount.
///
/// Not the rules of a whole computer. Every folder handed to a container
/// usually comes from the same disk, so one disk mounted twice is two drives
/// here; and their file systems are whatever the outside uses, Docker
/// Desktop's own included, so none is ruled out.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn container_drives(mounts: &str) -> Vec<Drive> {
    let mut drives: Vec<Drive> = Vec::new();
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_device), Some(point)) = (fields.next(), fields.next()) else {
            continue;
        };
        let point = unescape_mount(point);
        if point != "/media" && !point.starts_with("/media/") {
            continue;
        }
        if drives.iter().any(|d| d.path == Path::new(&point)) {
            continue;
        }
        let path = PathBuf::from(&point);
        let (free, total) = crate::space::for_path(&path);
        drives.push(Drive {
            path,
            label: String::new(),
            kind: "fixed",
            free,
            total,
        });
    }
    drives.sort_by(|a, b| a.path.cmp(&b.path));
    drives
}

/// The person running the host, for finding where their drives are mounted.
#[cfg(target_os = "linux")]
fn user_name() -> Option<String> {
    std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| std::env::var("LOGNAME").ok().filter(|u| !u.is_empty()))
}

/// File systems a drive full of a person's files is on. Everything else in
/// the mount table (the kernel's own, snaps, containers) is not a drive.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DRIVE_FILE_SYSTEMS: &[&str] = &[
    "ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "zfs", "jfs", "reiserfs", "vfat", "exfat",
    "ntfs", "ntfs3", "fuseblk", "hfsplus", "apfs", "nfs", "nfs4", "cifs", "smb3", "9p", "drvfs",
];

/// The drives a person would share, from the mount table's text: their own
/// home folder, the system's own disk, and whatever is mounted under
/// `/media`, `/run/media` and `/mnt`, the places Linux puts a USB drive or a
/// second disk. Each mounted volume once, the home folder first.
///
/// On most Linux computers the system's disk is the only one, and the host,
/// running as the person, may not add files anywhere on it but in their own
/// folder: offered alone, it was the obvious choice and refused every
/// upload. Their home folder holds their Videos, Music and Downloads and
/// takes uploads. A host run as a service has its home elsewhere, and is not
/// offered one.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_drives(mounts: &str, user: Option<&str>, home: Option<&Path>) -> Vec<Drive> {
    let mut seen_devices = std::collections::HashSet::new();
    let mut drives: Vec<Drive> = Vec::new();
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(device), Some(point), Some(fs)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !DRIVE_FILE_SYSTEMS.contains(&fs) {
            continue;
        }
        let point = unescape_mount(point);
        let wanted = point == "/"
            || point == "/home"
            || ["/media/", "/run/media/", "/mnt/"]
                .iter()
                .any(|place| point.starts_with(place));
        // WSL's own plumbing lives under /mnt/wsl; it is not a drive.
        if !wanted || point.starts_with("/mnt/wsl") {
            continue;
        }
        // The same disk mounted twice (a bind mount) is one drive.
        if device.starts_with('/') && !seen_devices.insert(device.to_string()) {
            continue;
        }
        let path = PathBuf::from(&point);
        let kind = if matches!(fs, "nfs" | "nfs4" | "cifs" | "smb3") {
            "network"
        } else if point.starts_with("/media/") || point.starts_with("/run/media/") {
            "removable"
        } else {
            "fixed"
        };
        // A drive mounted by the desktop is named after its label, under the
        // person's own folder: /media/maya/Films is the drive called Films.
        let label = match user {
            Some(user) => {
                let under_user = [format!("/media/{user}/"), format!("/run/media/{user}/")];
                under_user
                    .iter()
                    .find_map(|prefix| point.strip_prefix(prefix.as_str()))
                    .filter(|rest| !rest.contains('/'))
                    .unwrap_or("")
                    .to_string()
            }
            None => String::new(),
        };
        let (free, total) = crate::space::for_path(&path);
        drives.push(Drive {
            path,
            label,
            kind,
            free,
            total,
        });
    }
    drives.sort_by_key(|d| match d.path.to_str() {
        Some("/") => (0, String::new()),
        Some("/home") => (1, String::new()),
        other => (2, other.unwrap_or_default().to_string()),
    });
    if let Some(home) = home.filter(|home| is_a_persons_home(home)) {
        // A /home of its own is everyone's folders, which the host can't add
        // to either: this person's is offered in its place.
        drives.retain(|d| d.path != Path::new("/home"));
        let (free, total) = crate::space::for_path(home);
        drives.insert(
            0,
            Drive {
                path: home.to_path_buf(),
                label: "Home".to_string(),
                kind: "fixed",
                free,
                total,
            },
        );
    }
    drives
}

/// A person's own folder, as `/home/maya` is, rather than a service's or
/// root's.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_a_persons_home(home: &Path) -> bool {
    let Some(text) = home.to_str() else {
        return false;
    };
    let text = text.trim_end_matches('/');
    ["/home/", "/var/home/"].iter().any(|place| {
        text.strip_prefix(place)
            .is_some_and(|name| !name.is_empty() && !name.contains('/'))
    })
}

/// Where, in the mount table's text, things are mounted that are not drives:
/// the kernel's own views (`/proc`, `/sys`), memory (`/run`), snaps and the
/// like. A drive shared whole passes over these, which hold no one's files
/// and cannot all be read.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn not_drives(mounts: &str) -> Vec<std::path::PathBuf> {
    mounts
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (_, point, fs) = (fields.next()?, fields.next()?, fields.next()?);
            (!DRIVE_FILE_SYSTEMS.contains(&fs)).then(|| unescape_mount(point).into())
        })
        .collect()
}

/// The mount table writes a space as `\040`, and a few other characters the
/// same way.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn unescape_mount(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && bytes[i + 1..i + 4]
                .iter()
                .all(|b| (b'0'..=b'7').contains(b))
        {
            let value =
                (bytes[i + 1] - b'0') * 64 + (bytes[i + 2] - b'0') * 8 + (bytes[i + 3] - b'0');
            out.push(value);
            i += 4;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether a path can actually be served right now.
///
/// Used before locking one in, so choosing a drive that has been unplugged
/// since the list was drawn fails with something the user can act on rather
/// than a vault that opens onto nothing.
pub fn is_available(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// Beside the config: whether the host could add files to the folder it
/// shares, last it looked. Written by the running host, read by
/// `basalt-host status`, which runs as another user and so cannot look for
/// itself.
pub const WRITE_CHECK_FILE: &str = "drive-check.json";

/// What the host found when it last tried to add a file to its folder.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCheck {
    /// The folder looked at.
    pub path: std::path::PathBuf,
    pub writable: bool,
}

/// Whether this process can add a file to `folder`: one is made and removed.
///
/// Asked of the folder itself, not worked out from its permission bits,
/// which say nothing of ACLs, read-only mounts, Docker's user or Windows.
/// A host that can read its folder and not write to it lists and plays
/// everything, and only an upload or a new folder says otherwise.
pub fn can_write(folder: &Path) -> bool {
    let probe = folder.join(format!(".basalt-write-check-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        // Left over from a check that was cut short: it was written then.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The last check written beside `config_path`, if there is one.
pub fn read_write_check(config_path: &Path) -> Option<WriteCheck> {
    let dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    let text = std::fs::read_to_string(dir.join(WRITE_CHECK_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// What a device sees when it browses the host's folders to share one.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderList {
    /// Where this is, as a person writes it; empty for the list of drives.
    pub path: String,
    /// One level up: `None` at the top, empty for the list of drives.
    pub parent: Option<String>,
    pub folders: Vec<FolderEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
}

/// The most folders one listing shows: a folder of thousands is not one to
/// pick through on a phone, and its path can still be typed.
const MOST_FOLDERS: usize = 500;

/// The folders in `path`, for a device that manages the host to choose one
/// to share. Empty starts where it makes sense: the drives on Windows, the
/// mounted folders in a container, the top of the file system otherwise.
/// Hidden folders (a dot first) are left out, as a file manager does.
pub fn list_folders(path: &str) -> std::io::Result<FolderList> {
    let path = path.trim();
    if path.is_empty() {
        if cfg!(windows) {
            let folders = list()
                .into_iter()
                .filter(|d| is_available(&d.path))
                .map(|d| FolderEntry {
                    name: d.display_name(),
                    path: display(&d.path),
                })
                .collect();
            return Ok(FolderList {
                path: String::new(),
                parent: None,
                folders,
            });
        }
        #[cfg(target_os = "linux")]
        if in_container() && Path::new("/media").is_dir() {
            return list_folders("/media");
        }
        return list_folders("/");
    }
    let here = Path::new(path);
    let mut folders: Vec<FolderEntry> = std::fs::read_dir(here)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            // Followed through links, as sharing one would be.
            std::fs::metadata(entry.path()).is_ok_and(|m| m.is_dir())
        })
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (!name.starts_with('.') && !name.starts_with('$')).then(|| FolderEntry {
                name,
                path: display(&entry.path()),
            })
        })
        .collect();
    folders.sort_by_key(|f| f.name.to_lowercase());
    folders.truncate(MOST_FOLDERS);
    let parent = match here.parent() {
        Some(up) if !up.as_os_str().is_empty() => Some(display(up)),
        // At a drive's top on Windows: up is the list of drives.
        _ if cfg!(windows) => Some(String::new()),
        _ => None,
    };
    Ok(FolderList {
        path: display(here),
        parent,
        folders,
    })
}

/// What a drive or folder is called when nobody gave it a name: as the drive
/// list shows it, or the folder's own name.
pub fn default_name(path: &Path) -> String {
    let shown = display(path);
    let trimmed = shown.trim_end_matches(['\\', '/']);
    if let Some(drive) = list()
        .into_iter()
        .find(|d| display(&d.path).trim_end_matches(['\\', '/']) == trimmed)
    {
        return drive.display_name();
    }
    Path::new(trimmed)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| shown.clone())
}

/// A path the way a person writes it.
///
/// A canonical Windows path comes back as `\\?\D:\`, which is correct and looks
/// like something has gone wrong. The host's window showed exactly that under
/// the drive's name.
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[cfg(windows)]
fn windows_drives() -> Vec<Drive> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_CDROM, DRIVE_FIXED, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };

    // SAFETY: no arguments, no out-parameters; a bitmask of present letters.
    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();

    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = format!("{letter}:\\");
        let wide = wide(&root);

        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let kind = match unsafe { GetDriveTypeW(wide.as_ptr()) } {
            DRIVE_FIXED => "fixed",
            DRIVE_REMOVABLE => "removable",
            DRIVE_REMOTE => "network",
            DRIVE_CDROM => "cdrom",
            _ => "other",
        };

        let path = PathBuf::from(&root);
        let (free, total) = crate::space::for_path(&path);
        drives.push(Drive {
            path,
            label: volume_label(&wide).unwrap_or_default(),
            kind,
            free,
            total,
        });
    }

    drives
}

#[cfg(windows)]
fn volume_label(root: &[u16]) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let mut label = [0u16; 256];

    // SAFETY: `root` is NUL-terminated; `label` is written with at most its own
    // length; every other out-parameter is null, which this API accepts.
    let ok = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        // An empty card reader slot fails here. Not an error worth reporting —
        // the drive is listed with no label and no size, which is the truth.
        return None;
    }

    let end = label.iter().position(|&c| c == 0).unwrap_or(label.len());
    Some(String::from_utf16_lossy(&label[..end]))
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test, removed after it.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("basalt-drives-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_folder_that_takes_files_is_writable_and_is_left_as_it_was() {
        let dir = Scratch::new("writable");
        assert!(can_write(dir.path()));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_folder_that_is_not_there_is_not_writable() {
        let dir = Scratch::new("missing");
        assert!(!can_write(&dir.path().join("gone")));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_the_host_may_only_read_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Scratch::new("read-only");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        // root writes anyway: the check is only meaningful as anyone else.
        let root = unsafe { libc::geteuid() } == 0;
        assert_eq!(can_write(dir.path()), root);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    const MOUNTS: &str = "\
sysfs /sys sysfs rw,nosuid 0 0
proc /proc proc rw 0 0
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
tmpfs /run tmpfs rw 0 0
/dev/nvme0n1p3 /home ext4 rw 0 0
/dev/loop3 /snap/core/123 squashfs ro 0 0
/dev/sda1 /media/maya/Media\\040Drive exfat rw 0 0
/dev/sdb1 /mnt/backup btrfs rw 0 0
/dev/sdb1 /srv/backup btrfs rw 0 0
/dev/sdb1 /mnt/backup-again btrfs rw 0 0
none /mnt/wsl tmpfs rw 0 0
//nas/films /mnt/nas cifs rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
";

    #[test]
    fn linux_drives_are_the_disks_a_person_would_share_and_nothing_else() {
        let drives = linux_drives(MOUNTS, Some("maya"), None);
        let paths: Vec<_> = drives
            .iter()
            .map(|d| d.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            paths,
            [
                "/",
                "/home",
                "/media/maya/Media Drive",
                "/mnt/backup",
                "/mnt/nas"
            ]
        );
        let usb = &drives[2];
        assert_eq!(usb.label, "Media Drive");
        assert_eq!(usb.kind, "removable");
        assert_eq!(drives[4].kind, "network");
        assert_eq!(linux_name(&drives[0].path, &drives[0].label), "Computer");
        assert_eq!(linux_name(&drives[1].path, &drives[1].label), "Home");
        assert_eq!(linux_name(&usb.path, &usb.label), "Media Drive");
        assert_eq!(linux_name(&drives[3].path, &drives[3].label), "backup");
    }

    #[test]
    fn a_persons_home_folder_comes_first_in_place_of_everyones() {
        let drives = linux_drives(MOUNTS, Some("maya"), Some(Path::new("/home/maya")));
        let paths: Vec<_> = drives
            .iter()
            .map(|d| d.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            paths,
            [
                "/home/maya",
                "/",
                "/media/maya/Media Drive",
                "/mnt/backup",
                "/mnt/nas"
            ]
        );
        assert_eq!(linux_name(&drives[0].path, &drives[0].label), "Home");
        assert_eq!(drives[0].kind, "fixed");
    }

    #[test]
    fn only_the_disk_when_the_home_is_a_services() {
        let one_disk = "/dev/sda2 / ext4 rw 0 0\n";
        for home in ["/var/lib/basalt-host", "/root", "/", "/home", "/home/"] {
            let drives = linux_drives(one_disk, None, Some(Path::new(home)));
            let paths: Vec<_> = drives.iter().map(|d| d.path.clone()).collect();
            assert_eq!(paths, [PathBuf::from("/")], "{home}");
        }
        let drives = linux_drives(one_disk, Some("maya"), Some(Path::new("/var/home/maya/")));
        assert_eq!(drives.len(), 2);
        assert_eq!(drives[0].label, "Home");
    }

    // Docker hands a container its folders as bind mounts, usually all from
    // one disk: each is a drive of its own, and only those under /media.
    #[test]
    fn a_container_lists_each_folder_mounted_under_media() {
        let mounts = "overlay / overlay rw 0 0
proc /proc proc rw 0 0
/dev/sda1 /config ext4 rw 0 0
/dev/sda1 /media/films ext4 rw 0 0
/dev/sda1 /media/photos ext4 rw 0 0
/dev/sda1 /media/photos ext4 rw 0 0
grpcfuse /media/Music\\040Library fakeowner rw 0 0
/dev/sda1 /etc/hosts ext4 rw 0 0
";
        let paths: Vec<_> = container_drives(mounts)
            .iter()
            .map(|d| d.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            paths,
            ["/media/Music Library", "/media/films", "/media/photos"]
        );
        assert_eq!(
            container_drives(
                "/dev/sdb1 /media ext4 rw 0 0
"
            )[0]
            .path,
            Path::new("/media")
        );
    }

    #[test]
    fn a_mount_table_with_nothing_wanted_lists_nothing() {
        assert!(linux_drives("proc /proc proc rw 0 0\n", None, None).is_empty());
        assert!(linux_drives("", None, None).is_empty());
        assert!(linux_drives("garbage\n\n   \n", None, None).is_empty());
    }

    #[test]
    fn escaped_mount_points_read_as_written() {
        assert_eq!(unescape_mount("/media/a\\040b"), "/media/a b");
        assert_eq!(unescape_mount("/plain"), "/plain");
        assert_eq!(unescape_mount("/bad\\0"), "/bad\\0");
    }

    #[test]
    fn this_machine_has_at_least_one_drive() {
        let drives = list();
        if cfg!(target_os = "linux") {
            assert!(
                drives.iter().any(|d| d.path == Path::new("/")),
                "Linux always has its own disk"
            );
        }
        if cfg!(windows) {
            assert!(!drives.is_empty(), "Windows always has a system drive");
            assert!(
                drives.iter().any(|d| d.kind == "fixed" && d.total > 0),
                "at least one fixed volume should report a size"
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn every_drive_is_a_root_path() {
        for drive in list() {
            let text = drive.path.to_string_lossy().into_owned();
            assert_eq!(text.len(), 3, "expected a root like E:\\, got {text}");
            assert!(text.ends_with('\\'), "{text}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn a_drive_without_a_label_still_has_something_to_call_it() {
        let drive = Drive {
            path: PathBuf::from("E:\\"),
            label: String::new(),
            kind: "removable",
            free: 0,
            total: 0,
        };
        assert_eq!(drive.display_name(), "Removable Disk (E:)");
    }

    #[test]
    #[cfg(windows)]
    fn a_label_is_preferred_and_trimmed() {
        let drive = Drive {
            path: PathBuf::from("E:\\"),
            label: "  Films  ".into(),
            kind: "fixed",
            free: 0,
            total: 0,
        };
        assert_eq!(drive.display_name(), "Films (E:)");
    }

    #[test]
    #[cfg(windows)]
    fn a_path_is_shown_the_way_a_person_writes_it() {
        assert_eq!(display(Path::new(r"\\?\D:\")), r"D:\");
        assert_eq!(display(Path::new(r"\\?\D:\Films")), r"D:\Films");
        assert_eq!(display(Path::new(r"\\?\UNC\nas\share")), r"\\nas\share");
        assert_eq!(display(Path::new(r"E:\")), r"E:\");
    }

    #[test]
    fn a_drive_that_is_not_there_is_not_available() {
        assert!(!is_available(Path::new(
            "Z:\\definitely\\not\\mounted\\8f2a"
        )));
        assert!(is_available(&std::env::temp_dir()));
    }

    #[test]
    fn a_file_is_not_a_drive() {
        // `Vault::open` would refuse this anyway, but saying so at the point of
        // choosing gives a much better message than "could not open the vault".
        let file = std::env::temp_dir().join("basalt-drives-probe.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(!is_available(&file));
        let _ = std::fs::remove_file(&file);
    }
}
