//! The player on Linux: mpv drawn into a GL area under the page.
//!
//! On Windows the libmpv plugin hands mpv the window, and the page, in its
//! own transparent child window, stays above the picture. On Linux that does
//! not work: WebKitGTK draws into the window itself, so mpv's window would
//! cover the page, controls and all, and on Wayland mpv cannot be handed a
//! window at all. So the app draws the picture itself: mpv's render API
//! (`vo=libmpv`) in a GL context of its own, and each frame painted onto the
//! window just before GTK draws the page over it (see `attach`). The page is
//! unchanged: transparent where the picture is, as on Windows.
//!
//! libmpv is opened when the player starts, `libmpv.so.2` then `.so.1`, so
//! the packages depend on the system's mpv library rather than carrying one.
//!
//! The page talks to it through the commands below, with the names and
//! shapes the Android plugin uses (see `lib/mpvBackend.ts`), and hears
//! property changes as `basalt-mpv` events.

use std::collections::HashMap;
use std::ffi::{c_char, c_double, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use gtk::glib;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

// mpv's numbers, from client.h and render.h.
const FORMAT_NONE: c_int = 0;
const FORMAT_STRING: c_int = 1;
const FORMAT_FLAG: c_int = 3;
const FORMAT_INT64: c_int = 4;
const FORMAT_DOUBLE: c_int = 5;
const EVENT_SHUTDOWN: c_int = 1;
const EVENT_PROPERTY_CHANGE: c_int = 22;
const RENDER_PARAM_INVALID: c_int = 0;
const RENDER_PARAM_API_TYPE: c_int = 1;
const RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const RENDER_PARAM_OPENGL_FBO: c_int = 3;
const RENDER_PARAM_FLIP_Y: c_int = 4;
const RENDER_PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;

/// The property the player watches for itself, apart from the page's: whether
/// there is a picture to draw. Told apart by its reply number.
const OWN: u64 = 1;

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct RenderParam {
    kind: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct OpenGlInitParams {
    get_proc_address: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    get_proc_address_ctx: *mut c_void,
    // Only in older mpv; newer ones stop reading before it.
    extra_exts: *const c_char,
}

#[repr(C)]
struct OpenGlFbo {
    fbo: c_int,
    w: c_int,
    h: c_int,
    internal_format: c_int,
}

type Handle = *mut c_void;

/// libmpv's functions, as opened.
struct Lib {
    _lib: libloading::Library,
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(Handle, *const *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(Handle, *const c_char, c_int, *mut c_void) -> c_int,
    get_property_string: unsafe extern "C" fn(Handle, *const c_char) -> *mut c_char,
    free: unsafe extern "C" fn(*mut c_void),
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, c_double) -> *mut Event,
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    render_create: unsafe extern "C" fn(*mut Handle, Handle, *mut RenderParam) -> c_int,
    render_set_update_callback:
        unsafe extern "C" fn(Handle, Option<unsafe extern "C" fn(*mut c_void)>, *mut c_void),
    render_render: unsafe extern "C" fn(Handle, *mut RenderParam) -> c_int,
    render_update: unsafe extern "C" fn(Handle) -> u64,
    render_free: unsafe extern "C" fn(Handle),
    render_report_swap: unsafe extern "C" fn(Handle),
}

impl Lib {
    fn open() -> Result<Self, String> {
        let mut last = String::new();
        for name in ["libmpv.so.2", "libmpv.so.1", "libmpv.so"] {
            // SAFETY: libmpv's initialisers do nothing but set up its own state.
            match unsafe { libloading::Library::new(name) } {
                Ok(lib) => return Self::load(lib),
                Err(e) => last = e.to_string(),
            }
        }
        Err(format!(
            "the mpv library is not installed (install libmpv2, or mpv-libs): {last}"
        ))
    }

    fn load(lib: libloading::Library) -> Result<Self, String> {
        // SAFETY: each symbol is looked up by its documented name and given
        // the signature client.h and render.h declare for it.
        unsafe {
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get($name).map_err(|e| {
                        format!("this mpv library has no {}: {e}", stringify!($name))
                    })?
                };
            }
            Ok(Self {
                create: sym!(b"mpv_create"),
                initialize: sym!(b"mpv_initialize"),
                set_option_string: sym!(b"mpv_set_option_string"),
                command: sym!(b"mpv_command"),
                set_property_string: sym!(b"mpv_set_property_string"),
                get_property: sym!(b"mpv_get_property"),
                get_property_string: sym!(b"mpv_get_property_string"),
                free: sym!(b"mpv_free"),
                observe_property: sym!(b"mpv_observe_property"),
                wait_event: sym!(b"mpv_wait_event"),
                error_string: sym!(b"mpv_error_string"),
                render_create: sym!(b"mpv_render_context_create"),
                render_set_update_callback: sym!(b"mpv_render_context_set_update_callback"),
                render_render: sym!(b"mpv_render_context_render"),
                render_update: sym!(b"mpv_render_context_update"),
                render_free: sym!(b"mpv_render_context_free"),
                render_report_swap: sym!(b"mpv_render_context_report_swap"),
                _lib: lib,
            })
        }
    }

    fn error(&self, code: c_int) -> String {
        // SAFETY: mpv returns a static string for any error code.
        unsafe { CStr::from_ptr((self.error_string)(code)) }
            .to_string_lossy()
            .into_owned()
    }
}

/// The player, once started: mpv's handle is safe to use from any thread.
struct Player {
    lib: Lib,
    handle: Handle,
    /// Whether `loadfile` takes a position before its options, as mpv does
    /// from 0.38. The system's mpv is older on many: Ubuntu 22.04 has 0.34.
    loadfile_index: bool,
}
// SAFETY: libmpv's client API may be called from any thread on one handle.
unsafe impl Send for Player {}
unsafe impl Sync for Player {}

static PLAYER: OnceLock<Player> = OnceLock::new();
static STARTING: Mutex<()> = Mutex::new(());
/// Whether mpv has a picture to draw: until then the area is left clear, so
/// the window's rounded corners stay rounded.
static PICTURE: AtomicBool = AtomicBool::new(false);

fn player() -> Result<&'static Player, String> {
    PLAYER
        .get()
        .ok_or_else(|| "the player has not started".to_string())
}

fn c(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| format!("{text:?} has a NUL in it"))
}

