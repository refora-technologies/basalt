//! Basalt client shell, for Windows and Android.
//!
//! A thin layer of commands over [`basalt_client::Basalt`]. Everything with
//! any judgement in it lives in that crate, where it can be tested against a
//! real host in one process; this file only translates between Tauri's world
//! and that API.
//!
//! The window is frameless because the app draws its own title bar (see
//! `TitleBar.tsx`), and **transparent** — not for any visual effect, but
//! because that is how video gets on screen. libmpv renders into the native
//! window behind the webview, so the page has to be able to get out of its
//! way. `body` stays opaque, so nothing about the app looks any different;
//! only the player makes itself see-through, and mpv shows through the hole.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use basalt_client::client::{Cancel, ProgressFn, WatchHandle};
use basalt_client::proxy::MediaProxy;
use basalt_client::{Basalt, DiscoveredHost, Status, TransferEvent, UiError};
use tauri::{Emitter, Manager, State};

#[cfg(target_os = "linux")]
mod linux_player;
mod linux_share;
#[cfg(target_os = "linux")]
mod linux_update;
mod media_controls;
mod music_timing;
mod nearby_wifi;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tray;
#[cfg(target_os = "linux")]
use linux_player::{
    linux_mpv_command, linux_mpv_destroy, linux_mpv_get_property, linux_mpv_init,
    linux_mpv_set_property,
};

/// A line from the page, written to the log: what a test script running in
/// it reports. Only debug builds write it.
#[tauri::command]
fn page_log(text: String) {
    #[cfg(debug_assertions)]
    eprintln!("page: {text}");
    #[cfg(not(debug_assertions))]
    let _ = text;
}

