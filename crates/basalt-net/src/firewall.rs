//! Whether the firewall lets other devices reach a Basalt program, and
//! letting them: for the app, which listens for devices nearby (1.6.4).
//!
//! On Linux it is a port, [`NEARBY_PORT`] (UDP for looks, TCP for the
//! files), in firewalld's zones or ufw's rules; letting it in goes through
//! `pkexec`, where the desktop asks for an administrator's password. A
//! computer with neither, or with both off, is open.
//!
//! Windows asks the first time a program listens, but not always: with
//! notifications off for the network's kind, it turns every connection away
//! without a word. The app looks for itself, and when it is shut out, says
//! so and offers one rule letting it in, added after Windows asks for an
//! administrator's say-so. (Basalt Host has its own, in its crate.)
//!
//! The rule covers private networks, public ones, and whichever the computer
//! is on: a device's own Wi-Fi (two devices with no network in common) is
//! one Windows can't place, so it counts as public. The app listens only
//! while it is ready for nearby devices or offering files, and lets in only
//! what proves itself (TLS pinned to a key, a one-time secret, a code).

/// The port the app listens on for devices nearby: looks (UDP) and, where
/// it is free, the files (TCP).
pub const NEARBY_PORT: u16 = 7745;

/// What the firewall does with connections to the program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Firewall {
    Open,
    Blocked,
    Unknown,
}

impl Firewall {
    pub fn as_str(self) -> &'static str {
        match self {
            Firewall::Open => "open",
            Firewall::Blocked => "blocked",
            Firewall::Unknown => "unknown",
        }
    }
}

/// Why letting it through did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowError {
    /// Windows asked, and the answer was no.
    Declined,
    /// It was tried, and failed.
    Failed(String),
}

impl std::fmt::Display for AllowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AllowError::Declined if cfg!(windows) => f.write_str(
                "Windows did not allow it. Try again, and choose Yes when Windows asks.",
            ),
            AllowError::Declined => {
                f.write_str("It was not allowed. Try again, and enter your password when asked.")
            }
            AllowError::Failed(why) => write!(f, "The firewall could not be changed: {why}"),
        }
    }
}

/// Whether the firewall lets other devices reach `exe`, on the networks the
/// computer is on now and on public ones.
pub fn check(exe: &std::path::Path) -> Firewall {
    #[cfg(windows)]
    {
        windows::check(exe)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = exe;
        linux::check(NEARBY_PORT)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = exe;
        Firewall::Open
    }
}

/// Lets other devices reach `exe` as `name`, after Windows asks for an
/// administrator, and says what the firewall does now.
pub fn allow(exe: &std::path::Path, name: &str, description: &str) -> Result<Firewall, AllowError> {
    #[cfg(windows)]
    {
        windows::allow(exe, name, description)?;
        Ok(windows::check(exe))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (exe, description);
        linux::allow(NEARBY_PORT, name)?;
        Ok(linux::check(NEARBY_PORT))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (exe, name, description);
        Ok(Firewall::Open)
    }
}

/// A PowerShell string literal: single-quoted, with its quotes doubled.
#[cfg_attr(not(windows), allow(dead_code))]
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Prints `open`, `blocked` or `unknown`: for each kind of network the
/// computer is on, and Public, a firewall that is on and turns connections
/// away by default needs a rule letting the program in; one turning it away
/// wins over any that lets it in.
#[cfg_attr(not(windows), allow(dead_code))]
fn check_script(exe: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $exe = {exe}
  $kinds = @('Public') + @(Get-NetConnectionProfile | ForEach-Object {{
    $c = $_.NetworkCategory.ToString(); if ($c -eq 'DomainAuthenticated') {{ 'Domain' }} else {{ $c }} }}) | Select-Object -Unique
  $mine = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -PolicyStore ActiveStore |
    Where-Object {{ $_ -and "$($_.Enabled)" -eq 'True' -and "$($_.Direction)" -eq 'Inbound' }})
  foreach ($kind in $kinds) {{
    $fw = Get-NetFirewallProfile -PolicyStore ActiveStore -Name $kind
    if ("$($fw.Enabled)" -ne 'True') {{ continue }}
    $inKind = @($mine | Where-Object {{ $p = "$($_.Profile)"; $p -eq 'Any' -or ($p -split ', ') -contains $kind }})
    if (@($inKind | Where-Object {{ "$($_.Action)" -eq 'Block' }}).Count -gt 0) {{ 'blocked'; exit }}
    if ("$($fw.DefaultInboundAction)" -eq 'Allow') {{ continue }}
    if (@($inKind | Where-Object {{ "$($_.Action)" -eq 'Allow' }}).Count -eq 0) {{ 'blocked'; exit }}
  }}
  'open'
}} catch {{ 'unknown' }}
"#,
        exe = literal(exe),
    )
}

