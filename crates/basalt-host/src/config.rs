//! What the host remembers between runs.
//!
//! Its identity above all: regenerating the certificate would change the host
//! id, and every paired device would refuse to connect to what it would
//! correctly regard as a different machine. Losing this file means pairing
//! everything again.

use std::path::{Path, PathBuf};

use basalt_net::HostIdentity;
use basalt_proto::hex;
use serde::{Deserialize, Serialize};

use crate::error::{HostError, Result};
use crate::registry::Device;

/// An absent boolean reads as true, for the fields where that is the safe way
/// to read silence.
fn default_true() -> bool {
    true
}

/// On-disk host state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfig {
    /// Hex DER of the certificate and its private key.
    pub cert_der: String,
    pub key_der: crate::sealed::Secret,

    /// The drive or folder being served. `None` until one is chosen.
    pub vault_path: Option<PathBuf>,
    pub vault_name: String,
    /// What this machine calls itself, shown to clients before pairing.
    pub host_name: String,
    pub port: u16,

    /// Whether pairing asks for a PIN.
    ///
    /// Defaults to on, including for a config written before this field
    /// existed. With it off, anyone on the network can read the drive — not a
    /// default to choose on somebody's behalf.
    #[serde(default = "default_true")]
    pub require_pin: bool,

    /// Whether the host starts with Windows. Mirrors the registry entry, so
    /// the app can draw the switch without reading the registry every time.
    #[serde(default)]
    pub start_with_windows: bool,

    /// Whether to recognise films and series on the drive.
    ///
    /// Off unless asked for. Scanning somebody's drive and filing what is on it
    /// is work they did not request, and a library they may not want — so an
    /// upgrade must not quietly start doing it.
    #[serde(default)]
    pub library_enabled: bool,

    /// Whether to fetch artwork for what the library has recognised.
    ///
    /// Off by default, and the switch is the consent. A lookup tells a third
    /// party what is on the drive, and a list of titles is a list of what
    /// somebody watches — that must never start happening because of an
    /// upgrade. It used to be the TMDb key below that gated this, simply
    /// because a key was required; posters need no key now, so the decision
    /// had to become a decision of its own rather than quietly disappear.
    #[serde(default)]
    pub posters: bool,

    /// TMDb key, for titles the keyless source does not have. Optional.
    ///
    /// Only consulted when [`Self::posters`] is on and the free source found
    /// nothing, so this widens coverage rather than unlocking the feature.
    #[serde(default)]
    pub tmdb_key: String,

    /// No longer used: since profiles, a device keeps a history of its own and
    /// a profile's follows it. Still read, so an older config loads.
    #[serde(default, skip_serializing)]
    pub progress_per_device: bool,

    /// The household's profiles. See [`crate::profiles`].
    #[serde(default)]
    pub profiles: Vec<crate::profiles::Profile>,
    /// Devices signed in to them, by token hash.
    #[serde(default)]
    pub profile_tokens: Vec<crate::profiles::ProfileToken>,

    /// Every device must sign in to a profile; none uses the drive as
    /// itself. Off unless the owner turns it on, as it has always been.
    #[serde(default)]
    pub require_profile: bool,
    /// Only the host's owner adds profiles. Off: anyone using the drive may.
    #[serde(default)]
    pub owner_adds_profiles: bool,

    /// Which library sections devices show. All of them unless the owner
    /// unticks some.
    #[serde(default)]
    pub sections: basalt_proto::msg::Sections,

    /// Whether this host converts video for a device that cannot play it.
    /// On by default: a device that needs it gets a smooth picture, and one
    /// that does not never asks.
    #[serde(default = "default_true")]
    pub convert_enabled: bool,
    /// Conversions at once, chosen by hand. None: as measured.
    #[serde(default)]
    pub convert_at_once: Option<u32>,
    /// What this machine was measured to manage, so it is measured once.
    #[serde(default)]
    pub convert_measured: Option<crate::convert::Measured>,
    /// Set while measuring, and cleared when a measurement ends. Still set at
    /// a start means the last one never ended: the system stopped the host
    /// part-way, for want of memory most likely, and it is not started again
    /// by itself, or it would be stopped again at every start.
    #[serde(default)]
    pub convert_measuring: bool,

    #[serde(default)]
    pub devices: Vec<Device>,

    /// The household's key, PKCS#8 hex: what speaks for devices using the
    /// drive as themselves. Sealed when written down.
    #[serde(default, skip_serializing_if = "crate::sealed::Secret::is_empty")]
    pub household_key: crate::sealed::Secret,
    /// Member statements made and not yet expired: see `crate::authority`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issued: Vec<crate::authority::Issued>,
    /// Statements taken back before their time.
    #[serde(default)]
    pub revoked: basalt_trust::revocation::RevocationList,
    /// An owner's device vouching for this host's key, the newest there is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endorsement: Option<crate::authority::Endorsement>,
}