/// After the system moved or resized the window from a press on the page,
/// on Linux: see `linux_player::release_in_page`. Nothing elsewhere.
#[tauri::command]
fn release_pointer(window: tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    linux_player::release_in_page(&window);
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// The Linux player's commands everywhere else, so one list names them all.
/// Never called: the page uses them only on Linux.
#[cfg(not(target_os = "linux"))]
mod linux_stand_in {
    const ELSEWHERE: &str = "only on Linux";
    #[tauri::command]
    pub fn linux_mpv_init(
        options: std::collections::HashMap<String, String>,
        observed: Vec<Vec<String>>,
    ) -> Result<(), String> {
        let _ = (options, observed);
        Err(ELSEWHERE.into())
    }
    #[tauri::command]
    pub fn linux_mpv_command(args: Vec<String>) -> Result<(), String> {
        let _ = args;
        Err(ELSEWHERE.into())
    }
    #[tauri::command]
    pub fn linux_mpv_set_property(name: String, value: String) -> Result<(), String> {
        let _ = (name, value);
        Err(ELSEWHERE.into())
    }
    #[tauri::command]
    pub fn linux_mpv_get_property(
        name: String,
        format: String,
    ) -> Result<serde_json::Value, String> {
        let _ = (name, format);
        Err(ELSEWHERE.into())
    }
    #[tauri::command]
    pub fn linux_mpv_destroy() -> Result<(), String> {
        Err(ELSEWHERE.into())
    }
}
#[cfg(not(target_os = "linux"))]
use linux_stand_in::{
    linux_mpv_command, linux_mpv_destroy, linux_mpv_get_property, linux_mpv_init,
    linux_mpv_set_property,
};

/// Every command answers with this: the value, or an error the interface can
/// branch on. `UiError` and the response types live in `basalt-client` so their
/// JSON field names are covered by tests — see that crate's `ui` module for why
/// that matters more than it looks.
type Answer<T> = Result<T, UiError>;

/// Bytes that crossed the link, and how long that took.
///
/// A rate cannot be reconstructed from the bytes alone: whoever receives this
/// has no reliable way to know how long the window was, and guessing from
/// arrival times is what produced a display reading 35 MB/s over a 22 MB/s
/// link.
#[derive(Debug, Clone, Copy, serde::Serialize)]
struct ByteWindow {
    bytes: u64,
    millis: f64,
}

struct AppState {
    client: Arc<Basalt>,
    proxy: tokio::sync::Mutex<Option<Arc<MediaProxy>>>,
    transfers: Mutex<HashMap<String, Cancel>>,
    /// The live-change subscription. Replaced whenever the app reconnects, and
    /// the old one stops the moment it is dropped.
    watch: Mutex<Option<WatchHandle>>,
    /// Paths handed to a player outside this app.
    ///
    /// The proxy records how far anything has *read*, which is the only
    /// resume signal an external player gives away — but it is a poor one,
    /// because a player reads ahead of what it is showing. The app's own
    /// player reports real positions, so folding its read-ahead in as well
    /// would push Continue watching minutes past where anybody has watched.
    /// Only paths in here contribute that estimate.
    external: Mutex<std::collections::HashSet<String>>,
    /// Messages from the host's other devices not yet taken by the page: kept
    /// here so one that comes while there is no page (on Android, the app
    /// swiped away and staying ready) is still there when it opens.
    channel: Mutex<std::collections::VecDeque<basalt_proto::msg::ChannelMessage>>,
    /// Where offers and hand-offs are kept a while on disk (see `keep_share_message`).
    kept_shares: Option<std::path::PathBuf>,
    /// Where share notices go for Android to show (see `share_notice`).
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    notices: Option<std::path::PathBuf>,
    /// This device's listener for files it offers from itself, started the
    /// first time it offers one.
    direct: tokio::sync::OnceCell<Arc<basalt_client::direct::DirectServer>>,
    /// Ready to receive from devices nearby, while it is.
    nearby_ready: Mutex<Option<basalt_client::nearby::Ready>>,
    /// This device's own Wi-Fi while ready, and one joined to share.
    nearby_wifi: nearby_wifi::State,
    /// Offers to devices nearby still waiting for their answer: a word here
    /// drops the line, and the other side's question goes with it.
    nearby_asking: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Offers to devices nearby waiting for the code shown there.
    nearby_offers: Mutex<std::collections::HashMap<String, WaitingOffer>>,
}

/// Messages kept for the page at most: past it, the oldest go.
const CHANNEL_KEPT: usize = 200;

impl AppState {
    /// Starts the media proxy the first time something needs a URL.
    ///
    /// Lazily, because it is only useful once connected, and starting it at
    /// launch would mean a listening socket for an app that may never play
    /// anything.
    async fn proxy(&self) -> Answer<Arc<MediaProxy>> {
        let mut slot = self.proxy.lock().await;
        if let Some(proxy) = slot.as_ref() {
            return Ok(Arc::clone(proxy));
        }
        let proxy = Arc::new(MediaProxy::start(Arc::clone(&self.client)).await?);
        *slot = Some(Arc::clone(&proxy));
        Ok(proxy)
    }
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

#[tauri::command]
fn status(state: State<'_, AppState>) -> Status {
    status_of(&state.client)
}

/// Every Basalt host answering on this network.
///
/// This is what replaced typing an address. It takes about a second — the scan
/// window — so the interface shows the previous list while it runs rather than
/// emptying itself on every sweep.
#[tauri::command]
async fn discover(state: State<'_, AppState>) -> Answer<Vec<DiscoveredHost>> {
    Ok(state.client.discover_hosts().await?)
}

/// Asks a host to pair, and reports whether it wants a PIN.
///
/// From this moment the host is displaying the request — this device's name
/// against the number to read across — so the interface can show a PIN field
/// knowing one is on screen at the other end.
#[tauri::command]
async fn begin_pairing(
    state: State<'_, AppState>,
    address: String,
) -> Answer<basalt_client::ui::PairingStart> {
    Ok(state.client.begin_pairing_at(&address).await?)
}

/// Who answers at an address typed into the drive list: a host this device
/// knows is reconnected to rather than paired with again.
#[tauri::command]
async fn identify_host(
    state: State<'_, AppState>,
    address: String,
) -> Answer<basalt_client::ui::DiscoveredHost> {
    Ok(state.client.identify_at(&address).await?)
}

/// Completes the request begun above, on the same session.
///
/// `pin` is empty when the host did not ask for one. Two calls rather than one
/// because they answer different questions, and because a single call would
/// mean typing a PIN at a host that might not be there.
#[tauri::command]
async fn finish_pairing(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    pin: String,
) -> Answer<Status> {
    let pin = pin.trim();
    state
        .client
        .finish_pairing(if pin.is_empty() { None } else { Some(pin) })
        .await?;
    start_watching(&state.client, &app);
    Ok(status_of(&state.client))
}

/// Abandons a request, for when the user backs out of the PIN screen.
///
/// Worth doing rather than letting it lapse: the host is showing a card with
/// this device's name on it, and leaving it there for three minutes after
/// somebody changed their mind is untidy at best and confusing at worst.
#[tauri::command]
async fn cancel_pairing(state: State<'_, AppState>) -> Answer<()> {
    state.client.cancel_pairing().await;
    Ok(())
}

#[tauri::command]
async fn connect_saved(state: State<'_, AppState>, app: tauri::AppHandle) -> Answer<Status> {
    state.client.connect_saved().await?;
    start_watching(&state.client, &app);
    Ok(status_of(&state.client))
}

#[tauri::command]
async fn connect_to(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    host_id: String,
    address: Option<String>,
) -> Answer<Status> {
    state.client.connect(&host_id, address.as_deref()).await?;
    start_watching(&state.client, &app);
    Ok(status_of(&state.client))
}

/// Starts the watch again, for a phone coming back to the screen.
///
/// A phone asleep, or an app in the background, can lose its connection
/// without either end noticing, and whatever the host said on it meanwhile
/// (this device removed, made read-only) is lost with it. A fresh watch asks
/// again: connecting is where the device learns both.
#[tauri::command]
async fn rewatch(state: State<'_, AppState>, app: tauri::AppHandle) -> Answer<()> {
    if state.client.is_connected() {
        start_watching(&state.client, &app);
    }
    Ok(())
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Answer<Status> {
    // Dropped, not left running: a watch with nothing to watch is a retry loop.
    state.watch.lock().expect("watch lock").take();
    state.client.disconnect().await;
    Ok(status_of(&state.client))
}

#[tauri::command]
async fn forget_host(state: State<'_, AppState>, host_id: String) -> Answer<Status> {
    // Only the drive in use has a watch to end. Forgetting another one, from
    // the drive list, used to end it too, and live changes stopped arriving.
    let in_use = state.client.status().map(|info| info.host_id);
    if in_use.as_deref() == Some(host_id.as_str()) {
        state.watch.lock().expect("watch lock").take();
    }
    state.client.forget(&host_id).await?;
    Ok(status_of(&state.client))
}

fn status_of(client: &Arc<Basalt>) -> Status {
    // The paired host on disk, which is what the window needs in order to name
    // the vault — or to forget it — while nothing is answering.
    //
    // While nothing answers, that is the host being tried again: the one used
    // last. It used to be the first ever paired, so a device with two drives
    // could name one while waiting for the other.
    let saved = client.known_hosts();
    let live = client.status();
    let waiting = client.primary_host();
    let paired = live
        .as_ref()
        .and_then(|info| saved.iter().find(|host| host.host_id == info.host_id))
        .or(waiting.as_ref());

    Status::new(live.clone(), paired, client.device_name())
        .connecting(client.is_connecting())
        .key(client.key_kind())
}

// ---------------------------------------------------------------------------
// Live changes
// ---------------------------------------------------------------------------

/// The phone's hardware key store, as the client reaches it: through the
/// Basalt plugin's Rust-only commands, which no page can call.
#[cfg(mobile)]
struct PhoneKeyStore(tauri::AppHandle);

#[cfg(mobile)]
impl basalt_client::keys::PhoneKeys for PhoneKeyStore {
    fn create(&self, alias: &str) -> Result<Vec<u8>, String> {
        use tauri_plugin_basalt_android::BasaltAndroidExt;
        self.0
            .basalt_android()
            .key_create(alias)
            .map_err(|e| e.to_string())
    }
    fn public(&self, alias: &str) -> Result<Option<Vec<u8>>, String> {
        use tauri_plugin_basalt_android::BasaltAndroidExt;
        self.0
            .basalt_android()
            .key_public(alias)
            .map_err(|e| e.to_string())
    }
    fn sign(&self, alias: &str, message: &[u8]) -> Result<Vec<u8>, String> {
        use tauri_plugin_basalt_android::BasaltAndroidExt;
        self.0
            .basalt_android()
            .key_sign(alias, message)
            .map_err(|e| e.to_string())
    }
    fn delete(&self, alias: &str) -> Result<(), String> {
        use tauri_plugin_basalt_android::BasaltAndroidExt;
        self.0
            .basalt_android()
            .key_delete(alias)
            .map_err(|e| e.to_string())
    }
}

/// Subscribes to the host's changes and forwards them to the window.
///
/// Replaces any watch already running, so reconnecting does not leave two
/// subscriptions delivering everything twice.
fn start_watching(client: &Arc<Basalt>, app: &tauri::AppHandle) {
    let emitter = app.clone();
    let told = app.clone();
    let watched = Arc::clone(client);
    // Removed by the host while open, or its access changed: the window goes
    // to the drive list, or shows the buttons it now may, without waiting for
    // the next thing somebody clicks.
    let handle = client.watch_with(
        move |change| {
            let _ = emitter.emit("basalt://change", change);
        },
        move |notice| match notice {
            // The owner changed the profiles or the rules about them: the
            // window asks again who is using this device, at once.
            basalt_client::WatchNotice::ProfilesChanged => {
                let _ = told.emit("basalt://profiles", ());
            }
            // What the profile's other devices play changed: the window asks.
            basalt_client::WatchNotice::MusicNow => {
                let _ = told.emit("basalt://music-now", ());
            }
            // A message from another of the host's devices, and who is online.
            basalt_client::WatchNotice::Channel(message) => {
                if let Some(state) = told.try_state::<AppState>() {
                    let mut kept = state.channel.lock().expect("channel lock");
                    kept.push_back(message.clone());
                    while kept.len() > CHANNEL_KEPT {
                        kept.pop_front();
                    }
                }
                #[cfg(target_os = "android")]
                share_offer_notice(&told, &message);
                if message.kind == "share.offer" || message.kind == "share.handoff" {
                    let path = told
                        .try_state::<AppState>()
                        .and_then(|state| state.kept_shares.clone());
                    if let Some(path) = path {
                        keep_share_message(&path, &message);
                    }
                }
                let _ = told.emit("basalt://channel", message);
            }
            basalt_client::WatchNotice::PresenceChanged => {
                let _ = told.emit("basalt://presence", ());
            }
            notice => {
                if let basalt_client::WatchNotice::Removed(removed) = notice {
                    let _ = told.emit("basalt://removed", removed.to_string());
                }
                // Removed or made read-only: either way the window's status
                // is out of date, and with it which buttons it shows.
                let _ = told.emit("basalt://status", status_of(&watched));
            }
        },
    );
    if let Some(state) = app.try_state::<AppState>() {
        // Assigning drops the previous handle, which stops the old watch.
        *state.watch.lock().expect("watch lock") = Some(handle);
    }
}

// ---------------------------------------------------------------------------
// The media library
// ---------------------------------------------------------------------------

/// The host's index of films and series.
///
/// `knownRevision` lets the answer be "nothing has changed", which is what
/// makes it cheap to ask after every change event.
#[tauri::command]
async fn library(
    state: State<'_, AppState>,
    known_revision: u64,
) -> Answer<basalt_proto::msg::LibraryResponse> {
    Ok(state.client.library(known_revision).await?)
}

/// A poster, as a data URL an `<img>` can use directly.
///
/// A data URL rather than a byte array because the alternative is shipping
/// megabytes of JSON-encoded numbers across the IPC boundary and rebuilding a
/// blob on the other side. Posters are ~40 KB and cached by the interface, so
/// the base64 overhead is paid once per title.
#[tauri::command]
async fn library_art(state: State<'_, AppState>, id: String) -> Answer<Option<String>> {
    match state.client.art(&id).await {
        Ok(bytes) if !bytes.is_empty() => {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(Some(format!("data:image/jpeg;base64,{encoded}")))
        }
        // A missing poster is not an error worth a banner: the interface draws
        // its own instead.
        _ => Ok(None),
    }
}

/// Records where something got to, and reads back everything watched.
///
/// Also folds in whatever the media proxy has seen an external player read,
/// which is the only resume signal a player like PotPlayer gives away. It runs
/// ahead of what is actually on screen by however much the player buffered, so
/// it is an estimate — good enough for Continue watching, and much better than
/// having nothing for anything that will not play in the window.
#[tauri::command]
async fn watch_progress(
    state: State<'_, AppState>,
    update: Option<basalt_proto::msg::Watched>,
    forget: Option<String>,
) -> Answer<Vec<basalt_proto::msg::Watched>> {
    // Whatever an external player read since the last poll, reported first so
    // the answer already includes it.
    if let Some(proxy) = state.proxy.lock().await.as_ref() {
        let external = state.external.lock().expect("external lock").clone();
        for (path, reach) in proxy.take_reach() {
            let fraction = reach.fraction();
            // Read-ahead is only a resume signal for a player this app cannot
            // see. Its own reports what it is actually showing.
            if fraction <= 0.0 || !external.contains(&path) {
                continue;
            }
            let _ = state
                .client
                .progress(basalt_proto::msg::ProgressRequest {
                    update: Some(basalt_proto::msg::Watched {
                        path,
                        fraction,
                        // Seconds are unknowable from a byte offset, and the
                        // host is careful not to let this overwrite a real
                        // position with a weaker guess.
                        position: 0.0,
                        duration: 0.0,
                        updated_at: 0,
                    }),
                    forget: None,
                })
                .await;
        }
    }

    Ok(state
        .client
        .progress(basalt_proto::msg::ProgressRequest { update, forget })
        .await?)
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_dir(
    state: State<'_, AppState>,
    path: String,
) -> Answer<Vec<basalt_proto::msg::DirEntry>> {
    Ok(state.client.list(&path).await?)
}

#[tauri::command]
async fn space(state: State<'_, AppState>) -> Answer<(u64, u64)> {
    Ok(state.client.space().await?)
}

#[tauri::command]
async fn stat_entry(
    state: State<'_, AppState>,
    path: String,
) -> Answer<basalt_proto::msg::DirEntry> {
    Ok(state.client.stat(&path).await?)
}

#[tauri::command]
async fn copy_entry(state: State<'_, AppState>, from: String, to: String) -> Answer<()> {
    Ok(state.client.copy(&from, &to).await?)
}

#[tauri::command]
async fn make_dir(state: State<'_, AppState>, path: String) -> Answer<()> {
    Ok(state.client.mkdir(&path).await?)
}

#[tauri::command]
async fn rename_entry(state: State<'_, AppState>, from: String, to: String) -> Answer<()> {
    Ok(state.client.rename(&from, &to).await?)
}

#[tauri::command]
async fn remove_entry(state: State<'_, AppState>, path: String, recursive: bool) -> Answer<()> {
    Ok(state.client.remove(&path, recursive).await?)
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/// Who is using this device, and whether to ask.
#[tauri::command]
async fn identity(state: State<'_, AppState>) -> Answer<basalt_client::IdentityState> {
    Ok(state.client.identity().await)
}

/// Asks the host this device manages to do what its own window would, and
/// answers with the host as that window shows it.
#[tauri::command]
async fn manage(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    action: basalt_proto::msg::ManageAction,
) -> Answer<serde_json::Value> {
    let before = state.client.status().map(|i| (i.has_vault, i.vault));
    let view = state.client.manage(action).await?;
    // A drive chosen, or another: the rest of the window follows at once.
    if state.client.status().map(|i| (i.has_vault, i.vault)) != before {
        let _ = app.emit("basalt://status", status_of(&state.client));
    }
    Ok(view)
}

#[tauri::command]
async fn profiles(state: State<'_, AppState>) -> Answer<Vec<basalt_proto::msg::ProfileView>> {
    Ok(state.client.profiles().await?)
}

#[tauri::command]
async fn create_profile(
    state: State<'_, AppState>,
    name: String,
    pin: String,
    color: u8,
    remember: bool,
) -> Answer<basalt_proto::msg::ProfileView> {
    Ok(state
        .client
        .create_profile(&name, &pin, color, remember)
        .await?)
}

#[tauri::command]
async fn sign_in_profile(
    state: State<'_, AppState>,
    id: String,
    pin: String,
    remember: bool,
) -> Answer<basalt_proto::msg::ProfileView> {
    Ok(state.client.sign_in_profile(&id, &pin, remember).await?)
}

/// Signs in to a profile with no PIN yet, choosing its PIN, with the code
/// the host shows for it.
#[tauri::command]
async fn claim_profile(
    state: State<'_, AppState>,
    id: String,
    code: String,
    pin: String,
    remember: bool,
) -> Answer<basalt_proto::msg::ProfileView> {
    Ok(state
        .client
        .claim_profile(&id, &code, &pin, remember)
        .await?)
}

/// Profiles this device is signed in to on its other drives.
#[tauri::command]
async fn profiles_elsewhere(
    state: State<'_, AppState>,
) -> Answer<Vec<basalt_client::ui::ProfilePass>> {
    Ok(state.client.profiles_elsewhere())
}

/// Uses one of them here: signed in, or waiting for approval.
#[tauri::command]
async fn use_profile_elsewhere(
    state: State<'_, AppState>,
    host_id: String,
    profile_id: String,
    remember: bool,
) -> Answer<basalt_client::ui::ProfileLinkOutcome> {
    Ok(state
        .client
        .use_profile_elsewhere(&host_id, &profile_id, remember)
        .await?)
}

#[tauri::command]
async fn sign_out_profile(state: State<'_, AppState>) -> Answer<()> {
    Ok(state.client.sign_out_profile().await?)
}

#[tauri::command]
async fn continue_as_device(state: State<'_, AppState>, always: bool) -> Answer<()> {
    Ok(state.client.continue_as_device(always).await?)
}

/// The subtitles for one video, wherever they are on the drive.
#[tauri::command]
async fn subtitles_for(
    state: State<'_, AppState>,
    path: String,
) -> Answer<basalt_proto::msg::SubtitlesResponse> {
    Ok(state.client.subtitles(&path).await?)
}

/// The signed-in profile's stars, replaced first when `set` is given.
#[tauri::command]
async fn profile_stars(
    state: State<'_, AppState>,
    set: Option<Vec<basalt_proto::msg::Star>>,
) -> Answer<Vec<basalt_proto::msg::Star>> {
    Ok(state.client.stars(set).await?)
}

/// Every video, song and photo on the drive, sorted by the host.
#[tauri::command]
async fn collections(
    state: State<'_, AppState>,
    known_revision: u64,
) -> Answer<basalt_proto::msg::CollectionsResponse> {
    Ok(state.client.collections(known_revision).await?)
}

/// Every song on the drive with its tags, read by the host.
#[tauri::command]
async fn music(
    state: State<'_, AppState>,
    known_revision: u64,
) -> Answer<basalt_proto::msg::MusicResponse> {
    Ok(state.client.music(known_revision).await?)
}

/// The profile's playlists and where it was listening, kept on the host.
#[tauri::command]
async fn music_mine(
    state: State<'_, AppState>,
    request: basalt_proto::msg::MusicMineRequest,
) -> Answer<basalt_proto::msg::MusicMine> {
    Ok(state.client.music_mine(request).await?)
}

/// What this device plays, told to the host, and what the profile's other
/// devices play, with what they asked of this one.
#[tauri::command]
async fn music_now(
    state: State<'_, AppState>,
    request: basalt_proto::msg::MusicNowRequest,
) -> Answer<basalt_proto::msg::MusicNowResponse> {
    Ok(state.client.music_now(request).await?)
}

/// Whether the app goes on running when its window closes: set while it is
/// ready to receive, with Android's service keeping it going. Then the exit a
/// closed window asks for is refused, and the line to the host, the heartbeat
/// and anything moving carry on without a window. A window opened again finds
/// them still there.
static STAY_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn stay_running(on: bool) {
    STAY_RUNNING.store(on, std::sync::atomic::Ordering::SeqCst);
}

/// A notification from the system, with up to two buttons: see `tray::notify`.
#[tauri::command]
fn notify(
    app: tauri::AppHandle,
    tag: String,
    title: String,
    text: String,
    buttons: Vec<(String, String)>,
) {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    tray::notify(&app, tag, &title, &text, &buttons);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = (app, tag, title, text, buttons);
}

/// The messages from other devices the page has not taken yet, now handed
/// over: at start, and as each one is told (`basalt://channel`).
#[tauri::command]
fn channel_take(state: State<'_, AppState>) -> Vec<basalt_proto::msg::ChannelMessage> {
    state
        .channel
        .lock()
        .expect("channel lock")
        .drain(..)
        .collect()
}

/// A file received here, opened with what the computer opens it with. A
/// program never is: it is shown in its folder instead, for the person to
/// decide.
#[tauri::command]
fn received_open(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = std::path::Path::new(&path);
    if !file.is_file() {
        return Err("It’s no longer there.".into());
    }
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if is_program(name) {
        return Err(
            "A program is never opened by Basalt: it’s shown in its folder instead.".into(),
        );
    }
    #[cfg(desktop)]
    {
        open_outside(&app, &path, false)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Only on a computer.".into())
    }
}

/// Opens a file, or with `link` an address, with the computer's own app for
/// it.
///
/// From an AppImage, the opener's own way handed that app the AppImage's
/// libraries: the Text Editor stopped at once ("undefined symbol") and Open
/// did nothing. There it is started outside them (`basalt_net::outside`).
fn open_outside(app: &tauri::AppHandle, target: &str, link: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        use std::process::Stdio;
        let mut child = basalt_net::outside::command("xdg-open")
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("couldn’t open it ({e})"))?;
        // Waited for, so it doesn't linger once it has handed over.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        return Ok(());
    }
    use tauri_plugin_opener::OpenerExt;
    if link {
        app.opener().open_url(target, None::<&str>)
    } else {
        app.opener().open_path(target, None::<&str>)
    }
    .map_err(|e| e.to_string())
}

/// A link from the page, opened in the browser or the mail app: on Linux,
/// where an AppImage must start the browser outside its own libraries. Only
/// the addresses the app's capability file lets the opener open, the same
/// list, read from it.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !link_allowed(&url) {
        return Err("Basalt doesn’t open that address.".into());
    }
    open_outside(&app, &url, true)
}

/// Whether `url` is one of the addresses in `capabilities/default.json`'s
/// `opener:allow-open-url`: the same, or under one ending in `*`.
fn link_allowed(url: &str) -> bool {
    static ALLOWED: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    let allowed = ALLOWED.get_or_init(|| {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap_or_default();
        capability["permissions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["identifier"] == "opener:allow-open-url")
            .flat_map(|p| p["allow"].as_array().cloned().unwrap_or_default())
            .filter_map(|a| a["url"].as_str().map(str::to_string))
            .collect()
    });
    allowed
        .iter()
        .any(|pattern| match pattern.strip_suffix('*') {
            Some(start) => url.starts_with(start),
            None => url == pattern,
        })
}

/// A file received here, shown selected in its folder.
#[tauri::command]
fn received_show(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = std::path::Path::new(&path);
    if !file.exists() {
        return Err("It’s no longer there.".into());
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .reveal_item_in_dir(file)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Only on a computer.".into())
    }
}

/// Where a file shared with this device landed.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Received {
    /// Where somebody would look for it: a folder and a name.
    shown_as: String,
    /// On a computer, the file itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// On a phone, what opens or shares it.
    #[serde(skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
}

/// Takes a file shared with this device from the drive into its received
/// folder: a computer's Downloads\Basalt unless another is chosen, a phone's
/// Download/Basalt. Never over a file already there: a second copy is
/// "name (1).ext".
#[tauri::command]
async fn receive_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    remote: String,
    id: String,
    folder: Option<String>,
) -> Answer<Received> {
    #[cfg(target_os = "android")]
    {
        let _ = folder;
        let saved = download_to_phone(app, state, remote, id).await?;
        Ok(Received {
            shown_as: saved.shown_as,
            path: None,
            uri: Some(saved.uri),
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let dir = match folder.filter(|f| !f.trim().is_empty()) {
            Some(folder) => PathBuf::from(folder),
            None => received_folder(&app)?,
        };
        std::fs::create_dir_all(&dir).map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t make the folder {}: {e}", dir.display()),
        })?;
        let local = free_name(&dir, &safe_local_name(&remote));
        let shown_as = local.display().to_string();
        download(app, state, remote, shown_as.clone(), id).await?;
        Ok(Received {
            shown_as: shown_as.clone(),
            path: Some(shown_as),
            uri: None,
        })
    }
}