/// Starts mpv, once for the life of the window. Options as the page gives
/// them, except where it draws: here, into the GL area.
#[tauri::command]
pub fn linux_mpv_init<R: Runtime>(
    app: AppHandle<R>,
    options: HashMap<String, String>,
    observed: Vec<Vec<String>>,
) -> Result<(), String> {
    let _once = STARTING.lock().map_err(|e| e.to_string())?;
    if let Some(player) = PLAYER.get() {
        observe(player, &observed)?;
        return Ok(());
    }
    let lib = Lib::open()?;
    // mpv reads and writes numbers the C way, and will not start otherwise:
    // GTK set the desktop's own way as the app started, and with it, on
    // most computers but a test container, mpv refused and nothing played.
    // The page shows numbers itself, so nothing else here reads them.
    extern "C" {
        fn setlocale(category: c_int, locale: *const c_char) -> *mut c_char;
    }
    const LC_NUMERIC: c_int = 1;
    // SAFETY: on the GTK thread, before mpv or anything else reads numbers.
    unsafe { setlocale(LC_NUMERIC, c"C".as_ptr()) };
    // SAFETY: a new handle, configured and initialised here before anything
    // else can reach it.
    let handle = unsafe { (lib.create)() };
    if handle.is_null() {
        return Err("mpv could not start".into());
    }
    let set = |name: &str, value: &str| -> Result<c_int, String> {
        let (name, value) = (c(name)?, c(value)?);
        // SAFETY: a handle not yet initialised, and two C strings.
        Ok(unsafe { (lib.set_option_string)(handle, name.as_ptr(), value.as_ptr()) })
    };
    set("vo", "libmpv")?;
    // A smaller read-ahead than mpv's own 150 MB and 50 MB back: the computers
    // Linux runs on are often short of memory, and this still holds a minute
    // ahead and half a minute back of a conversion.
    if !options.contains_key("demuxer-max-bytes") {
        set("demuxer-max-bytes", "64MiB")?;
        set("demuxer-max-back-bytes", "32MiB")?;
    }
    for (name, value) in &options {
        // Where it draws is decided here; and a sound device named on another
        // system means nothing on this one.
        if ["vo", "wid", "gpu-api", "gpu-context"].contains(&name.as_str()) {
            continue;
        }
        let code = set(name, value)?;
        if code < 0 {
            eprintln!("mpv option {name}={value}: {}", lib.error(code));
        }
    }
    // SAFETY: the handle made above.
    let code = unsafe { (lib.initialize)(handle) };
    if code < 0 {
        return Err(format!("mpv could not start: {}", lib.error(code)));
    }
    // SAFETY: an initialised handle and a C string; the answer is mpv's.
    let version = unsafe {
        let text = (lib.get_property_string)(handle, c"mpv-version".as_ptr());
        if text.is_null() {
            String::new()
        } else {
            let version = CStr::from_ptr(text).to_string_lossy().into_owned();
            (lib.free)(text.cast());
            version
        }
    };
    let loadfile_index = takes_loadfile_index(&version);
    eprintln!("linux player: {version}");
    let player = PLAYER.get_or_init(|| Player {
        lib,
        handle,
        loadfile_index,
    });
    let picture = c("vo-configured")?;
    // SAFETY: an initialised handle and a C string.
    unsafe { (player.lib.observe_property)(handle, OWN, picture.as_ptr(), FORMAT_FLAG) };
    observe(player, &observed)?;

    let events_app = app.clone();
    std::thread::Builder::new()
        .name("mpv events".into())
        .spawn(move || events(events_app, player))
        .map_err(|e| e.to_string())?;

    // The render context, before anything is opened: a file opened first
    // finds no picture output, and mpv drops its video for good. On GTK's
    // thread, which owns the area; this command usually runs there already.
    let make = start_rendering;
    if glib::MainContext::default().is_owner() {
        make();
    } else {
        let (done, wait) = std::sync::mpsc::channel();
        let _ = app.run_on_main_thread(move || {
            make();
            let _ = done.send(());
        });
        let _ = wait.recv_timeout(std::time::Duration::from_secs(5));
    }
    Ok(())
}

fn observe(player: &Player, observed: &[Vec<String>]) -> Result<(), String> {
    for property in observed {
        let Some(name) = property.first() else {
            continue;
        };
        let format = match property.get(1).map(String::as_str) {
            Some("flag") => FORMAT_FLAG,
            Some("int64") => FORMAT_INT64,
            Some("double") => FORMAT_DOUBLE,
            Some("string") => FORMAT_STRING,
            _ => FORMAT_NONE,
        };
        let name = c(name)?;
        // SAFETY: an initialised handle and a C string.
        unsafe { (player.lib.observe_property)(player.handle, 0, name.as_ptr(), format) };
    }
    Ok(())
}

/// mpv's events, as the page hears them, until mpv shuts down.
fn events<R: Runtime>(app: AppHandle<R>, player: &'static Player) {
    loop {
        // SAFETY: an initialised handle; the event stays valid until the
        // next wait, and is read before it.
        let event = unsafe { &*(player.lib.wait_event)(player.handle, -1.0) };
        match event.event_id {
            EVENT_SHUTDOWN => return,
            EVENT_PROPERTY_CHANGE if !event.data.is_null() => {
                // SAFETY: a property change's data is an mpv_event_property.
                let property = unsafe { &*(event.data as *const EventProperty) };
                // SAFETY: the name is a C string mpv owns until the next wait.
                let name = unsafe { CStr::from_ptr(property.name) }.to_string_lossy();
                // SAFETY: data matches the format mpv says it is in.
                let data = unsafe { value_of(property.format, property.data) };
                if event.reply_userdata == OWN {
                    PICTURE.store(data == Value::Bool(true), Ordering::SeqCst);
                    redraw();
                    continue;
                }
                let _ = app.emit(
                    "basalt-mpv",
                    json!({ "event": "property-change", "name": name, "data": data }),
                );
            }
            _ => {}
        }
    }
}

/// A value mpv handed over, as JSON.
///
/// # Safety
/// `data` must point at a value of `format`, or be null.
unsafe fn value_of(format: c_int, data: *const c_void) -> Value {
    if data.is_null() {
        return Value::Null;
    }
    // SAFETY: as the caller promises.
    unsafe {
        match format {
            FORMAT_FLAG => Value::Bool(*(data as *const c_int) != 0),
            FORMAT_INT64 => json!(*(data as *const i64)),
            FORMAT_DOUBLE => json!(*(data as *const f64)),
            FORMAT_STRING => {
                let text = *(data as *const *const c_char);
                if text.is_null() {
                    Value::Null
                } else {
                    Value::String(CStr::from_ptr(text).to_string_lossy().into_owned())
                }
            }
            _ => Value::Null,
        }
    }
}

/// Whether this mpv's `loadfile` takes a position before its options: from
/// 0.38 on. `mpv v0.41.0-1050-ge76a35ec9`, `mpv 0.34.1`, `mpv 0.40.0-dirty`.
fn takes_loadfile_index(version: &str) -> bool {
    let number = version
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .trim_start_matches('v');
    let mut parts = number
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse::<u32>().ok());
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) => major > 0 || minor >= 38,
        // Built from git with no number: new.
        _ => true,
    }
}

