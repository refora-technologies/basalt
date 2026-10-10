//! Keeping the host up to date.
//!
//! One updater for every kind of host, owned by the host rather than by its
//! window: the window, the screenless program and a device that manages the
//! host all see and start the same thing. A host nobody looks at is exactly
//! the one that falls behind, so it checks by itself, and with automatic
//! updates on (the default) puts a new version in when nothing is being
//! watched or copied.
//!
//! **What a device may ask.** Only "check now", "update to the newest release
//! now", and automatic updates on or off. Never a version, a source or a file:
//! every update is the newest official release, and every download is checked
//! against the SHA-256 published beside it (see `basalt-update`).
//!
//! **How it goes in** depends on how this copy was installed ([`Method`]):
//! the Windows installer; an AppImage replacing itself; a Linux package,
//! through a small helper run as root (`pkexec` for the person at the
//! computer, a systemd unit for the screenless host); or, in Docker and for a
//! copy put in place by hand, by being told what to run.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{HostError, Result};
use crate::server::Host;

/// The helper that installs a Linux package as root.
pub const HELPER: &str = "/usr/lib/basalt-host/basalt-host-update";

/// Beside the config: the screenless host asks for an update by making this
/// file, and the root helper's systemd unit, watching for it, does the rest.
/// What is in it is never read.
pub const REQUEST_FILE: &str = "update-request";

/// Beside the config: what the helper did, written by it as root, read and
/// removed by the host when it starts again.
pub const RESULT_FILE: &str = "update-result.json";

/// Beside the config: the last check, for `basalt-host status`, which runs as
/// its own process and cannot ask the host.
pub const STATE_FILE: &str = "update.json";

/// How often the host looks for a new release.
const EVERY: Duration = Duration::from_secs(12 * 60 * 60);

/// The first look, once the host has settled after starting.
const FIRST: Duration = Duration::from_secs(60);

/// How this copy is updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// The Windows installer, run over this copy.
    Installer,
    /// An AppImage, replaced by the new one.
    AppImage,
    /// A desktop `.deb` or `.rpm`, through the helper and `pkexec`.
    Package,
    /// The screenless host's package, through the helper's systemd unit.
    Service,
    /// Docker: a new image is pulled by whoever runs the container.
    Container,
    /// Anything else: told where the new version is.
    Manual,
}

impl Method {
    pub fn can_install(self) -> bool {
        matches!(
            self,
            Method::Installer | Method::AppImage | Method::Package | Method::Service
        )
    }

    /// What a person runs instead, where the host cannot update itself.
    fn command(self) -> Option<&'static str> {
        match self {
            Method::Container => Some("docker compose pull && docker compose up -d"),
            Method::Manual => Some("https://github.com/refora-technologies/basalt/releases/latest"),
            _ => None,
        }
    }
}

/// What the shell does to finish an update the host has prepared: only a
/// window can close itself and start its successor.
pub enum Finish {
    /// Run this verified Windows installer, then close.
    RunInstaller(PathBuf),
    /// The new version is in place: start it and close.
    Restart,
}

type Finisher = Box<dyn Fn(Finish) + Send + Sync>;

/// Where an update is up to.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Stage {
    #[default]
    Idle,
    Checking,
    Downloading {
        percent: u8,
    },
    Installing,
    Failed {
        why: String,
    },
}

/// A newer release, as a person reads about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub version: String,
    pub notes: String,
    pub page_url: String,
}

/// What the helper did, kept across the restart it causes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub version: String,
    pub ok: bool,
    pub message: String,
    pub at: i64,
}

/// The last check, as `basalt-host status` reads it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub checked_at: Option<i64>,
    pub available: Option<String>,
}

/// Everything a screen shows about updates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    /// The version running.
    pub version: String,
    pub method: Method,
    pub can_install: bool,
    pub automatic: bool,
    pub available: Option<Offer>,
    pub stage: Stage,
    pub checked_at: Option<i64>,
    /// What to run, where the host cannot update itself.
    pub command: Option<String>,
    /// The last update the helper put in, or why it could not.
    pub outcome: Option<Outcome>,
}

/// The host's updater state. See the module documentation.
#[derive(Default)]
pub struct Updates {
    method: Mutex<Option<Method>>,
    finisher: OnceLock<Finisher>,
    state: Mutex<State>,
    started: AtomicBool,
}

#[derive(Default)]
struct State {
    release: Option<basalt_update::Release>,
    stage: Stage,
    checked_at: Option<i64>,
    outcome: Option<Outcome>,
}

