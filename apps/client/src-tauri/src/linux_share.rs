//! "Share with Basalt" in GNOME Files (Nautilus), Ubuntu's file manager.
//!
//! Files has no right-click entries for apps, but every person's own
//! scripts folder shows under right-click > Scripts. So the app puts one
//! there as it starts (and keeps its path right: an AppImage moves), when
//! Files is on the computer. Dolphin (KDE) and Nemo (Mint) have theirs in
//! the packages, in the system's folders.
//!
//! Not an "Open With" entry: one taking every file made GNOME pick it to
//! open text files with a double click.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::PathBuf;

/// The script's name, as Files shows it.
const NAME: &str = "Share with Basalt";

/// The script: the files chosen in Files (their full paths, one a line),
/// handed to Basalt to share.
pub fn script(exe: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # Basalt's: the files chosen in Files, to share. Written by Basalt as it starts.\n\
         IFS='\n'\n\
         set -f\n\
         if [ -n \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\" ]; then set -- $NAUTILUS_SCRIPT_SELECTED_FILE_PATHS; fi\n\
         exec {} --share \"$@\"\n",
        quoted(exe)
    )
}

/// A path as one word for the shell.
fn quoted(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// Where Files looks for this person's scripts.
fn folder() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(data.join("nautilus").join("scripts"))
}

/// Puts the script in place, or puts it right, when Files is here.
#[cfg(target_os = "linux")]
pub fn install() {
    if !std::path::Path::new("/usr/bin/nautilus").exists() {
        return;
    }
    // The AppImage runs from a temporary mount: its own file is $APPIMAGE.
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    let (Some(exe), Some(folder)) = (exe, folder()) else {
        return;
    };
    let path = folder.join(NAME);
    let wanted = script(&exe.to_string_lossy());
    if std::fs::read_to_string(&path).is_ok_and(|now| now == wanted) {
        return;
    }
    if std::fs::create_dir_all(&folder).is_err() || std::fs::write(&path, wanted).is_err() {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_hands_the_chosen_files_to_basalt() {
        let text = script("/home/o'neil/Apps/Basalt.AppImage");
        assert!(text.starts_with("#!/bin/sh\n"));
        assert!(text.contains("exec '/home/o'\\''neil/Apps/Basalt.AppImage' --share \"$@\"\n"));
        assert!(text.contains("set -f\n"), "names are never globbed");
        assert!(text.contains("IFS='\n'\n"), "one path a line");
    }
}
