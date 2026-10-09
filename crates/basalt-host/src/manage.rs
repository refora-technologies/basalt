//! Managing the host from a device.
//!
//! A device that manages the host does what the host's own window does, by the
//! same names and through the same methods, so the two can never come to
//! differ. Whether a connection may ask at all is the server's to decide, as it
//! reads the request: signed in with its own key, and marked as managing. What
//! is decided here is what no device may do from afar even then: leave the host
//! with nobody to manage it.

use std::path::Path;
use std::sync::Arc;

use basalt_proto::msg::ManageAction;

use crate::error::{HostError, Result};
use crate::server::Host;
use crate::ui::{DriveView, PairingView};

impl Host {
    /// Does what a device that manages this host asked, and answers with the
    /// host as its window shows it, after the change. `by` is the asking
    /// device's id, said back as `you`, so it can tell itself in the list.
    pub async fn manage(
        self: &Arc<Self>,
        action: ManageAction,
        by: &str,
    ) -> Result<serde_json::Value> {
        let mut drives = false;
        match action {
            ManageAction::View => {}
            ManageAction::RenameDevice { id, name } => {
                self.rename_device(&id, &name)?;
            }
            ManageAction::SetWritable { id, writable } => {
                self.set_writable(&id, writable)?;
            }
            ManageAction::SetManages { id, manages } => {
                if !manages {
                    self.keep_one_manager(&id)?;
                }
                self.set_owner(&id, manages)?;
            }
            ManageAction::RemoveDevice { id } => {
                self.keep_one_manager(&id)?;
                self.revoke(&id)?;
            }
            ManageAction::DenyPairing { id } => {
                self.deny_pairing(&id);
            }
            ManageAction::SetRequirePin { require } => self.set_require_pin(require)?,
            ManageAction::SetHostName { name } => self.set_host_name(&name)?,
            ManageAction::SetLibrary { enabled } => self.set_library_enabled(enabled).await?,
            ManageAction::Rescan => self.start_scan(),
            ManageAction::SetPosters { enabled } => self.set_posters(enabled).await?,
            ManageAction::SetTmdbKey { key } => self.set_tmdb_key(&key).await?,
            ManageAction::SetConversion { enabled } => self.set_conversion_enabled(enabled)?,
            ManageAction::SetConversionAtOnce { at_once } => {
                self.set_conversion_at_once(at_once)?
            }
            ManageAction::MeasureConversion => {
                self.measure_conversion().map_err(HostError::Unavailable)?
            }
            ManageAction::SetSections { sections } => self.set_sections(sections).await?,
            ManageAction::AddProfile { name, color } => self.add_profile(&name, color)?,
            ManageAction::RemoveProfile { id } => {
                self.remove_profile(&id)?;
            }
            ManageAction::ResetProfilePin { id } => {
                self.reset_profile_pin(&id)?;
            }
            ManageAction::SetRequireProfile { require } => self.set_require_profile(require)?,
            ManageAction::SetOwnerAddsProfiles { owner_only } => {
                self.set_owner_adds_profiles(owner_only)?
            }
            ManageAction::ListDrives => drives = true,
            ManageAction::ChooseDrive { path, name } => {
                self.choose_drive(Path::new(&path), &name).await?;
            }
            ManageAction::ApproveProfileLink { id } => self.approve_profile_link(&id)?,
            ManageAction::DenyProfileLink { id } => {
                self.deny_profile_link(&id);
            }
        }
        Ok(self.view(drives, by).await)
    }

    /// Shares the drive or folder at `path`, called `name` (or by its path,
    /// when that is empty). What the window's drive list does, and a device's.
    pub async fn choose_drive(self: &Arc<Self>, path: &Path, name: &str) -> Result<()> {
        if !crate::drives::is_available(path) {
            return Err(HostError::NotFound(format!(
                "{} is not there any more. Plug it back in, or pick another drive.",
                path.display()
            )));
        }
        let name = if name.trim().is_empty() {
            path.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .to_string()
        } else {
            name.trim().to_string()
        };
        self.set_vault(path, &name).await
    }

    /// Refuses to leave the host with nobody to manage it: the device `id`
    /// being the only one that does. From the host's window it can still be
    /// done; from afar, a host without a screen would be left unmanageable.
    fn keep_one_manager(&self, id: &str) -> Result<()> {
        let devices = self.devices();
        let mut managers = devices.iter().filter(|device| device.owner);
        let only = match (managers.next(), managers.next()) {
            (Some(one), None) => one.token_hash == id,
            _ => false,
        };
        if only {
            return Err(HostError::Denied(
                "this is the only device that manages this host; let another device manage it \
                 first"
                    .into(),
            ));
        }
        Ok(())
    }

    /// The host as its window shows it: its status, its devices, the pairing
    /// requests waiting, and, when asked for, the drives it could share.
    async fn view(self: &Arc<Self>, drives: bool, by: &str) -> serde_json::Value {
        let status = self.status(true).await;
        // Rates are the window's own measure, taken between its polls: a
        // device asking now and then would only be shown noise.
        let devices = crate::ui::devices_view(
            &self.devices(),
            &self.traffic(),
            &std::collections::HashMap::new(),
        );
        let now = std::time::Instant::now();
        let pairings: Vec<PairingView> = self
            .pending_pairings()
            .iter()
            .map(|request| PairingView::new(request, now))
            .collect();
        let drives: Option<Vec<DriveView>> = if drives {
            tokio::task::spawn_blocking(|| {
                crate::drives::list()
                    .into_iter()
                    .map(DriveView::from)
                    .collect()
            })
            .await
            .ok()
        } else {
            None
        };
        serde_json::json!({
            "status": status,
            "devices": devices,
            "pairings": pairings,
            "drives": drives,
            "profileLinks": self.profile_links(),
            "you": by,
        })
    }
}
