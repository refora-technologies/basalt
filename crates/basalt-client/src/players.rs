//! Finding a media player that can open a URL.
//!
//! The app's own window cannot decode most of a real film library — Chromium
//! reads Matroska only well enough for WebM, so an MKV carrying AC3, DTS or
//! Dolby Digital Plus plays its picture in silence. The answer is to hand the
//! file to a player that can.
//!
//! **The point is that it is handed a URL, not a file.** Downloading a 3 GB
//! episode before it could start would take over two minutes on a 22.7 MB/s
//! link and fill the disk with copies. VLC, mpv, MPC and PotPlayer all open an
//! HTTP URL and seek through it with range requests, which is exactly what the
//! media proxy already serves — so playback starts at once and nothing is
//! stored.
//!
//! Players are found through what Windows records about them rather than a
//! list of guessed directories: people put programs where they like. The
//! first version guessed, and failed on a machine where PotPlayer lives on a
//! second drive. The second read only `App Paths`, and failed on
//! the same machine once PotPlayer was reinstalled without writing one — and
//! with no player found the app copied the whole film to disk instead. So a
//! player is now looked for everywhere Windows keeps a note of it: `App
//! Paths`, its `Applications` entry, and the file types it opens, the default
//! for `.mkv` included. That last is also the person's own answer to "which
//! player", and it is asked first.
//!
//! Only players known to accept a URL are found on their own. Launching
//! whatever is registered for `.mkv` would work for most and fail bafflingly
//! for the rest, handing a player an address it takes for a file name. Any
//! other program is used only when the person picks it themselves.

use std::path::{Path, PathBuf};

/// A player installed on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Player {
    pub name: String,
    pub path: PathBuf,
    /// Whether Windows opens this kind of file with it.
    pub is_default: bool,
}

/// A player worth looking for: its display name, the executables it installs
/// under, and the directories it lands in when it does not register itself.
struct Candidate {
    name: &'static str,
    executables: &'static [&'static str],
    fallback_paths: &'static [&'static str],
}

/// In order of preference when Windows' default for the file is none of
/// them. VLC first because it is the most widely installed and the most
/// forgiving about codecs; mpv next because it is what the app embeds.
const CANDIDATES: &[Candidate] = &[
    Candidate {
        name: "VLC",
        executables: &["vlc.exe"],
        fallback_paths: &[
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        ],
    },
    Candidate {
        name: "mpv",
        executables: &["mpv.exe"],
        fallback_paths: &[
            r"C:\Program Files\mpv\mpv.exe",
            r"C:\Program Files\mpv-x86_64\mpv.exe",
        ],
    },
    Candidate {
        name: "MPC-HC",
        executables: &["mpc-hc64.exe", "mpc-hc.exe"],
        fallback_paths: &[
            r"C:\Program Files\MPC-HC\mpc-hc64.exe",
            r"C:\Program Files (x86)\MPC-HC\mpc-hc.exe",
            r"C:\Program Files (x86)\K-Lite Codec Pack\MPC-HC64\mpc-hc64.exe",
        ],
    },
    Candidate {
        name: "MPC-BE",
        executables: &["mpc-be64.exe", "mpc-be.exe"],
        fallback_paths: &[
            r"C:\Program Files\MPC-BE\mpc-be64.exe",
            r"C:\Program Files (x86)\MPC-BE\mpc-be.exe",
        ],
    },
    Candidate {
        name: "PotPlayer",
        executables: &["PotPlayerMini64.exe", "PotPlayerMini.exe"],
        fallback_paths: &[
            r"C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe",
            r"C:\Program Files (x86)\DAUM\PotPlayer\PotPlayerMini.exe",
        ],
    },
    Candidate {
        name: "SMPlayer",
        executables: &["smplayer.exe"],
        fallback_paths: &[r"C:\Program Files\SMPlayer\smplayer.exe"],
    },
    Candidate {
        name: "KMPlayer",
        executables: &["KMPlayer64.exe", "KMPlayer.exe"],
        fallback_paths: &[
            r"C:\Program Files\KMPlayer 64X\KMPlayer64.exe",
            r"C:\Program Files (x86)\The KMPlayer\KMPlayer.exe",
        ],
    },
    Candidate {
        name: "GOM Player",
        executables: &["GOM64.exe", "GOM.exe"],
        fallback_paths: &[
            r"C:\Program Files\GRETECH\GomPlayer\GOM64.exe",
            r"C:\Program Files (x86)\GRETECH\GomPlayer\GOM.exe",
        ],
    },
];

