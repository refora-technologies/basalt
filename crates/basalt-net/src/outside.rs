//! Programs of the computer's own (nmcli, pkexec, gdbus, a film player),
//! started from Basalt.
//!
//! An AppImage runs with its own libraries first: its start script points
//! `LD_LIBRARY_PATH`, GTK's and GIO's settings at the files inside it. A
//! program of the computer's own, started with those, loads the AppImage's
//! older libraries and stops at once ("gdbus: undefined symbol"). Seen on
//! Ubuntu 26.04: Basalt thought there was no tray, so closing the window left
//! it running with no way back. Everything pointing into the AppImage is
//! taken away; what the person set themselves is kept.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Command;

/// `program`, to be started as if from the desktop rather than from inside
/// an AppImage. Outside an AppImage, plain `Command::new`.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    if std::env::var_os("APPIMAGE").is_some()
        && let Some(appdir) = std::env::var_os("APPDIR")
    {
        for (key, value) in std::env::vars_os() {
            match outside(&key, &value, Path::new(&appdir)) {
                Some(kept) if kept != value => {
                    command.env(&key, kept);
                }
                Some(_) => {}
                None => {
                    command.env_remove(&key);
                }
            }
        }
    }
    command
}

/// What a setting becomes outside the AppImage at `appdir`: the same if it
/// doesn't point into it, without the parts that do, or nothing at all.
fn outside(key: &OsStr, value: &OsStr, appdir: &Path) -> Option<OsString> {
    // Set by the AppImage's start script for its own GTK, whatever the
    // desktop uses.
    if key == "GTK_THEME" || key == "GDK_BACKEND" {
        return None;
    }
    let inside = |path: &Path| path.starts_with(appdir);
    let text = value.to_string_lossy();
    if !text.contains(&*appdir.to_string_lossy()) {
        return Some(value.to_os_string());
    }
    let kept: Vec<_> = std::env::split_paths(value)
        .filter(|path| !path.as_os_str().is_empty() && !inside(path))
        .collect();
    if kept.is_empty() {
        return None;
    }
    std::env::join_paths(kept).ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::outside;
    use std::ffi::OsStr;
    use std::path::Path;

    const APPDIR: &str = "/tmp/.mount_BasaltgmPGDi";

    fn after(key: &str, value: &str) -> Option<String> {
        outside(OsStr::new(key), OsStr::new(value), Path::new(APPDIR))
            .map(|v| v.to_string_lossy().into_owned())
    }

    #[test]
    fn library_paths_into_the_appimage_are_dropped() {
        let value = format!("{APPDIR}/usr/lib/:{APPDIR}/usr/lib/x86_64-linux-gnu/:");
        assert_eq!(after("LD_LIBRARY_PATH", &value), None);
    }

    #[test]
    fn the_persons_own_entries_are_kept() {
        let value = format!("{APPDIR}/usr/share:/usr/share:/usr/local/share");
        assert_eq!(
            after("XDG_DATA_DIRS", &value).as_deref(),
            Some("/usr/share:/usr/local/share")
        );
        assert_eq!(
            after("PATH", "/usr/local/bin:/usr/bin").as_deref(),
            Some("/usr/local/bin:/usr/bin")
        );
    }

    #[test]
    fn single_paths_into_the_appimage_go() {
        let value = format!("{APPDIR}/usr/lib/x86_64-linux-gnu/gio/modules");
        assert_eq!(after("GIO_EXTRA_MODULES", &value), None);
        assert_eq!(after("GTK_DATA_PREFIX", APPDIR), None);
    }

    #[test]
    fn settings_that_are_not_paths_stay_as_they_are() {
        let bus = "unix:path=/run/user/1000/bus";
        assert_eq!(after("DBUS_SESSION_BUS_ADDRESS", bus).as_deref(), Some(bus));
        assert_eq!(after("GTK_THEME", "Adwaita:dark"), None);
    }

    #[test]
    fn a_folder_merely_starting_with_the_same_letters_is_not_inside() {
        let value = format!("{APPDIR}-other/lib");
        assert_eq!(
            after("LD_LIBRARY_PATH", &value).as_deref(),
            Some(value.as_str())
        );
    }
}