impl HostConfig {
    /// Builds a config around a freshly generated identity.
    pub fn create(host_name: &str) -> Result<Self> {
        let identity = HostIdentity::generate(host_name)
            .map_err(|e| HostError::BadRequest(format!("could not create an identity: {e}")))?;
        Ok(Self {
            cert_der: hex::encode(&identity.cert_der),
            key_der: crate::sealed::Secret(hex::encode(&identity.key_der)),
            vault_path: None,
            vault_name: "Vault".to_string(),
            host_name: host_name.to_string(),
            port: basalt_net::DEFAULT_PORT,
            require_pin: true,
            start_with_windows: false,
            library_enabled: false,
            posters: false,
            tmdb_key: String::new(),
            progress_per_device: false,
            profiles: Vec::new(),
            profile_tokens: Vec::new(),
            require_profile: false,
            owner_adds_profiles: false,
            sections: basalt_proto::msg::Sections::default(),
            convert_enabled: true,
            convert_at_once: None,
            convert_measured: None,
            convert_measuring: false,
            devices: Vec::new(),
            household_key: Default::default(),
            issued: Vec::new(),
            revoked: Default::default(),
            endorsement: None,
        })
    }

    pub fn identity(&self) -> Result<HostIdentity> {
        let cert = hex::decode(&self.cert_der)?;
        let key = hex::decode(&self.key_der.0)?;
        HostIdentity::from_der(cert, key)
            .map_err(|e| HostError::BadRequest(format!("stored identity is unusable: {e}")))
    }

    /// Loads the config, creating one if this is the first run.
    pub fn load_or_create(path: &Path, host_name: &str) -> Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<Self>(&bytes)
                .map_err(|e| {
                    // Never silently replace a config that failed to parse: the
                    // identity inside it is the only thing tying paired devices
                    // to this machine, and overwriting it would quietly unpair
                    // them all. Better to stop and say so.
                    HostError::BadRequest(format!(
                        "{} did not parse ({e}). Move it aside to start fresh, \
                         but every paired device will have to pair again.",
                        path.display()
                    ))
                })?
                .revealed(path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let config = Self::create(host_name)?;
                config.save(path)?;
                Ok(config)
            }
            Err(e) => Err(HostError::Io(e)),
        }
    }

    /// Writes the config, replacing any previous copy atomically.
    ///
    /// Via a temporary file and a rename, so an interrupted write cannot leave
    /// a half-written identity behind — which would be indistinguishable from
    /// a corrupt one and would cost every pairing.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(&self.sealed())
            .map_err(|e| HostError::BadRequest(format!("could not encode the config: {e}")))?;

        let temp = path.with_extension("tmp");
        write_private(&temp, &json)?;
        std::fs::rename(&temp, path)?;
        Ok(())
    }
}

impl HostConfig {
    /// A copy with every secret sealed, as it is written down. See
    /// [`crate::sealed`].
    fn sealed(&self) -> Self {
        let mut config = self.clone();
        config.key_der.0 = crate::sealed::seal(&config.key_der.0);
        config.household_key.0 = crate::sealed::seal(&config.household_key.0);
        for profile in &mut config.profiles {
            profile.person_key.0 = crate::sealed::seal(&profile.person_key.0);
        }
        config
    }

    /// Every secret opened, as the host uses them.
    ///
    /// The host's own key that will not open stops the host with the reason:
    /// its identity is the one thing that cannot be made again without every
    /// device pairing again, so it is never replaced behind anyone's back.
    /// People's keys that will not open are let go and made again; nothing
    /// relies on them yet.
    fn revealed(mut self, path: &Path) -> Result<Self> {
        self.key_der.0 = crate::sealed::open(&self.key_der.0).map_err(|_| {
            HostError::BadRequest(format!(
                "{} holds this host's key sealed by another installation of Windows, \
                 and it cannot be opened here. Move the file aside to start fresh, \
                 but every paired device will have to pair again.",
                path.display()
            ))
        })?;
        let open_or_drop = |secret: &mut crate::sealed::Secret| match crate::sealed::open(&secret.0)
        {
            Ok(opened) => secret.0 = opened,
            Err(_) => {
                tracing::warn!("a person's key did not open here; it will be made again");
                secret.0.clear();
            }
        };
        open_or_drop(&mut self.household_key);
        for profile in &mut self.profiles {
            open_or_drop(&mut profile.person_key);
        }
        Ok(self)
    }
}

