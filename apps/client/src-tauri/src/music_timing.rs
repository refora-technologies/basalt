//! The moments music in a group keeps to, kept out of the page.
//!
//! A hidden page (a phone's screen off, the window in the tray) runs its
//! timers at most once a second, and after a few minutes once a minute.
//! Playing together needs better: sixteen reads of the player's clock 13 ms
//! apart, a start or a pause at an exact moment, and a hair faster or slower
//! for a few seconds at a time. Those are done here, on threads of their own,
//! whatever the page is doing. The page still decides what to do; this does
//! it on time.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// Counts starts, pauses and cancels: a wait for a moment gives way to
/// anything asked after it.
static TURN: AtomicU64 = AtomicU64::new(0);
/// Counts speed changes: a nudge's own end gives way to a newer one.
static RATE_TURN: AtomicU64 = AtomicU64::new(0);

/// Ready too late to start with the others: how far further on it starts instead, in seconds.
const CATCH_UP_MARGIN_S: f64 = 0.8;
/// The longest it waits for a song to be open and done seeking.
const READY_AT_MOST: Duration = Duration::from_secs(8);
/// Already this close to the place asked for, in seconds: not sought again (a seek costs a phone ~0.1 s).
const THERE_ALREADY_S: f64 = 0.03;

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// mpv, wherever it lives: the libmpv plugin on Windows and macOS, the
/// app's own on Linux, the Android plugin on a phone or TV.
struct Player<R: Runtime> {
    #[allow(dead_code)]
    app: AppHandle<R>,
}

impl<R: Runtime> Player<R> {
    fn get(&self, name: &str, format: &str) -> Option<serde_json::Value> {
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_basalt_android::BasaltAndroidExt;
            self.app
                .basalt_android()
                .mpv_get(name, format)
                .ok()
                .flatten()
        }
        #[cfg(target_os = "linux")]
        {
            crate::linux_player::linux_mpv_get_property(name.into(), format.into())
                .ok()
                .and_then(|v| v.get("value").cloned())
        }
        #[cfg(all(desktop, not(target_os = "linux")))]
        {
            use tauri_plugin_libmpv::MpvExt;
            self.app
                .mpv()
                .get_property(name.into(), format.into(), "main")
                .ok()
                .filter(|v| !v.is_null())
        }
        #[cfg(not(any(target_os = "android", desktop)))]
        {
            let _ = (name, format);
            None
        }
    }

    fn number(&self, name: &str) -> Option<f64> {
        self.get(name, "double").and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        })
    }

    fn flag(&self, name: &str) -> Option<bool> {
        self.get(name, "flag").and_then(|v| match v {
            serde_json::Value::Bool(b) => Some(b),
            serde_json::Value::String(s) => Some(s == "yes" || s == "true"),
            serde_json::Value::Number(n) => Some(n.as_i64() == Some(1)),
            _ => None,
        })
    }

    fn set(&self, name: &str, value: Setting) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_basalt_android::BasaltAndroidExt;
            self.app
                .basalt_android()
                .mpv_set(name, &value.words())
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "linux")]
        {
            crate::linux_player::linux_mpv_set_property(name.into(), value.words())
        }
        #[cfg(all(desktop, not(target_os = "linux")))]
        {
            use tauri_plugin_libmpv::MpvExt;
            self.app
                .mpv()
                .set_property(name, &value.json(), "main")
                .map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "android", desktop)))]
        {
            let _ = (name, value);
            Ok(())
        }
    }

    fn seek(&self, to: f64) -> Result<(), String> {
        let at = format!("{:.3}", to.max(0.0));
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_basalt_android::BasaltAndroidExt;
            self.app
                .basalt_android()
                .mpv_command(&["seek".into(), at, "absolute+exact".into()])
                .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "linux")]
        {
            crate::linux_player::linux_mpv_command(vec!["seek".into(), at, "absolute+exact".into()])
        }
        #[cfg(all(desktop, not(target_os = "linux")))]
        {
            use tauri_plugin_libmpv::MpvExt;
            self.app
                .mpv()
                .command(
                    "seek",
                    &vec![serde_json::Value::String(at), "absolute+exact".into()],
                    "main",
                )
                .map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "android", desktop)))]
        {
            let _ = at;
            Ok(())
        }
    }

    /// Open, and done seeking: false if given up on meanwhile.
    fn ready(&self, mine: u64) -> bool {
        let until = std::time::Instant::now() + READY_AT_MOST;
        loop {
            if TURN.load(Ordering::SeqCst) != mine {
                return false;
            }
            let there = self.number("time-pos").is_some();
            if (there && self.flag("seeking") == Some(false)) || std::time::Instant::now() > until {
                return true;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

/// A value for mpv: each backend takes it in its own form.
#[derive(Clone, Copy)]
enum Setting {
    Flag(bool),
    Number(f64),
}

impl Setting {
    #[allow(dead_code)]
    fn words(self) -> String {
        match self {
            Setting::Flag(b) => if b { "yes" } else { "no" }.into(),
            Setting::Number(n) => format!("{n:.4}"),
        }
    }

    #[allow(dead_code)]
    fn json(self) -> serde_json::Value {
        match self {
            Setting::Flag(b) => b.into(),
            Setting::Number(n) => n.into(),
        }
    }
}

/// Sleeps until `at` (Unix ms), in short steps: false if given up on meanwhile.
fn sleep_until(at: f64, mine: u64) -> bool {
    loop {
        if TURN.load(Ordering::SeqCst) != mine {
            return false;
        }
        let left = at - now_ms();
        if left <= 0.0 {
            return true;
        }
        std::thread::sleep(Duration::from_secs_f64((left.min(50.0)) / 1000.0));
    }
}

/// One read of the player's clock.
#[derive(Serialize)]
pub struct Reading {
    position: f64,
    /// Unix ms, halfway through the read.
    at: f64,
    /// How long the read took, ms.
    took: f64,
}

/// Quick reads of the player's clock, `reads` of them 13 ms apart.
#[tauri::command]
pub async fn music_clock<R: Runtime>(
    app: AppHandle<R>,
    reads: u32,
) -> Result<Vec<Reading>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let player = Player { app };
        let mut readings = Vec::with_capacity(reads as usize);
        for _ in 0..reads.min(64) {
            let sent = now_ms();
            let position = player.number("time-pos");
            let back = now_ms();
            if let Some(position) = position {
                readings.push(Reading {
                    position,
                    at: (sent + back) / 2.0,
                    took: back - sent,
                });
            }
            std::thread::sleep(Duration::from_millis(13));
        }
        readings
    })
    .await
    .map_err(|e| e.to_string())
}