/// The folder shared files land in unless another is chosen.
#[cfg(not(target_os = "android"))]
fn received_folder(app: &tauri::AppHandle) -> Answer<PathBuf> {
    app.path()
        .download_dir()
        .map(|d| d.join("Basalt"))
        .map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t find the Downloads folder: {e}"),
        })
}

/// The received folder, for Settings to show.
#[tauri::command]
fn default_received_folder(app: tauri::AppHandle) -> Answer<String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Ok("Download/Basalt".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(received_folder(&app)?.display().to_string())
    }
}

/// `name` in `dir`, or "name (1).ext", "name (2).ext"... whichever is free.
#[cfg(not(target_os = "android"))]
fn free_name(dir: &std::path::Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("a free name")
}

/// Opens a file this device offers: a path on a computer, a content URI on
/// a phone.
fn open_local(app: &tauri::AppHandle) -> basalt_client::direct::Opener {
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        Arc::new(move |source: &str| {
            use tauri_plugin_basalt_android::BasaltAndroidExt;
            let fd = app
                .basalt_android()
                .open_fd(source, "r")
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            Ok(owned_file(fd))
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Arc::new(|source: &str| std::fs::File::open(source))
    }
}

/// This device's listener for files it offers, started now: files on it, and
/// files on the drive passed on from the host as they come (`drive:<path>`),
/// for a device nearby that isn't on the host.
async fn start_direct(
    app: &tauri::AppHandle,
    client: Arc<Basalt>,
) -> basalt_client::Result<Arc<basalt_client::direct::DirectServer>> {
    let server = basalt_client::direct::DirectServer::start(open_local(app)).await?;
    server.set_relay(Arc::new(move |path: String, from: u64| {
        let client = Arc::clone(&client);
        Box::pin(async move {
            let (total, read) = client
                .read_stream(&path, from)
                .await
                .map_err(std::io::Error::other)?;
            Ok((
                total,
                Box::new(read) as Box<dyn tokio::io::AsyncRead + Send + Unpin>,
            ))
        })
    }));
    Ok(server)
}

/// Offers files on this device to another, straight across the Wi-Fi: where
/// to take them from, and the secret that does. `sources` are paths, or a
/// phone's content URIs.
#[tauri::command]
async fn share_local(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    offer: String,
    sources: Vec<String>,
) -> Answer<serde_json::Value> {
    let server = state
        .direct
        .get_or_try_init(|| start_direct(&app, Arc::clone(&state.client)))
        .await?;
    let token = server.offer(&offer, sources);
    Ok(serde_json::json!({ "endpoint": server.endpoint(), "token": token }))
}

/// This device as others nearby see it: its name, kind and short id.
fn nearby_me(state: &AppState) -> basalt_client::nearby::Me {
    basalt_client::nearby::Me {
        id: basalt_client::nearby::short_id(state.client.device_id().as_bytes()),
        name: state.client.device_name().to_string(),
        form: Some(
            if cfg!(target_os = "android") {
                "phone"
            } else {
                "computer"
            }
            .to_string(),
        ),
    }
}

/// This device's name and short id, as devices nearby see them.
#[tauri::command]
fn nearby_whoami(state: State<'_, AppState>) -> basalt_client::nearby::Me {
    nearby_me(&state)
}

/// Ready to receive from devices nearby, or not; `always_code` asks every
/// sender for a code. What happens comes as `basalt://nearby-ready` events.
#[tauri::command]
async fn nearby_ready(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    on: bool,
    always_code: bool,
) -> Answer<()> {
    use tauri::Emitter;
    // The last one stops first, so its port is free for this one.
    let before = state.nearby_ready.lock().expect("nearby lock").take();
    drop(before);
    if !on {
        return Ok(());
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let ready = basalt_client::nearby::Ready::start(
        nearby_me(&state),
        always_code,
        tx,
        basalt_client::nearby::READY_PORT,
    )
    .await?;
    *state.nearby_ready.lock().expect("nearby lock") = Some(ready);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            #[cfg(target_os = "android")]
            nearby_offer_notice(&app, &event);
            let _ = app.emit("basalt://nearby-ready", &event);
        }
    });
    Ok(())
}

/// How long an offer or hand-off is kept on disk for a page that isn't
/// there yet: a phone's app reopened from its notification starts afresh,
/// and what was only in memory would be gone. As long as an offer is worth
/// answering (OFFER_TTL_MS on the page).
const KEPT_SHARES_FOR_MS: u128 = 10 * 60_000;

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Adds `message` to those kept at `path`, dropping any too old.
fn keep_share_message(path: &std::path::Path, message: &basalt_proto::msg::ChannelMessage) {
    let mut kept: Vec<serde_json::Value> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let now = now_ms();
    kept.retain(|k| {
        k["at"]
            .as_u64()
            .is_some_and(|at| now.saturating_sub(u128::from(at)) < KEPT_SHARES_FOR_MS)
    });
    kept.push(serde_json::json!({ "at": now as u64, "message": message }));
    let start = kept.len().saturating_sub(20);
    if let Ok(bytes) = serde_json::to_vec(&kept[start..]) {
        let _ = std::fs::write(path, bytes);
    }
}

/// The offers and hand-offs kept at `path` still worth answering: what the
/// page finds waiting when it starts (it skips any it already has).
fn kept_share_messages(
    path: &std::path::Path,
) -> std::collections::VecDeque<basalt_proto::msg::ChannelMessage> {
    let kept: Vec<serde_json::Value> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let now = now_ms();
    kept.into_iter()
        .filter(|k| {
            k["at"]
                .as_u64()
                .is_some_and(|at| now.saturating_sub(u128::from(at)) < KEPT_SHARES_FOR_MS)
        })
        .filter_map(|k| serde_json::from_value(k["message"].clone()).ok())
        .collect()
}

/// A share offered by a device of this home, told by Android itself while
/// the app is out of sight: with the app swiped away there is no page to
/// tell it. The offer's own tag, so the page's fuller one (Accept, Decline)
/// takes its place when the page is there to make it.
#[cfg(target_os = "android")]
fn share_offer_notice(app: &tauri::AppHandle, message: &basalt_proto::msg::ChannelMessage) {
    use tauri_plugin_basalt_android::BasaltAndroidExt;
    // An offer, or one passed on by another of this person's devices to be
    // taken here ("Accept on"): the offer itself is inside.
    let (body, passed) = match message.kind.as_str() {
        "share.offer" => (&message.body, false),
        "share.handoff" => (&message.body["offer"], true),
        _ => return,
    };
    let Some(offer) = body["offer"].as_str() else {
        return;
    };
    let names: Vec<&str> = body["files"]
        .as_array()
        .map(|files| files.iter().filter_map(|f| f["name"].as_str()).collect())
        .unwrap_or_default();
    let what = match names.as_slice() {
        [one] => (*one).to_string(),
        [] => "a file".to_string(),
        many => format!("{} files", many.len()),
    };
    let from = body["from"]["profileName"]
        .as_str()
        .or(body["from"]["name"].as_str())
        .unwrap_or(&message.from_name);
    let (title, text) = if passed {
        (
            format!("{what} from {from}: tap to take it here"),
            format!("Passed on from {}", message.from_name),
        )
    } else {
        (
            format!("{from} wants to send you {what}"),
            format!("From {}", message.from_name),
        )
    };
    share_notice(app, offer, &title, &text, &[]);
}

/// An offer from a device nearby, told by Android itself while the app is
/// out of sight: the page doesn't run then, so it can't. The same tag and
/// buttons as the page's own (nearbyNotifications.ts), so a tap answers it.
#[cfg(target_os = "android")]
fn nearby_offer_notice(app: &tauri::AppHandle, event: &basalt_client::nearby::ReadyEvent) {
    let basalt_client::nearby::ReadyEvent::Offer {
        ask,
        from,
        files,
        code,
    } = event
    else {
        return;
    };
    let what = match files.as_slice() {
        [one] => one.name.clone(),
        many => format!("{} files", many.len()),
    };
    let title = format!("{} · {} wants to send you {what}", from.name, from.id);
    let text = if *code {
        "A device nearby · a code is asked"
    } else {
        "A device nearby"
    };
    share_notice(
        app,
        &format!("nearby-{ask}"),
        &title,
        text,
        &["Accept|accept", "Decline|decline"],
    );
    nearby_log(&format!("offer {ask}: notice written"));
}

