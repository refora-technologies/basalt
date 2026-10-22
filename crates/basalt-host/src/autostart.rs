//! Starting with Windows.
//!
//! A value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which is
//! the per-user autostart list. Deliberately per-user rather than the
//! machine-wide `HKLM` equivalent or a scheduled task: `HKCU` needs no
//! administrator, is visible to the user in Task Manager's Startup tab where
//! they can turn it off without this app, and is removed cleanly by writing one
//! value away.
//!
//! A host that only serves while somebody is logged in is the right trade for a
//! laptop in a spare room. Running before login would mean a service, and a
//! service means an installer that needs elevation for something nobody asked
//! for.

use std::path::Path;

/// The value name. Also what appears in Task Manager's Startup tab.
#[cfg(not(test))]
const VALUE_NAME: &str = "Basalt Host";
/// The tests' own entry, never the real one. They once used the real one and
/// "restored" it by writing it again, from the test program: every test run
/// pointed the developer's own startup entry at a test program, which Task
/// Manager showed as `basalt_host-<hash>` and which never started the host.
#[cfg(test)]
const VALUE_NAME: &str = "Basalt Host (test)";
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Passed by the startup entry so the app knows it was not opened on purpose.
///
/// A window that throws itself over the desktop at every login is precisely the
/// kind of thing that gets an app turned off, and the host has nothing to say
/// at startup anyway — it serves whether or not anyone is looking at it.
pub const STARTUP_FLAG: &str = "--startup";

/// Whether Windows started this program rather than the user.
pub fn launched_at_startup() -> bool {
    std::env::args().skip(1).any(|arg| arg == STARTUP_FLAG)
}

/// Whether this program is registered to start with Windows.
pub fn is_enabled() -> bool {
    read_value().is_some()
}

/// The command currently registered, if any.
pub fn registered_command() -> Option<String> {
    read_value()
}

/// Registers or unregisters this executable.
///
/// Always writes the *current* executable's path, so moving or reinstalling the
/// app and toggling this again corrects a stale entry rather than leaving one
/// pointing at a file that is no longer there.
pub fn set_enabled(enabled: bool) -> std::io::Result<()> {
    if !enabled {
        return delete_value();
    }
    let exe = std::env::current_exe()?;
    write_value(&exe)
}

/// Points an entry that names some other program at this one: a copy since
/// moved, or another program altogether, as the tests once wrote there (see
/// VALUE_NAME). One that names this program, or no entry, is left alone: the
/// setting stays the person's. Whether anything was written.
pub fn repair() -> std::io::Result<bool> {
    let Some(command) = read_value() else {
        return Ok(false);
    };
    let exe = std::env::current_exe()?;
    if names(&command, &exe) {
        return Ok(false);
    }
    write_value(&exe)?;
    Ok(true)
}

/// Whether a registered command starts `exe`: the same program, by its file
/// name, and a file that is there.
fn names(command: &str, exe: &Path) -> bool {
    let program = command
        .strip_prefix('"')
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_else(|| command.split_whitespace().next().unwrap_or(""));
    let registered = Path::new(program);
    registered.file_name() == exe.file_name() && registered.exists()
}

/// The command line that would be registered, quoted for the registry.
fn command_for(exe: &Path) -> String {
    // Quoted because `C:\Program Files\…` contains a space, and an unquoted
    // path there is a classic way to have Windows run the wrong program.
    format!("\"{}\" {STARTUP_FLAG}", exe.display())
}

#[cfg(windows)]
fn read_value() -> Option<String> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};

    let subkey = wide(RUN_KEY);
    let name = wide(VALUE_NAME);
    let mut buffer = [0u16; 1024];
    let mut size = std::mem::size_of_val(&buffer) as u32;

    // SAFETY: both strings are NUL-terminated and outlive the call, and the
    // buffer and its size are consistent.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buffer[..chars]))
}

