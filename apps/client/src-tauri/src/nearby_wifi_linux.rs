//! A nearby device's own Wi-Fi on Linux, through NetworkManager (`nmcli`).
//!
//! Unlike Windows and Android, which open their own Wi-Fi beside the one they
//! are on, a Linux computer has one Wi-Fi card doing one thing. So it hosts
//! only when that card is free (not on a Wi-Fi), and never takes it off one.
//! While it hosts, every two minutes it steps aside for a moment when nobody
//! is on it: if NetworkManager then joins a Wi-Fi it knows (a laptop come
//! home), that one keeps it and hosting ends; if not, it opens again.
//!
//! Joining is a connection kept in memory only, for that one Wi-Fi, and
//! leaving goes back to the Wi-Fi it was on. Nothing is saved: both
//! connections go with the app, and are cleared at its next start if it
//! ended without.

use super::{nmcli_devices, nmcli_wifi_list, Card, Found};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HOST: &str = "basalt-nearby-host";
const JOIN: &str = "basalt-nearby-join";
const WIFI_OFF: &str =
    "this computer's Wi-Fi is off: turn it on (and flight mode off), then try again";
const NO_NMCLI: &str =
    "this computer's Wi-Fi isn't run by NetworkManager, which Basalt uses for this";
/// How often a host steps aside for a Wi-Fi it knows.
const STEP_ASIDE: Duration = Duration::from_secs(120);

/// The Wi-Fi this computer hosts while it is ready, and the one it joined
/// to share, with the one it was on before.
#[derive(Default)]
pub struct State {
    hosting: Mutex<Option<Arc<AtomicBool>>>,
    joined: Mutex<Option<Option<String>>>,
    /// One change to the Wi-Fi at a time: the page's and the host's own.
    busy: Arc<Mutex<()>>,
}

fn nmcli(args: &[&str]) -> Result<String, String> {
    let out = basalt_net::outside::command("nmcli")
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .map_err(|_| NO_NMCLI.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(why.strip_prefix("Error: ").unwrap_or(&why).to_string())
    }
}

/// The Wi-Fi card: its name, whether it is on a Wi-Fi, and which.
fn card() -> Result<Card, String> {
    let text = nmcli(&["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"])?;
    nmcli_devices(&text).ok_or_else(|| "this computer has no Wi-Fi".to_string())
}

/// Wi-Fi switched off in software: switched on, and a moment given for it.
fn wifi_on() -> bool {
    if nmcli(&["radio", "wifi"]).is_ok_and(|s| s.trim() == "enabled") {
        return true;
    }
    if nmcli(&["radio", "wifi", "on"]).is_err() {
        return false;
    }
    std::thread::sleep(Duration::from_secs(4));
    nmcli(&["radio", "wifi"]).is_ok_and(|s| s.trim() == "enabled")
}

/// The person this runs as: connections are theirs alone.
fn me() -> Option<String> {
    std::env::var("USER").ok().filter(|u| !u.is_empty())
}

/// A Wi-Fi connection kept in memory only, WPA2 with a passphrase.
fn add(name: &str, card: &str, ssid: &str, passphrase: &str, ap: bool) -> Result<(), String> {
    let _ = nmcli(&["connection", "delete", name]);
    let mut args: Vec<String> = [
        "connection",
        "add",
        "save",
        "no",
        "type",
        "wifi",
        "ifname",
        card,
        "con-name",
        name,
        "autoconnect",
        "no",
        "ssid",
        ssid,
        "wifi-sec.key-mgmt",
        "wpa-psk",
        "wifi-sec.psk",
        passphrase,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if ap {
        // 2.4 GHz: every phone joins that. Shared: NetworkManager hands out
        // addresses, its own the first (10.42.0.1), looked at first.
        for s in [
            "802-11-wireless.mode",
            "ap",
            "802-11-wireless.band",
            "bg",
            "wifi-sec.proto",
            "rsn",
            "wifi-sec.pairwise",
            "ccmp",
            "wifi-sec.group",
            "ccmp",
            "ipv4.method",
            "shared",
            "ipv6.method",
            "ignore",
        ] {
            args.push(s.into());
        }
    }
    if let Some(user) = me() {
        args.push("connection.permissions".into());
        args.push(format!("user:{user}"));
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    nmcli(&args).map(|_| ())
}

fn up(name: &str) -> Result<(), String> {
    nmcli(&["--wait", "30", "connection", "up", name]).map(|_| ())
}

fn gone(name: &str) {
    let _ = nmcli(&["connection", "down", name]);
    let _ = nmcli(&["connection", "delete", name]);
}

/// Someone on this computer's own Wi-Fi now (heard from lately).
fn anyone_on(card: &str) -> bool {
    let Ok(out) = basalt_net::outside::command("ip")
        .args(["-4", "neigh", "show", "dev", card])
        .output()
    else {
        return true;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.contains("REACHABLE") || l.contains("DELAY") || l.contains("PROBE"))
}

/// Left over from a Basalt that ended without closing them.
pub fn tidy() {
    gone(HOST);
    gone(JOIN);
}

pub fn host(state: &State, ssid: &str, passphrase: &str) -> Result<(), String> {
    stop_host(state);
    let _turn = state.busy.lock().expect("wifi lock");
    if !wifi_on() {
        return Err(WIFI_OFF.into());
    }
    let mut card = card()?;
    // Joining one now (just started, say): given a moment to finish first.
    let settling = Instant::now();
    while card.connecting && settling.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_secs(2));
        card = self::card()?;
    }
    if card.connecting {
        return Err("this computer's Wi-Fi is still joining a Wi-Fi".into());
    }
    if let Some(on) = card.on.as_deref().filter(|on| *on != HOST) {
        return Err(format!(
            "this computer's Wi-Fi is on {on}, and it can't open one of its own beside it"
        ));
    }
    add(HOST, &card.name, ssid, passphrase, true)
        .and_then(|_| up(HOST))
        .map_err(|e| {
            gone(HOST);
            format!("this computer's Wi-Fi can't open a Wi-Fi of its own ({e})")
        })?;
    let stop = Arc::new(AtomicBool::new(false));
    *state.hosting.lock().expect("hosting lock") = Some(stop.clone());
    let busy = state.busy.clone();
    std::thread::spawn(move || step_aside(card.name, stop, busy));
    Ok(())
}