/// A share's notice, for Android to show while Basalt isn't on screen
/// (ShareNotices watches the file): written, never asked of the plugin,
/// which fails with Basalt swiped away. The last 20 are kept.
#[cfg(target_os = "android")]
fn share_notice(app: &tauri::AppHandle, tag: &str, title: &str, text: &str, actions: &[&str]) {
    let Some(path) = app
        .try_state::<AppState>()
        .and_then(|state| state.notices.clone())
    else {
        return;
    };
    let mut kept: Vec<serde_json::Value> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    kept.push(serde_json::json!({
        "at": now_ms() as u64,
        "tag": tag,
        "title": title,
        "text": text,
        "actions": actions,
    }));
    let start = kept.len().saturating_sub(20);
    let Ok(bytes) = serde_json::to_vec(&kept[start..]) else {
        return;
    };
    // Whole, then moved into place: the watcher reads it complete.
    let fresh = path.with_extension("json.new");
    if std::fs::write(&fresh, bytes).is_ok() {
        let _ = std::fs::rename(&fresh, &path);
    }
}

/// Accept or Decline for an offer from a device nearby. False if it's gone.
#[tauri::command]
fn nearby_reply(state: State<'_, AppState>, ask: String, accept: bool) -> bool {
    state
        .nearby_ready
        .lock()
        .expect("nearby lock")
        .as_ref()
        .is_some_and(|ready| ready.answer(&ask, accept))
}

/// How taking the files from a device nearby went: `done` or `failed`.
#[tauri::command]
fn nearby_finish(state: State<'_, AppState>, ask: String, answer: String) {
    if let Some(ready) = state.nearby_ready.lock().expect("nearby lock").as_ref() {
        ready.finish(&ask, &answer);
    }
}

/// This device's own Wi-Fi, as others find it: its name and passphrase.
#[tauri::command]
fn nearby_wifi_own(state: State<'_, AppState>) -> nearby_wifi::Own {
    nearby_wifi::own(&nearby_me(&state))
}

/// The passphrase of a Basalt Wi-Fi found around, from its name.
#[tauri::command]
fn nearby_wifi_passphrase(ssid: String) -> Answer<String> {
    let (id, _) = basalt_client::nearby::wifi_device(&ssid).ok_or_else(|| UiError {
        kind: "error".into(),
        message: "that isn't a Basalt Wi-Fi".into(),
    })?;
    Ok(basalt_client::nearby::wifi_passphrase(&id))
}

fn wifi_error(message: String) -> UiError {
    UiError {
        kind: "error".into(),
        message,
    }
}

/// Hosts this computer's own Wi-Fi while it is ready, for devices with no
/// network in common; or stops.
#[tauri::command]
async fn nearby_wifi_host(app: tauri::AppHandle, on: bool) -> Answer<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if on {
            nearby_wifi::host(&state.nearby_wifi, &nearby_me(&state)).map_err(wifi_error)
        } else {
            nearby_wifi::stop_host(&state.nearby_wifi);
            Ok(())
        }
    })
    .await
    .map_err(|e| wifi_error(e.to_string()))?
}

/// The Basalt Wi-Fis around: devices ready with no network in common.
#[tauri::command]
async fn nearby_wifi_scan() -> Answer<Vec<nearby_wifi::Found>> {
    tauri::async_runtime::spawn_blocking(nearby_wifi::scan)
        .await
        .map_err(|e| wifi_error(e.to_string()))?
        .map_err(wifi_error)
}

/// Joins a Basalt Wi-Fi found around, to share with the device hosting it.
#[tauri::command]
async fn nearby_wifi_join(app: tauri::AppHandle, ssid: String) -> Answer<()> {
    tauri::async_runtime::spawn_blocking(move || {
        nearby_wifi::join(&app.state::<AppState>().nearby_wifi, &ssid).map_err(wifi_error)
    })
    .await
    .map_err(|e| wifi_error(e.to_string()))?
}

/// Leaves a Basalt Wi-Fi joined to share: back to the Wi-Fi before.
#[tauri::command]
async fn nearby_wifi_leave(app: tauri::AppHandle) -> Answer<()> {
    tauri::async_runtime::spawn_blocking(move || {
        nearby_wifi::leave(&app.state::<AppState>().nearby_wifi)
    })
    .await
    .map_err(|e| wifi_error(e.to_string()))
}

/// Whether Windows Firewall lets devices nearby reach this app: `open`,
/// `blocked` or `unknown` (always `open` elsewhere).
#[tauri::command]
async fn nearby_firewall() -> Answer<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = std::env::current_exe().map_err(|e| wifi_error(e.to_string()))?;
        Ok(basalt_net::firewall::check(&exe).as_str().to_string())
    })
    .await
    .map_err(|e| wifi_error(e.to_string()))?
}

/// Lets devices nearby reach this app through Windows Firewall, after
/// Windows asks for an administrator; what it does now.
#[tauri::command]
async fn nearby_firewall_allow() -> Answer<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = std::env::current_exe().map_err(|e| wifi_error(e.to_string()))?;
        // The development copy's own name, never the real app's rule.
        let name = if dev_isolated().is_some() {
            "Basalt (development copy)"
        } else {
            "Basalt"
        };
        basalt_net::firewall::allow(
            &exe,
            name,
            "Lets devices nearby offer you files, and take the ones you send them.",
        )
        .map(|state| state.as_str().to_string())
        .map_err(|e| wifi_error(e.to_string()))
    })
    .await
    .map_err(|e| wifi_error(e.to_string()))?
}

/// An offer to a device nearby waiting for its code: the line, where each
/// file is (`drive:` for one on the drive), and their size together.
type WaitingOffer = (basalt_client::nearby::Offering, Vec<String>, u64);

/// The files after `--share` in a command line ("Share with Basalt" in
/// Explorer, Send to): each that is a file here, with its name and size.
fn shared_in(args: &[String]) -> Vec<LocalFile> {
    let Some(at) = args.iter().position(|a| a == "--share") else {
        return Vec::new();
    };
    args[at + 1..]
        .iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
            let name = std::path::Path::new(path)
                .file_name()?
                .to_string_lossy()
                .into_owned();
            Some(LocalFile {
                source: path.clone(),
                name,
                size: meta.len(),
            })
        })
        .collect()
}

/// Files Basalt was opened to share ("Share with Basalt" with it closed),
/// once: the page asks as it starts.
#[tauri::command]
fn shared_at_start() -> Vec<LocalFile> {
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if TAKEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Vec::new();
    }
    shared_in(&std::env::args().collect::<Vec<_>>())
}

/// One line of what sharing nearby did, for the device's own log: Android's
/// logcat (tag "BasaltNearby"), or the console on a computer.
fn nearby_log(line: &str) {
    #[cfg(target_os = "android")]
    {
        unsafe extern "C" {
            fn __android_log_write(
                priority: std::ffi::c_int,
                tag: *const std::ffi::c_char,
                text: *const std::ffi::c_char,
            ) -> std::ffi::c_int;
        }
        const INFO: std::ffi::c_int = 4;
        let text = std::ffi::CString::new(line.replace('\0', " ")).unwrap_or_default();
        // SAFETY: both are NUL-terminated strings that outlive the call.
        unsafe {
            __android_log_write(INFO, c"BasaltNearby".as_ptr(), text.as_ptr());
        }
    }
    #[cfg(not(target_os = "android"))]
    eprintln!("nearby: {line}");
}

/// A step of sharing nearby, as the page saw it: into the same log.
#[tauri::command]
fn nearby_note(line: String) {
    nearby_log(&format!(
        "page: {}",
        line.chars().take(500).collect::<String>()
    ));
}

/// The devices nearby ready to receive, on this Wi-Fi.
#[tauri::command]
async fn nearby_find(
    state: State<'_, AppState>,
) -> Answer<Vec<basalt_client::nearby::NearbyDevice>> {
    let me = nearby_me(&state);
    let mut found = basalt_client::nearby::find(
        basalt_client::nearby::READY_PORT,
        basalt_client::nearby::LOOK_FOR,
    )
    .await?;
    // Never this device itself, ready on its own.
    found.retain(|d| d.id != me.id);
    Ok(found)
}

/// Offers files on this device (or the drive's, `drive:<path>`) to a device
/// nearby, and waits for its answer: accepted (the files go down the same line,
/// `basalt://nearby-progress` says how far, `basalt://nearby-sent` how it
/// ended), declined, or a code wanted (then `nearby_code`).
#[tauri::command]
async fn nearby_offer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    device: basalt_client::nearby::NearbyDevice,
    offer: String,
    files: Vec<LocalFile>,
    always_code: bool,
) -> Answer<basalt_client::nearby::Said> {
    let listed: Vec<basalt_client::nearby::NearbyFile> = files
        .iter()
        .map(|f| basalt_client::nearby::NearbyFile {
            name: f.name.clone(),
            size: f.size,
        })
        .collect();
    let me = nearby_me(&state);
    // Taken back while it waits (Cancel): the line drops, and the question
    // on the other device goes with it, rather than staying to be accepted.
    let (stop, stopped) = tokio::sync::oneshot::channel();
    state
        .nearby_asking
        .lock()
        .expect("nearby lock")
        .insert(offer.clone(), stop);
    let asked = tokio::select! {
        answered = basalt_client::nearby::offer(&device, &me, &listed, always_code) => Some(answered),
        _ = stopped => None,
    };
    state
        .nearby_asking
        .lock()
        .expect("nearby lock")
        .remove(&offer);
    let (said, offering) = match asked {
        Some(Ok(answered)) => answered,
        Some(Err(e)) => return Err(e.into()),
        None => {
            return Err(UiError {
                kind: "cancelled".into(),
                message: "Cancelled.".into(),
            });
        }
    };
    let sources: Vec<String> = files.into_iter().map(|f| f.source).collect();
    let total: u64 = listed.iter().map(|f| f.size).sum();
    match said {
        basalt_client::nearby::Said::Accepted => nearby_serve(app, offer, offering, sources, total),
        basalt_client::nearby::Said::Code => {
            state
                .nearby_offers
                .lock()
                .expect("nearby lock")
                .insert(offer, (offering, sources, total));
        }
        basalt_client::nearby::Said::Declined => {}
    }
    Ok(said)
}

/// Sends an agreed offer's files down its line as they're asked for, then
/// says how it ended.
fn nearby_serve(
    app: tauri::AppHandle,
    offer: String,
    offering: basalt_client::nearby::Offering,
    sources: Vec<String>,
    total: u64,
) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let opener = open_local(&app);
        let client = Arc::clone(&app.state::<AppState>().client);
        let open = move |file: usize| {
            let source = sources.get(file).cloned();
            let opener = Arc::clone(&opener);
            let client = Arc::clone(&client);
            async move {
                let source = source.ok_or_else(|| std::io::Error::other("no such file"))?;
                // A file on the drive: passed on from the host as it comes.
                if let Some(path) = source.strip_prefix(basalt_client::direct::DRIVE_SOURCE) {
                    let (length, read) = client
                        .read_stream(path, 0)
                        .await
                        .map_err(std::io::Error::other)?;
                    return Ok((length, Box::new(read) as basalt_client::nearby::Source));
                }
                let file = tokio::task::spawn_blocking(move || opener(&source))
                    .await
                    .map_err(std::io::Error::other)??;
                let length = file.metadata()?.len();
                Ok((
                    length,
                    Box::new(tokio::fs::File::from_std(file)) as basalt_client::nearby::Source,
                ))
            }
        };
        let told = app.clone();
        let progress_offer = offer.clone();
        let last = std::sync::Mutex::new(std::time::Instant::now());
        let answer = offering
            .serve(open, move |sent| {
                // About four times a second is plenty for a bar.
                let mut at = last.lock().expect("progress lock");
                if at.elapsed() < std::time::Duration::from_millis(250) && sent < total {
                    return;
                }
                *at = std::time::Instant::now();
                let _ = told.emit(
                    "basalt://nearby-progress",
                    serde_json::json!({ "offer": progress_offer, "done": sent, "total": total.max(sent) }),
                );
            })
            .await;
        let _ = app.emit(
            "basalt://nearby-sent",
            serde_json::json!({ "offer": offer, "answer": answer }),
        );
    });
}

/// The code shown on the device nearby, typed here.
#[tauri::command]
async fn nearby_code(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    offer: String,
    code: String,
) -> Answer<basalt_client::nearby::CodeSaid> {
    let taken = state
        .nearby_offers
        .lock()
        .expect("nearby lock")
        .remove(&offer);
    let Some((mut offering, sources, total)) = taken else {
        return Err(UiError {
            kind: "error".into(),
            message: "that offer has ended: send it again".into(),
        });
    };
    let said = offering.code(&code).await?;
    match said {
        basalt_client::nearby::CodeSaid::Right => {
            nearby_serve(app, offer, offering, sources, total)
        }
        basalt_client::nearby::CodeSaid::Wrong { left } if left > 0 => {
            state
                .nearby_offers
                .lock()
                .expect("nearby lock")
                .insert(offer, (offering, sources, total));
        }
        basalt_client::nearby::CodeSaid::Wrong { .. } => {}
    }
    Ok(said)
}