/// Writes a file only its owner can read. On Linux the host's settings hold
/// its private key unsealed (there is nothing like Windows' sealing to hand),
/// so the file itself is the protection: readable by this user alone. On
/// Windows the folder in the person's profile already is.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // A file left from before keeps its old mode; set it either way.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// Where the host keeps its state.
///
/// `%APPDATA%\Basalt\host.json` on Windows, falling back to the working
/// directory anywhere the variable is missing. Beside the executable would be
/// worse: program directories are often read-only, and the failure would only
/// show up on the first save.
pub fn default_path() -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        return base.join("Basalt").join("host.json");
    }
    // Linux: `~/.config/basalt`, as the XDG convention has it.
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("basalt").join("host.json")
}

/// This machine's name, for display before pairing.
///
/// Windows says it in `COMPUTERNAME`. Linux keeps it in `/etc/hostname`;
/// `HOSTNAME` is a shell's variable, and a program started from a menu does
/// not see it.
pub fn machine_name() -> String {
    let named = |name: String| Some(name.trim().to_string()).filter(|n| !n.is_empty());
    std::env::var("COMPUTERNAME")
        .ok()
        .and_then(named)
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .and_then(named)
        })
        .or_else(|| std::env::var("HOSTNAME").ok().and_then(named))
        .unwrap_or_else(|| "Basalt Host".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "basalt-config-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn a_created_config_has_a_usable_identity() {
        let config = HostConfig::create("laptop-b").unwrap();
        let identity = config.identity().unwrap();
        assert_eq!(identity.host_id.len(), 64);
        assert_eq!(config.port, basalt_net::DEFAULT_PORT);
        assert!(config.vault_path.is_none());
    }

    #[test]
    fn saving_and_loading_preserves_the_identity() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");

        let first = HostConfig::load_or_create(&path, "laptop-b").unwrap();
        let second = HostConfig::load_or_create(&path, "laptop-b").unwrap();

        assert_eq!(
            first.identity().unwrap().host_id,
            second.identity().unwrap().host_id,
            "restarting the host must not unpair every device"
        );
    }

    #[test]
    fn the_config_file_is_created_on_first_run() {
        let dir = temp_dir();
        let path = dir.0.join("nested").join("host.json");
        assert!(!path.exists());
        HostConfig::load_or_create(&path, "laptop-b").unwrap();
        assert!(path.exists(), "the parent directory is created too");
    }

    #[test]
    fn a_corrupt_config_is_reported_rather_than_replaced() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        std::fs::write(&path, b"{ this is not json").unwrap();

        let err = HostConfig::load_or_create(&path, "laptop-b").unwrap_err();
        assert!(
            format!("{err}").contains("pair again"),
            "the message must explain the cost, got: {err}"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"{ this is not json",
            "the original file must be left alone"
        );
    }

    #[test]
    fn devices_and_vault_settings_survive_a_round_trip() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");

        let mut config = HostConfig::create("laptop-b").unwrap();
        config.vault_path = Some(PathBuf::from("E:/"));
        config.vault_name = "Films".into();
        config.devices.push(Device {
            token_hash: "abc123".into(),
            name: "Laptop A".into(),
            paired_at: 1_700_000_000,
            last_seen: 1_700_000_500,
            writable: false,
            device_id: "0123456789abcdef0123456789abcdef".into(),
            named_by_host: true,
            ..Device::default()
        });
        config.save(&path).unwrap();

        let back = HostConfig::load_or_create(&path, "ignored").unwrap();
        assert_eq!(back.vault_path, Some(PathBuf::from("E:/")));
        assert_eq!(back.vault_name, "Films");
        assert_eq!(back.devices.len(), 1);
        assert_eq!(back.devices[0].name, "Laptop A");
        assert!(!back.devices[0].writable);
        assert_eq!(
            back.devices[0].device_id,
            "0123456789abcdef0123456789abcdef"
        );
        assert!(back.devices[0].named_by_host);
    }

    #[test]
    fn saving_leaves_no_temporary_file_behind() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        HostConfig::create("laptop-b").unwrap().save(&path).unwrap();

        let leftovers: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "found {leftovers:?}");
    }

    #[test]
    fn an_older_config_without_a_device_list_still_loads() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        let config = HostConfig::create("laptop-b").unwrap();

        let mut value = serde_json::to_value(&config).unwrap();
        value.as_object_mut().unwrap().remove("devices");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let back = HostConfig::load_or_create(&path, "laptop-b").unwrap();
        assert!(back.devices.is_empty());
    }

    #[test]
    fn the_default_path_is_absolute_and_named() {
        let path = default_path();
        if cfg!(windows) {
            assert!(path.ends_with("Basalt\\host.json"), "{path:?}");
        } else {
            assert!(path.ends_with("basalt/host.json"), "{path:?}");
        }
    }

    #[test]
    fn the_machine_always_has_some_name() {
        assert!(!machine_name().is_empty());
    }

    // -----------------------------------------------------------------------
    // Sealed secrets
    // -----------------------------------------------------------------------

    fn raw(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn the_hosts_key_is_sealed_on_disk_and_opens_to_the_same_identity() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        let mut config = HostConfig::create("laptop-b").unwrap();
        config.household_key = crate::sealed::Secret("abcd".into());
        let id = config.identity().unwrap().host_id;
        config.save(&path).unwrap();

        let written = raw(&path);
        let key = written["key_der"].as_str().unwrap();
        #[cfg(windows)]
        {
            assert!(crate::sealed::is_sealed(key), "sealed on disk");
            assert!(!key.contains(&config.key_der.0[..40]));
            assert!(crate::sealed::is_sealed(
                written["household_key"].as_str().unwrap()
            ));
        }
        let _ = key;

        let back = HostConfig::load_or_create(&path, "ignored").unwrap();
        assert_eq!(back.identity().unwrap().host_id, id);
        assert_eq!(back.key_der, config.key_der, "open in memory");
        assert_eq!(back.household_key.0, "abcd");
    }

    #[test]
    fn a_config_written_before_sealing_loads_and_is_sealed_when_next_saved() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        let config = HostConfig::create("laptop-b").unwrap();
        // Written the way 1.4.6 wrote it: the key as plain hex.
        std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
        assert!(!crate::sealed::is_sealed(
            raw(&path)["key_der"].as_str().unwrap()
        ));

        let loaded = HostConfig::load_or_create(&path, "ignored").unwrap();
        assert_eq!(
            loaded.identity().unwrap().host_id,
            config.identity().unwrap().host_id
        );
        loaded.save(&path).unwrap();
        #[cfg(windows)]
        assert!(crate::sealed::is_sealed(
            raw(&path)["key_der"].as_str().unwrap()
        ));
        let again = HostConfig::load_or_create(&path, "ignored").unwrap();
        assert_eq!(again.key_der, config.key_der);
    }

    #[test]
    fn a_key_that_will_not_open_stops_the_host_and_leaves_the_file_alone() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        let config = HostConfig::create("laptop-b").unwrap();
        config.save(&path).unwrap();
        let mut written = raw(&path);
        written["key_der"] = serde_json::json!("sealed:00ff00ff");
        std::fs::write(&path, serde_json::to_vec_pretty(&written).unwrap()).unwrap();
        let before = std::fs::read(&path).unwrap();

        let refused = HostConfig::load_or_create(&path, "ignored").unwrap_err();
        assert!(
            refused.to_string().contains("cannot be opened here"),
            "{refused}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before, "never replaced");
    }

    #[test]
    fn peoples_keys_that_will_not_open_are_let_go_to_be_made_again() {
        let dir = temp_dir();
        let path = dir.0.join("host.json");
        let config = HostConfig::create("laptop-b").unwrap();
        config.save(&path).unwrap();
        let mut written = raw(&path);
        written["household_key"] = serde_json::json!("sealed:00ff");
        std::fs::write(&path, serde_json::to_vec_pretty(&written).unwrap()).unwrap();

        let loaded = HostConfig::load_or_create(&path, "ignored").unwrap();
        assert!(loaded.household_key.is_empty());
        assert!(loaded.identity().is_ok(), "the host's own key is untouched");
    }

    #[test]
    fn a_config_shown_in_a_log_never_shows_a_persons_key() {
        let mut config = HostConfig::create("laptop-b").unwrap();
        config.household_key = crate::sealed::Secret("deadbeefcafe".into());
        let shown = format!("{config:?}");
        assert!(!shown.contains("deadbeefcafe"));
        assert!(
            !shown.contains(&config.key_der.0[..40]),
            "nor the host's own"
        );
        assert!(shown.contains("Secret(…)"));
    }
}
