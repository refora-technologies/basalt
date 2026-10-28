//! The system's own controls for the music playing in the app.
//!
//! Windows shows what is playing in its volume flyout and on the lock
//! screen, and sends the keyboard's media keys there; a Linux desktop has
//! MPRIS, which its top bar and lock screen read. Both are told about the
//! song here, and their buttons come back to the page as
//! `basalt://media-control` events, which move the music player exactly as
//! its own buttons do. On Android the Basalt plugin does the same with a
//! media session, so these do nothing there.

use serde::{Deserialize, Serialize};

/// The song playing, as the page describes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    /// An address the system can fetch the cover from: the app's media proxy.
    #[serde(default)]
    pub cover: Option<String>,
    /// Seconds.
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub position: f64,
    pub playing: bool,
}

/// A button pressed in the system's controls.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Pressed {
    /// `play`, `pause`, `toggle`, `next`, `previous`, `stop` or `seek`.
    pub action: &'static str,
    /// For `seek`: where to, in seconds. Negative otherwise.
    pub position: f64,
}

#[cfg(desktop)]
fn pressed(event: souvlaki::MediaControlEvent) -> Option<Pressed> {
    use souvlaki::MediaControlEvent as E;
    let simple = |action| {
        Some(Pressed {
            action,
            position: -1.0,
        })
    };
    match event {
        E::Play => simple("play"),
        E::Pause => simple("pause"),
        E::Toggle => simple("toggle"),
        E::Next => simple("next"),
        E::Previous => simple("previous"),
        E::Stop => simple("stop"),
        E::SetPosition(souvlaki::MediaPosition(at)) => Some(Pressed {
            action: "seek",
            position: at.as_secs_f64(),
        }),
        _ => None,
    }
}

#[cfg(desktop)]
mod imp {
    use std::cell::RefCell;
    use std::time::Duration;

    use souvlaki::{MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
    use tauri::{AppHandle, Emitter, Manager};

    use super::NowPlaying;

    /// The song last told to the system: title, artist, album, cover, length.
    type Shown = (String, String, String, Option<String>, u64);

    // On the main thread, where the window and its message loop are: Windows'
    // controls belong to the window, and are not to be moved between threads.
    thread_local! {
        static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
        static SHOWN_SONG: RefCell<Option<Shown>> = const { RefCell::new(None) };
    }

    fn create(app: &AppHandle) -> Option<MediaControls> {
        #[cfg(windows)]
        let hwnd = {
            let window = app.webview_windows().into_values().next()?;
            Some(window.hwnd().ok()?.0)
        };
        #[cfg(not(windows))]
        let hwnd = None;
        let config = PlatformConfig {
            display_name: "Basalt",
            dbus_name: "com.reforatech.basalt",
            hwnd,
        };
        let mut controls = MediaControls::new(config).ok()?;
        let emitter = app.clone();
        controls
            .attach(move |event| {
                if let Some(pressed) = super::pressed(event) {
                    let _ = emitter.emit("basalt://media-control", pressed);
                }
            })
            .ok()?;
        Some(controls)
    }

    pub fn show(app: &AppHandle, now: NowPlaying) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            CONTROLS.with(|cell| {
                let mut slot = cell.borrow_mut();
                if slot.is_none() {
                    *slot = create(&handle);
                }
                let Some(controls) = slot.as_mut() else {
                    return;
                };
                // The song's details only when they change: Windows fetches the
                // cover again each time it is told.
                let song = (
                    now.title.clone(),
                    now.artist.clone(),
                    now.album.clone(),
                    now.cover.clone(),
                    now.duration.round() as u64,
                );
                let changed = SHOWN_SONG.with(|shown| {
                    let mut shown = shown.borrow_mut();
                    let changed = shown.as_ref() != Some(&song);
                    *shown = Some(song);
                    changed
                });
                if changed {
                    let _ = controls.set_metadata(MediaMetadata {
                        title: Some(&now.title),
                        artist: (!now.artist.is_empty()).then_some(now.artist.as_str()),
                        album: (!now.album.is_empty()).then_some(now.album.as_str()),
                        cover_url: now.cover.as_deref(),
                        duration: (now.duration > 0.0)
                            .then(|| Duration::from_secs_f64(now.duration)),
                    });
                }
                let progress = Some(MediaPosition(Duration::from_secs_f64(
                    now.position.max(0.0),
                )));
                let _ = controls.set_playback(if now.playing {
                    MediaPlayback::Playing { progress }
                } else {
                    MediaPlayback::Paused { progress }
                });
            });
        });
    }

    pub fn clear(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| {
            CONTROLS.with(|cell| {
                if let Some(controls) = cell.borrow_mut().as_mut() {
                    let _ = controls.set_playback(MediaPlayback::Stopped);
                    let _ = controls.set_metadata(MediaMetadata::default());
                }
            });
            SHOWN_SONG.with(|shown| *shown.borrow_mut() = None);
        });
    }
}

/// Tells the system what music is playing. Nothing on Android: the plugin's
/// media session does it there.
#[tauri::command]
pub fn media_controls_show(app: tauri::AppHandle, now: NowPlaying) {
    #[cfg(desktop)]
    imp::show(&app, now);
    #[cfg(not(desktop))]
    let _ = (app, now);
}

/// No music any more.
#[tauri::command]
pub fn media_controls_clear(app: tauri::AppHandle) {
    #[cfg(desktop)]
    imp::clear(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

#[cfg(all(test, desktop))]
mod tests {
    use std::time::Duration;

    use souvlaki::{MediaControlEvent, MediaPosition};

    use super::*;

    #[test]
    fn the_system_buttons_become_the_players_own() {
        assert_eq!(pressed(MediaControlEvent::Toggle).unwrap().action, "toggle");
        assert_eq!(pressed(MediaControlEvent::Next).unwrap().action, "next");
        let seek = pressed(MediaControlEvent::SetPosition(MediaPosition(
            Duration::from_millis(61_500),
        )))
        .unwrap();
        assert_eq!((seek.action, seek.position), ("seek", 61.5));
        // Volume and the rest are the system's own business.
        assert!(pressed(MediaControlEvent::SetVolume(0.5)).is_none());
    }

    #[test]
    fn the_song_reads_as_the_page_sends_it() {
        let now: NowPlaying = serde_json::from_str(
            r#"{"title":"One More Time","artist":"Daft Punk","album":"Discovery","cover":null,"duration":320.5,"position":12,"playing":true}"#,
        )
        .unwrap();
        assert_eq!(now.title, "One More Time");
        assert!(now.playing);
        assert_eq!(now.duration, 320.5);
    }
}