/// Stops an offer to a device nearby: nobody can take it any more.
#[tauri::command]
fn nearby_cancel(state: State<'_, AppState>, offer: String) {
    if let Some(stop) = state
        .nearby_asking
        .lock()
        .expect("nearby lock")
        .remove(&offer)
    {
        let _ = stop.send(());
    }
    state
        .nearby_offers
        .lock()
        .expect("nearby lock")
        .remove(&offer);
}

/// Takes an offer back: nobody can take its files any more.
#[tauri::command]
fn withdraw_local(state: State<'_, AppState>, offer: String) {
    if let Some(server) = state.direct.get() {
        server.withdraw(&offer);
    }
}

/// Files picked on this computer, with their names and sizes, to offer.
#[tauri::command]
fn local_files(paths: Vec<String>) -> Vec<serde_json::Value> {
    paths
        .into_iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
            let name = std::path::Path::new(&path)
                .file_name()?
                .to_string_lossy()
                .into_owned();
            Some(serde_json::json!({ "source": path, "name": name, "size": meta.len() }))
        })
        .collect()
}

/// Takes one file of an offer straight from the device that offers it,
/// across the Wi-Fi, into this device's received folder.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn receive_direct(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    endpoint: basalt_client::direct::Endpoint,
    offer: String,
    token: String,
    file: usize,
    name: String,
    id: String,
    folder: Option<String>,
) -> Answer<Received> {
    let shown = name.clone();
    receive_into(
        app,
        &state,
        name,
        id,
        folder,
        move |out, report, cancel| async move {
            basalt_client::direct::fetch(
                &endpoint,
                &offer,
                &token,
                file,
                &shown,
                out,
                Some(report),
                Some(cancel),
            )
            .await
        },
    )
    .await
}

/// Takes one file of an offer from a device nearby, agreed: it comes down
/// the line its offer came up.
#[tauri::command]
async fn nearby_take_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ask: String,
    file: usize,
    name: String,
    id: String,
    folder: Option<String>,
) -> Answer<Received> {
    let link = state
        .nearby_ready
        .lock()
        .expect("nearby lock")
        .as_ref()
        .and_then(|ready| ready.link(&ask))
        .ok_or_else(|| UiError {
            kind: "error".into(),
            message: "the device that sent it has gone".into(),
        })?;
    let shown = name.clone();
    receive_into(
        app,
        &state,
        name,
        id,
        folder,
        move |out, report, cancel| async move {
            link.take_file(file, &shown, out, Some(report), Some(cancel))
                .await
        },
    )
    .await
}

async fn receive_into<F, Fut>(
    app: tauri::AppHandle,
    state: &AppState,
    name: String,
    id: String,
    folder: Option<String>,
    take: F,
) -> Answer<Received>
where
    F: FnOnce(std::fs::File, basalt_client::client::ProgressFn, Cancel) -> Fut,
    Fut: std::future::Future<Output = basalt_client::Result<u64>>,
{
    let cancel = Cancel::new();
    state
        .transfers
        .lock()
        .expect("transfers lock")
        .insert(id.clone(), cancel.clone());
    let report = progress_reporter(app.clone(), id.clone(), name.clone(), "download");
    let safe = safe_local_name(&name);
    #[cfg(target_os = "android")]
    let outcome = {
        let _ = folder;
        use tauri_plugin_basalt_android::BasaltAndroidExt;
        let handle = app.clone();
        let wanted = safe.clone();
        let created = tokio::task::spawn_blocking(move || {
            handle.basalt_android().create_download(&wanted, "")
        })
        .await
        .map_err(|e| UiError {
            kind: "error".into(),
            message: e.to_string(),
        })?
        .map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t save to Downloads: {e}"),
        })?;
        let result = take(owned_file(created.fd), report, cancel).await;
        let ok = result.is_ok();
        let handle = app.clone();
        let uri = created.uri.clone();
        let _ =
            tokio::task::spawn_blocking(move || handle.basalt_android().finish_download(&uri, ok))
                .await;
        result.map(|_| Received {
            shown_as: created.shown_as,
            path: None,
            uri: Some(created.uri),
        })
    };
    #[cfg(not(target_os = "android"))]
    let outcome = {
        let dir = match folder.filter(|f| !f.trim().is_empty()) {
            Some(folder) => PathBuf::from(folder),
            None => received_folder(&app)?,
        };
        std::fs::create_dir_all(&dir).map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t make the folder {}: {e}", dir.display()),
        })?;
        let local = free_name(&dir, &safe);
        let out = std::fs::File::create(&local).map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t write {}: {e}", local.display()),
        })?;
        let result = take(out, report, cancel).await;
        if result.is_err() {
            let _ = std::fs::remove_file(&local);
        } else {
            mark_downloaded(&local);
        }
        let shown = local.display().to_string();
        result.map(|_| Received {
            shown_as: shown.clone(),
            path: Some(shown),
            uri: None,
        })
    };
    state.transfers.lock().expect("transfers lock").remove(&id);
    Ok(outcome?)
}

/// Keeps files on the drive on the host for a device that is away.
#[tauri::command]
async fn share_hold(
    state: State<'_, AppState>,
    id: String,
    to: String,
    keep: bool,
    paths: Vec<String>,
) -> Answer<basalt_proto::msg::HeldShare> {
    Ok(state
        .client
        .share_hold(basalt_proto::msg::ShareHoldRequest {
            id,
            to,
            keep,
            paths,
            staged: Vec::new(),
        })
        .await?)
}

/// A file on this device to keep on the host for a device that is away.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct LocalFile {
    source: String,
    name: String,
    size: u64,
}

/// Keeps files on this device on the host for a device that is away: each
/// uploaded first (`basalt://share-sending` says how far), then kept there.
#[tauri::command]
async fn share_hold_local(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    to: String,
    keep: bool,
    files: Vec<LocalFile>,
) -> Answer<basalt_proto::msg::HeldShare> {
    use tauri::Emitter;
    let open = open_local(&app);
    let total: u64 = files.iter().map(|f| f.size).sum();
    let mut before = 0u64;
    let mut staged = Vec::new();
    for file in &files {
        let source = {
            let open = Arc::clone(&open);
            let at = file.source.clone();
            tokio::task::spawn_blocking(move || open(&at))
                .await
                .map_err(|e| std::io::Error::other(e.to_string()))
                .and_then(|opened| opened)
                // About this device's file, not the host: said as such.
                .map_err(|e| {
                    basalt_client::ClientError::Config(format!(
                        "{} couldn't be opened on this device: {e}",
                        file.name
                    ))
                })?
        };
        let told = app.clone();
        let offer = id.clone();
        let from = before;
        let progress: basalt_client::client::ProgressFn = Arc::new(move |p| {
            let _ = told.emit(
                "basalt://share-sending",
                serde_json::json!({ "offer": offer, "done": from + p.transferred, "total": total }),
            );
        });
        let stage = state
            .client
            .stage_for_share(source, file.size, &file.name, Some(progress), None)
            .await?;
        before += file.size;
        staged.push(basalt_proto::msg::StagedFile {
            stage,
            name: file.name.clone(),
            size: file.size,
        });
    }
    Ok(state
        .client
        .share_hold(basalt_proto::msg::ShareHoldRequest {
            id,
            to,
            keep,
            paths: Vec::new(),
            staged,
        })
        .await?)
}

/// This device's answer to a share the host kept for it.
#[tauri::command]
async fn share_answer(state: State<'_, AppState>, id: String, accepted: bool) -> Answer<()> {
    Ok(state.client.share_answer(&id, accepted).await?)
}

/// What this profile has kept on the host.
#[tauri::command]
async fn share_held(state: State<'_, AppState>) -> Answer<basalt_proto::msg::ShareHeldResponse> {
    Ok(state.client.share_held().await?)
}

/// Deletes a share kept on the host, moves its files onto the drive, or
/// shares it again with another device (`again`: the new share's id).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn share_manage(
    state: State<'_, AppState>,
    action: String,
    id: String,
    folder: String,
    to: Option<String>,
    again: Option<String>,
    keep: Option<bool>,
) -> Answer<()> {
    Ok(state
        .client
        .share_manage(basalt_proto::msg::ShareManageRequest {
            action,
            id,
            folder,
            to: to.unwrap_or_default(),
            again: again.unwrap_or_default(),
            keep: keep.unwrap_or(false),
        })
        .await?)
}

/// Takes one file of a share the host kept for this device into its
/// received folder.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn receive_held(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    share: String,
    file: usize,
    name: String,
    size: u64,
    id: String,
    folder: Option<String>,
) -> Answer<Received> {
    let cancel = Cancel::new();
    state
        .transfers
        .lock()
        .expect("transfers lock")
        .insert(id.clone(), cancel.clone());
    let report = progress_reporter(app.clone(), id.clone(), name.clone(), "download");
    let safe = safe_local_name(&name);
    #[cfg(target_os = "android")]
    let outcome = {
        let _ = folder;
        use tauri_plugin_basalt_android::BasaltAndroidExt;
        let handle = app.clone();
        let wanted = safe.clone();
        let created = tokio::task::spawn_blocking(move || {
            handle.basalt_android().create_download(&wanted, "")
        })
        .await
        .map_err(|e| UiError {
            kind: "error".into(),
            message: e.to_string(),
        })?
        .map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t save to Downloads: {e}"),
        })?;
        let result = state
            .client
            .download_held(
                &share,
                file,
                size,
                &name,
                owned_file(created.fd),
                Some(report),
                Some(cancel),
            )
            .await;
        let ok = result.is_ok();
        let handle = app.clone();
        let uri = created.uri.clone();
        let _ =
            tokio::task::spawn_blocking(move || handle.basalt_android().finish_download(&uri, ok))
                .await;
        result.map(|_| Received {
            shown_as: created.shown_as,
            path: None,
            uri: Some(created.uri),
        })
    };
    #[cfg(not(target_os = "android"))]
    let outcome = {
        let dir = match folder.filter(|f| !f.trim().is_empty()) {
            Some(folder) => PathBuf::from(folder),
            None => received_folder(&app)?,
        };
        std::fs::create_dir_all(&dir).map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t make the folder {}: {e}", dir.display()),
        })?;
        let local = free_name(&dir, &safe);
        let out = std::fs::File::create(&local).map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t write {}: {e}", local.display()),
        })?;
        let result = state
            .client
            .download_held(&share, file, size, &name, out, Some(report), Some(cancel))
            .await;
        if result.is_err() {
            let _ = std::fs::remove_file(&local);
        } else {
            mark_downloaded(&local);
        }
        let shown = local.display().to_string();
        result.map(|_| Received {
            shown_as: shown.clone(),
            path: Some(shown),
            uri: None,
        })
    };
    state.transfers.lock().expect("transfers lock").remove(&id);
    Ok(outcome?)
}

/// The host's devices, and who of them is online now.
#[tauri::command]
async fn presence(state: State<'_, AppState>) -> Answer<basalt_proto::msg::PresenceResponse> {
    Ok(state.client.presence().await?)
}

/// Passes a message to another of the host's devices, or a profile's.
#[tauri::command]
async fn channel_send(
    state: State<'_, AppState>,
    request: basalt_proto::msg::ChannelSendRequest,
) -> Answer<basalt_proto::msg::ChannelSendResponse> {
    Ok(state.client.channel_send(request).await?)
}

/// Asks another of the profile's devices, playing, to do something.
#[tauri::command]
async fn music_command(
    state: State<'_, AppState>,
    request: basalt_proto::msg::MusicCommandRequest,
) -> Answer<()> {
    Ok(state.client.music_command(request).await?)
}

/// Asks about a group of the profile's devices playing together.
#[tauri::command]
async fn music_group(
    state: State<'_, AppState>,
    request: basalt_proto::msg::MusicGroupRequest,
) -> Answer<basalt_proto::msg::MusicGroupResponse> {
    Ok(state.client.music_group(request).await?)
}

/// Whether a film's timeline pictures are made, and how they are laid out.
#[tauri::command]
async fn previews(
    state: State<'_, AppState>,
    path: String,
) -> Answer<basalt_proto::msg::PreviewsResponse> {
    Ok(state.client.previews(&path).await?)
}

/// Measures the connection to the host, for Settings.
#[tauri::command]
async fn speed_test(state: State<'_, AppState>) -> Answer<basalt_proto::msg::SpeedResult> {
    Ok(state.client.speed_test().await?)
}