/// `loadfile` as this mpv takes it: without the position the page sends,
/// where it is older than 0.38.
fn for_this_mpv(mut args: Vec<String>, loadfile_index: bool) -> Vec<String> {
    if !loadfile_index
        && args.first().is_some_and(|a| a == "loadfile")
        && args.len() >= 5
        && args[3].parse::<i64>().is_ok()
    {
        args.remove(3);
    }
    args
}

#[tauri::command]
pub fn linux_mpv_command(args: Vec<String>) -> Result<(), String> {
    let player = player()?;
    // A film after the player last closed: the picture's output again
    // first, or mpv opens the film with none and drops its video.
    if args.first().is_some_and(|a| a == "loadfile") && RENDER.with(|r| r.get()).is_null() {
        on_gtk(start_rendering);
    }
    let args = for_this_mpv(args, player.loadfile_index);
    let owned = args.iter().map(|a| c(a)).collect::<Result<Vec<_>, _>>()?;
    let mut pointers: Vec<*const c_char> = owned.iter().map(|a| a.as_ptr()).collect();
    pointers.push(std::ptr::null());
    // SAFETY: a NULL-terminated array of C strings that outlive the call.
    let code = unsafe { (player.lib.command)(player.handle, pointers.as_ptr()) };
    if code < 0 {
        return Err(format!("{}: {}", args.join(" "), player.lib.error(code)));
    }
    // The page stops mpv as the player closes.
    if args.first().is_some_and(|a| a == "stop") {
        on_gtk(stop_rendering);
    }
    Ok(())
}

#[tauri::command]
pub fn linux_mpv_set_property(name: String, value: String) -> Result<(), String> {
    let player = player()?;
    let (key, text) = (c(&name)?, c(&value)?);
    // SAFETY: two C strings.
    let code =
        unsafe { (player.lib.set_property_string)(player.handle, key.as_ptr(), text.as_ptr()) };
    if code < 0 {
        return Err(format!("{name}={value}: {}", player.lib.error(code)));
    }
    Ok(())
}

/// A property's value as `{ value }`, or `{}` when mpv has none.
#[tauri::command]
pub fn linux_mpv_get_property(name: String, format: String) -> Result<Value, String> {
    let player = player()?;
    let key = c(&name)?;
    let lib = &player.lib;
    // SAFETY: each read gives mpv room for the format asked for.
    let value = unsafe {
        match format.as_str() {
            "string" => {
                let text = (lib.get_property_string)(player.handle, key.as_ptr());
                if text.is_null() {
                    None
                } else {
                    let value = CStr::from_ptr(text).to_string_lossy().into_owned();
                    (lib.free)(text as *mut c_void);
                    Some(Value::String(value))
                }
            }
            "flag" => {
                let mut flag: c_int = 0;
                ((lib.get_property)(
                    player.handle,
                    key.as_ptr(),
                    FORMAT_FLAG,
                    (&raw mut flag).cast(),
                ) >= 0)
                    .then_some(Value::Bool(flag != 0))
            }
            "int64" => {
                let mut number: i64 = 0;
                ((lib.get_property)(
                    player.handle,
                    key.as_ptr(),
                    FORMAT_INT64,
                    (&raw mut number).cast(),
                ) >= 0)
                    .then(|| json!(number))
            }
            _ => {
                let mut number: f64 = 0.0;
                ((lib.get_property)(
                    player.handle,
                    key.as_ptr(),
                    FORMAT_DOUBLE,
                    (&raw mut number).cast(),
                ) >= 0)
                    .then(|| json!(number))
            }
        }
    };
    Ok(match value {
        Some(value) => json!({ "value": value }),
        None => json!({}),
    })
}

/// Stops what is playing. mpv itself stays for the life of the window: its
/// render context belongs to the GL area, and is ended with it.
#[tauri::command]
pub fn linux_mpv_destroy() -> Result<(), String> {
    if PLAYER.get().is_some() {
        linux_mpv_command(vec!["stop".into()])?;
    }
    Ok(())
}

/// Runs `f` on GTK's thread, which owns the drawing, and waits for it.
fn on_gtk(f: fn()) {
    let context = glib::MainContext::default();
    if context.is_owner() {
        f();
        return;
    }
    let (done, wait) = std::sync::mpsc::channel();
    context.invoke(move || {
        f();
        let _ = done.send(());
    });
    let _ = wait.recv_timeout(std::time::Duration::from_secs(5));
}

