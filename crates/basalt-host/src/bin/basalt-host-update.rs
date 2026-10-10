//! `basalt-host-update` — puts the newest Basalt Host release in, as root.
//!
//! Run two ways, never by a person:
//!
//! - by `pkexec`, for the host with a window, when somebody at the computer
//!   (or a device that manages the host) asks for the update. Polkit lets the
//!   active local session run it without a password, and nothing else;
//! - by `basalt-host-update.service`, for the screenless host, which a systemd
//!   path unit starts when the host (running as its own unprivileged user)
//!   leaves a request file beside its settings. With `--service` it writes
//!   what it did beside them for the host to read when it starts again.
//!
//! **It takes nothing from whoever started it.** No version, no address, no
//! file: it finds which Basalt Host package is installed, asks GitHub for the
//! newest release, downloads that release's file for this package and
//! processor into a folder only root can write to, checks it against the
//! SHA-256 published beside it, and installs it with the system's own package
//! tools. The most anyone able to start it can do is update Basalt Host to the
//! newest official version.

#[cfg(target_os = "linux")]
fn main() {
    let service = std::env::args().any(|a| a == "--service");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let outcome = runtime.block_on(linux::run(service));
    let (ok, message) = match &outcome {
        Ok(message) => (true, message.clone()),
        Err(message) => (false, message.clone()),
    };
    println!("{message}");
    if service {
        linux::write_outcome(ok, &message);
    }
    std::process::exit(if ok { 0 } else { 1 });
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("basalt-host-update is for Linux only");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use basalt_update::{LinuxPackage, Product};

    /// Where the screenless host keeps its settings, and so its request and
    /// this helper's answer.
    const STATE_DIR: &str = "/var/lib/basalt-host";
    /// Root's own: downloads are never put anywhere the host's user can write.
    const CACHE_DIR: &str = "/var/cache/basalt-host/updates";

    pub async fn run(service: bool) -> Result<String, String> {
        // SAFETY: geteuid has no preconditions and cannot fail.
        if unsafe { libc::geteuid() } != 0 {
            return Err("basalt-host-update must be run by the system, as root".into());
        }
        if service {
            // Gone first, so the path unit does not start this again.
            let _ = std::fs::remove_file(Path::new(STATE_DIR).join("update-request"));
        }
        let (product, package, current) =
            installed(service).ok_or("Basalt Host is not installed as a package here")?;

        let release = basalt_update::check_linux(product, &current, package)
            .await
            .map_err(|e| format!("Couldn't check for a new version: {e}"))?;
        let Some(release) = release else {
            return Ok(format!(
                "Basalt Host {current} is already the newest version."
            ));
        };

        let cache = cache_dir()?;
        let file = basalt_update::fetch(&release, &cache, |_, _| {})
            .await
            .map_err(|e| format!("Couldn't download Basalt Host {}: {e}", release.version))?;
        let installed = install(package, &file);
        let _ = std::fs::remove_file(&file);
        installed?;
        Ok(format!("Basalt Host updated to {}.", release.version))
    }

    /// Which Basalt Host is installed, how, and which version.
    fn installed(service: bool) -> Option<(Product, LinuxPackage, String)> {
        for (name, product) in [
            ("basalt-host-server", Product::HostServer),
            ("basalt-host", Product::Host),
        ] {
            if let Some(version) = query("dpkg-query", &["-W", "-f=${Status}|${Version}", name])
                .and_then(|out| {
                    let (status, version) = out.split_once('|')?;
                    status.ends_with("installed").then(|| version.to_string())
                })
            {
                return Some((product, LinuxPackage::Deb, upstream(&version)));
            }
            if let Some(version) = query("rpm", &["-q", "--qf", "%{VERSION}", name]) {
                return Some((product, LinuxPackage::Rpm, version));
            }
        }
        // The screenless host from its .tar.gz, put in place by hand with
        // this helper and its unit beside it.
        if service && Path::new("/usr/bin/basalt-host").exists() {
            let version = query("/usr/bin/basalt-host", &["--version"])
                .and_then(|out| out.split_whitespace().last().map(str::to_string))?;
            return Some((Product::HostServer, LinuxPackage::Tarball, version));
        }
        None
    }

    /// `1.5.0-1` as a package spells it, as releases do: `1.5.0`.
    fn upstream(version: &str) -> String {
        version.split('-').next().unwrap_or(version).to_string()
    }

    fn query(program: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(program).args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn has(program: &str) -> bool {
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .iter()
            .any(|dir| Path::new(dir).join(program).exists())
    }

    fn cache_dir() -> Result<PathBuf, String> {
        use std::os::unix::fs::PermissionsExt;
        let dir = PathBuf::from(CACHE_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make {CACHE_DIR}: {e}"))?;
        let meta = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!("{CACHE_DIR} is not a plain folder"));
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        Ok(dir)
    }

    fn install(package: LinuxPackage, file: &Path) -> Result<(), String> {
        let run = |program: &str, args: &[&str]| -> Result<(), String> {
            let status = Command::new(program)
                .args(args)
                .arg(file)
                .env("DEBIAN_FRONTEND", "noninteractive")
                .status()
                .map_err(|e| format!("Couldn't run {program}: {e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("{program} couldn't install the update ({status})"))
            }
        };
        match package {
            LinuxPackage::Deb if has("apt-get") => run(
                "apt-get",
                &[
                    "install",
                    "-y",
                    "-o",
                    "Dpkg::Options::=--force-confdef",
                    "-o",
                    "Dpkg::Options::=--force-confold",
                ],
            ),
            LinuxPackage::Deb => run("dpkg", &["-i"]),
            LinuxPackage::Rpm if has("dnf") => run("dnf", &["install", "-y"]),
            LinuxPackage::Rpm if has("zypper") => run(
                "zypper",
                &["--non-interactive", "install", "--allow-unsigned-rpm"],
            ),
            LinuxPackage::Rpm => run("rpm", &["-U"]),
            LinuxPackage::Tarball => install_tarball(file),
            LinuxPackage::AppImage => Err("an AppImage updates itself".into()),
        }
    }

    /// The `.tar.gz`: its program (and this helper) copied over the ones in
    /// place, each in one step, then the service restarted.
    fn install_tarball(file: &Path) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let unpacked = Path::new(CACHE_DIR).join("unpacked");
        let _ = std::fs::remove_dir_all(&unpacked);
        std::fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(file)
            .arg("-C")
            .arg(&unpacked)
            .status()
            .map_err(|e| format!("Couldn't run tar: {e}"))?;
        if !status.success() {
            return Err("Couldn't unpack the update".into());
        }
        let found = |name: &str| -> Option<PathBuf> {
            std::fs::read_dir(&unpacked)
                .ok()?
                .flatten()
                .map(|entry| entry.path().join(name))
                .find(|path| path.is_file())
        };
        let program = found("basalt-host").ok_or("the update has no basalt-host in it")?;
        for (from, to) in [
            (Some(program), "/usr/bin/basalt-host"),
            (found("basalt-host-update"), super::HELPER_PATH),
        ] {
            let Some(from) = from else { continue };
            let to = Path::new(to);
            if !to.exists() {
                continue;
            }
            let incoming = to.with_extension("new");
            std::fs::copy(&from, &incoming).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&incoming, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
            std::fs::rename(&incoming, to).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(&unpacked);
        let _ = Command::new("systemctl")
            .args(["restart", "basalt-host"])
            .status();
        Ok(())
    }

    /// What was done, beside the host's settings, for the host to read when it
    /// starts again. Written to a new file and renamed into place, so a link
    /// left where it goes is replaced rather than followed; given to the
    /// folder's owner, the host's user, who reads and removes it.
    pub fn write_outcome(ok: bool, message: &str) {
        use std::io::Write;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let dir = Path::new(STATE_DIR);
        let Ok(meta) = std::fs::symlink_metadata(dir) else {
            return;
        };
        if !meta.is_dir() {
            return;
        }
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let version = message
            .split_whitespace()
            .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .unwrap_or("")
            .trim_end_matches('.')
            .to_string();
        let body = serde_json::json!({
            "version": version,
            "ok": ok,
            "message": message,
            "at": at,
        });
        let temp = dir.join(format!(".update-result-{}", std::process::id()));
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp)
            .and_then(|mut file| {
                file.write_all(body.to_string().as_bytes())?;
                std::os::unix::fs::fchown(&file, Some(meta.uid()), Some(meta.gid()))
            });
        if written.is_ok() {
            let _ = std::fs::rename(&temp, dir.join("update-result.json"));
        } else {
            let _ = std::fs::remove_file(&temp);
        }
    }
}

/// Where this helper is installed.
#[cfg(target_os = "linux")]
const HELPER_PATH: &str = basalt_host::updates::HELPER;