/// Where a film's or an episode's intro and credits are.
#[tauri::command]
async fn segments(
    state: State<'_, AppState>,
    path: String,
) -> Answer<basalt_proto::msg::SegmentsResponse> {
    Ok(state.client.segments(&path).await?)
}

/// The start of every media URL; a percent-encoded vault path goes on the end,
/// and `?thumb=320` makes it a thumbnail.
#[tauri::command]
async fn media_base(state: State<'_, AppState>) -> Answer<String> {
    Ok(state.proxy().await?.base_url())
}

/// A URL the player, image viewer or PDF viewer can open directly.
#[tauri::command]
async fn media_url(state: State<'_, AppState>, path: String) -> Answer<String> {
    Ok(state.proxy().await?.url_for(&path))
}

/// Whether the host could convert a video now: what would, or an error
/// saying why not.
#[tauri::command]
async fn conversion_check(
    state: State<'_, AppState>,
    path: String,
) -> Answer<basalt_proto::msg::ConvertStarted> {
    Ok(state.client.convert_check(&path).await?)
}

/// How the latest conversion of a video went: what is converting it, or why
/// it could not be. None when it has not been asked for.
#[tauri::command]
async fn conversion_status(
    state: State<'_, AppState>,
    path: String,
) -> Answer<Option<basalt_client::proxy::Conversion>> {
    Ok(state.proxy().await?.conversion(&path))
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/// Reports progress to the interface, throttled.
///
/// A 4 MiB chunk over a 22.7 MB/s link arrives about six times a second, which
/// is already a sensible rate for a progress bar — but a cached or local-speed
/// transfer would fire far faster and flood the event channel for no visible
/// benefit. The throttle costs nothing and bounds it.
fn progress_reporter(
    app: tauri::AppHandle,
    id: String,
    name: String,
    kind: &'static str,
) -> ProgressFn {
    let last = Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1));
    let meter = Mutex::new(basalt_client::rate::Meter::new());

    Arc::new(move |p: basalt_client::Progress| {
        let now = std::time::Instant::now();
        // Every report goes into the meter, throttled or not: the rate is only
        // as good as the samples behind it.
        let (rate, eta_rate) = {
            let mut meter = meter.lock().expect("meter lock");
            meter.record(now, p.transferred);
            (meter.current(now), meter.steady(now))
        };

        let complete = p.transferred >= p.total;
        {
            let mut last = last.lock().expect("throttle lock");
            if !complete && last.elapsed() < std::time::Duration::from_millis(120) {
                return;
            }
            *last = now;
        }

        let _ = app.emit(
            "basalt://transfer",
            TransferEvent {
                id: id.clone(),
                kind,
                name: name.clone(),
                path: p.path.clone(),
                transferred: p.transferred,
                total: p.total,
                status: if complete { "done" } else { "active" },
                rate,
                eta_rate,
            },
        );
    })
}

#[tauri::command]
async fn download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    remote: String,
    local: String,
    id: String,
) -> Answer<u64> {
    let name = remote.rsplit('/').next().unwrap_or(&remote).to_string();
    let cancel = Cancel::new();
    state
        .transfers
        .lock()
        .expect("transfers lock")
        .insert(id.clone(), cancel.clone());

    let report = progress_reporter(app, id.clone(), name, "download");
    let local = PathBuf::from(local);
    let result = state
        .client
        .download(&remote, &local, Some(report), Some(cancel))
        .await;

    state.transfers.lock().expect("transfers lock").remove(&id);
    let bytes = result?;
    mark_downloaded(&local);
    Ok(bytes)
}

/// Marks a file as come from elsewhere, as a browser marks its downloads, so
/// Windows asks before running it and Office opens it in Protected View. A
/// file from the drive is only as trustworthy as every device that can write
/// to it. Nowhere else to mark it (a drive that is not NTFS) is not an error.
fn mark_downloaded(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let mut marked = path.as_os_str().to_os_string();
        marked.push(":Zone.Identifier");
        let _ = std::fs::write(marked, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// A name from the drive, safe to give a file here: whatever came after the
/// last slash of either kind, without the characters Windows refuses, and
/// never `.` or `..`. A host could name a file `..\..\Startup\x.bat`.
fn safe_local_name(remote: &str) -> String {
    let last = remote.rsplit(['/', '\\']).next().unwrap_or(remote);
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim_start();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "file".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Kinds of file Windows runs when it opens them. Basalt never opens one of
/// these from the drive by itself: a program anyone with write access could
/// have put there, named to look like a photo, would run with no question.
const PROGRAMS: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "ws",
    "hta",
    "msi",
    "msp",
    "mst",
    "scr",
    "pif",
    "cpl",
    "lnk",
    "url",
    "reg",
    "jar",
    "appref-ms",
    "application",
    "msc",
    "gadget",
    "inf",
    "scf",
    "sct",
    "settingcontent-ms",
    "library-ms",
    "search-ms",
    "appx",
    "msix",
    "appxbundle",
    "msixbundle",
    "diagcab",
    "xll",
    "chm",
];

fn is_program(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| PROGRAMS.contains(&ext.to_ascii_lowercase().as_str()))
}

#[tauri::command]
async fn upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    local: String,
    remote: String,
    overwrite: bool,
    id: String,
) -> Answer<UploadOutcome> {
    let name = remote.rsplit('/').next().unwrap_or(&remote).to_string();
    let cancel = Cancel::new();
    state
        .transfers
        .lock()
        .expect("transfers lock")
        .insert(id.clone(), cancel.clone());

    let report = progress_reporter(app, id.clone(), name, "upload");
    let local = PathBuf::from(local);

    // A folder goes up whole, as one transfer. Handed to the file upload it
    // used to fail as "access is denied", which is how Windows answers a
    // program that opens a folder as if it were a file.
    let is_folder = tokio::fs::metadata(&local)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    let result = if is_folder {
        state
            .client
            .upload_tree(&local, &remote, Some(report), Some(cancel))
            .await
            .map(|tree| UploadOutcome {
                bytes: tree.bytes,
                files: tree.files,
                failed: tree.failed,
            })
    } else {
        state
            .client
            .upload(&local, &remote, overwrite, Some(report), Some(cancel))
            .await
            .map(|bytes| UploadOutcome {
                bytes,
                files: 1,
                failed: Vec::new(),
            })
    };

    state.transfers.lock().expect("transfers lock").remove(&id);
    Ok(result?)
}

// ---------------------------------------------------------------------------
// The phone's own files
// ---------------------------------------------------------------------------

/// A file on the phone, as Android describes one it has handed over.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneFile {
    /// The `content://` address Android gave for it.
    uri: String,
    /// Where it goes, relative to the folder it is uploaded into: the name,
    /// or `Folder/Sub/name` for a file inside a picked folder.
    rel: String,
    /// Bytes. Negative when Android could not say.
    size: i64,
    /// Unix seconds, or 0 when not known.
    #[serde(default)]
    mtime: i64,
}

/// An open file from a descriptor Android handed over.
#[cfg(target_os = "android")]
fn owned_file(fd: i32) -> std::fs::File {
    use std::os::fd::FromRawFd;
    // Detached on the Kotlin side, so this is the only owner, and dropping
    // the File closes it.
    unsafe { std::fs::File::from_raw_fd(fd) }
}

/// Uploads files from the phone: picked, shared from another app, or a
/// whole picked folder with the folders inside it. One transfer for all of
/// them, as the desktop does for a folder.
#[allow(unused_variables)]
#[tauri::command]
async fn upload_from_phone(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    files: Vec<PhoneFile>,
    folders: Vec<String>,
    into: String,
    label: String,
    id: String,
) -> Answer<UploadOutcome> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, state, files, folders, into, label, id);
        Err(UiError {
            kind: "error".into(),
            message: "only on Android".into(),
        })
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_basalt_android::BasaltAndroidExt;

        let join = |rel: &str| {
            if into.is_empty() {
                rel.to_string()
            } else {
                format!("{into}/{rel}")
            }
        };

        // Folders first, parents before children, so every file has
        // somewhere to land. One that is already there is fine.
        let mut folders = folders;
        folders.sort_by_key(|f| f.matches('/').count());
        for folder in &folders {
            match state.client.mkdir(&join(folder)).await {
                Ok(()) => {}
                Err(e) if e.kind() == "exists" => {}
                Err(e) => return Err(e.into()),
            }
        }

        let cancel = Cancel::new();
        state
            .transfers
            .lock()
            .expect("transfers lock")
            .insert(id.clone(), cancel.clone());
        let report = progress_reporter(app.clone(), id.clone(), label, "upload");

        let total: u64 = files.iter().map(|f| f.size.max(0) as u64).sum();
        let mut done = 0u64;
        let mut outcome = UploadOutcome {
            bytes: 0,
            files: 0,
            failed: Vec::new(),
        };

        for file in &files {
            if cancel.is_cancelled() {
                break;
            }
            let target = join(&file.rel);
            if file.size < 0 {
                outcome
                    .failed
                    .push((target, "the phone would not say how big it is".into()));
                continue;
            }
            let base = done;
            let ceiling = total.saturating_sub(1);
            let outer = std::sync::Arc::clone(&report);
            let whole = target.clone();
            let progress: ProgressFn = Arc::new(move |p: basalt_client::Progress| {
                outer(basalt_client::Progress {
                    kind: p.kind,
                    path: whole.clone(),
                    transferred: (base + p.transferred).min(ceiling),
                    total,
                })
            });

            let handle = app.clone();
            let uri = file.uri.clone();
            let opened =
                tokio::task::spawn_blocking(move || handle.basalt_android().open_fd(&uri, "r"))
                    .await;
            let fd = match opened {
                Ok(Ok(fd)) => fd,
                Ok(Err(e)) => {
                    outcome.failed.push((target, e.to_string()));
                    done += file.size as u64;
                    continue;
                }
                Err(e) => {
                    outcome.failed.push((target, e.to_string()));
                    done += file.size as u64;
                    continue;
                }
            };
            let mtime = (file.mtime > 0).then_some(file.mtime);
            match state
                .client
                .upload_file(
                    owned_file(fd),
                    file.size as u64,
                    mtime,
                    &target,
                    false,
                    Some(progress),
                    Some(cancel.clone()),
                )
                .await
            {
                Ok(bytes) => {
                    outcome.files += 1;
                    outcome.bytes += bytes;
                }
                Err(e) => outcome.failed.push((target, e.to_string())),
            }
            done += file.size as u64;
        }

        report(basalt_client::Progress {
            kind: basalt_client::TransferKind::Upload,
            path: into.clone(),
            transferred: total,
            total,
        });
        state.transfers.lock().expect("transfers lock").remove(&id);
        if cancel.is_cancelled() {
            return Err(basalt_client::ClientError::Cancelled.into());
        }
        Ok(outcome)
    }
}

/// Where a download landed on the phone.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedOnPhone {
    /// For opening or sharing it afterwards.
    uri: String,
    /// Where somebody would look for it: `Download/Basalt/name`.
    shown_as: String,
}

/// Downloads a file into the phone's Downloads/Basalt folder.
///
/// Hidden from other apps until it is complete, and removed if it fails, so
/// Downloads never shows half a film.
#[allow(unused_variables)]
#[tauri::command]
async fn download_to_phone(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    remote: String,
    id: String,
) -> Answer<SavedOnPhone> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, state, remote, id);
        Err(UiError {
            kind: "error".into(),
            message: "only on Android".into(),
        })
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_basalt_android::BasaltAndroidExt;

        let name = remote.rsplit('/').next().unwrap_or(&remote).to_string();
        let handle = app.clone();
        let wanted = name.clone();
        let created = tokio::task::spawn_blocking(move || {
            handle.basalt_android().create_download(&wanted, "")
        })
        .await
        .map_err(|e| UiError {
            kind: "error".into(),
            message: e.to_string(),
        })?
        .map_err(|e| UiError {
            kind: "error".into(),
            message: format!("couldn’t save to Downloads: {e}"),
        })?;

        let cancel = Cancel::new();
        state
            .transfers
            .lock()
            .expect("transfers lock")
            .insert(id.clone(), cancel.clone());
        let report = progress_reporter(app.clone(), id.clone(), name, "download");
        let result = state
            .client
            .download_to_file(&remote, owned_file(created.fd), Some(report), Some(cancel))
            .await;
        state.transfers.lock().expect("transfers lock").remove(&id);

        let ok = result.is_ok();
        let handle = app.clone();
        let uri = created.uri.clone();
        let _ =
            tokio::task::spawn_blocking(move || handle.basalt_android().finish_download(&uri, ok))
                .await;
        result?;
        Ok(SavedOnPhone {
            uri: created.uri,
            shown_as: created.shown_as,
        })
    }
}