/// Lets go of everything drawing took once the player closes: mpv's render
/// context, the GL context and the driver behind it, and the memory freed
/// with them, which the system would otherwise not get back. A film after
/// that makes them again (see `linux_mpv_command`).
fn stop_rendering() {
    let Some(player) = PLAYER.get() else { return };
    let render = RENDER.with(|r| r.replace(std::ptr::null_mut()));
    if !render.is_null() {
        let current = OFFSCREEN.with(|o| o.borrow().as_ref().is_some_and(Offscreen::make_current));
        if current {
            // SAFETY: the render context made in `start_rendering`, freed
            // once, on this thread, with its GL context current; mpv takes
            // down its video output first.
            unsafe { (player.lib.render_free)(render) };
        }
    }
    TARGET.with(|t| t.set((0, 0, 0, 0)));
    FRAME.with(|f| f.borrow_mut().take());
    OFFSCREEN.with(|o| o.borrow_mut().take());
    extern "C" {
        fn malloc_trim(pad: usize) -> c_int;
    }
    // SAFETY: glibc's own call; it only hands free memory back.
    unsafe { malloc_trim(0) };
    eprintln!("linux player: drawing let go");
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/// WebKit draws the page directly, never composited.
///
/// Composited, WebKit keeps a second copy of the window and, without a
/// graphics card, draws every frame through software GL: on a virtual
/// machine the introduction alone took four cores and 600 MB, and the window
/// stopped answering. Drawn directly it is light, as Basalt Host is. Set
/// here rather than by `WEBKIT_DISABLE_COMPOSITING_MODE`, which would also
/// stop anyone who sets it otherwise.
fn compose(page: &webkit2gtk::WebView, composited: bool) {
    use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
    eprintln!(
        "linux player: page {}",
        if composited {
            "composited"
        } else {
            "drawn directly"
        }
    );
    if let Some(settings) = WebViewExt::settings(page) {
        settings.set_hardware_acceleration_policy(if composited {
            HardwareAccelerationPolicy::Always
        } else {
            HardwareAccelerationPolicy::Never
        });
    }
}

thread_local! {
    /// The page, to change how WebKit draws it: see `compose`.
    static PAGE: std::cell::RefCell<Option<webkit2gtk::WebView>> = const { std::cell::RefCell::new(None) };
    /// Whether the page is composited now.
    static COMPOSITED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The column Tauri put the page in. The picture is painted onto it,
    /// before GTK draws the page over it.
    static COLUMN: std::cell::RefCell<Option<gtk::Widget>> = const { std::cell::RefCell::new(None) };
    /// mpv's own GL context, out of sight of GTK and WebKit.
    static OFFSCREEN: std::cell::RefCell<Option<Offscreen>> = const { std::cell::RefCell::new(None) };
    /// mpv's render context, made on the GTK thread with that context
    /// current, and let go of when the player closes.
    static RENDER: std::cell::Cell<Handle> = const { std::cell::Cell::new(std::ptr::null_mut()) };
    /// The image each frame is read back into, kept between frames.
    static FRAME: std::cell::RefCell<Option<gtk::cairo::ImageSurface>> = const { std::cell::RefCell::new(None) };
    /// What mpv draws into: a framebuffer, its texture, and their size.
    static TARGET: std::cell::Cell<(u32, u32, c_int, c_int)> = const { std::cell::Cell::new((0, 0, 0, 0)) };
}

/// Paints the picture under the page, which stays where Tauri put it. On
/// the GTK thread, before the page shows anything.
///
/// mpv draws each frame in a GL context of its own, which neither GTK nor
/// WebKit sees, and the frame is painted under the page as any picture is.
/// The ways that let GTK do it went wrong: a GL area in an overlay with the
/// page made every click close the app (Tauri's resizing looks for the
/// window two steps above the page), was drawn under the page at every frame
/// with nothing playing, and showed nothing at all once WebKit drew directly;
/// a GL picture handed to GTK covered the page, controls and all, unless the
/// page was composited, which is what made the app so heavy.
pub fn attach<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        use gtk::prelude::*;
        let page = webview.inner();
        compose(&page, false);
        page.connect_scroll_event(wheel);
        PAGE.with(|slot| *slot.borrow_mut() = Some(page.clone()));
        let Some(column) = page.parent() else {
            eprintln!("linux player: the page has no column; no picture here");
            return;
        };
        // After the page, behind it: WebKit drawing directly copies its
        // pixels in, transparent ones too, so a picture painted first was
        // wiped. Painted after, "under" what is there, it shows only where
        // the page lets it, and the controls stay on top.
        column.connect_local("draw", true, |args| {
            let column = args[0].get::<gtk::Widget>().ok()?;
            let cr = args[1].get::<gtk::cairo::Context>().ok()?;
            draw(&column, &cr);
            Some(false.to_value())
        });
        COLUMN.with(|slot| *slot.borrow_mut() = Some(column));
    });
}

/// The mouse wheel, handed to the page while WebKit draws it directly.
///
/// Drawing directly was asked of WebKit through its settings, the only way
/// that lets the player switch to compositing for a film, and in that way
/// WebKit stops passing the wheel to the page at all: nothing scrolled. GTK
/// still has it here, so it goes to the page's own handler in
/// `lib/windowFrame.ts`. Composited, WebKit passes it on itself.
fn wheel(page: &webkit2gtk::WebView, event: &gtk::gdk::EventScroll) -> glib::Propagation {
    use gtk::gdk::{ModifierType, ScrollDirection};
    if COMPOSITED.with(|c| c.get()) {
        return glib::Propagation::Proceed;
    }
    // One notch, in CSS pixels, as WebKit scrolls by one; a touchpad's
    // smooth amounts are lines, about a third of that.
    const NOTCH: f64 = 87.0;
    const LINE: f64 = 29.0;
    let (mut dx, mut dy) = match event.direction() {
        ScrollDirection::Up => (0.0, -NOTCH),
        ScrollDirection::Down => (0.0, NOTCH),
        ScrollDirection::Left => (-NOTCH, 0.0),
        ScrollDirection::Right => (NOTCH, 0.0),
        _ => {
            let (x, y) = event.delta();
            (x * LINE * 3.0, y * LINE * 3.0)
        }
    };
    let state = event.state();
    if state.contains(ModifierType::SHIFT_MASK) && dx == 0.0 {
        (dx, dy) = (dy, 0.0);
    }
    let (x, y) = event.position();
    let ctrl = state.contains(ModifierType::CONTROL_MASK);
    let script = format!(
        "window.__basaltWheel && window.__basaltWheel({x:.1}, {y:.1}, {dx:.1}, {dy:.1}, {ctrl})"
    );
    #[allow(deprecated)]
    {
        use webkit2gtk::WebViewExt;
        page.run_javascript(&script, None::<&gtk::gio::Cancellable>, |_| {});
    }
    glib::Propagation::Stop
}