/// Video types whose registered programs are searched for players, besides
/// the file's own.
#[cfg(windows)]
const VIDEO_TYPES: &[&str] = &[".mkv", ".mp4", ".avi"];

/// The first streaming-capable player found on this machine.
pub fn find() -> Option<Player> {
    installed(".mkv").into_iter().next()
}

/// Every streaming-capable player on this machine, the one Windows opens
/// `extension` with first, then the rest in order of preference.
pub fn installed(extension: &str) -> Vec<Player> {
    let extension = normalise_extension(extension);
    let default = default_program(&extension);
    let registered = registered_programs(&extension);

    let mut found: Vec<Player> = Vec::new();
    for candidate in CANDIDATES {
        if let Some(path) = locate(candidate, &registered) {
            let is_default = default.as_deref().is_some_and(|d| same_file(d, &path));
            found.push(Player {
                name: candidate.name.to_string(),
                path,
                is_default,
            });
        }
    }
    // The default first; otherwise the order above.
    found.sort_by_key(|p| !p.is_default);
    found
}

/// A program the person picked, as a player, when it exists.
pub fn chosen(path: &Path) -> Option<Player> {
    if !path.is_file() {
        return None;
    }
    let file = path.file_name()?.to_string_lossy().to_string();
    let name = CANDIDATES
        .iter()
        .find(|c| c.executables.iter().any(|e| e.eq_ignore_ascii_case(&file)))
        .map(|c| c.name.to_string())
        .unwrap_or_else(|| display_name(path));
    Some(Player {
        name,
        path: path.to_path_buf(),
        is_default: false,
    })
}

/// Launches a player against a URL, without waiting for it to exit.
pub fn launch(player: &Player, url: &str) -> std::io::Result<()> {
    let mut command = std::process::Command::new(&player.path);
    command.arg(url);

    // MPC keeps a single instance by default and would replace whatever is
    // already playing rather than opening a second window.
    if player.name.starts_with("MPC") {
        command.arg("/new");
    }

    // Spawned and forgotten: the player outlives this call, and waiting on it
    // would block the app for the length of the film.
    command.spawn().map(|_| ())
}

/// Where one candidate is installed, if it is.
fn locate(candidate: &Candidate, registered: &[PathBuf]) -> Option<PathBuf> {
    for exe in candidate.executables {
        // Where Windows says the program is. This is the answer that survives
        // someone installing to another drive.
        if let Some(path) = app_path(exe).filter(|p| p.is_file()) {
            return Some(path);
        }
        if let Some(path) = application_command(exe).filter(|p| p.is_file()) {
            return Some(path);
        }
        if let Some(path) = registered.iter().find(|p| file_is(p, exe) && p.is_file()) {
            return Some(path.clone());
        }
        if let Some(path) = on_path(exe) {
            return Some(path);
        }
    }
    candidate
        .fallback_paths
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

fn normalise_extension(extension: &str) -> String {
    let bare = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if bare.is_empty() {
        ".mkv".to_string()
    } else {
        format!(".{bare}")
    }
}

fn file_is(path: &Path, exe: &str) -> bool {
    path.file_name()
        .is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(exe))
}

fn same_file(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

/// A program's name for a person: `PotPlayerMini64.exe` reads as itself, but
/// `vlc.exe` should not read as "vlc.exe".
fn display_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// The program in a shell command such as `"D:\Apps\Player.exe" "%1"` or
/// `C:\Apps\Player.exe /open "%1"`.
#[cfg_attr(not(windows), allow(dead_code))]
fn program_in_command(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        let end = rest.find('"')?;
        let path = &rest[..end];
        return (!path.is_empty()).then(|| PathBuf::from(path));
    }
    let lower = command.to_ascii_lowercase();
    let end = lower.find(".exe")? + 4;
    Some(PathBuf::from(&command[..end]))
}

/// The program Windows opens `extension` with, when it is a program.
///
/// The person's own choice first (`UserChoice`), then the machine's. A
/// Store app has no program path and gives `None`.
#[cfg(windows)]
fn default_program(extension: &str) -> Option<PathBuf> {
    use registry::{HKCR, HKCU, string};
    let user = string(
        HKCU,
        &format!(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{extension}\UserChoice"
        ),
        Some("ProgId"),
    );
    let prog_id = user.or_else(|| string(HKCR, extension, None))?;
    open_command(&prog_id)
}

