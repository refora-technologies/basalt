//! `basalt-host` — Basalt Host with no screen.
//!
//! The same host as the desktop app, without its window: run as a service on
//! a Linux box, a Raspberry Pi or a NAS, or in a Docker container. Everything
//! the window does is done from the Basalt app instead, with Manage host, by
//! the device that manages the host. The first such device is let in with a
//! setup code this program writes in its log; see `basalt_host::setup`.
//!
//! The commands besides `serve` are for the person at the machine: the setup
//! code, what is shared, how things stand. None of them edits the host's
//! config while it runs, which the running host would overwrite.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use basalt_host::config::{self, HostConfig};
use basalt_host::server::{self, Host};
use basalt_host::setup;
use basalt_net::identity::short_id;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "basalt-host",
    about = "Basalt Host with no screen: shares a drive with your devices on this network",
    version
)]
struct Cli {
    /// The host's config file. Also `BASALT_HOST_CONFIG`. By default the
    /// service's (/var/lib/basalt-host/host.json) where there is one, else
    /// this user's.
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the host (the default). Stops on Ctrl-C or when the service stops.
    Serve {
        /// The port devices connect to. The one in the config otherwise
        /// (7742 unless changed).
        #[arg(long)]
        port: Option<u16>,
    },

    /// Show the setup code, which lets your first device set up and manage
    /// this host.
    SetupCode {
        /// Make a new code even though devices already manage the host: for
        /// when the device that managed it is lost. The next device to pair
        /// with it manages the host too.
        #[arg(long)]
        reset: bool,
    },

    /// Choose the drive or folder the host shares. Only while it is stopped:
    /// while it runs, choose it from the Basalt app, in Manage host.
    Share {
        /// The folder, for example /srv/media.
        path: PathBuf,
        /// What devices call it. The folder's own name otherwise.
        #[arg(long, short)]
        name: Option<String>,
    },

    /// Show whether the host is running, its address, what it shares, its
    /// devices, and the setup code while it waits to be set up.
    Status {
        /// Wait a few seconds for a host just started to answer: for the
        /// package's install script, which shows this as its last word.
        #[arg(long, hide = true)]
        wait: bool,
    },

    /// Exit 0 if the host answers on its port; for Docker's healthcheck.
    Health {
        #[arg(long, default_value_t = basalt_net::DEFAULT_PORT)]
        port: u16,
    },

    /// Start the basalt-host service, and say when it is running.
    Start,

    /// Stop the basalt-host service until it is started again or the
    /// computer restarts.
    Stop,

    /// Restart the basalt-host service, and say when it is back.
    Restart,

    /// Update to the newest version now, where this host can update itself.
    Update,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let config_path = cli
        .config
        .or_else(|| std::env::var_os("BASALT_HOST_CONFIG").map(PathBuf::from))
        .unwrap_or_else(default_config_path);

    let command = cli.command.unwrap_or(Command::Serve { port: None });
    // Piped into `head` or a pager that stops reading, a command stops quietly,
    // as command-line tools do, rather than panicking over the closed pipe.
    // Not `serve`: there a closed socket must stay an error to handle.
    #[cfg(unix)]
    if !matches!(command, Command::Serve { .. }) {
        // SAFETY: restoring a signal's default action has no preconditions.
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        }
    }
    let outcome = match command {
        Command::Serve { port } => serve(config_path, port).await,
        Command::SetupCode { reset } => setup_code(&config_path, reset),
        Command::Share { path, name } => share(&config_path, &path, name),
        Command::Status { wait } => status(&config_path, wait),
        Command::Health { port } => health(port).await,
        Command::Start => service(&config_path, Action::Start),
        Command::Stop => service(&config_path, Action::Stop),
        Command::Restart => service(&config_path, Action::Restart),
        Command::Update => update(&config_path),
    };
    if let Err(e) = outcome {
        eprintln!("basalt-host: {e:#}");
        std::process::exit(1);
    }
}

/// The service's config where there is one, so `sudo basalt-host setup-code`
/// finds the host the service runs; this user's otherwise.
fn default_config_path() -> PathBuf {
    let service = PathBuf::from("/var/lib/basalt-host/host.json");
    if cfg!(target_os = "linux") && service.parent().is_some_and(Path::exists) {
        return service;
    }
    config::default_path()
}