/// What an upload did: one file, or a folder of them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadOutcome {
    bytes: u64,
    files: usize,
    /// Files in a folder that did not arrive, and why.
    failed: Vec<(String, String)>,
}

/// Hands a file to a player that can actually decode it.
///
/// **Streamed, not downloaded.** The player is given a URL from the media
/// proxy and seeks through it with range requests, so a 3 GB episode starts
/// playing at once instead of after two minutes of copying, and nothing is
/// written to this machine's disk.
///
/// `player` is a program the person chose; without one, the player Windows
/// opens this kind of file with when it can stream, else the first that can.
/// With none at all this fails as `noplayer`, and the app asks: it never
/// copies a film out on its own any more. `copy` is that question's other
/// answer, asked for by name: download it, then open it with whatever Windows
/// opens it with.
#[tauri::command]
async fn open_externally(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    remote: String,
    id: String,
    player: Option<String>,
    copy: Option<bool>,
) -> Answer<OpenResult> {
    if copy == Some(true) {
        return copy_and_open(app, state, remote, id).await;
    }

    let chosen = match player {
        Some(path) => Some(
            basalt_client::players::chosen(std::path::Path::new(&path)).ok_or_else(|| UiError {
                kind: "noplayer".into(),
                message: "That player is no longer on this computer.".into(),
            })?,
        ),
        None => basalt_client::players::installed(extension_of(&remote))
            .into_iter()
            .next(),
    };
    let Some(player) = chosen else {
        return Err(UiError {
            kind: "noplayer".into(),
            message:
                "No player that can stream was found on this computer. Install VLC, then try again."
                    .into(),
        });
    };

    let url = state.proxy().await?.url_for(&remote);
    state
        .external
        .lock()
        .expect("external lock")
        .insert(remote.clone());
    basalt_client::players::launch(&player, &url).map_err(|e| UiError {
        kind: "error".into(),
        message: format!("couldn’t start {}: {e}", player.name),
    })?;
    Ok(OpenResult {
        player: player.name,
        streamed: true,
    })
}

/// The file's extension, with its dot, for asking Windows what opens it.
fn extension_of(remote: &str) -> &str {
    let name = remote.rsplit('/').next().unwrap_or(remote);
    name.rfind('.').map_or("", |at| &name[at..])
}

/// Copies a file out and lets Windows decide what opens it: slower, and only
/// when asked for.
async fn copy_and_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    remote: String,
    id: String,
) -> Answer<OpenResult> {
    let name = safe_local_name(&remote);
    if is_program(&name) {
        return Err(UiError {
            kind: "error".into(),
            message: format!(
                "{name} is a program, and Basalt doesn’t run programs from the drive. If you \
                 trust where it came from, download it and open it from this computer."
            ),
        });
    }
    let dir = scratch_dir(&app).join("Basalt");
    std::fs::create_dir_all(&dir).map_err(|e| UiError::from(basalt_client::ClientError::Io(e)))?;
    let local = dir.join(&name);

    let cancel = Cancel::new();
    state
        .transfers
        .lock()
        .expect("transfers lock")
        .insert(id.clone(), cancel.clone());

    let report = progress_reporter(app.clone(), id.clone(), name, "download");
    let result = state
        .client
        .download(&remote, &local, Some(report), Some(cancel))
        .await;
    state.transfers.lock().expect("transfers lock").remove(&id);
    result?;
    mark_downloaded(&local);

    let shown = local.display().to_string();
    open_outside(&app, &shown, false).map_err(|e| UiError {
        kind: "error".into(),
        message: format!("couldn’t open {shown}: {e}"),
    })?;
    Ok(OpenResult {
        player: "the default app".into(),
        streamed: false,
    })
}

/// Somewhere to put a file for a moment.
///
/// The system's temporary folder on Windows. On Android that folder belongs
/// to the shell and an app cannot write there, so it is the app's own cache.
fn scratch_dir(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(mobile)]
    if let Ok(dir) = app.path().app_cache_dir() {
        return dir;
    }
    let _ = app;
    std::env::temp_dir()
}

/// Which player took the file, and whether it was streamed or copied first.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    player: String,
    streamed: bool,
}

/// Which app this is, for the interface to lay itself out for.
#[tauri::command]
fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "desktop"
    }
}

/// Whether a player that can stream a URL is installed.
#[tauri::command]
fn external_player() -> Option<String> {
    basalt_client::players::find().map(|p| p.name)
}

/// A player on this computer, for the "Open with" list.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerInfo {
    name: String,
    path: String,
    is_default: bool,
}

/// Every player on this computer that can stream, Windows' default for this
/// kind of file first.
#[tauri::command]
fn external_players(name: String) -> Vec<PlayerInfo> {
    basalt_client::players::installed(extension_of(&name))
        .into_iter()
        .map(|p| PlayerInfo {
            name: p.name,
            path: p.path.display().to_string(),
            is_default: p.is_default,
        })
        .collect()
}

/// What a program the person picked is called, or `None` when it is not a
/// program that exists.
#[tauri::command]
fn player_name(path: String) -> Option<String> {
    basalt_client::players::chosen(std::path::Path::new(&path)).map(|p| p.name)
}

#[tauri::command]
fn cancel_transfer(state: State<'_, AppState>, id: String) -> bool {
    match state.transfers.lock().expect("transfers lock").get(&id) {
        Some(cancel) => {
            cancel.cancel();
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/// Which app this is, for picking the right installer out of a release.
///
/// Both apps are published from one repository, so a release carries two
/// installers and each has to recognise its own.
const PRODUCT: basalt_update::Product = basalt_update::Product::Client;

/// What is running now, as the release tags spell it.
#[tauri::command]
async fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Whether a newer release exists. `None` means this is the newest.
///
/// A failure to reach GitHub is an error rather than "no update": the two
/// mean different things to somebody who just pressed the button, and
/// reporting the first as the second is how an app quietly stops updating.
#[tauri::command]
async fn check_update() -> Answer<Option<basalt_update::Release>> {
    basalt_update::check(PRODUCT, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|e| UiError {
            kind: "error".into(),
            message: e.to_string(),
        })
}

/// The release notes of one version, as published on GitHub, or `None` when
/// that version has no release there. The Play build reads the notes of the
/// version Play offers through this.
#[tauri::command]
async fn release_notes(version: String) -> Answer<Option<String>> {
    basalt_update::notes_for(&version)
        .await
        .map_err(|e| UiError {
            kind: "error".into(),
            message: e.to_string(),
        })
}

/// What kind of device this is, as the page knows it from Android: a phone,
/// a tablet or a TV. Shown on the host beside the device's name.
#[tauri::command]
fn set_device_form(form: basalt_proto::msg::DeviceForm) {
    basalt_client::store::set_device_form(form);
}

/// Downloads an offered release, reporting progress, and returns its path.
///
/// The file is verified against the release's signed list of digests before
/// this returns; an installer that fails is deleted rather than handed back.
#[tauri::command]
async fn download_update(app: tauri::AppHandle, release: basalt_update::Release) -> Answer<String> {
    let into = scratch_dir(&app).join("Basalt Updates");
    let emitter = app.clone();
    let path = basalt_update::fetch(&release, &into, move |had, total| {
        let _ = emitter.emit("basalt://update-progress", (had, total));
    })
    .await
    .map_err(|e| UiError {
        // Refused for its signature: the page offers to report it.
        kind: match e {
            basalt_update::UpdateError::Unsigned | basalt_update::UpdateError::BadSignature => {
                "unsigned".into()
            }
            _ => "error".into(),
        },
        message: e.to_string(),
    })?;

    Ok(path.to_string_lossy().into_owned())
}

/// Starts the installer and stands aside.
///
/// The app has to go: an installer cannot replace files that are open, and
/// NSIS will silently skip the executable of a running program — which is
/// exactly how somebody ends up "updating" and finding the same version.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, path: String) -> Answer<()> {
    // Linux: a package, installed the way this copy was, and the new copy
    // started once it is in. See linux_update.
    #[cfg(target_os = "linux")]
    {
        let next = linux_update::install(std::path::Path::new(&path))
            .await
            .map_err(|message| UiError {
                kind: "error".into(),
                message,
            })?;
        basalt_net::outside::command(&next)
            .spawn()
            .map_err(|e| UiError {
                kind: "error".into(),
                message: format!("the update is installed; start Basalt again ({e})"),
            })?;
        app.exit(0);
        Ok(())
    }

    // As an update, not a first install: /UPDATE goes over the installed copy
    // without uninstalling it or asking anything, and keeps the user's
    // shortcuts as they are; /P shows only a progress bar, closing this app if
    // it is still running; /R starts it again when the new version is in.
    // One press of "Restart to update", and nothing else to click.
    #[cfg(not(target_os = "linux"))]
    {
        std::process::Command::new(&path)
            .args(["/P", "/UPDATE", "/R"])
            .spawn()
            .map_err(|e| UiError {
                kind: "error".into(),
                message: format!("couldn’t start the installer: {e}"),
            })?;

        // A moment for the installer to be up before this window disappears,
        // so the screen is never empty with nothing apparently happening.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            app.exit(0);
        });
        Ok(())
    }
}