#[cfg(windows)]
fn write_value(exe: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ, RegCloseKey, RegOpenKeyExW, RegSetValueExW,
    };

    let subkey = wide(RUN_KEY);
    let name = wide(VALUE_NAME);
    let value = wide(&command_for(exe));

    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: `subkey` is NUL-terminated, and `key` is a valid out-parameter.
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(std::io::Error::other(format!(
            "could not open the startup list ({status})"
        )));
    }

    // SAFETY: `value` is a NUL-terminated wide string and the length counts its
    // bytes including that terminator, as `REG_SZ` requires.
    let status = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            REG_SZ,
            value.as_ptr().cast(),
            (value.len() * 2) as u32,
        )
    };
    // SAFETY: `key` came from a successful open and is not used afterwards.
    unsafe { RegCloseKey(key) };

    if status != ERROR_SUCCESS {
        return Err(std::io::Error::other(format!(
            "could not write the startup entry ({status})"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn delete_value() -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyValueW};

    let subkey = wide(RUN_KEY);
    let name = wide(VALUE_NAME);

    // SAFETY: both strings are NUL-terminated and outlive the call.
    let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr()) };

    // Already absent is the state that was asked for, not a failure.
    if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "could not remove the startup entry ({status})"
        )))
    }
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// Linux: an entry in `~/.config/autostart`, which every desktop that follows
// the XDG autostart convention (GNOME, KDE, Xfce, Cinnamon and the rest) starts
// at login.

#[cfg(not(windows))]
fn autostart_file() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    // The tests' own file, as on Windows: see VALUE_NAME.
    let name = if cfg!(test) {
        "basalt-host-test.desktop"
    } else {
        "basalt-host.desktop"
    };
    Some(base.join("autostart").join(name))
}

#[cfg(not(windows))]
fn read_value() -> Option<String> {
    let text = std::fs::read_to_string(autostart_file()?).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("Exec="))
        .map(str::to_string)
}

#[cfg(not(windows))]
fn write_value(exe: &Path) -> std::io::Result<()> {
    let file = autostart_file()
        .ok_or_else(|| std::io::Error::other("there is no home folder to start from"))?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // An AppImage runs from a mount that changes every time; what starts it
    // again is the AppImage file itself, which it is told in `APPIMAGE`.
    let program = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| exe.to_path_buf());
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={VALUE_NAME}\nComment=Share a drive with your own devices\nExec={}\nIcon=basalt-host\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        command_for(&program)
    );
    std::fs::write(file, entry)
}

#[cfg(not(windows))]
fn delete_value() -> std::io::Result<()> {
    match autostart_file() {
        Some(file) => match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_spaces_is_quoted() {
        // `C:\Program Files\…` is the normal case, and an unquoted path there
        // is a well-known way to have Windows run something else entirely.
        let command = command_for(Path::new(r"C:\Program Files\Basalt\host.exe"));
        assert!(command.starts_with('"'));
        assert!(command.contains("Program Files"));
        assert!(
            command.starts_with(r#""C:\Program Files\Basalt\host.exe""#),
            "the quotes must close before the arguments start, got {command}"
        );
    }

    #[test]
    fn the_startup_entry_says_it_is_the_startup_entry() {
        let command = command_for(Path::new(r"C:\Basalt\host.exe"));
        assert!(command.ends_with(STARTUP_FLAG), "got {command}");
    }

    #[test]
    fn a_normal_launch_is_not_a_startup_launch() {
        // The test runner's own arguments stand in for a hand launch; none of
        // them is the flag.
        assert!(!launched_at_startup());
    }

    #[test]
    fn reading_the_setting_never_panics() {
        // Whether it is on depends on the machine; what matters is that asking
        // is safe and gives an answer either way.
        let _ = is_enabled();
        let _ = registered_command();
    }

    // On its own entry (see VALUE_NAME), so the developer's own startup list
    // is never touched, and left removed afterwards.
    #[cfg(windows)]
    #[test]
    fn turning_it_on_and_off_round_trips() {
        set_enabled(true).expect("writing to HKCU needs no administrator");
        assert!(is_enabled());
        let command = registered_command().unwrap();
        assert!(command.contains(".exe"), "got {command}");
        assert!(command.starts_with('"'), "the path must be quoted");
        assert!(command.ends_with(STARTUP_FLAG), "got {command}");

        set_enabled(false).expect("removing it again");
        assert!(!is_enabled());

        // Removing something already absent is the state asked for.
        set_enabled(false).expect("idempotent");
    }

    /// A command names this program only when it is the same file name and
    /// the file is there: a test program, or a copy since removed, does not.
    #[test]
    fn an_entry_names_this_program_only_when_it_is_this_program() {
        let exe = std::env::current_exe().unwrap();
        assert!(names(&command_for(&exe), &exe));
        let other = exe.with_file_name("basalt-host-shell.exe");
        assert!(!names(&command_for(&other), &exe));
        let gone = exe.with_extension("gone");
        assert!(!names(&command_for(&gone), &gone));
    }

    /// The tests never use the real entry, whatever they do with theirs.
    #[test]
    fn the_tests_have_an_entry_of_their_own() {
        assert_ne!(VALUE_NAME, "Basalt Host");
    }
}