/// How a screenless host started from `config_path` is updated: in Docker,
/// by its image; as the packaged service, by the helper's unit; otherwise by
/// hand. Also for `basalt-host status`.
pub fn headless_method(config_path: &Path) -> Method {
    let in_container =
        std::env::var_os("BASALT_CONTAINER").is_some() || Path::new("/.dockerenv").exists();
    if in_container {
        return Method::Container;
    }
    let service = config_path.starts_with("/var/lib/basalt-host")
        && Path::new(HELPER).exists()
        && [
            "/usr/lib/systemd/system/basalt-host-update.path",
            "/lib/systemd/system/basalt-host-update.path",
            "/etc/systemd/system/basalt-host-update.path",
        ]
        .iter()
        .any(|unit| Path::new(unit).exists());
    if service {
        Method::Service
    } else {
        Method::Manual
    }
}

/// The last check, as saved beside the config.
pub fn read_saved(config_path: &Path) -> Saved {
    std::fs::read_to_string(beside(config_path, STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn beside(config_path: &Path, name: &str) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(name)
}

impl Host {
    /// How this copy is updated, said by whoever started it: the window
    /// knows whether it is an installer, an AppImage or a package.
    pub fn set_update_method(&self, method: Method) {
        *self.updates.method.lock().expect("updates lock") = Some(method);
    }

    /// What the window does to finish an update. Set once, by the window.
    pub fn set_update_finisher(&self, finish: impl Fn(Finish) + Send + Sync + 'static) {
        let _ = self.updates.finisher.set(Box::new(finish));
    }

    pub fn update_method(&self) -> Method {
        if let Some(method) = *self.updates.method.lock().expect("updates lock") {
            return method;
        }
        if self.is_headless() {
            headless_method(&self.config_path)
        } else {
            Method::Manual
        }
    }

    pub fn automatic_updates(&self) -> bool {
        self.config.lock().expect("config lock").automatic_updates
    }

    pub fn set_automatic_updates(&self, on: bool) -> Result<()> {
        self.config.lock().expect("config lock").automatic_updates = on;
        self.persist()
    }

    /// Everything a screen shows about updates.
    pub fn update_view(&self) -> UpdateView {
        let method = self.update_method();
        let state = self.updates.state.lock().expect("updates lock");
        UpdateView {
            version: env!("CARGO_PKG_VERSION").to_string(),
            method,
            can_install: method.can_install(),
            automatic: self.automatic_updates(),
            available: state.release.as_ref().map(|r| Offer {
                version: r.version.clone(),
                notes: r.notes.clone(),
                page_url: r.page_url.clone(),
            }),
            stage: state.stage.clone(),
            checked_at: state.checked_at,
            command: method.command().map(str::to_string),
            outcome: state.outcome.clone(),
        }
    }

    fn set_stage(&self, stage: Stage) {
        self.updates.state.lock().expect("updates lock").stage = stage;
    }

    fn busy_updating(&self) -> bool {
        matches!(
            self.updates.state.lock().expect("updates lock").stage,
            Stage::Checking | Stage::Downloading { .. } | Stage::Installing
        )
    }

    /// Starts looking for updates: a minute after starting, then every twelve
    /// hours, and with automatic updates on, puts a new version in when
    /// nothing is being watched or copied. Once per host.
    pub fn start_updates(self: &Arc<Self>) {
        if self.updates.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.read_outcome();
        let host = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(FIRST).await;
            loop {
                // The helper's note can land after this host has started:
                // a package restarts the host before the helper is done.
                host.read_outcome();
                let _ = host.check_for_update(false).await;
                let until = tokio::time::Instant::now() + EVERY;
                // Up to the next check, for a quiet minute to update in.
                while host.wants_automatic_update() && tokio::time::Instant::now() < until {
                    if host.quiet_for_a_minute().await && host.wants_automatic_update() {
                        tracing::info!("nothing is being watched or copied: updating now");
                        let _ = host.install_update();
                        break;
                    }
                }
                tokio::time::sleep_until(until).await;
            }
        });
    }

    /// A newer release is waiting, automatic updates are on, and this copy
    /// can put it in by itself.
    fn wants_automatic_update(&self) -> bool {
        let offered = self
            .updates
            .state
            .lock()
            .expect("updates lock")
            .release
            .is_some();
        offered
            && self.automatic_updates()
            && self.update_method().can_install()
            && !self.busy_updating()
    }

    /// Whether a minute passes with nothing streamed or copied, and nothing
    /// being converted. Takes the minute to find out.
    async fn quiet_for_a_minute(&self) -> bool {
        let moved = |host: &Host| -> u64 { host.traffic().values().map(|t| t.total()).sum() };
        let before = moved(self);
        tokio::time::sleep(Duration::from_secs(60)).await;
        let during = moved(self).saturating_sub(before);
        // A device's own chatter (keeping its connection, a thumbnail) is not
        // somebody watching; a film is megabytes a minute.
        during < 2 * 1024 * 1024 && self.converter.active().is_empty() && !self.busy_updating()
    }

    /// Asks for the newest release. `asked` is a person pressing the button:
    /// a failure is shown then, and only then.
    pub async fn check_for_update(&self, asked: bool) -> Result<()> {
        if self.busy_updating() {
            return Ok(());
        }
        self.set_stage(Stage::Checking);
        let method = self.update_method();
        let current = env!("CARGO_PKG_VERSION");
        use basalt_update::{LinuxPackage, Product};
        let found = match method {
            Method::Installer => basalt_update::check(Product::Host, current).await,
            Method::AppImage => {
                basalt_update::check_linux(Product::Host, current, LinuxPackage::AppImage).await
            }
            Method::Package => {
                basalt_update::check_linux(Product::Host, current, LinuxPackage::here()).await
            }
            // Every release carries the screenless host's tarball for both
            // processors: whether it exists is whether a new version does.
            Method::Service | Method::Container | Method::Manual => {
                basalt_update::check_linux(Product::HostServer, current, LinuxPackage::Tarball)
                    .await
            }
        };
        let now = crate::server::unix_now();
        let result = {
            let mut state = self.updates.state.lock().expect("updates lock");
            match found {
                Ok(release) => {
                    if let Some(release) = &release {
                        tracing::info!("Basalt Host {} is available", release.version);
                    }
                    state.release = release;
                    state.checked_at = Some(now);
                    state.stage = Stage::Idle;
                    Ok(())
                }
                Err(e) => {
                    let why = describe(&e);
                    state.stage = if asked {
                        Stage::Failed { why: why.clone() }
                    } else {
                        Stage::Idle
                    };
                    Err(HostError::Unavailable(why))
                }
            }
        };
        self.save_check();
        result
    }

    fn save_check(&self) {
        let state = self.updates.state.lock().expect("updates lock");
        let saved = Saved {
            checked_at: state.checked_at,
            available: state.release.as_ref().map(|r| r.version.clone()),
        };
        drop(state);
        if let Ok(text) = serde_json::to_string(&saved) {
            let _ = std::fs::write(beside(&self.config_path, STATE_FILE), text);
        }
    }

    /// Puts the newest release in, the way this copy is updated. Returns once
    /// it has started; the stage says how it goes.
    pub fn install_update(self: &Arc<Self>) -> Result<()> {
        let method = self.update_method();
        if !method.can_install() {
            return Err(HostError::BadRequest(match method.command() {
                Some(command) if method == Method::Container => {
                    format!("in Docker, update by pulling the new image: {command}")
                }
                Some(page) => format!("this copy is updated by hand: {page}"),
                None => "this copy cannot update itself".into(),
            }));
        }
        if self.busy_updating() {
            return Ok(());
        }
        let host = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(why) = host.put_update_in(method).await {
                tracing::warn!("the update did not go in: {why}");
                host.set_stage(Stage::Failed { why });
            }
        });
        Ok(())
    }

    async fn put_update_in(self: &Arc<Self>, method: Method) -> std::result::Result<(), String> {
        let release = self
            .updates
            .state
            .lock()
            .expect("updates lock")
            .release
            .clone();
        // Asked before a check found anything: look first.
        let release = match release {
            Some(release) => release,
            None => {
                self.check_for_update(true)
                    .await
                    .map_err(|e| e.to_string())?;
                self.updates
                    .state
                    .lock()
                    .expect("updates lock")
                    .release
                    .clone()
                    .ok_or("this is already the newest version")?
            }
        };
        match method {
            Method::Installer | Method::AppImage => {
                self.set_stage(Stage::Downloading { percent: 0 });
                let into = std::env::temp_dir().join("Basalt Updates");
                let host = Arc::clone(self);
                let path = basalt_update::fetch(&release, &into, move |had, total| {
                    let percent = (had * 100).checked_div(total).unwrap_or(0).min(100) as u8;
                    host.set_stage(Stage::Downloading { percent });
                })
                .await
                .map_err(|e| describe(&e))?;
                self.set_stage(Stage::Installing);
                if method == Method::AppImage {
                    replace_appimage(&path)?;
                    self.finish(Finish::Restart)
                } else {
                    self.finish(Finish::RunInstaller(path))
                }
            }
            Method::Package => {
                self.set_stage(Stage::Installing);
                let output = tokio::process::Command::new("pkexec")
                    .arg(HELPER)
                    .output()
                    .await
                    .map_err(|e| format!("could not ask the system to update Basalt Host ({e})"))?;
                if output.status.success() {
                    self.finish(Finish::Restart)
                } else {
                    let said = String::from_utf8_lossy(&output.stdout);
                    let last = said.lines().rev().find(|l| !l.trim().is_empty());
                    Err(match (output.status.code(), last) {
                        // pkexec: refused, or the window asking was closed.
                        (Some(126 | 127), _) => "the update was not allowed".into(),
                        (_, Some(line)) => line.trim().to_string(),
                        _ => "the update did not go in".into(),
                    })
                }
            }
            Method::Service => {
                self.set_stage(Stage::Installing);
                std::fs::write(beside(&self.config_path, REQUEST_FILE), b"update\n")
                    .map_err(|e| format!("could not ask for the update ({e})"))?;
                // The helper restarts the host when it is done. Still here
                // after that: it said why, or never ran.
                for _ in 0..120 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    if let Some(outcome) = self.take_outcome()
                        && !outcome.ok
                    {
                        return Err(outcome.message);
                    }
                }
                Err(
                    "the update service did not run. Run `sudo systemctl status \
                     basalt-host-update` to see why."
                        .into(),
                )
            }
            Method::Container | Method::Manual => Err("this copy cannot update itself".into()),
        }
    }

    fn finish(&self, finish: Finish) -> std::result::Result<(), String> {
        match self.updates.finisher.get() {
            Some(finisher) => {
                finisher(finish);
                Ok(())
            }
            None => Err("this copy cannot restart itself".into()),
        }
    }

    /// What the helper did before the restart it caused, said once.
    fn read_outcome(&self) {
        if let Some(outcome) = self.take_outcome() {
            if outcome.ok {
                tracing::info!("{}", outcome.message);
            } else {
                tracing::warn!("the last update did not go in: {}", outcome.message);
            }
            self.updates.state.lock().expect("updates lock").outcome = Some(outcome);
        }
    }

    fn take_outcome(&self) -> Option<Outcome> {
        let path = beside(&self.config_path, RESULT_FILE);
        let text = std::fs::read_to_string(&path).ok()?;
        let _ = std::fs::remove_file(&path);
        serde_json::from_str(&text).ok()
    }
}

