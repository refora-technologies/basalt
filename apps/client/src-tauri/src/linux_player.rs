//! The player on Linux: mpv drawn into a GL area under the page.
//!
//! On Windows the libmpv plugin hands mpv the window, and the page, in its
//! own transparent child window, stays above the picture. On Linux that does
//! not work: WebKitGTK draws into the window itself, so mpv's window would
//! cover the page, controls and all, and on Wayland mpv cannot be handed a
//! window at all. So the app draws the picture itself: mpv's render API
//! (`vo=libmpv`) into a `GtkGLArea`, with the page laid over it in a
//! `GtkOverlay`, as Celluloid does. The page is unchanged: transparent where
//! the picture is, as on Windows.
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
    let player = PLAYER.get_or_init(|| Player { lib, handle });
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
    let make = || {
        AREA.with(|area| {
            if let Some(area) = area.borrow().as_ref() {
                start_rendering(area);
            }
        })
    };
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

#[tauri::command]
pub fn linux_mpv_command(args: Vec<String>) -> Result<(), String> {
    let player = player()?;
    let owned = args.iter().map(|a| c(a)).collect::<Result<Vec<_>, _>>()?;
    let mut pointers: Vec<*const c_char> = owned.iter().map(|a| a.as_ptr()).collect();
    pointers.push(std::ptr::null());
    // SAFETY: a NULL-terminated array of C strings that outlive the call.
    let code = unsafe { (player.lib.command)(player.handle, pointers.as_ptr()) };
    if code < 0 {
        return Err(format!("{}: {}", args.join(" "), player.lib.error(code)));
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
                    .then(|| Value::Bool(flag != 0))
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

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

thread_local! {
    /// The GL area, on the GTK thread that owns it.
    static AREA: std::cell::RefCell<Option<gtk::GLArea>> = const { std::cell::RefCell::new(None) };
    /// mpv's render context, made once on the GTK thread with the area's GL
    /// context current.
    static RENDER: std::cell::Cell<Handle> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

/// Puts a GL area under the page, in the window's own widgets. On the GTK
/// thread, before the page shows anything.
pub fn attach<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        use gtk::prelude::*;
        let page = webview.inner();
        let Some(parent) = page.parent() else { return };
        let Ok(parent) = parent.downcast::<gtk::Container>() else {
            return;
        };
        let overlay = gtk::Overlay::new();
        let area = gtk::GLArea::new();
        area.set_has_alpha(true);
        area.connect_realize(|area| {
            area.make_current();
            match area.error() {
                None => start_rendering(area),
                Some(e) => eprintln!("linux player: no GL here: {e}"),
            }
        });
        area.connect_render(|area, _| {
            draw(area);
            glib::Propagation::Stop
        });
        parent.remove(&page);
        overlay.add(&area);
        overlay.add_overlay(&page);
        match parent.clone().downcast::<gtk::Box>() {
            Ok(column) => column.pack_start(&overlay, true, true, 0),
            Err(parent) => parent.add(&overlay),
        }
        overlay.show_all();
        AREA.with(|slot| *slot.borrow_mut() = Some(area));
    });
}