/// How a start at a moment went.
#[derive(Serialize)]
pub struct Started {
    /// Where it started from; None when it started late (not a measure of
    /// the player's own delay) or was given up on.
    position: Option<f64>,
    /// When (Unix ms) it started from there.
    at: f64,
    /// Given up on: something else was asked meanwhile.
    gone: bool,
}

/// Paused at `position`, then playing from it at `at` (Unix ms), unpaused
/// `lag` ms early: how long this player takes to make sound. Ready too late
/// for the moment, it starts a little further on, where the others will be.
#[tauri::command]
pub async fn music_play_at<R: Runtime>(
    app: AppHandle<R>,
    position: f64,
    at: f64,
    lag: f64,
) -> Result<Started, String> {
    let mine = TURN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let player = Player { app };
        let gone = Started {
            position: None,
            at,
            gone: true,
        };
        player.set("pause", Setting::Flag(true))?;
        let here = player.number("time-pos");
        if here.is_none_or(|p| (p - position).abs() > THERE_ALREADY_S) {
            player.seek(position)?;
        }
        if !player.ready(mine) {
            return Ok(gone);
        }
        let mut target = position;
        let mut when = at;
        let mut tries = 1;
        while when - lag < now_ms() && tries <= 3 {
            target = position + (now_ms() - at) / 1000.0 + CATCH_UP_MARGIN_S * f64::from(tries);
            when = at + (target - position) * 1000.0;
            player.seek(target)?;
            if !player.ready(mine) {
                return Ok(gone);
            }
            tries += 1;
        }
        let wait = when - lag - now_ms();
        if !sleep_until(when - lag, mine) {
            return Ok(gone);
        }
        player.set("pause", Setting::Flag(false))?;
        Ok(Started {
            position: (wait > -40.0).then_some(target),
            at: when,
            gone: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Paused at `at` (Unix ms), at `position`. False if given up on meanwhile.
#[tauri::command]
pub async fn music_pause_at<R: Runtime>(
    app: AppHandle<R>,
    position: f64,
    at: f64,
) -> Result<bool, String> {
    let mine = TURN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        if !sleep_until(at, mine) {
            return Ok(false);
        }
        let player = Player { app };
        player.set("pause", Setting::Flag(true))?;
        player.seek(position)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Any start or pause waiting for its moment is given up.
#[tauri::command]
pub fn music_cancel() {
    TURN.fetch_add(1, Ordering::SeqCst);
}

/// Plays at `rate`; anything but 1 goes back to 1 after `for_ms` unless
/// asked again: a page that stops checking (hidden) never leaves the song
/// running fast or slow, drifting away by the minute.
#[tauri::command]
pub async fn music_set_rate<R: Runtime>(
    app: AppHandle<R>,
    rate: f64,
    for_ms: u64,
) -> Result<(), String> {
    let mine = RATE_TURN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let player = Player { app };
        player.set("speed", Setting::Number(rate))?;
        if (rate - 1.0).abs() > f64::EPSILON && for_ms > 0 {
            std::thread::sleep(Duration::from_millis(for_ms));
            if RATE_TURN.load(Ordering::SeqCst) == mine {
                player.set("speed", Setting::Number(1.0))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