/// Every two minutes with nobody on it: closed for a moment, for a Wi-Fi
/// NetworkManager knows. One it joins keeps the card; hosting ends there.
fn step_aside(card: String, stop: Arc<AtomicBool>, busy: Arc<Mutex<()>>) {
    loop {
        let wait = Instant::now();
        while wait.elapsed() < STEP_ASIDE {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        if anyone_on(&card) {
            continue;
        }
        let _turn = busy.lock().expect("wifi lock");
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let _ = nmcli(&["connection", "down", HOST]);
        // NetworkManager looks, and joins one it knows, within some seconds.
        let looked = Instant::now();
        let mut joined = false;
        while looked.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_secs(2));
            match card_state(&card) {
                Some((true, _)) => {
                    joined = true;
                    break;
                }
                Some((false, true)) => continue,
                _ if looked.elapsed() >= Duration::from_secs(8) => break,
                _ => {}
            }
        }
        if joined {
            let _ = nmcli(&["connection", "delete", HOST]);
            stop.store(true, Ordering::SeqCst);
            return;
        }
        if stop.load(Ordering::SeqCst) || up(HOST).is_err() {
            gone(HOST);
            return;
        }
    }
}

/// The card: (on a Wi-Fi, still connecting).
fn card_state(card: &str) -> Option<(bool, bool)> {
    let now = self::card().ok().filter(|c| c.name == card)?;
    Some((now.on.is_some(), now.connecting))
}

pub fn stop_host(state: &State) {
    if let Some(stop) = state.hosting.lock().expect("hosting lock").take() {
        stop.store(true, Ordering::SeqCst);
        let _turn = state.busy.lock().expect("wifi lock");
        gone(HOST);
    }
}

/// The Basalt Wi-Fis around, after a fresh look.
pub fn scan(prefix: &str) -> Result<Vec<Found>, String> {
    if !wifi_on() {
        return Err(WIFI_OFF.into());
    }
    card()?;
    let list = |rescan: &str| {
        nmcli(&[
            "-t",
            "-f",
            "SSID,SIGNAL",
            "device",
            "wifi",
            "list",
            "--rescan",
            rescan,
        ])
    };
    // A look just after another is refused: the last one's list, then.
    let text = list("yes").or_else(|_| list("no"))?;
    Ok(nmcli_wifi_list(&text, prefix))
}

pub fn join(state: &State, ssid: &str, passphrase: &str) -> Result<(), String> {
    let _turn = state.busy.lock().expect("wifi lock");
    if !wifi_on() {
        return Err(WIFI_OFF.into());
    }
    let card = card()?;
    let before = card.on.filter(|on| on != JOIN && on != HOST);
    add(JOIN, &card.name, ssid, passphrase, false)
        .and_then(|_| up(JOIN))
        .map_err(|e| {
            gone(JOIN);
            if let Some(before) = &before {
                let _ = up(before);
            }
            format!("couldn't join {ssid} ({e})")
        })?;
    *state.joined.lock().expect("joined lock") = Some(before);
    Ok(())
}

pub fn leave(state: &State) {
    let Some(before) = state.joined.lock().expect("joined lock").take() else {
        return;
    };
    let _turn = state.busy.lock().expect("wifi lock");
    gone(JOIN);
    if let Some(before) = before {
        let _ = nmcli(&["--wait", "20", "connection", "up", &before]);
    }
}