/// Makes mpv's render context, when both mpv and the area are there.
fn start_rendering(area: &gtk::GLArea) {
    use gtk::prelude::*;
    let Some(player) = PLAYER.get() else { return };
    if !RENDER.with(|r| r.get()).is_null() {
        return;
    }
    if !area.is_realized() {
        eprintln!("linux player: the GL area is not shown yet");
        return;
    }
    area.make_current();
    if area.error().is_some() {
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
    let mut context: Handle = std::ptr::null_mut();
    // SAFETY: the area's GL context is current, and the parameters live
    // through the call.
    let code =
        unsafe { (player.lib.render_create)(&mut context, player.handle, params.as_mut_ptr()) };
    if code < 0 || context.is_null() {
        eprintln!("mpv could not draw here: {}", player.lib.error(code));
        return;
    }
    RENDER.with(|r| r.set(context));
    eprintln!("linux player: drawing with GL");
    // SAFETY: a context just made; the callback only queues a redraw.
    unsafe {
        (player.lib.render_set_update_callback)(context, Some(on_update), std::ptr::null_mut())
    };
}

/// From mpv's own threads: a new frame. Only queued here; drawn on GTK's.
unsafe extern "C" fn on_update(_: *mut c_void) {
    redraw();
}

fn redraw() {
    glib::idle_add_once(|| {
        AREA.with(|area| {
            if let Some(area) = area.borrow().as_ref() {
                use gtk::prelude::*;
                area.queue_render();
            }
        })
    });
}

/// One frame, into the area's framebuffer: mpv's picture, or nothing at all
/// while there is none.
fn draw(area: &gtk::GLArea) {
    use gtk::prelude::*;
    let gl = gl();
    let context = RENDER.with(|r| r.get());
    let Some(player) = PLAYER.get() else {
        gl.clear_transparent();
        return;
    };
    if context.is_null() || !PICTURE.load(Ordering::SeqCst) {
        gl.clear_transparent();
        return;
    }
    let scale = area.scale_factor();
    let mut fbo = OpenGlFbo {
        fbo: gl.framebuffer(),
        w: area.allocated_width() * scale,
        h: area.allocated_height() * scale,
        internal_format: 0,
    };
    let mut flip: c_int = 1;
    let mut params = [
        RenderParam {
            kind: RENDER_PARAM_OPENGL_FBO,
            data: (&raw mut fbo).cast(),
        },
        RenderParam {
            kind: RENDER_PARAM_FLIP_Y,
            data: (&raw mut flip).cast(),
        },
        RenderParam {
            kind: RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ];
    // SAFETY: the area's GL context is current while it renders, and the
    // parameters live through the call.
    unsafe { (player.lib.render_render)(context, params.as_mut_ptr()) };
}

// ---------------------------------------------------------------------------
// OpenGL, as far as this needs it
// ---------------------------------------------------------------------------

type GetProc = unsafe extern "C" fn(*const c_char) -> *mut c_void;

/// How GL functions are found: through EGL where GTK drew with it (always on
/// Wayland), otherwise GLX.
struct Gl {
    _libs: Vec<libloading::Library>,
    egl: Option<GetProc>,
    glx: Option<GetProc>,
    get_integer: Option<unsafe extern "C" fn(u32, *mut c_int)>,
    clear_color: Option<unsafe extern "C" fn(f32, f32, f32, f32)>,
    clear: Option<unsafe extern "C" fn(u32)>,
}
// SAFETY: function pointers into system libraries, used on GTK's thread.
unsafe impl Send for Gl {}
unsafe impl Sync for Gl {}

static GL: OnceLock<Gl> = OnceLock::new();

fn gl() -> &'static Gl {
    GL.get_or_init(|| {
        let mut libs = Vec::new();
        let mut egl = None;
        let mut glx = None;
        // SAFETY: system GL loaders, looked up by their documented names.
        unsafe {
            if let Ok(lib) = libloading::Library::new("libEGL.so.1") {
                let current: Option<unsafe extern "C" fn() -> *mut c_void> =
                    lib.get(b"eglGetCurrentContext").ok().map(|s| *s);
                if current.is_some_and(|f| !f().is_null()) {
                    egl = lib.get::<GetProc>(b"eglGetProcAddress").ok().map(|s| *s);
                }
                libs.push(lib);
            }
            if egl.is_none() {
                if let Ok(lib) = libloading::Library::new("libGL.so.1") {
                    glx = lib.get::<GetProc>(b"glXGetProcAddressARB").ok().map(|s| *s);
                    libs.push(lib);
                }
            }
        }
        let mut gl = Gl {
            _libs: libs,
            egl,
            glx,
            get_integer: None,
            clear_color: None,
            clear: None,
        };
        // SAFETY: the names are GL's, and each pointer is given its signature.
        unsafe {
            gl.get_integer =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glGetIntegerv"));
            gl.clear_color =
                std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glClearColor"));
            gl.clear = std::mem::transmute::<*mut c_void, Option<_>>(gl.find(c"glClear"));
        }
        gl
    })
}

impl Gl {
    fn find(&self, name: &CStr) -> *mut c_void {
        // SAFETY: a GL loader and a C string.
        unsafe {
            match (self.egl, self.glx) {
                (Some(egl), _) => egl(name.as_ptr()),
                (None, Some(glx)) => glx(name.as_ptr()),
                _ => std::ptr::null_mut(),
            }
        }
    }

    /// The framebuffer GTK has bound for the area to draw into.
    fn framebuffer(&self) -> c_int {
        const FRAMEBUFFER_BINDING: u32 = 0x8CA6;
        let mut fbo: c_int = 0;
        if let Some(get) = self.get_integer {
            // SAFETY: one integer's room for one integer.
            unsafe { get(FRAMEBUFFER_BINDING, &mut fbo) };
        }
        fbo
    }

    fn clear_transparent(&self) {
        const COLOR_BUFFER_BIT: u32 = 0x4000;
        if let (Some(color), Some(clear)) = (self.clear_color, self.clear) {
            // SAFETY: plain GL calls with the area's context current.
            unsafe {
                color(0.0, 0.0, 0.0, 0.0);
                clear(COLOR_BUFFER_BIT);
            }
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