/// An AppImage is one file: the new one is written beside it, made
/// runnable, and moved over it in one step, so a failure part way leaves the
/// old copy as it was.
#[cfg(unix)]
fn replace_appimage(path: &Path) -> std::result::Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let current = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or("this copy is not an AppImage")?;
    let incoming = current.with_extension("new");
    std::fs::copy(path, &incoming)
        .map_err(|e| format!("could not put the update in place: {e}"))?;
    std::fs::set_permissions(&incoming, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("could not make the update runnable: {e}"))?;
    std::fs::rename(&incoming, &current)
        .map_err(|e| format!("could not replace the old version: {e}"))
}

#[cfg(not(unix))]
fn replace_appimage(_path: &Path) -> std::result::Result<(), String> {
    Err("an AppImage is Linux only".into())
}

/// An update failure, said plainly.
fn describe(e: &basalt_update::UpdateError) -> String {
    use basalt_update::UpdateError as E;
    match e {
        E::Network(_) | E::Status(_) => {
            "Couldn't reach the update server. Check this computer's internet connection.".into()
        }
        E::ChecksumMismatch => {
            "The download didn't match its published checksum, so it was thrown away. Try again \
             later."
                .into()
        }
        E::Stalled => "The download stopped part way. Try again.".into(),
        E::NoInstaller => "The new version has no download for this computer yet.".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_methods_that_can_install_say_so() {
        assert!(Method::Installer.can_install());
        assert!(Method::Service.can_install());
        assert!(!Method::Container.can_install());
        assert!(!Method::Manual.can_install());
        assert!(
            Method::Container
                .command()
                .unwrap()
                .contains("docker compose pull")
        );
    }

    #[test]
    fn a_host_started_by_hand_is_updated_by_hand() {
        if std::env::var_os("BASALT_CONTAINER").is_some() || Path::new("/.dockerenv").exists() {
            return;
        }
        assert_eq!(
            headless_method(Path::new("/home/someone/.config/basalt/host.json")),
            Method::Manual
        );
    }

    #[test]
    fn the_last_check_is_read_back_or_nothing() {
        let dir = std::env::temp_dir().join(format!("basalt-updates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("host.json");
        assert!(read_saved(&config).checked_at.is_none());
        std::fs::write(
            dir.join(STATE_FILE),
            r#"{"checkedAt":5,"available":"9.0.0"}"#,
        )
        .unwrap();
        let saved = read_saved(&config);
        assert_eq!(saved.checked_at, Some(5));
        assert_eq!(saved.available.as_deref(), Some("9.0.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