/// Makes mpv's render context, once mpv has started.
fn start_rendering() {
    let Some(player) = PLAYER.get() else { return };
    if !RENDER.with(|r| r.get()).is_null() {
        return;
    }
    let ready = OFFSCREEN.with(|o| {
        let mut slot = o.borrow_mut();
        if slot.is_none() {
            match Offscreen::new() {
                Ok(offscreen) => *slot = Some(offscreen),
                Err(e) => eprintln!("linux player: no GL here: {e}"),
            }
        }
        slot.as_ref().is_some_and(Offscreen::make_current)
    });
    if !ready {
        return;
    }
    let mut init = OpenGlInitParams {
        get_proc_address: gl_proc,
        get_proc_address_ctx: std::ptr::null_mut(),
        extra_exts: std::ptr::null(),
    };
    let api = c"opengl";
    let mut params = [
        RenderParam {
            kind: RENDER_PARAM_API_TYPE,
            data: api.as_ptr() as *mut c_void,
        },
        RenderParam {
            kind: RENDER_PARAM_OPENGL_INIT_PARAMS,
            data: (&raw mut init).cast(),
        },
        RenderParam {
            kind: RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ];
    let mut render: Handle = std::ptr::null_mut();
    // SAFETY: mpv's GL context is current, and the parameters live through
    // the call.
    let code =
        unsafe { (player.lib.render_create)(&mut render, player.handle, params.as_mut_ptr()) };
    if code < 0 || render.is_null() {
        eprintln!("mpv could not draw here: {}", player.lib.error(code));
        return;
    }
    RENDER.with(|r| r.set(render));
    eprintln!("linux player: drawing with GL");
    // SAFETY: a context just made; the callback only queues a redraw.
    unsafe {
        (player.lib.render_set_update_callback)(render, Some(on_update), std::ptr::null_mut())
    };
}

/// From mpv's own threads: a new frame. Only queued here; drawn on GTK's.
unsafe extern "C" fn on_update(_: *mut c_void) {
    redraw();
}

/// Whether the page is composited while a film plays, which depends on the
/// WebKit the app runs on.
///
/// Up to WebKit 2.50, a see-through page drawn directly left stale pixels
/// over the picture and then covered it, so the page is composited for a
/// film. From 2.52 (Ubuntu 26.04) it is the other way round: drawn directly
/// the picture shows, cleanly, and composited WebKit lets nothing painted
/// under the page through, so the desktop showed where the film was.
/// `BASALT_LINUX_COMPOSITE=never` or `always` overrides it, to find out what
/// another WebKit needs.
fn composite_for_films() -> bool {
    static ANSWER: OnceLock<bool> = OnceLock::new();
    *ANSWER.get_or_init(|| {
        // SAFETY: plain reads of the version of the WebKit that is loaded.
        let version = unsafe {
            (
                webkit2gtk::ffi::webkit_get_major_version(),
                webkit2gtk::ffi::webkit_get_minor_version(),
            )
        };
        let composite = match std::env::var("BASALT_LINUX_COMPOSITE").as_deref() {
            Ok("never") => false,
            Ok("always") => true,
            _ => composites_for_films(version),
        };
        eprintln!(
            "linux player: WebKit {}.{}, so the page is {} for films",
            version.0,
            version.1,
            if composite {
                "composited"
            } else {
                "drawn directly"
            }
        );
        composite
    })
}

/// See `composite_for_films`.
fn composites_for_films((major, minor): (u32, u32)) -> bool {
    (major, minor) < (2, 52)
}

fn redraw() {
    glib::idle_add_once(|| {
        let picture = PICTURE.load(Ordering::SeqCst);
        if picture && !COMPOSITED.with(|c| c.get()) && composite_for_films() {
            COMPOSITED.with(|c| c.set(true));
            PAGE.with(|page| page.borrow().as_ref().map(|page| compose(page, true)));
        } else if !picture && COMPOSITED.with(|c| c.get()) {
            // Back to drawing directly once the page has closed the player
            // and is opaque again: switched while it was still see-through,
            // WebKit drew nothing at all from then on.
            glib::timeout_add_local_once(std::time::Duration::from_millis(1500), || {
                if !PICTURE.load(Ordering::SeqCst) && COMPOSITED.with(|c| c.get()) {
                    COMPOSITED.with(|c| c.set(false));
                    PAGE.with(|page| page.borrow().as_ref().map(|page| compose(page, false)));
                }
            });
        }
        // What mpv has left for this thread (a new picture size, a new
        // format) is done here, as mpv asks after each of its signals. Left
        // undone, mpv gave up on the frames waiting on it, and from mpv 0.41
        // the picture often stayed black under the subtitles.
        // A new frame is drawn and read back as soon as mpv has it, and
        // the window shows the latest whenever it next draws. Drawn only as
        // the window drew, mpv waited on the window, took its frames for
        // late and dropped a fifth of them where windows are slow to show.
        let new_frame = update_render() & UPDATE_FRAME != 0;
        COLUMN.with(|column| {
            if let Some(column) = column.borrow().as_ref() {
                use gtk::prelude::*;
                if picture && new_frame {
                    render_frame(column);
                }
                column.queue_draw();
            }
        })
    });
}

/// mpv_render_context_update's flag: there is a new frame to draw.
const UPDATE_FRAME: u64 = 1;

/// Runs what mpv has queued for the thread that draws, in mpv's GL context.
/// What mpv says is to be done now (a new frame, say).
fn update_render() -> u64 {
    let render = RENDER.with(|r| r.get());
    let Some(player) = PLAYER.get() else { return 0 };
    if render.is_null()
        || !OFFSCREEN.with(|o| o.borrow().as_ref().is_some_and(Offscreen::make_current))
    {
        return 0;
    }
    // SAFETY: a live render context, on the thread that draws, with its GL
    // context current.
    let flags = unsafe { (player.lib.render_update)(render) };
    release_gl();
    flags
}

/// mpv's frame drawn offscreen and read back into the image the window
/// shows (`FRAME`), at the column's size.
fn render_frame(column: &gtk::Widget) {
    use gtk::prelude::*;
    let render = RENDER.with(|r| r.get());
    let Some(player) = PLAYER.get() else { return };
    if render.is_null()
        || !OFFSCREEN.with(|o| o.borrow().as_ref().is_some_and(Offscreen::make_current))
    {
        return;
    }
    let gl = gl();
    let scale = column.scale_factor();
    let (w, h) = (
        column.allocated_width() * scale,
        column.allocated_height() * scale,
    );
    if w <= 0 || h <= 0 {
        return;
    }
    let Some((fbo, _)) = gl.target(w, h) else {
        return;
    };
    let mut target = OpenGlFbo {
        fbo: fbo as c_int,
        w,
        h,
        internal_format: 0,
    };
    // As GL keeps it, bottom row first; read back from the top, it comes
    // out the right way up, as cairo keeps an image.
    let mut flip: c_int = 0;
    // Not waiting for the frame's moment to come: mpv paces itself, and
    // waiting here held the window up.
    let mut wait: c_int = 0;
    let mut params = [
        RenderParam {
            kind: RENDER_PARAM_OPENGL_FBO,
            data: (&raw mut target).cast(),
        },
        RenderParam {
            kind: RENDER_PARAM_FLIP_Y,
            data: (&raw mut flip).cast(),
        },
        RenderParam {
            kind: RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
            data: (&raw mut wait).cast(),
        },
        RenderParam {
            kind: RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ];
    // SAFETY: mpv's GL context is current, and the parameters live through
    // the call.
    unsafe { (player.lib.render_render)(render, params.as_mut_ptr()) };

    // One image, kept from frame to frame while the size stays: a new one
    // each time was a few megabytes made and thrown away 24 times a second.
    let kept = FRAME.with(|f| f.borrow_mut().take());
    let mut frame = match kept {
        Some(frame) if frame.width() == w && frame.height() == h => frame,
        _ => match gtk::cairo::ImageSurface::create(gtk::cairo::Format::Rgb24, w, h) {
            Ok(frame) => frame,
            Err(_) => return,
        },
    };
    let stride = frame.stride();
    {
        let Ok(mut pixels) = frame.data() else {
            release_gl();
            return;
        };
        gl.read(fbo, w, h, stride, &mut pixels);
    }
    release_gl();
    frame.mark_dirty();
    frame.set_device_scale(f64::from(scale), f64::from(scale));
    // SAFETY: the render context just drawn with, on this thread: tells mpv
    // the frame is out, for its timing.
    unsafe { (player.lib.render_report_swap)(render) };
    FRAME.with(|f| *f.borrow_mut() = Some(frame));
}

/// The picture, under the page: the latest frame mpv drew, painted where the
/// page is about to be drawn. Nothing while there is no picture.
fn draw(column: &gtk::Widget, cr: &gtk::cairo::Context) {
    use gtk::prelude::*;
    if !PICTURE.load(Ordering::SeqCst) {
        return;
    }
    // None yet, or the window changed size: drawn again for it now (paused,
    // mpv sends no new frame).
    let scale = column.scale_factor();
    let size = (
        column.allocated_width() * scale,
        column.allocated_height() * scale,
    );
    let fits = FRAME.with(|f| {
        f.borrow()
            .as_ref()
            .is_some_and(|frame| (frame.width(), frame.height()) == size)
    });
    if !fits {
        let _ = update_render();
        render_frame(column);
    }
    FRAME.with(|f| {
        let Some(frame) = f.borrow().clone() else {
            // No picture to show yet, or none can be drawn here: black under
            // the page, as a player is, never the desktop showing through the
            // window where the film should be.
            let _ = cr.save();
            cr.set_operator(gtk::cairo::Operator::DestOver);
            cr.set_source_rgb(0.0, 0.0, 0.0);
            let _ = cr.paint();
            let _ = cr.restore();
            return;
        };
        let _ = cr.save();
        // Inside the window's rounded corners, as the page is (styles.css),
        // unless it fills the screen and is square.
        if !square(column) {
            rounded(
                cr,
                f64::from(column.allocated_width()),
                f64::from(column.allocated_height()),
                CORNER,
            );
            cr.clip();
        }
        cr.set_operator(gtk::cairo::Operator::DestOver);
        if cr.set_source_surface(&frame, 0.0, 0.0).is_ok() {
            let _ = cr.paint();
        }
        let _ = cr.restore();
    });
}

/// The radius of the window's corners: the page's, in styles.css.
const CORNER: f64 = 10.0;

/// Whether the window is maximised or full screen, when the page squares its
/// corners off (lib/windowFrame.ts).
fn square(column: &gtk::Widget) -> bool {
    use gtk::prelude::*;
    let Some(window) = column.window() else {
        return false;
    };
    let state = window.toplevel().state();
    state.intersects(gtk::gdk::WindowState::MAXIMIZED | gtk::gdk::WindowState::FULLSCREEN)
}

/// A rectangle `width` by `height` with corners of `radius`, as `cr`'s path.
fn rounded(cr: &gtk::cairo::Context, width: f64, height: f64, radius: f64) {
    use std::f64::consts::{FRAC_PI_2, PI};
    cr.new_path();
    cr.arc(width - radius, radius, radius, -FRAC_PI_2, 0.0);
    cr.arc(width - radius, height - radius, radius, 0.0, FRAC_PI_2);
    cr.arc(radius, height - radius, radius, FRAC_PI_2, PI);
    cr.arc(radius, radius, radius, PI, 3.0 * FRAC_PI_2);
    cr.close_path();
}

// ---------------------------------------------------------------------------
// OpenGL, as far as this needs it
// ---------------------------------------------------------------------------

type GetProc = unsafe extern "C" fn(*const c_char) -> *mut c_void;

/// mpv's GL context: EGL, with a tiny surface of its own it never shows.
/// mpv draws into a framebuffer, and the frame is read back from there.
struct Offscreen {
    _lib: libloading::Library,
    display: *mut c_void,
    surface: *mut c_void,
    context: *mut c_void,
    make_current: MakeCurrent,
    destroy_context: DestroyContext,
    destroy_surface: DestroySurface,
    terminate: Terminate,
    /// The display is this context's alone (Mesa's surfaceless one), so it
    /// can be ended with it; the system's may be shared.
    own_display: bool,
}

impl Offscreen {
    /// mpv's GL context. Mesa's surfaceless display first: it needs no
    /// window system, so it is the same under X11 and Wayland. Then the
    /// system's own display with a tiny surface, and without one: Mesa has no
    /// such surfaces on Wayland, and NVIDIA has no surfaceless display.
    fn new() -> Result<Self, String> {
        const PLATFORM_SURFACELESS_MESA: u32 = 0x31DD;
        // SAFETY: EGL's loader, by its documented name.
        let lib = unsafe { libloading::Library::new("libEGL.so.1") }
            .map_err(|e| format!("no EGL: {e}"))?;
        let egl = Egl::load(&lib)?;
        let mut last = String::from("no way to make a GL context");
        let displays = [
            egl.platform_display.map(|get| {
                // SAFETY: EGL's own call, for the surfaceless platform.
                unsafe {
                    get(
                        PLATFORM_SURFACELESS_MESA,
                        std::ptr::null_mut(),
                        std::ptr::null(),
                    )
                }
            }),
            // SAFETY: EGL's own call, for the system's display.
            Some(unsafe { (egl.get_display)(std::ptr::null_mut()) }),
        ];
        for (n, display) in displays.into_iter().enumerate() {
            let Some(display) = display.filter(|d| !d.is_null()) else {
                continue;
            };
            for with_surface in [false, true] {
                match egl.context(display, with_surface) {
                    Ok((surface, context)) => {
                        eprintln!(
                            "linux player: GL on the {} display{}",
                            if n == 0 { "surfaceless" } else { "system's" },
                            if with_surface { ", with a surface" } else { "" }
                        );
                        return Ok(Offscreen {
                            display,
                            surface,
                            context,
                            make_current: egl.make_current,
                            destroy_context: egl.destroy_context,
                            destroy_surface: egl.destroy_surface,
                            terminate: egl.terminate,
                            own_display: n == 0,
                            _lib: lib,
                        });
                    }
                    Err(e) => last = e,
                }
            }
        }
        Err(last)
    }

    fn make_current(&self) -> bool {
        // SAFETY: the display, surface (or none) and context this made.
        unsafe { (self.make_current)(self.display, self.surface, self.surface, self.context) != 0 }
    }

    /// Lets go of the context on this thread, which GTK draws on too: left
    /// current, GTK's own GL (the composited page) could land in it.
    fn release(&self) {
        let none = std::ptr::null_mut();
        // SAFETY: the display this made; no surface or context is current
        // after it.
        unsafe { (self.make_current)(self.display, none, none, none) };
    }
}

/// Lets go of mpv's GL context, if there is one.
fn release_gl() {
    OFFSCREEN.with(|o| {
        if let Some(offscreen) = o.borrow().as_ref() {
            offscreen.release();
        }
    });
}

impl Drop for Offscreen {
    /// The context and all it held: with software GL, mpv's textures and
    /// framebuffers are ordinary memory, and the driver's own is much more.
    fn drop(&mut self) {
        let none = std::ptr::null_mut();
        // SAFETY: the display, surface and context this made, let go of
        // first; nothing uses them after this.
        unsafe {
            (self.make_current)(self.display, none, none, none);
            (self.destroy_context)(self.display, self.context);
            if !self.surface.is_null() {
                (self.destroy_surface)(self.display, self.surface);
            }
            if self.own_display {
                (self.terminate)(self.display);
            }
        }
    }
}

type MakeCurrent = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> u32;
type DestroyContext = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
type DestroySurface = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
type Terminate = unsafe extern "C" fn(*mut c_void) -> u32;

/// The EGL calls a context takes.
struct Egl {
    get_display: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    platform_display: Option<unsafe extern "C" fn(u32, *mut c_void, *const isize) -> *mut c_void>,
    initialize: unsafe extern "C" fn(*mut c_void, *mut i32, *mut i32) -> u32,
    bind_api: unsafe extern "C" fn(u32) -> u32,
    choose: unsafe extern "C" fn(*mut c_void, *const i32, *mut *mut c_void, i32, *mut i32) -> u32,
    pbuffer: unsafe extern "C" fn(*mut c_void, *mut c_void, *const i32) -> *mut c_void,
    create: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *const i32) -> *mut c_void,
    make_current: MakeCurrent,
    destroy_context: DestroyContext,
    destroy_surface: DestroySurface,
    terminate: Terminate,
}

impl Egl {
    fn load(lib: &libloading::Library) -> Result<Self, String> {
        // SAFETY: EGL's functions, by their documented names and signatures.
        unsafe {
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get($name)
                        .map_err(|e| format!("EGL has no {}: {e}", stringify!($name)))?
                };
            }
            Ok(Egl {
                get_display: sym!(b"eglGetDisplay"),
                platform_display: lib.get(b"eglGetPlatformDisplay").ok().map(|s| *s),
                initialize: sym!(b"eglInitialize"),
                bind_api: sym!(b"eglBindAPI"),
                choose: sym!(b"eglChooseConfig"),
                pbuffer: sym!(b"eglCreatePbufferSurface"),
                create: sym!(b"eglCreateContext"),
                make_current: sym!(b"eglMakeCurrent"),
                destroy_context: sym!(b"eglDestroyContext"),
                destroy_surface: sym!(b"eglDestroySurface"),
                terminate: sym!(b"eglTerminate"),
            })
        }
    }

    /// A desktop OpenGL context on `display`, current, with a tiny surface
    /// of its own or with none at all.
    fn context(
        &self,
        display: *mut c_void,
        with_surface: bool,
    ) -> Result<(*mut c_void, *mut c_void), String> {
        const OPENGL_API: u32 = 0x30A2;
        const SURFACE_TYPE: i32 = 0x3033;
        const PBUFFER_BIT: i32 = 0x0001;
        const RENDERABLE_TYPE: i32 = 0x3040;
        const OPENGL_BIT: i32 = 0x0008;
        const RED_SIZE: i32 = 0x3024;
        const GREEN_SIZE: i32 = 0x3023;
        const BLUE_SIZE: i32 = 0x3022;
        const WIDTH: i32 = 0x3057;
        const HEIGHT: i32 = 0x3056;
        const NONE: i32 = 0x3038;
        // SAFETY: EGL's calls, in the order EGL asks, on a display it gave.
        unsafe {
            let (mut major, mut minor) = (0, 0);
            if (self.initialize)(display, &mut major, &mut minor) == 0 {
                return Err("EGL would not start".into());
            }
            if (self.bind_api)(OPENGL_API) == 0 {
                return Err("EGL has no desktop OpenGL".into());
            }
            let surface_type = if with_surface { PBUFFER_BIT } else { 0 };
            let wanted = [
                SURFACE_TYPE,
                surface_type,
                RENDERABLE_TYPE,
                OPENGL_BIT,
                RED_SIZE,
                8,
                GREEN_SIZE,
                8,
                BLUE_SIZE,
                8,
                NONE,
            ];
            let mut config = std::ptr::null_mut();
            let mut found = 0;
            if (self.choose)(display, wanted.as_ptr(), &mut config, 1, &mut found) == 0
                || found == 0
            {
                return Err("no EGL configuration for OpenGL".into());
            }
            let surface = if with_surface {
                let size = [WIDTH, 16, HEIGHT, 16, NONE];
                let surface = (self.pbuffer)(display, config, size.as_ptr());
                if surface.is_null() {
                    return Err("EGL could not make a surface".into());
                }
                surface
            } else {
                std::ptr::null_mut()
            };
            let context = (self.create)(display, config, std::ptr::null_mut(), [NONE].as_ptr());
            if context.is_null() {
                return Err("EGL could not make a GL context".into());
            }
            if (self.make_current)(display, surface, surface, context) == 0 {
                return Err("EGL could not use the GL context".into());
            }
            Ok((surface, context))
        }
    }
}

