//! Setting up a host that has no screen.
//!
//! A host in a cupboard, a Raspberry Pi or a Docker container has no window to
//! show a pairing PIN, and nobody to decide who manages it. So the first device
//! is let in by a setup code instead: eight characters the host writes in its
//! own log, and `basalt-host setup-code` prints on the machine. Whoever can read
//! the machine's console is taken to be its owner, which for a box at home is
//! exactly right. The device that pairs with the code becomes the host's first
//! manager, and from then on pairing PINs appear on its Manage host screen.
//!
//! The code is a file beside the config, readable only by the host's own user,
//! and read afresh at every attempt: the command line and the running service
//! never have to talk to each other, and never write the same file. It is used
//! up when a device pairs with it, and replaced after a few wrong guesses, so
//! anyone guessing has to start again from a code they cannot see.
//!
//! Only on the local network: pairing, this included, is never offered over
//! the internet (decided 2026-10-10).
//!
//! The desktop host never enters setup mode: its window is its owner's screen.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use basalt_net::pairing;

use crate::error::{HostError, Result};
use crate::server::Host;

/// Wrong setup codes, across every attempt, before the code is replaced.
pub const MAX_WRONG_CODES: u32 = 10;

/// Where the setup code is kept: beside the host's config.
pub fn code_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("setup-code")
}

/// The setup code waiting to be used, if there is a good one.
pub fn read_code(config_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(code_path(config_path)).ok()?;
    let code = pairing::normalise_code(&text);
    pairing::is_valid_setup_code(&code).then_some(code)
}

/// Makes a new setup code and keeps it, replacing any before it.
pub fn new_code(config_path: &Path) -> Result<String> {
    let code = pairing::generate_setup_code()
        .map_err(|e| HostError::Unavailable(format!("could not make a setup code: {e}")))?;
    let path = code_path(config_path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Written beside and moved into place, so a code half written is never
    // read; readable by this user only, from the moment it exists.
    let temp = path.with_extension("new");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(format!("{}\n", pairing::format_setup_code(&code)).as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, &path)?;
    give_to_folder_owner(&path);
    Ok(code)
}

/// Made by root (`sudo basalt-host setup-code`, `docker exec`), the file
/// would be root's, and the host, running as its own user, could not read it.
/// It belongs to whoever owns the folder it is in: the host's user.
#[cfg(unix)]
fn give_to_folder_owner(path: &Path) {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    if let Some(folder) = path.parent().and_then(|dir| std::fs::metadata(dir).ok()) {
        let _ = std::os::unix::fs::chown(path, Some(folder.uid()), Some(folder.gid()));
    }
}

#[cfg(not(unix))]
fn give_to_folder_owner(_path: &Path) {}

/// Throws the setup code away: used, or no longer wanted.
pub fn remove_code(config_path: &Path) {
    let _ = std::fs::remove_file(code_path(config_path));
}

/// The lines a person reads in the log to set the host up.
pub fn announcement(code: &str) -> String {
    let code = pairing::format_setup_code(code);
    format!(
        "\n  ┌──────────────────────────────────────────────┐\
         \n  │  Set up this host from the Basalt app        │\
         \n  │                                              │\
         \n  │  Setup code:  {code:<31}│\
         \n  │                                              │\
         \n  │  Open Basalt on your phone or computer, on   │\
         \n  │  this network, choose this host, and type    │\
         \n  │  the code. That device will manage the host. │\
         \n  └──────────────────────────────────────────────┘\n"
    )
}

impl Host {
    /// Runs this host with no screen: it can be set up from a device with a
    /// setup code. See the module documentation.
    pub fn set_headless(&self, headless: bool) {
        self.headless.store(headless, Ordering::Relaxed);
    }

    pub fn is_headless(&self) -> bool {
        self.headless.load(Ordering::Relaxed)
    }

    /// How many devices manage this host.
    pub fn managers(&self) -> usize {
        self.devices().iter().filter(|d| d.owner).count()
    }

    /// Whether pairing goes by the setup code now: a host with no screen that
    /// nobody manages, or one given a code on the machine to let a manager in
    /// again.
    pub fn in_setup(&self) -> bool {
        self.is_headless() && (self.managers() == 0 || read_code(&self.config_path).is_some())
    }

    /// The setup code, made now if there is none. `None` outside setup mode.
    pub fn setup_code(&self) -> Result<Option<String>> {
        if !self.in_setup() {
            return Ok(None);
        }
        match read_code(&self.config_path) {
            Some(code) => Ok(Some(code)),
            None => {
                let code = new_code(&self.config_path)?;
                tracing::info!("{}", announcement(&code));
                Ok(Some(code))
            }
        }
    }

    /// After a setup code was tried and was wrong: once [`MAX_WRONG_CODES`]
    /// have been, across every attempt, the code is replaced, and the new one
    /// is in the log. The registry counts them as it checks each one.
    pub(crate) fn check_setup_guesses(&self) {
        {
            let mut registry = self.registry.lock().expect("registry lock");
            if registry.wrong_setup_codes < MAX_WRONG_CODES {
                return;
            }
            registry.wrong_setup_codes = 0;
        }
        match new_code(&self.config_path) {
            Ok(code) => tracing::warn!(
                "the setup code was guessed wrong {MAX_WRONG_CODES} times, so it has been \
                 replaced{}",
                announcement(&code)
            ),
            Err(e) => tracing::error!("could not replace the setup code: {e}"),
        }
    }

    /// A device paired with the setup code: it manages the host now, and the
    /// code is used up.
    pub(crate) fn setup_done(&self, device_name: &str) {
        remove_code(&self.config_path);
        self.registry
            .lock()
            .expect("registry lock")
            .wrong_setup_codes = 0;
        tracing::info!("{device_name} set this host up, and manages it now");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("basalt-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("host.json")
    }

    #[test]
    fn a_code_is_kept_beside_the_config_and_read_back() {
        let config = folder("kept");
        assert_eq!(read_code(&config), None);
        let code = new_code(&config).unwrap();
        assert_eq!(read_code(&config), Some(code.clone()));
        // Written for reading, read however it was written.
        let text = std::fs::read_to_string(code_path(&config)).unwrap();
        assert_eq!(text.trim(), pairing::format_setup_code(&code));
        let again = new_code(&config).unwrap();
        assert_ne!(again, code, "a new code replaces the old one");
        remove_code(&config);
        assert_eq!(read_code(&config), None);
        let _ = std::fs::remove_dir_all(config.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn only_the_hosts_own_user_can_read_the_code() {
        use std::os::unix::fs::PermissionsExt;
        let config = folder("private");
        new_code(&config).unwrap();
        let mode = std::fs::metadata(code_path(&config))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "mode {mode:o}");
        let _ = std::fs::remove_dir_all(config.parent().unwrap());
    }

    #[test]
    fn a_damaged_code_file_is_not_a_code() {
        let config = folder("damaged");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(code_path(&config), "hello").unwrap();
        assert_eq!(read_code(&config), None);
        let _ = std::fs::remove_dir_all(config.parent().unwrap());
    }

    #[test]
    fn the_announcement_shows_the_code_as_it_is_typed() {
        assert!(announcement("K7QM4XPR").contains("K7QM-4XPR"));
    }
}
