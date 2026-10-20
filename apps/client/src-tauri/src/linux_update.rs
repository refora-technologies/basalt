//! Installing an update on Linux, the way this copy was installed.
//!
//! On Windows the downloaded installer runs itself. On Linux the download is
//! a package, which cannot be run: an AppImage replaces this one, and a
//! `.deb` or `.rpm` goes through the system's package manager, which asks for
//! the administrator's password as installing software always does there.

use std::path::{Path, PathBuf};
use std::process::Command;

use basalt_update::LinuxPackage;

/// Installs the package at `path`, and says what to start afterwards: the
/// new copy of the app.
pub async fn install(path: &Path) -> Result<PathBuf, String> {
    match LinuxPackage::here() {
        LinuxPackage::AppImage => replace_appimage(path),
        package => {
            let command = package_command(package, path, |program| on_path(program).is_some())
                .ok_or("no package manager here could install it")?;
            let path = path.to_path_buf();
            let status = tauri::async_runtime::spawn_blocking(move || {
                Command::new("pkexec").args(&command).status()
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| {
                format!(
                    "couldn’t ask for permission to install it ({e}). The update is at {}",
                    path.display()
                )
            })?;
            match status.code() {
                Some(0) => std::env::current_exe().map_err(|e| e.to_string()),
                // pkexec: the password was not given, or the person said no.
                Some(126 | 127) => {
                    Err("The update was not installed: permission was not given.".into())
                }
                _ => Err(format!(
                    "The package manager could not install the update ({status}). It is at {}",
                    path.display()
                )),
            }
        }
    }
}

/// The command that installs `path` as a package of `kind`, from the first
/// package manager this system has (`has` says which are here).
fn package_command(
    kind: LinuxPackage,
    path: &Path,
    has: impl Fn(&str) -> bool,
) -> Option<Vec<String>> {
    let file = path.to_string_lossy().to_string();
    let with = |words: &[&str]| -> Vec<String> {
        words
            .iter()
            .map(|w| w.to_string())
            .chain([file.clone()])
            .collect()
    };
    match kind {
        // apt resolves what the package needs; dpkg alone does not.
        LinuxPackage::Deb if has("apt-get") => Some(with(&["apt-get", "install", "-y"])),
        LinuxPackage::Deb if has("dpkg") => Some(with(&["dpkg", "-i"])),
        LinuxPackage::Rpm if has("dnf") => Some(with(&["dnf", "install", "-y"])),
        LinuxPackage::Rpm if has("zypper") => {
            Some(with(&["zypper", "--non-interactive", "install"]))
        }
        LinuxPackage::Rpm if has("rpm") => Some(with(&["rpm", "-U"])),
        _ => None,
    }
}

/// The AppImage this copy runs from, replaced by the new one: written beside
/// it first, so a failed copy leaves the old one whole.
fn replace_appimage(new: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let current =
        PathBuf::from(std::env::var_os("APPIMAGE").ok_or("this copy is not an AppImage")?);
    let staged = current.with_extension("new");
    std::fs::copy(new, &staged)
        .map_err(|e| format!("couldn’t write the update beside the app: {e}"))?;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    std::fs::rename(&staged, &current)
        .map_err(|e| format!("couldn’t put the update in place: {e}"))?;
    Ok(current)
}

fn on_path(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_goes_through_the_manager_the_system_has() {
        let file = Path::new("/tmp/Basalt-Client-Linux-amd64.deb");
        let ubuntu = |p: &str| ["apt-get", "dpkg"].contains(&p);
        assert_eq!(
            package_command(LinuxPackage::Deb, file, ubuntu).unwrap(),
            [
                "apt-get",
                "install",
                "-y",
                "/tmp/Basalt-Client-Linux-amd64.deb"
            ]
        );
        let bare = |p: &str| p == "dpkg";
        assert_eq!(
            package_command(LinuxPackage::Deb, file, bare).unwrap()[0],
            "dpkg"
        );

        let rpm = Path::new("/tmp/Basalt-Client-Linux-x86_64.rpm");
        let fedora = |p: &str| ["dnf", "rpm"].contains(&p);
        assert_eq!(
            package_command(LinuxPackage::Rpm, rpm, fedora).unwrap()[0],
            "dnf"
        );
        let suse = |p: &str| ["zypper", "rpm"].contains(&p);
        assert_eq!(
            package_command(LinuxPackage::Rpm, rpm, suse).unwrap()[0],
            "zypper"
        );
        assert!(package_command(LinuxPackage::Rpm, rpm, |_| false).is_none());
    }
}