#[cfg(not(windows))]
fn default_program(_extension: &str) -> Option<PathBuf> {
    None
}

/// Every program registered to open `extension` or the common video types.
#[cfg(windows)]
fn registered_programs(extension: &str) -> Vec<PathBuf> {
    use registry::{HKCR, HKCU, value_names};
    let mut types: Vec<&str> = vec![extension];
    types.extend(VIDEO_TYPES.iter().filter(|t| **t != extension));

    let mut programs = Vec::new();
    for kind in types {
        let mut prog_ids = value_names(
            HKCU,
            &format!(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{kind}\OpenWithProgids"
            ),
        );
        prog_ids.extend(value_names(HKCR, &format!(r"{kind}\OpenWithProgids")));
        programs.extend(default_program(kind));
        programs.extend(prog_ids.iter().filter_map(|id| open_command(id)));
    }
    programs
}

#[cfg(not(windows))]
fn registered_programs(_extension: &str) -> Vec<PathBuf> {
    Vec::new()
}

/// The program a ProgId's "open" runs.
#[cfg(windows)]
fn open_command(prog_id: &str) -> Option<PathBuf> {
    let command = registry::string(
        registry::HKCR,
        &format!(r"{prog_id}\shell\open\command"),
        None,
    )?;
    program_in_command(&command)
}