/// How GL functions are found: through EGL, with mpv's context current; and
/// the few this file calls itself.
struct Gl {
    _lib: Option<libloading::Library>,
    egl: Option<GetProc>,
    gen_framebuffers: Option<unsafe extern "C" fn(c_int, *mut u32)>,
    bind_framebuffer: Option<unsafe extern "C" fn(u32, u32)>,
    framebuffer_texture: Option<unsafe extern "C" fn(u32, u32, u32, u32, c_int)>,
    gen_textures: Option<unsafe extern "C" fn(c_int, *mut u32)>,
    bind_texture: Option<unsafe extern "C" fn(u32, u32)>,
    tex_image: Option<
        unsafe extern "C" fn(u32, c_int, c_int, c_int, c_int, c_int, u32, u32, *const c_void),
    >,
    pixel_store: Option<unsafe extern "C" fn(u32, c_int)>,
    read_pixels: Option<unsafe extern "C" fn(c_int, c_int, c_int, c_int, u32, u32, *mut c_void)>,
}
// SAFETY: function pointers into system libraries, used on GTK's thread.
unsafe impl Send for Gl {}
unsafe impl Sync for Gl {}

static GL: OnceLock<Gl> = OnceLock::new();

fn gl() -> &'static Gl {
    GL.get_or_init(|| {
        // SAFETY: EGL's loader, by its documented name.
        let lib = unsafe { libloading::Library::new("libEGL.so.1") }.ok();
        // SAFETY: as above.
        let egl = lib.as_ref().and_then(|lib| {
            unsafe { lib.get::<GetProc>(b"eglGetProcAddress") }
                .ok()
                .map(|s| *s)
        });
        let mut gl = Gl {
            _lib: lib,
            egl,
            gen_framebuffers: None,
            bind_framebuffer: None,
            framebuffer_texture: None,
            gen_textures: None,
            bind_texture: None,
            tex_image: None,
            pixel_store: None,
            read_pixels: None,
        };
        // SAFETY: the names are GL's, and each pointer is given its signature.
        unsafe {
            gl.gen_framebuffers =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glGenFramebuffers"));
            gl.bind_framebuffer =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glBindFramebuffer"));
            gl.framebuffer_texture =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glFramebufferTexture2D"));
            gl.gen_textures =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glGenTextures"));
            gl.bind_texture =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glBindTexture"));
            gl.tex_image = std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glTexImage2D"));
            gl.pixel_store =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glPixelStorei"));
            gl.read_pixels =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glReadPixels"));
        }
        gl
    })
}