/// The host's config, as it is: never made here, outside `serve`.
fn existing(config_path: &Path) -> Result<HostConfig> {
    // The service's settings are its own user's alone: not missing, just
    // not this user's to read.
    if let Err(e) = std::fs::metadata(config_path)
        && e.kind() == std::io::ErrorKind::PermissionDenied
    {
        bail!("only the host's own user can read its settings. Run it with sudo.");
    }
    if !config_path.exists() {
        bail!(
            "there is no host at {} yet. Start it first (`basalt-host serve`, or the \
             basalt-host service), or say where it is with --config.",
            config_path.display()
        );
    }
    HostConfig::load_or_create(config_path, &config::machine_name()).with_context(|| {
        format!(
            "reading {} (as root, or as the host's own user?)",
            config_path.display()
        )
    })
}

async fn serve(config_path: PathBuf, port: Option<u16>) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "basalt_host=info,basalt_net=info,warn".into()),
        )
        .with_target(false)
        // journald and `docker logs` keep the text as written: colours only
        // for a person watching a terminal.
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .init();

    // In a container the machine's name is a random id: `BASALT_HOST_NAME`
    // names it the first time instead. Manage host renames it any time.
    let name = std::env::var("BASALT_HOST_NAME")
        .ok()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(config::machine_name);
    let mut config = HostConfig::load_or_create(&config_path, &name)
        .with_context(|| format!("reading {}", config_path.display()))?;
    if let Some(port) = port {
        config.port = port;
    }
    let port = config.port;
    tracing::info!(
        "Basalt Host {} starting, with no screen; config {}",
        env!("CARGO_PKG_VERSION"),
        config_path.display()
    );

    let host = Host::new(config, config_path.clone())?;
    host.set_headless(true);
    host.start_updates();
    // The system's ffmpeg converts video for devices that cannot play it.
    if let Some(dir) = config_path.parent()
        && let Some(ffmpeg) = basalt_host::convert::find_ffmpeg(dir)
    {
        tracing::info!("converting video with {}", ffmpeg.display());
        host.converter.use_ffmpeg(ffmpeg);
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let bound = server::bind(Arc::clone(&host), addr)
        .await
        .with_context(|| {
            format!("could not listen on port {port}; is another Basalt Host running?")
        })?;
    describe(&host, port);

    if host.in_setup() {
        // Said every start until it is used, so it is always in the newest
        // part of the log.
        match setup::read_code(&config_path) {
            Some(code) => tracing::info!("{}", setup::announcement(&code)),
            None => {
                host.setup_code()?;
            }
        }
    }

    tokio::select! {
        result = server::serve(bound) => result.context("sharing stopped")?,
        _ = stopped() => tracing::info!("stopping"),
    }
    Ok(())
}

/// Ctrl-C, or the service manager (or Docker) asking it to stop.
async fn stopped() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("a SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// What the log says first: which host this is and where it can be found.
fn describe(host: &Arc<Host>, port: u16) {
    let addresses: Vec<String> = basalt_net::discovery::local_addresses()
        .into_iter()
        .map(|ip| format!("{ip}:{port}"))
        .collect();
    tracing::info!(
        "{} (identity {}) is sharing {}, on {}",
        host.host_name(),
        short_id(host.host_id()),
        if host.has_drive() {
            host.vault_name()
        } else {
            "nothing yet".into()
        },
        if addresses.is_empty() {
            "no network yet".into()
        } else {
            addresses.join(", ")
        }
    );
    let managers = host.managers();
    if managers > 0 {
        tracing::info!(
            "{} device(s) paired, {managers} managing the host",
            host.devices().len()
        );
    }
}

fn setup_code(config_path: &Path, reset: bool) -> Result<()> {
    let config = existing(config_path)?;
    let managers = config.devices.iter().filter(|d| d.owner).count();
    let code = if reset {
        setup::new_code(config_path)?
    } else if managers > 0 && setup::read_code(config_path).is_none() {
        bail!(
            "this host is already set up: {managers} device(s) manage it, and new devices' \
             PINs show in their Manage host. If none of them is to hand any more, run \
             `basalt-host setup-code --reset` to let another device in as a manager."
        );
    } else {
        match setup::read_code(config_path) {
            Some(code) => code,
            None => setup::new_code(config_path)?,
        }
    };
    println!("{}", setup::announcement(&code));
    if reset && managers > 0 {
        println!(
            "  The host is in setup mode until a device pairs with this code, and that\n  \
             device will manage it too. Remove lost devices in Manage host afterwards.\n"
        );
    }
    Ok(())
}

fn share(config_path: &Path, path: &Path, name: Option<String>) -> Result<()> {
    let mut config = existing(config_path)?;
    // While the host runs it would write its own config over this one.
    if std::net::TcpListener::bind(("0.0.0.0", config.port)).is_err() {
        bail!(
            "the host is running. Choose what it shares from the Basalt app, in Manage \
             host, or stop it first."
        );
    }
    let path =
        std::fs::canonicalize(path).with_context(|| format!("{} is not there", path.display()))?;
    if !path.is_dir() {
        bail!("{} isn’t a folder", path.display());
    }
    let name = name.unwrap_or_else(|| {
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string())
    });
    config.vault_path = Some(path.clone());
    config.vault_name = name.clone();
    config.save(config_path)?;
    println!("Sharing {} as {name}.", path.display());
    Ok(())
}