/// Reads `App Paths\<exe>`, where Windows records installed programs.
///
/// Checked in both hives: per-machine installs land in `HKLM`, per-user ones
/// in `HKCU`, and either is a perfectly normal way to install a player.
#[cfg(windows)]
fn app_path(exe: &str) -> Option<PathBuf> {
    use registry::{HKCU, HKLM, string};
    let subkey = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    [HKCU, HKLM].into_iter().find_map(|hive| {
        let raw = string(hive, &subkey, None)?;
        // The value is sometimes quoted, because it is also used as a command.
        let trimmed = raw.trim().trim_matches('"');
        (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
    })
}

#[cfg(not(windows))]
fn app_path(_exe: &str) -> Option<PathBuf> {
    None
}

/// Reads `Applications\<exe>\shell\open\command`, which most players write
/// so as to appear in Windows' "Open with" list.
#[cfg(windows)]
fn application_command(exe: &str) -> Option<PathBuf> {
    let command = registry::string(
        registry::HKCR,
        &format!(r"Applications\{exe}\shell\open\command"),
        None,
    )?;
    program_in_command(&command)
}

#[cfg(not(windows))]
fn application_command(_exe: &str) -> Option<PathBuf> {
    None
}

/// Looks for an executable on `PATH`.
fn on_path(exe: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

/// The few registry reads the search needs.
#[cfg(windows)]
mod registry {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    pub use windows_sys::Win32::System::Registry::HKEY;
    use windows_sys::Win32::System::Registry::{
        HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ, RegCloseKey, RegEnumValueW, RegGetValueW, RegOpenKeyExW,
    };

    pub const HKCR: HKEY = HKEY_CLASSES_ROOT;
    pub const HKCU: HKEY = HKEY_CURRENT_USER;
    pub const HKLM: HKEY = HKEY_LOCAL_MACHINE;

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// A string value; `name` of `None` reads the key's default.
    pub fn string(hive: HKEY, subkey: &str, name: Option<&str>) -> Option<String> {
        let subkey = wide(subkey);
        let name = name.map(wide);
        let mut buffer = vec![0u16; 2048];
        let mut size = (buffer.len() * 2) as u32;

        // SAFETY: `subkey` and `name` are NUL-terminated, and the buffer and
        // its size in bytes agree.
        let status = unsafe {
            RegGetValueW(
                hive,
                subkey.as_ptr(),
                name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let chars = (size as usize / 2).saturating_sub(1).min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..chars]);
        let text = text.trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    /// The names of a key's values: how `OpenWithProgids` lists its ProgIds.
    pub fn value_names(hive: HKEY, subkey: &str) -> Vec<String> {
        let subkey = wide(subkey);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: `subkey` is NUL-terminated and `key` is written on success.
        if unsafe { RegOpenKeyExW(hive, subkey.as_ptr(), 0, KEY_READ, &mut key) } != ERROR_SUCCESS {
            return Vec::new();
        }
        let mut names = Vec::new();
        for index in 0..256u32 {
            let mut buffer = [0u16; 512];
            let mut length = buffer.len() as u32;
            // SAFETY: the buffer and its length in characters agree; type
            // and data are not asked for.
            let status = unsafe {
                RegEnumValueW(
                    key,
                    index,
                    buffer.as_mut_ptr(),
                    &mut length,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            let name = String::from_utf16_lossy(&buffer[..length as usize]);
            if !name.is_empty() {
                names.push(name);
            }
        }
        // SAFETY: `key` was opened above and is closed once.
        unsafe { RegCloseKey(key) };
        names
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_program_is_not_found_rather_than_a_panic() {
        assert!(on_path("definitely-not-a-real-player-9f2a.exe").is_none());
        assert!(app_path("definitely-not-a-real-player-9f2a.exe").is_none());
        assert!(application_command("definitely-not-a-real-player-9f2a.exe").is_none());
    }

    #[test]
    fn finding_a_player_is_optional_and_never_fails() {
        // Whether one is installed depends on the machine, so this asserts the
        // shape rather than the outcome: a result, never a panic, and a real
        // file when something is found.
        for player in installed(".mkv") {
            assert!(player.path.is_file(), "{:?} must exist", player.path);
            assert!(!player.name.is_empty());
        }
        let players = installed("mkv");
        // At most one default, and it comes first.
        assert!(players.iter().skip(1).all(|p| !p.is_default));
    }

    #[test]
    fn the_program_is_read_out_of_a_shell_command() {
        assert_eq!(
            program_in_command(r#""E:\Programs\Video Players\PotPlayerMini64.exe" "%1""#),
            Some(PathBuf::from(
                r"E:\Programs\Video Players\PotPlayerMini64.exe"
            ))
        );
        assert_eq!(
            program_in_command(r#"C:\Apps\vlc.exe --started-from-file "%1""#),
            Some(PathBuf::from(r"C:\Apps\vlc.exe"))
        );
        assert_eq!(
            program_in_command(r#"C:\Apps\Player.EXE"#),
            Some(PathBuf::from(r"C:\Apps\Player.EXE"))
        );
        assert_eq!(program_in_command(r#"rundll32 shell32.dll"#), None);
        assert_eq!(program_in_command(r#""""#), None);
    }

    #[test]
    fn extensions_are_compared_the_same_way_however_written() {
        assert_eq!(normalise_extension("MKV"), ".mkv");
        assert_eq!(normalise_extension(".Mp4"), ".mp4");
        assert_eq!(normalise_extension(""), ".mkv");
    }

    #[test]
    fn a_chosen_program_keeps_a_known_players_name() {
        let me = std::env::current_exe().unwrap();
        let player = chosen(&me).expect("the test binary exists");
        assert!(!player.name.is_empty());
        assert!(!player.is_default);
        assert!(chosen(Path::new(r"C:\nowhere\nothing-9f2a.exe")).is_none());
    }

    // The failure that made this registry-based: PotPlayer installed on a
    // second drive, which no list of guessed directories would ever contain.
    #[cfg(windows)]
    #[test]
    fn a_registered_program_is_found_wherever_it_was_installed() {
        // `notepad.exe` is registered in App Paths on every Windows machine and
        // is a stable stand-in for "a program Windows knows about".
        let found = app_path("notepad.exe");
        if let Some(path) = found {
            assert!(path.is_file(), "{path:?} should exist");
            assert!(path.is_absolute());
        }
        // `.txt` opens with something on every Windows machine; reading it
        // must not panic whatever it is, a program or a Store app.
        let _ = default_program(".txt");
    }

    #[test]
    #[cfg(windows)]
    fn every_fallback_path_is_absolute() {
        // A relative path here would resolve against whatever directory the
        // app happened to be started from.
        for candidate in CANDIDATES {
            for path in candidate.fallback_paths {
                assert!(
                    PathBuf::from(path).is_absolute(),
                    "{path} should be absolute"
                );
            }
        }
    }

    #[test]
    fn every_candidate_is_complete_and_uniquely_named() {
        assert!(!CANDIDATES.is_empty());
        for candidate in CANDIDATES {
            assert!(!candidate.executables.is_empty(), "{}", candidate.name);
            for exe in candidate.executables {
                assert!(
                    !exe.contains('\\') && !exe.contains('/'),
                    "{exe} should be a bare executable name"
                );
            }
        }
        let names: std::collections::HashSet<_> = CANDIDATES.iter().map(|c| c.name).collect();
        assert_eq!(names.len(), CANDIDATES.len(), "duplicate player names");
    }
}