impl Gl {
    fn find(&self, name: &CStr) -> *mut c_void {
        match self.egl {
            // SAFETY: EGL's loader and a C string.
            Some(egl) => unsafe { egl(name.as_ptr()) },
            None => std::ptr::null_mut(),
        }
    }

    /// A framebuffer and its texture, `w` by `h`, made the first time and
    /// made again when the window changes size.
    fn target(&self, w: c_int, h: c_int) -> Option<(u32, u32)> {
        const FRAMEBUFFER: u32 = 0x8D40;
        const COLOR_ATTACHMENT0: u32 = 0x8CE0;
        const TEXTURE_2D: u32 = 0x0DE1;
        const RGBA8: c_int = 0x8058;
        const RGBA: u32 = 0x1908;
        const UNSIGNED_BYTE: u32 = 0x1401;
        let (gen_fb, bind_fb, attach, gen_tex, bind_tex, image) = (
            self.gen_framebuffers?,
            self.bind_framebuffer?,
            self.framebuffer_texture?,
            self.gen_textures?,
            self.bind_texture?,
            self.tex_image?,
        );
        let (mut fbo, mut texture, was_w, was_h) = TARGET.with(|t| t.get());
        // SAFETY: plain GL calls with mpv's context current, on names this
        // made.
        unsafe {
            if fbo == 0 {
                gen_fb(1, &mut fbo);
                gen_tex(1, &mut texture);
            }
            if (w, h) != (was_w, was_h) {
                bind_tex(TEXTURE_2D, texture);
                image(
                    TEXTURE_2D,
                    0,
                    RGBA8,
                    w,
                    h,
                    0,
                    RGBA,
                    UNSIGNED_BYTE,
                    std::ptr::null(),
                );
                bind_fb(FRAMEBUFFER, fbo);
                attach(FRAMEBUFFER, COLOR_ATTACHMENT0, TEXTURE_2D, texture, 0);
                bind_fb(FRAMEBUFFER, 0);
                bind_tex(TEXTURE_2D, 0);
            }
        }
        TARGET.with(|t| t.set((fbo, texture, w, h)));
        Some((fbo, texture))
    }

