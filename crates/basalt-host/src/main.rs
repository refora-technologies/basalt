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

    /// Show the setup code, which lets the first device in to manage the host.
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

    /// How the host stands: its name, drive, devices and who manages it.
    Status,

    /// Exit 0 if the host answers on its port; for Docker's healthcheck.
    Health {
        #[arg(long, default_value_t = basalt_net::DEFAULT_PORT)]
        port: u16,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let config_path = cli
        .config
        .or_else(|| std::env::var_os("BASALT_HOST_CONFIG").map(PathBuf::from))
        .unwrap_or_else(default_config_path);

    let outcome = match cli.command.unwrap_or(Command::Serve { port: None }) {
        Command::Serve { port } => serve(config_path, port).await,
        Command::SetupCode { reset } => setup_code(&config_path, reset),
        Command::Share { path, name } => share(&config_path, &path, name),
        Command::Status => status(&config_path),
        Command::Health { port } => health(port).await,
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

    let mut config = HostConfig::load_or_create(&config_path, &config::machine_name())
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
        bail!("{} is not a folder", path.display());
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

fn status(config_path: &Path) -> Result<()> {
    let config = existing(config_path)?;
    let identity = config.identity()?;
    println!("  Basalt Host {}", env!("CARGO_PKG_VERSION"));
    println!("  name      {}", config.host_name);
    println!("  identity  {}", short_id(&identity.host_id));
    println!("  port      {}", config.port);
    match &config.vault_path {
        Some(path) => println!("  sharing   {} ({})", config.vault_name, path.display()),
        None => println!("  sharing   nothing yet"),
    }
    let managers: Vec<&str> = config
        .devices
        .iter()
        .filter(|d| d.owner)
        .map(|d| d.name.as_str())
        .collect();
    println!("  devices   {}", config.devices.len());
    for device in &config.devices {
        println!(
            "            {}{}",
            device.name,
            if device.owner {
                "  (manages the host)"
            } else {
                ""
            }
        );
    }
    if managers.is_empty() || setup::read_code(config_path).is_some() {
        println!("\n  Waiting to be set up: run `basalt-host setup-code` for the code.");
    }
    Ok(())
}

async fn health(port: u16) -> Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => Ok(()),
        _ => bail!("nothing answers on port {port}"),
    }
}