/// What a person at the machine needs at a glance: whether the host runs,
/// where devices find it, the setup code while it waits for one, and what is
/// left to do here. Also the last thing installing the package shows.
fn status(config_path: &Path, wait: bool) -> Result<()> {
    if wait {
        wait_until_ready(config_path);
    }
    let config = existing(config_path)?;
    let style = Style::new();
    let running = answers(config.port);
    let set_up = config.devices.iter().any(|d| d.owner);
    let waiting = !set_up || setup::read_code(config_path).is_some();
    let service = config_path.starts_with("/var/lib/basalt-host");
    let container = in_container();

    println!();
    let (dot, state) = if running {
        (style.green("●"), "is running")
    } else {
        (style.red("●"), "is not running")
    };
    println!(
        "  {dot} {}",
        style.bold(&format!(
            "Basalt Host {} {state}",
            env!("CARGO_PKG_VERSION")
        ))
    );
    println!();

    let address = match basalt_net::discovery::local_addresses().first() {
        // A container on Docker's own network sees only its private address,
        // which no device can reach: the computer's is the one to use.
        Some(std::net::IpAddr::V4(ip))
            if container && ip.octets()[0] == 172 && (16..32).contains(&ip.octets()[1]) =>
        {
            format!("port {} on this computer's address", config.port)
        }
        Some(ip) => format!("{ip}:{}", config.port),
        None => "no network yet".into(),
    };
    let sharing = match &config.vault_path {
        Some(path) => format!("{} ({})", config.vault_name, path.display()),
        None => "nothing yet".into(),
    };
    let row = |label: &str, value: &str| {
        println!("    {}  {value}", style.dim(&format!("{label:<10}")));
    };
    row("Name", &config.host_name);
    row("Address", &address);
    row("Identity", &short_id(&config.identity()?.host_id));
    let method = basalt_host::updates::headless_method(config_path);
    let newer = basalt_host::updates::read_saved(config_path).available;
    let version = match &newer {
        Some(newer) if method.can_install() && config.automatic_updates => format!(
            "{}  {}",
            env!("CARGO_PKG_VERSION"),
            style.dim(&format!(
                "{newer} is out, and goes in by itself when nothing is playing"
            ))
        ),
        Some(newer) => format!(
            "{}  {}",
            env!("CARGO_PKG_VERSION"),
            style.dim(&format!("{newer} is out"))
        ),
        None => env!("CARGO_PKG_VERSION").to_string(),
    };
    row("Version", &version);
    row("Sharing", &sharing);
    if config.devices.is_empty() {
        row("Devices", "none yet");
    }
    for (i, device) in config.devices.iter().enumerate() {
        let label = if i == 0 { "Devices" } else { "" };
        let manages = if device.owner {
            style.dim("  manages the host")
        } else {
            String::new()
        };
        row(label, &format!("{}{manages}", device.name));
    }

    if waiting {
        println!();
        let code =
            setup::read_code(config_path).map(|c| basalt_net::pairing::format_setup_code(&c));
        let lines = [
            String::new(),
            match &code {
                Some(code) => format!("Setup code   {code}"),
                None => "Setup code   sudo basalt-host setup-code".into(),
            },
            String::new(),
            "Open Basalt on your phone or computer, on this".into(),
            format!(
                "network, choose \"{}\" and type the code.",
                config.host_name
            ),
            "That device will manage the host.".into(),
            String::new(),
        ];
        boxed(&style, "Set it up", &lines, code.as_deref());
    }

    let mut next: Vec<(&str, String)> = Vec::new();
    if !running {
        if service {
            next.push(("Start it", "sudo basalt-host start".into()));
        } else if !container {
            next.push(("Start it", "basalt-host serve".into()));
        }
    }
    if !container && let Some(command) = firewall_closed(config.port) {
        next.push(("Open the firewall", command));
    }
    if newer.is_some() {
        match method {
            basalt_host::updates::Method::Service => {
                next.push(("Update now", "sudo basalt-host update".into()))
            }
            basalt_host::updates::Method::Container => next.push((
                "Update",
                "docker compose pull && docker compose up -d".into(),
            )),
            _ => next.push((
                "Get the new version",
                "https://github.com/refora-technologies/basalt/releases/latest".into(),
            )),
        }
    }
    if config.vault_path.is_none() {
        if container {
            next.push(("Folders it can share", "those mounted under /media".into()));
        } else if service {
            next.push((
                "Let it read a folder",
                "sudo setfacl -R -m u:basalt:rwX -m d:u:basalt:rwX /srv/media".into(),
            ));
        }
    }
    if container {
        next.push(("Follow the log", "docker logs -f basalt".into()));
    } else if service {
        next.push(("Follow the log", "journalctl -u basalt-host -f".into()));
        next.push(("Help", "/usr/share/doc/basalt-host-server/README.md".into()));
    }
    if !next.is_empty() {
        println!();
        println!("  {}", style.bold("Next"));
        let width = next.iter().map(|(l, _)| l.len()).max().unwrap_or(0);
        for (label, command) in &next {
            println!("    {label:<width$}   {}", style.cyan(command));
        }
    }
    println!();
    Ok(())
}