    /// The frame in `fbo`, into `pixels`, as cairo keeps an RGB image:
    /// blue, green, red and a spare byte, `stride` bytes a row.
    fn read(&self, fbo: u32, w: c_int, h: c_int, stride: i32, pixels: &mut [u8]) {
        const FRAMEBUFFER: u32 = 0x8D40;
        const PACK_ROW_LENGTH: u32 = 0x0D02;
        const PACK_ALIGNMENT: u32 = 0x0D05;
        const BGRA: u32 = 0x80E1;
        const UNSIGNED_BYTE: u32 = 0x1401;
        let (Some(bind_fb), Some(store), Some(read)) =
            (self.bind_framebuffer, self.pixel_store, self.read_pixels)
        else {
            return;
        };
        if pixels.len() < (stride * h) as usize {
            return;
        }
        // SAFETY: a framebuffer this made, read into a buffer of `stride`
        // bytes for each of `h` rows, as the row length says.
        unsafe {
            bind_fb(FRAMEBUFFER, fbo);
            store(PACK_ALIGNMENT, 4);
            store(PACK_ROW_LENGTH, stride / 4);
            read(0, 0, w, h, BGRA, UNSIGNED_BYTE, pixels.as_mut_ptr().cast());
            store(PACK_ROW_LENGTH, 0);
            bind_fb(FRAMEBUFFER, 0);
        }
    }
}

/// mpv's way of finding GL functions.
unsafe extern "C" fn gl_proc(_: *mut c_void, name: *const c_char) -> *mut c_void {
    // SAFETY: mpv passes a C string.
    gl().find(unsafe { CStr::from_ptr(name) })
}

// ---------------------------------------------------------------------------
// The window frame
// ---------------------------------------------------------------------------

/// After the system moved or resized the window from a press on the page:
/// tells the page the button was let go, as Basalt Host does. The system kept
/// the release, and the page went on thinking the button was held.
pub fn release_in_page<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        use gtk::gdk;
        use gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};
        use gtk::prelude::*;

        let Some(target) = webview.inner().window() else {
            return;
        };
        let Some(pointer) = target.display().default_seat().and_then(|s| s.pointer()) else {
            return;
        };
        let (_, x, y, _) = target.device_position_double(&pointer);
        let (_, root_x, root_y) = target.origin();

        let mut event = gdk::Event::new(gdk::EventType::ButtonRelease);
        // SAFETY: a button release made just above, whose fields are all
        // filled in here; the event takes its own reference to the window
        // and gives it back when it is dropped.
        unsafe {
            let raw: *mut gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
            let button = &mut (*raw).button;
            button.window = target.to_glib_full();
            button.send_event = 1;
            button.time = gdk::ffi::GDK_CURRENT_TIME as u32;
            button.x = x;
            button.y = y;
            button.x_root = f64::from(root_x) + x;
            button.y_root = f64::from(root_y) + y;
            button.state = gdk::ffi::GDK_BUTTON1_MASK;
            button.button = 1;
        }
        event.set_device(Some(&pointer));
        gtk::main_do_event(&mut event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn films_are_composited_only_on_webkit_before_2_52() {
        assert!(composites_for_films((2, 44)));
        assert!(composites_for_films((2, 50)));
        assert!(!composites_for_films((2, 52)));
        assert!(!composites_for_films((2, 54)));
        assert!(!composites_for_films((3, 0)));
    }

    #[test]
    fn older_mpv_is_told_loadfile_without_a_position() {
        assert!(takes_loadfile_index("mpv v0.41.0-1050-ge76a35ec9"));
        assert!(takes_loadfile_index("mpv 0.38.0"));
        assert!(takes_loadfile_index("mpv v0.40.0-dirty"));
        assert!(!takes_loadfile_index("mpv 0.34.1"));
        assert!(!takes_loadfile_index("mpv 0.37.0"));
        let page = |s: &[&str]| s.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let sent = page(&["loadfile", "http://x/f.mkv", "replace", "0", "pause=no"]);
        assert_eq!(for_this_mpv(sent.clone(), true), sent);
        assert_eq!(
            for_this_mpv(sent, false),
            page(&["loadfile", "http://x/f.mkv", "replace", "pause=no"])
        );
        // Anything else is left as it is.
        let other = page(&["seek", "10", "absolute+exact"]);
        assert_eq!(for_this_mpv(other.clone(), false), other);
    }
}