/// The folder a development copy keeps to, set by `BASALT_DEV_ISOLATED`:
/// see `run`. Always none in a release build.
fn dev_isolated() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("BASALT_DEV_ISOLATED").map(PathBuf::from)
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    basalt_client::nearby::trace_to(nearby_log);
    // Asked by the uninstaller when the app's data is deleted with it: the
    // device key lives in the chip, not in that data, and would otherwise be
    // left there for good. Done, and gone, before any window.
    #[cfg(windows)]
    if std::env::args().any(|arg| arg == "--forget-device-key") {
        basalt_client::keys::forget_chip_keys();
        return;
    }

    // WebView2 refuses to start playback with sound unless the page has a
    // recent user gesture. Clicking a file in the list *is* one, but the
    // `<video>` element is created afterwards, during a React render, and by
    // then the activation has often lapsed — so a film would open showing a
    // still frame, or play with no audio, for no reason the user could see.
    //
    // Set before the webview exists, which is why it is the first thing here.
    #[cfg(windows)]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--autoplay-policy=no-user-gesture-required",
    );

    // A development copy run beside the Basalt installed on the same computer:
    // its own settings, its own web storage, its own key (not in the TPM), its
    // own device id and name, and the page open to Chrome's developer tools on
    // a port. Debug builds only; `BASALT_DEV_ISOLATED` names its folder.
    #[cfg(all(windows, debug_assertions))]
    if let Some(folder) = dev_isolated() {
        // Named as what it is, on the host's list of devices; a second copy
        // beside the first by `BASALT_DEV_NAME`, on its own port by
        // `BASALT_DEV_PORT` (9223 unless set).
        let name = std::env::var("COMPUTERNAME").unwrap_or_default();
        let which = std::env::var("BASALT_DEV_NAME").unwrap_or_else(|_| "development copy".into());
        std::env::set_var("COMPUTERNAME", format!("{name} ({which})"));
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", folder.join("webview"));
        let port = std::env::var("BASALT_DEV_PORT").unwrap_or_else(|_| "9223".into());
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("--autoplay-policy=no-user-gesture-required --remote-debugging-port={port}"),
        );
    }

    let builder = tauri::Builder::default();
    // Opened again while running ("Share with Basalt", Send to): the window
    // comes forward, and the files are offered to share.
    // A development copy runs beside the installed Basalt: not one of it.
    #[cfg(desktop)]
    let builder = if dev_isolated().is_some() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Emitter;
            tray::show(app, None);
            let files = shared_in(&argv);
            if !files.is_empty() {
                let _ = app.emit("basalt://share-files", files);
            }
        }))
    };
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Not on Linux, where the app draws the picture itself: see linux_player.
    #[cfg(all(desktop, not(target_os = "linux")))]
    let builder = builder.plugin(tauri_plugin_libmpv::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_basalt_android::init());

    builder
        .setup(|app| {
            // A phone has no APPDATA: the store goes in the app's own private
            // folder, which nothing else on the phone can read.
            #[cfg(mobile)]
            let store_path = app.path().app_data_dir()?.join("client.json");
            #[cfg(desktop)]
            let store_path = match dev_isolated() {
                Some(folder) => folder.join("client.json"),
                None => basalt_client::store::default_path(),
            };
            // With the device's lasting id, so a reinstall is the same device
            // on the host rather than another of the same name. On Android the
            // id comes from the Java side; on Windows the client asks itself.
            #[cfg(mobile)]
            let hint = {
                use tauri_plugin_basalt_android::BasaltAndroidExt;
                app.basalt_android().device_hint().ok()
            };
            // A development copy is a device of its own: with this computer's
            // id it stood in for the installed app on the host, and its key
            // replaced the app's there.
            #[cfg(desktop)]
            let hint: Option<String> =
                dev_isolated().map(|folder| format!("development copy {}", folder.display()));
            let kept_shares = store_path.with_file_name("share-messages.json");
            let notices = store_path.with_file_name("share-notices.json");
            // Told now, while there is a window to ask Android through: later,
            // with Basalt swiped away, there may be none.
            #[cfg(target_os = "android")]
            {
                use tauri_plugin_basalt_android::BasaltAndroidExt;
                let _ = app.basalt_android().notices_at(&notices.to_string_lossy());
            }
            // The device's key goes in the phone's hardware key store there;
            // on Windows the client finds the TPM by itself.
            #[cfg(mobile)]
            let phone: Option<Arc<dyn basalt_client::keys::PhoneKeys>> =
                Some(Arc::new(PhoneKeyStore(app.handle().clone())));
            #[cfg(desktop)]
            let phone: Option<Arc<dyn basalt_client::keys::PhoneKeys>> = None;
            let keys = match dev_isolated() {
                Some(_) => basalt_client::keys::Policy::Software,
                None => basalt_client::keys::Policy::Platform(phone),
            };
            let client = Arc::new(Basalt::open_as_this_device_with_policy(
                store_path,
                hint.as_deref(),
                keys,
            )?);

            // Registered **before** anything else in this closure.
            //
            // The window is created from the config and starts loading as soon
            // as it exists, and the first thing the interface does is ask for
            // the connection status. If that call lands before the state is
            // managed, Tauri answers "state not managed", the interface has
            // nothing to show, and the app sits on its splash screen looking
            // exactly like a crash. Spawning tasks first was enough to lose
            // that race.
            // Device keys an earlier copy of the app left in the chip, gone
            // quietly in the background: a reinstall made a new key beside
            // the old one, and nothing ever tidied the old.
            {
                let client = Arc::clone(&client);
                std::thread::spawn(move || {
                    client.tidy_device_keys();
                });
            }

            // The tray icon, so closing the window can leave Basalt ready.

            #[cfg(windows)]
            if let Err(e) = tray::install(app.handle()) {
                eprintln!("basalt: no tray icon: {e}");
            }
            #[cfg(target_os = "linux")]
            if tray::has_tray() {
                if let Err(e) = tray::install(app.handle()) {
                    eprintln!("basalt: no tray icon: {e}");
                }
            }

            app.manage(AppState {
                client: Arc::clone(&client),
                proxy: tokio::sync::Mutex::new(None),
                transfers: Mutex::new(HashMap::new()),
                watch: Mutex::new(None),
                external: Mutex::new(std::collections::HashSet::new()),
                channel: Mutex::new(kept_share_messages(&kept_shares)),
                kept_shares: Some(kept_shares.clone()),
                notices: Some(notices.clone()),
                direct: tokio::sync::OnceCell::new(),
                nearby_ready: Mutex::new(None),
                nearby_wifi: nearby_wifi::State::default(),
                nearby_asking: Mutex::new(std::collections::HashMap::new()),
                nearby_offers: Mutex::new(std::collections::HashMap::new()),
            });

            // Feed the throughput trace from the one counter that sees every
            // byte — downloads, uploads, listings and, above all, a film being
            // streamed through the media proxy. Emitting only when something
            // moved means an idle app sends nothing at all.
            {
                let client = Arc::clone(&client);
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut last_total = 0u64;
                    let mut last_at = std::time::Instant::now();
                    let mut interval = tokio::time::interval(std::time::Duration::from_millis(125));
                    loop {
                        interval.tick().await;
                        let total = client.bytes_moved();
                        let delta = total.saturating_sub(last_total);
                        let elapsed = last_at.elapsed();
                        last_total = total;
                        last_at = std::time::Instant::now();

                        // The measured interval travels with the bytes. The
                        // interface used to divide this by its own tick length
                        // instead, and reported every speed about twice what it
                        // really was.
                        if delta > 0 {
                            let _ = handle.emit(
                                "basalt://bytes",
                                ByteWindow {
                                    bytes: delta,
                                    millis: elapsed.as_secs_f64() * 1000.0,
                                },
                            );
                        }
                    }
                });
            }

            // Reconnect in the background rather than blocking the window.
            // A host that is asleep must not mean an app that will not open.
            //
            // The watch starts only once a connection exists, and its handle is
            // kept in the app state: dropping it stops the watch, and a watch
            // that outlived what asked for it is exactly the shape of bug that
            // once turned one dropped file into eight uploads.
            {
                let client = Arc::clone(&client);
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = client.connect_saved().await;
                    // Removed while the app was closed: the pairing is already
                    // gone, and the window says why as it goes back to
                    // choosing a drive.
                    if let Err(e) = &result {
                        if e.kind() == "removed" {
                            let _ = handle.emit("basalt://removed", e.to_string());
                        }
                    }
                    let _ = handle.emit("basalt://status", status_of(&client));
                    if result.is_ok() {
                        start_watching(&client, &handle);
                    } else {
                        eprintln!("basalt: no saved host reachable at startup");
                    }
                });
            }

            // The picture's place under the page, before the page shows.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.webview_windows().into_values().next() {
                linux_player::attach(&window);
            }

            // A nearby Wi-Fi left open by a Basalt that ended without closing
            // it (Linux keeps it with NetworkManager): closed.
            #[cfg(target_os = "linux")]
            std::thread::spawn(nearby_wifi::tidy);
            // "Share with Basalt" in GNOME Files' Scripts menu (a development
            // copy leaves the person's own alone).
            #[cfg(target_os = "linux")]
            if dev_isolated().is_none() {
                std::thread::spawn(linux_share::install);
            }

            // Debug builds only: a script run in the page once it has loaded,
            // and again each time the file changes, for testing the app step
            // by step where nobody is there to click.
            #[cfg(debug_assertions)]
            if let (Ok(path), Some(window)) = (
                std::env::var("BASALT_TEST_SCRIPT"),
                app.webview_windows().into_values().next(),
            ) {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    let mut last = None;
                    loop {
                        let changed = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
                        if changed.is_some() && changed != last {
                            last = changed;
                            if let Ok(script) = std::fs::read_to_string(&path) {
                                let _ = window.eval(&script);
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            linux_mpv_init,
            linux_mpv_command,
            linux_mpv_set_property,
            linux_mpv_get_property,
            linux_mpv_destroy,
            release_pointer,
            page_log,
            media_controls::media_controls_show,
            media_controls::media_controls_clear,
            app_version,
            check_update,
            release_notes,
            set_device_form,
            download_update,
            install_update,
            status,
            discover,
            begin_pairing,
            identify_host,
            profiles_elsewhere,
            use_profile_elsewhere,
            finish_pairing,
            cancel_pairing,
            connect_saved,
            library,
            library_art,
            watch_progress,
            connect_to,
            rewatch,
            disconnect,
            forget_host,
            list_dir,
            stat_entry,
            copy_entry,
            space,
            make_dir,
            rename_entry,
            remove_entry,
            media_url,
            media_base,
            collections,
            music,
            music_mine,
            music_now,
            music_command,
            music_group,
            received_open,
            received_show,
            music_timing::music_clock,
            music_timing::music_play_at,
            music_timing::music_pause_at,
            music_timing::music_cancel,
            music_timing::music_set_rate,
            presence,
            channel_send,
            channel_take,
            receive_file,
            share_local,
            withdraw_local,
            local_files,
            receive_direct,
            share_hold,
            share_hold_local,
            nearby_whoami,
            nearby_ready,
            nearby_reply,
            nearby_finish,
            nearby_take_file,
            nearby_note,
            shared_at_start,
            nearby_wifi_own,
            nearby_firewall,
            nearby_firewall_allow,
            nearby_wifi_passphrase,
            nearby_wifi_host,
            nearby_wifi_scan,
            nearby_wifi_join,
            nearby_wifi_leave,
            nearby_find,
            nearby_offer,
            nearby_code,
            nearby_cancel,
            share_answer,
            share_held,
            share_manage,
            receive_held,
            default_received_folder,
            segments,
            speed_test,
            previews,
            identity,
            profiles,
            manage,
            create_profile,
            sign_in_profile,
            claim_profile,
            sign_out_profile,
            continue_as_device,
            profile_stars,
            subtitles_for,
            conversion_status,
            conversion_check,
            download,
            upload,
            open_externally,
            external_player,
            external_players,
            player_name,
            cancel_transfer,
            upload_from_phone,
            download_to_phone,
            platform,
            stay_running,
            notify,
            open_link,
        ])
        // Closed while it should stay ready, with an icon in the tray to come
        // back by: hidden, not closed. The line to the host, shares and
        // transfers go on.
        .on_window_event(|window, event| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && tray::installed()
                    && STAY_RUNNING.load(std::sync::atomic::Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building Basalt")
        .run(|_app, event| {
            // The window closed by itself (on Android, the app swiped away),
            // not quit on purpose: kept running while it should stay ready.
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = &event
            {
                // Only with a way back: on a computer, the icon in the tray.
                // With none (a desktop that shows no tray icons), the window
                // really closed, and running on would leave Basalt with no
                // window and nothing to bring one back: opening it again did
                // nothing at all.
                #[cfg(any(target_os = "android", target_os = "ios"))]
                let way_back = true;
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                let way_back = tray::installed();
                if way_back && STAY_RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            // Quitting: this computer's own Wi-Fi closed, and one joined to
            // share left (on Linux they would stay with NetworkManager).
            #[cfg(target_os = "linux")]
            if let tauri::RunEvent::Exit = event {
                let state = _app.state::<AppState>();
                nearby_wifi::stop_host(&state.nearby_wifi);
                nearby_wifi::leave(&state.nearby_wifi);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{is_program, link_allowed, safe_local_name};

    #[test]
    fn links_are_only_the_ones_the_capability_file_allows() {
        assert!(link_allowed("https://basalt.reforatech.com"));
        assert!(link_allowed("https://basalt.reforatech.com/download/host"));
        assert!(link_allowed(
            "https://github.com/refora-technologies/basalt/issues/new"
        ));
        assert!(link_allowed("mailto:reforatech@gmail.com?subject=Basalt"));
        assert!(!link_allowed("https://example.com"));
        assert!(!link_allowed("https://basalt.reforatech.com.example.com"));
        assert!(!link_allowed("file:///etc/passwd"));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn a_received_file_never_replaces_one_already_there() {
        let dir = std::env::temp_dir().join(format!("basalt-free-name-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            super::free_name(&dir, "Holiday.mkv"),
            dir.join("Holiday.mkv")
        );
        std::fs::write(dir.join("Holiday.mkv"), b"x").unwrap();
        assert_eq!(
            super::free_name(&dir, "Holiday.mkv"),
            dir.join("Holiday (1).mkv")
        );
        std::fs::write(dir.join("Holiday (1).mkv"), b"x").unwrap();
        assert_eq!(
            super::free_name(&dir, "Holiday.mkv"),
            dir.join("Holiday (2).mkv")
        );
        std::fs::write(dir.join("README"), b"x").unwrap();
        assert_eq!(super::free_name(&dir, "README"), dir.join("README (1)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The attack these guard: a file on the drive named to climb out of the
    // folder it is saved in, or a program dressed as a photo.
    #[test]
    fn a_name_from_the_drive_cannot_climb_out() {
        assert_eq!(
            safe_local_name("Photos/..\\..\\Startup\\run.bat"),
            "run.bat"
        );
        assert_eq!(safe_local_name("a/.."), "file");
        assert_eq!(safe_local_name("a/C:evil"), "C_evil");
        assert_eq!(
            safe_local_name("Films/Sintel (2010).mkv"),
            "Sintel (2010).mkv"
        );
        assert_eq!(safe_local_name("notes.txt. "), "notes.txt");
    }

    #[test]
    fn programs_are_known_by_their_last_extension() {
        assert!(is_program("Holiday photos.jpg.exe"));
        assert!(is_program("setup.MSI"));
        assert!(is_program("shortcut.lnk"));
        assert!(!is_program("Holiday photos.jpg"));
        assert!(!is_program("Recipes.pdf"));
        assert!(!is_program("no extension"));
    }
}