/// Run as administrator: the program's own inbound rules (one left by an
/// earlier "no" would win) are replaced by one letting it in.
#[cfg_attr(not(windows), allow(dead_code))]
fn allow_script(exe: &str, name: &str, description: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $exe = {exe}
  $kinds = @('Private', 'Public') + @(Get-NetConnectionProfile | ForEach-Object {{
    $c = $_.NetworkCategory.ToString(); if ($c -eq 'DomainAuthenticated') {{ 'Domain' }} else {{ $c }} }}) | Select-Object -Unique
  Get-NetFirewallApplicationFilter -PolicyStore PersistentStore -Program $exe -ErrorAction SilentlyContinue |
    Get-NetFirewallRule | Where-Object {{ $_.Direction.ToString() -eq 'Inbound' }} | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName {name} -Description {description} `
    -Direction Inbound -Action Allow -Program $exe -Profile $kinds -Enabled True | Out-Null
  exit 0
}} catch {{ exit 1 }}
"#,
        exe = literal(exe),
        name = literal(name),
        description = literal(description),
    )
}

/// Run as the user: starts `inner` as administrator, where Windows asks, and
/// waits. 1223 is Windows' own number for "the user said no".
#[cfg_attr(not(windows), allow(dead_code))]
fn elevate_script(inner: &str) -> String {
    format!(
        r#"try {{
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
    -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',{encoded}
  exit $p.ExitCode
}} catch {{ exit 1223 }}
"#,
        encoded = literal(&encode_command(inner)),
    )
}

/// What `-EncodedCommand` takes: the script as UTF-16LE, in base64.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_command(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The zones firewalld has in use, from `firewall-cmd --get-active-zones`
/// ("public" then its "  interfaces: wlp2s0" lines).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn active_zones(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.is_empty() && !l.starts_with(char::is_whitespace))
        .map(|l| l.trim().to_string())
        .collect()
}

/// Whether a zone's `--list-ports` lets `port` in over both TCP and UDP
/// ("7745/tcp 1025-65535/udp").
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ports_let_in(text: &str, port: u16) -> bool {
    let covers = |proto: &str| {
        text.split_whitespace().any(|entry| {
            let Some((range, p)) = entry.split_once('/') else {
                return false;
            };
            if p != proto {
                return false;
            }
            let (low, high) = range.split_once('-').unwrap_or((range, range));
            matches!((low.parse::<u16>(), high.parse::<u16>()), (Ok(l), Ok(h)) if l <= port && port <= h)
        })
    };
    covers("tcp") && covers("udp")
}

/// Whether ufw is on, from its `/etc/ufw/ufw.conf`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ufw_enabled(conf: &str) -> bool {
    conf.lines()
        .map(str::trim)
        .any(|l| l.eq_ignore_ascii_case("ENABLED=yes"))
}

/// Whether ufw turns connections away unless a rule lets them in, from
/// `/etc/default/ufw`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ufw_drops(defaults: &str) -> bool {
    defaults
        .lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("DEFAULT_INPUT_POLICY="))
        .map(|v| v.trim_matches('"') != "ACCEPT")
        .unwrap_or(true)
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::PathBuf;
    use std::process::Command;

    use super::{AllowError, Firewall};

    fn run(program: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(program)
            .args(args)
            .env("LC_ALL", "C")
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).to_string())
    }

    fn firewalld_running() -> bool {
        run("firewall-cmd", &["--state"]).is_some_and(|s| s.trim() == "running")
    }

    /// ufw's rules can only be read by root: the app remembers the port it
    /// let in, here.
    fn ufw_mark() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(config.join("basalt").join("ufw-allowed"))
    }

    pub fn check(port: u16) -> Firewall {
        if firewalld_running() {
            let Some(zones) = run("firewall-cmd", &["--get-active-zones"]) else {
                return Firewall::Unknown;
            };
            let zones = super::active_zones(&zones);
            if zones.is_empty() {
                return Firewall::Unknown;
            }
            for zone in zones {
                if zone == "trusted" {
                    continue;
                }
                let Some(ports) = run("firewall-cmd", &[&format!("--zone={zone}"), "--list-ports"])
                else {
                    return Firewall::Unknown;
                };
                if !super::ports_let_in(&ports, port) {
                    return Firewall::Blocked;
                }
            }
            return Firewall::Open;
        }
        let conf = std::fs::read_to_string("/etc/ufw/ufw.conf").unwrap_or_default();
        if super::ufw_enabled(&conf) {
            let defaults = std::fs::read_to_string("/etc/default/ufw").unwrap_or_default();
            if !super::ufw_drops(&defaults) {
                return Firewall::Open;
            }
            let marked = ufw_mark()
                .and_then(|m| std::fs::read_to_string(m).ok())
                .is_some_and(|m| m.trim() == port.to_string());
            return if marked {
                Firewall::Open
            } else {
                Firewall::Blocked
            };
        }
        Firewall::Open
    }

    /// `pkexec` says 126 when the person dismissed it or was not allowed.
    fn as_admin(script: &str) -> Result<(), AllowError> {
        let status = Command::new("pkexec")
            .args(["/bin/sh", "-c", script])
            .status()
            .map_err(|_| {
                AllowError::Failed("this computer has no pkexec to ask for a password".into())
            })?;
        match status.code() {
            Some(0) => Ok(()),
            Some(126) => Err(AllowError::Declined),
            other => Err(AllowError::Failed(format!(
                "it ended with {}",
                other.map_or("no code".to_string(), |c| c.to_string())
            ))),
        }
    }

    pub fn allow(port: u16, name: &str) -> Result<(), AllowError> {
        if firewalld_running() {
            let zones = run("firewall-cmd", &["--get-active-zones"])
                .map(|z| super::active_zones(&z))
                .unwrap_or_default();
            let zones = if zones.is_empty() {
                vec![String::new()]
            } else {
                zones
            };
            let mut script = String::new();
            for zone in zones {
                let zone = if zone.is_empty() {
                    String::new()
                } else {
                    format!("--zone='{zone}' ")
                };
                script.push_str(&format!(
                    "firewall-cmd --permanent {zone}--add-port={port}/tcp --add-port={port}/udp && "
                ));
            }
            script.push_str("firewall-cmd --reload");
            return as_admin(&script);
        }
        let name: String = name
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect();
        as_admin(&format!("ufw allow {port} comment '{name}'"))?;
        if let Some(mark) = ufw_mark() {
            if let Some(dir) = mark.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(mark, port.to_string());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    use super::{AllowError, Firewall};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn powershell(script: &str) -> std::io::Result<std::process::Output> {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
            ])
            .arg(super::encode_command(script))
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    pub fn check(exe: &Path) -> Firewall {
        let Ok(output) = powershell(&super::check_script(&exe.to_string_lossy())) else {
            return Firewall::Unknown;
        };
        match String::from_utf8_lossy(&output.stdout).trim() {
            "open" => Firewall::Open,
            "blocked" => Firewall::Blocked,
            _ => Firewall::Unknown,
        }
    }

    pub fn allow(exe: &Path, name: &str, description: &str) -> Result<(), AllowError> {
        let inner = super::allow_script(&exe.to_string_lossy(), name, description);
        let output = powershell(&super::elevate_script(&inner))
            .map_err(|e| AllowError::Failed(e.to_string()))?;
        match output.status.code() {
            Some(0) => Ok(()),
            Some(1223) => Err(AllowError::Declined),
            other => Err(AllowError::Failed(format!(
                "it ended with {}",
                other.map_or("no code".to_string(), |c| c.to_string())
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firewalld_zones_in_use() {
        let text = "FedoraWorkstation\n  interfaces: wlp2s0\npublic\n  interfaces: enp3s0\n";
        assert_eq!(active_zones(text), vec!["FedoraWorkstation", "public"]);
        assert!(active_zones("").is_empty());
    }

    #[test]
    fn a_zone_lets_the_port_in_over_both() {
        assert!(ports_let_in("7745/tcp 7745/udp", NEARBY_PORT));
        // Fedora Workstation's own zone.
        assert!(ports_let_in("1025-65535/udp 1025-65535/tcp", NEARBY_PORT));
        assert!(!ports_let_in("7745/udp", NEARBY_PORT), "TCP too");
        assert!(!ports_let_in("22/tcp 8000-7000/udp", NEARBY_PORT));
        assert!(!ports_let_in("", NEARBY_PORT));
    }

    #[test]
    fn ufw_on_and_turning_away() {
        assert!(ufw_enabled("# comment\nENABLED=yes\nLOGLEVEL=low\n"));
        assert!(!ufw_enabled("ENABLED=no\n"));
        assert!(ufw_drops("DEFAULT_INPUT_POLICY=\"DROP\"\n"));
        assert!(!ufw_drops("DEFAULT_INPUT_POLICY=\"ACCEPT\"\n"));
        assert!(ufw_drops(""), "unknown: turned away");
    }

    #[test]
    fn the_command_is_encoded_as_powershell_wants() {
        // PowerShell's own -EncodedCommand example gives this for "dir".
        assert_eq!(encode_command("dir"), "ZABpAHIA");
    }

    #[test]
    fn the_rule_lets_the_program_in_on_private_and_public_networks() {
        let script = allow_script(
            r"C:\Users\O'Neil\Basalt\basalt.exe",
            "Basalt",
            "Devices nearby",
        );
        assert!(script.contains(r"$exe = 'C:\Users\O''Neil\Basalt\basalt.exe'"));
        assert!(script.contains("-Direction Inbound -Action Allow -Program $exe"));
        assert!(script.contains("@('Private', 'Public')"));
        let outer = elevate_script(&script);
        assert!(outer.contains("-Verb RunAs"));
        assert!(!outer.contains("New-NetFirewallRule"), "travels encoded");
        assert!(
            check_script(r"C:\x.exe").contains("@('Public')"),
            "public is checked too"
        );
    }
}
