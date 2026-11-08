//! A nearby device's own Wi-Fi, on a computer (1.6.4): for two devices with
//! no network in common. See `basalt_client::nearby` for the names.
//!
//! Hosting is Wi-Fi Direct in "legacy" mode: Windows opens a small Wi-Fi
//! with our name and passphrase, beside the one it is on, and a phone or
//! another computer joins it as it would any Wi-Fi. Finding is a fresh look
//! at the Wi-Fis around (the WLAN API). Joining is a profile for that one
//! Wi-Fi and a connect, through `netsh`; leaving connects back to the Wi-Fi
//! it was on, and forgets the profile.
//!
//! Elsewhere (Linux, macOS) none of it is here yet, and says so.

use serde::Serialize;

/// A Basalt Wi-Fi found around.
#[derive(Debug, Clone, Serialize)]
pub struct Found {
    pub ssid: String,
    /// Signal, 0 to 100.
    pub level: i32,
}

#[cfg(windows)]
mod imp {
    use super::Found;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::Mutex;
    use std::time::Duration;

    use windows::core::HSTRING;
    use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
    use windows::Devices::WiFiDirect::{
        WiFiDirectAdvertisementPublisher, WiFiDirectAdvertisementPublisherStatus,
    };
    use windows::Security::Credentials::PasswordCredential;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::WiFi::{
        WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanGetAvailableNetworkList,
        WlanOpenHandle, WlanScan, WLAN_AVAILABLE_NETWORK_LIST, WLAN_INTERFACE_INFO_LIST,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const WIFI_OFF: &str =
        "this computer's Wi-Fi is off: turn it on (and flight mode off), then try again";

    /// The Wi-Fi this computer hosts while it is ready, and the one it
    /// joined to share, with the one it was on before.
    pub struct State {
        publisher: Mutex<Option<WiFiDirectAdvertisementPublisher>>,
        joined: Mutex<Option<(String, Option<String>)>>,
    }

    impl Default for State {
        fn default() -> Self {
            Self {
                publisher: Mutex::new(None),
                joined: Mutex::new(None),
            }
        }
    }

    /// Wi-Fi switched off (the quick settings, not a hardware switch or
    /// flight mode Windows won't undo for an app): switched back on, and a
    /// moment given for it to come up. Says whether it is on now.
    pub fn wifi_on() -> bool {
        let turned = (|| -> windows::core::Result<Option<bool>> {
            if Radio::RequestAccessAsync()?.get()? != RadioAccessStatus::Allowed {
                return Ok(None);
            }
            let mut any = None;
            for radio in Radio::GetRadiosAsync()?.get()? {
                if radio.Kind()? != RadioKind::WiFi {
                    continue;
                }
                if radio.State()? == RadioState::On {
                    any = Some(false);
                    continue;
                }
                let _ = radio.SetStateAsync(RadioState::On)?.get()?;
                any = Some(radio.State()? == RadioState::On);
            }
            Ok(any)
        })();
        match turned {
            // Just switched on: it takes a few seconds to be ready.
            Ok(Some(true)) => {
                std::thread::sleep(Duration::from_secs(3));
                true
            }
            Ok(Some(false)) => radio_is_on(),
            // Not allowed to say, or no radio API: carry on and let it say.
            _ => true,
        }
    }

    fn radio_is_on() -> bool {
        (|| -> windows::core::Result<bool> {
            for radio in Radio::GetRadiosAsync()?.get()? {
                if radio.Kind()? == RadioKind::WiFi && radio.State()? == RadioState::On {
                    return Ok(true);
                }
            }
            Ok(false)
        })()
        .unwrap_or(true)
    }

    pub fn host(state: &State, ssid: &str, passphrase: &str) -> Result<(), String> {
        stop_host(state);
        if !wifi_on() {
            return Err(WIFI_OFF.into());
        }
        let started = (|| -> windows::core::Result<WiFiDirectAdvertisementPublisher> {
            let publisher = WiFiDirectAdvertisementPublisher::new()?;
            let advertisement = publisher.Advertisement()?;
            advertisement.SetIsAutonomousGroupOwnerEnabled(true)?;
            let legacy = advertisement.LegacySettings()?;
            legacy.SetIsEnabled(true)?;
            legacy.SetSsid(&HSTRING::from(ssid))?;
            let credential = PasswordCredential::new()?;
            credential.SetPassword(&HSTRING::from(passphrase))?;
            legacy.SetPassphrase(&credential)?;
            publisher.Start()?;
            Ok(publisher)
        })()
        .map_err(|e| {
            format!(
                "this computer couldn't open its own Wi-Fi ({})",
                e.message()
            )
        })?;
        // It says whether it really started a moment later.
        for _ in 0..20 {
            match started.Status() {
                Ok(WiFiDirectAdvertisementPublisherStatus::Started) => break,
                Ok(WiFiDirectAdvertisementPublisherStatus::Aborted) => {
                    return Err("this computer's Wi-Fi can't open a Wi-Fi of its own".into());
                }
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        *state.publisher.lock().expect("publisher lock") = Some(started);
        Ok(())
    }

    pub fn stop_host(state: &State) {
        if let Some(publisher) = state.publisher.lock().expect("publisher lock").take() {
            let _ = publisher.Stop();
        }
    }

    /// The Basalt Wi-Fis around, after a fresh look.
    pub fn scan(prefix: &str) -> Result<Vec<Found>, String> {
        if !wifi_on() {
            return Err(WIFI_OFF.into());
        }
        // SAFETY: the WLAN API's own handles and lists, freed as it asks.
        unsafe {
            let mut version = 0u32;
            let mut handle = HANDLE::default();
            if WlanOpenHandle(2, None, &mut version, &mut handle) != 0 {
                return Err("this computer has no Wi-Fi to look with".into());
            }
            let mut interfaces: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(handle, None, &mut interfaces) != 0 || interfaces.is_null() {
                WlanCloseHandle(handle, None);
                return Err("this computer has no Wi-Fi to look with".into());
            }
            let list = &*interfaces;
            let guids: Vec<windows::core::GUID> = (0..list.dwNumberOfItems as usize)
                .map(|i| (*list.InterfaceInfo.as_ptr().add(i)).InterfaceGuid)
                .collect();
            WlanFreeMemory(interfaces as *const _);
            for guid in &guids {
                let _ = WlanScan(handle, guid, None, None, None);
            }
            // A look takes a few seconds; the list is read after.
            std::thread::sleep(Duration::from_millis(3_500));
            let mut found: Vec<Found> = Vec::new();
            for guid in &guids {
                let mut networks: *mut WLAN_AVAILABLE_NETWORK_LIST = std::ptr::null_mut();
                if WlanGetAvailableNetworkList(handle, guid, 0, None, &mut networks) != 0
                    || networks.is_null()
                {
                    continue;
                }
                let list = &*networks;
                for i in 0..list.dwNumberOfItems as usize {
                    let network = &*list.Network.as_ptr().add(i);
                    let length = (network.dot11Ssid.uSSIDLength as usize).min(32);
                    let ssid =
                        String::from_utf8_lossy(&network.dot11Ssid.ucSSID[..length]).to_string();
                    if !ssid.starts_with(prefix) {
                        continue;
                    }
                    let level = network.wlanSignalQuality as i32;
                    match found.iter_mut().find(|f| f.ssid == ssid) {
                        Some(known) => known.level = known.level.max(level),
                        None => found.push(Found { ssid, level }),
                    }
                }
                WlanFreeMemory(networks as *const _);
            }
            WlanCloseHandle(handle, None);
            found.sort_by_key(|f| std::cmp::Reverse(f.level));
            Ok(found)
        }
    }

    fn netsh(args: &[&str]) -> Result<String, String> {
        let out = Command::new("netsh")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        if out.status.success() {
            Ok(text)
        } else {
            Err(text.trim().to_string())
        }
    }

    /// The Wi-Fi profile connected now, if any: to go back to after.
    fn connected_profile() -> Option<String> {
        let text = netsh(&["wlan", "show", "interfaces"]).ok()?;
        text.lines()
            .find(|l| l.trim_start().starts_with("Profile"))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    /// Whether this computer is on `ssid` now, joined and not still trying.
    fn connected_to(ssid: &str) -> bool {
        let Ok(text) = netsh(&["wlan", "show", "interfaces"]) else {
            return false;
        };
        let (mut on, mut connected) = (false, false);
        for line in text.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            match (key.trim(), value.trim()) {
                ("SSID", v) if v == ssid => on = true,
                ("State", "connected") => connected = true,
                _ => {}
            }
        }
        on && connected
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }

    pub fn join(state: &State, ssid: &str, passphrase: &str) -> Result<(), String> {
        if !wifi_on() {
            return Err(WIFI_OFF.into());
        }
        let before = connected_profile().filter(|p| p != ssid);
        let profile = format!(
            r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{ssid}</name>
  <SSIDConfig><SSID><name>{ssid}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{pass}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>"#,
            ssid = escape(ssid),
            pass = escape(passphrase),
        );
        let file = std::env::temp_dir().join(format!("basalt-nearby-{}.xml", std::process::id()));
        std::fs::write(&file, profile).map_err(|e| e.to_string())?;
        let added = netsh(&[
            "wlan",
            "add",
            "profile",
            &format!("filename={}", file.display()),
            "user=current",
        ]);
        let _ = std::fs::remove_file(&file);
        added.map_err(|e| format!("couldn't add that Wi-Fi ({e})"))?;
        *state.joined.lock().expect("joined lock") = Some((ssid.to_string(), before));
        netsh(&[
            "wlan",
            "connect",
            &format!("name={ssid}"),
            &format!("ssid={ssid}"),
        ])
        .map_err(|e| format!("couldn't join that device's Wi-Fi ({e})"))?;
        // Joined, and given an address, within about twenty seconds.
        for _ in 0..40 {
            if connected_to(ssid) {
                std::thread::sleep(Duration::from_secs(2));
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        leave(state);
        Err("that device's Wi-Fi didn't let this computer in".into())
    }

    pub fn leave(state: &State) {
        let Some((ssid, before)) = state.joined.lock().expect("joined lock").take() else {
            return;
        };
        let _ = netsh(&["wlan", "disconnect"]);
        let _ = netsh(&["wlan", "delete", "profile", &format!("name={ssid}")]);
        if let Some(before) = before {
            let _ = netsh(&["wlan", "connect", &format!("name={before}")]);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Found;

    #[derive(Default)]
    pub struct State;

    const NOT_HERE: &str = "devices with no network in common aren't reached from here yet";

    pub fn host(_: &State, _: &str, _: &str) -> Result<(), String> {
        Err(NOT_HERE.into())
    }
    pub fn stop_host(_: &State) {}
    pub fn scan(_: &str) -> Result<Vec<Found>, String> {
        Err(NOT_HERE.into())
    }
    pub fn join(_: &State, _: &str, _: &str) -> Result<(), String> {
        Err(NOT_HERE.into())
    }
    pub fn leave(_: &State) {}
}

pub use imp::State;

/// This device's own Wi-Fi: its name and passphrase, as others find it.
#[derive(Serialize)]
pub struct Own {
    pub ssid: String,
    pub passphrase: String,
}

/// The name and passphrase of this device's own Wi-Fi.
pub fn own(me: &basalt_client::nearby::Me) -> Own {
    Own {
        ssid: basalt_client::nearby::wifi_name(me),
        passphrase: basalt_client::nearby::wifi_passphrase(&me.id),
    }
}

pub fn host(state: &State, me: &basalt_client::nearby::Me) -> Result<(), String> {
    let own = own(me);
    imp::host(state, &own.ssid, &own.passphrase)
}

pub fn stop_host(state: &State) {
    imp::stop_host(state)
}

pub fn scan() -> Result<Vec<Found>, String> {
    imp::scan(basalt_client::nearby::WIFI_PREFIX)
}

/// Joins a Basalt Wi-Fi found around, by its name alone.
pub fn join(state: &State, ssid: &str) -> Result<(), String> {
    let (id, _) = basalt_client::nearby::wifi_device(ssid).ok_or("that isn't a Basalt Wi-Fi")?;
    imp::join(state, ssid, &basalt_client::nearby::wifi_passphrase(&id))
}

pub fn leave(state: &State) {
    imp::leave(state)
}