/// Until a host just started answers, and has written its setup code if it
/// needs one: the install script asks before the service is quite up.
fn wait_until_ready(config_path: &Path) {
    let until = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < until {
        if let Ok(config) = existing(config_path)
            && answers(config.port)
            && (config.devices.iter().any(|d| d.owner) || setup::read_code(config_path).is_some())
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn answers(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok()
}

fn in_container() -> bool {
    std::env::var_os("BASALT_CONTAINER").is_some() || Path::new("/.dockerenv").exists()
}

/// The command that lets devices through the firewall, when one is on and has
/// no rule for the host yet. Only root can ask the firewall, so for anyone
/// else this says nothing rather than guess.
#[cfg(target_os = "linux")]
fn firewall_closed(port: u16) -> Option<String> {
    use std::process::{Command, Stdio};
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } != 0 {
        return None;
    }
    let run = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let port = port.to_string();
    if let Some(ufw) = run("ufw", &["status"]) {
        let closed =
            ufw.contains("Status: active") && !ufw.contains("Basalt Host") && !ufw.contains(&port);
        return closed.then(|| "sudo ufw allow \"Basalt Host\"".into());
    }
    if run("firewall-cmd", &["--state"]).is_some() {
        let open = run("firewall-cmd", &["--list-all"]).unwrap_or_default();
        if !open.contains("basalt-host") && !open.contains(&port) {
            return Some(
                "sudo firewall-cmd --permanent --add-service=basalt-host && sudo firewall-cmd \
                 --reload"
                    .into(),
            );
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn firewall_closed(_port: u16) -> Option<String> {
    None
}

/// Lines in a box under a title, with `highlight` drawn out wherever it is.
fn boxed(style: &Style, title: &str, lines: &[String], highlight: Option<&str>) {
    let widest = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    let inner = widest.max(title.chars().count() + 4) + 6;
    let rule = inner - title.chars().count() - 3;
    println!("  ┌─ {} {}┐", style.bold(title), "─".repeat(rule));
    for line in lines {
        let pad = inner - 3 - line.chars().count();
        let shown = match highlight {
            Some(h) if line.contains(h) => line.replace(h, &style.bold(&style.green(h))),
            _ => line.clone(),
        };
        println!("  │   {shown}{}│", " ".repeat(pad));
    }
    println!("  └{}┘", "─".repeat(inner));
}

/// Colour for a person at a terminal; plain text for logs, pipes, and anyone
/// who set NO_COLOR.
struct Style {
    on: bool,
}

impl Style {
    fn new() -> Self {
        Style {
            on: std::io::IsTerminal::is_terminal(&std::io::stdout())
                && std::env::var_os("NO_COLOR").is_none(),
        }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.on {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }

    fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }

    fn green(&self, text: &str) -> String {
        self.paint("32", text)
    }

    fn red(&self, text: &str) -> String {
        self.paint("31", text)
    }

    fn cyan(&self, text: &str) -> String {
        self.paint("36", text)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Start,
    Stop,
    Restart,
}

/// `systemctl` says nothing when it works, which leaves a person wondering
/// whether it did. This does the same through it, then waits to see the
/// host answer (or stop answering) and says so.
fn service(config_path: &Path, action: Action) -> Result<()> {
    let verb = match action {
        Action::Start => "start",
        Action::Stop => "stop",
        Action::Restart => "restart",
    };
    if in_container() {
        bail!(
            "in Docker, the container is the service: `docker {verb} basalt` (or your \
             container's name)."
        );
    }
    if !Path::new("/run/systemd/system").exists() {
        bail!(
            "there is no service manager here to {verb} it with. Run `basalt-host serve` \
             yourself instead."
        );
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    #[cfg(unix)]
    if unsafe { libc::geteuid() } != 0 {
        bail!("only root can {verb} the service. Run it with sudo.");
    }
    let style = Style::new();
    let port = existing(config_path)
        .map(|c| c.port)
        .unwrap_or(basalt_net::DEFAULT_PORT);
    let was_running = answers(port);
    if action == Action::Stop && !was_running {
        println!("  {} Basalt Host is already stopped.", style.dim("●"));
        return Ok(());
    }
    if action == Action::Start && was_running {
        println!("  {} Basalt Host is already running.", style.green("●"));
        return Ok(());
    }

    let ran = std::process::Command::new("systemctl")
        .args([verb, "basalt-host"])
        .status()
        .context("could not run systemctl")?;
    if !ran.success() {
        bail!("systemctl couldn’t {verb} it. `journalctl -u basalt-host -n 30` says why.");
    }

    let until = std::time::Instant::now() + Duration::from_secs(15);
    if action == Action::Stop {
        while answers(port) && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(200));
        }
        println!("  {} Basalt Host stopped.", style.red("●"));
        println!(
            "    Your devices show it as offline until it starts again: {}",
            style.cyan("sudo basalt-host start")
        );
        println!(
            "    It starts by itself when this computer restarts. To keep it off: {}",
            style.cyan("sudo systemctl disable basalt-host")
        );
        return Ok(());
    }

    while !answers(port) && std::time::Instant::now() < until {
        std::thread::sleep(Duration::from_millis(200));
    }
    if !answers(port) {
        bail!("it didn’t start within 15 seconds. `journalctl -u basalt-host -n 30` says why.");
    }
    let done = if action == Action::Start {
        "started"
    } else {
        "restarted"
    };
    let address = basalt_net::discovery::local_addresses()
        .first()
        .map(|ip| format!(" on {ip}:{port}"))
        .unwrap_or_default();
    println!(
        "  {} Basalt Host {done}, and is running{address}.",
        style.green("●")
    );
    println!("    Your devices reconnect by themselves.");
    Ok(())
}

/// Runs the update helper now, where the packaged service can update
/// itself; says what to do instead everywhere else.
fn update(config_path: &Path) -> Result<()> {
    use basalt_host::updates::{HELPER, Method};
    match basalt_host::updates::headless_method(config_path) {
        Method::Container => bail!(
            "in Docker, update by pulling the new image: docker compose pull && docker compose up -d"
        ),
        Method::Service => {}
        _ => bail!(
            "this copy was put in place by hand. Get the new version from https://github.com/refora-technologies/basalt/releases/latest"
        ),
    }
    #[cfg(unix)]
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } != 0 {
        bail!("only root can update Basalt Host. Run it with sudo.");
    }
    let style = Style::new();
    println!("  Looking for a new version…");
    let ran = std::process::Command::new(HELPER)
        .arg("--service")
        .output()
        .context("could not run the update helper")?;
    let said = String::from_utf8_lossy(&ran.stdout);
    let message = said
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if ran.status.success() {
        println!("  {} {message}", style.green("●"));
        Ok(())
    } else {
        bail!("{message}")
    }
}

async fn health(port: u16) -> Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => Ok(()),
        _ => bail!("nothing answers on port {port}"),
    }
}
