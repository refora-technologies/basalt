//! Whether the computer's firewall lets other devices reach this host, and
//! letting them.
//!
//! On Windows the host has always relied on the firewall asking, the first
//! time it listened, whether to let it through. Windows does not always ask:
//! with notifications turned off for the network's profile, it turns every
//! connection away without a word. The host's own computer still connects,
//! over its loopback, so nothing looks wrong there; a phone sees the host in
//! its list, from the host's announcements, and cannot open it.
//!
//! So the host looks for itself, and when it is shut out, says so and offers
//! to fix it: one rule letting Basalt Host in, added after Windows asks for an
//! administrator's say-so, as only an administrator may.
//!
//! The looking is done by PowerShell's firewall commands rather than the COM
//! interfaces behind them: they answer with the same English names on every
//! Windows, whatever its language, and need nothing added to the build. It
//! takes a second or two, so it is never on the window's thread.
//!
//! Elsewhere there is nothing to do: the Linux packages carry their own
//! firewall rules, and the answer is always [`Firewall::Open`].

use std::path::Path;

use serde::Serialize;

/// What the firewall does with connections to this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Firewall {
    /// Other devices can connect, as far as the firewall goes.
    Open,
    /// Connections from other devices are turned away.
    Blocked,
    /// It could not be told; nothing is said about it.
    Unknown,
}

/// Why letting the host through did not happen.
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
            AllowError::Declined => f.write_str(
                "Windows did not allow it. Try again, and choose Yes when Windows asks.",
            ),
            AllowError::Failed(why) => write!(f, "The firewall could not be changed: {why}"),
        }
    }
}

/// Whether the firewall lets other devices reach `exe` listening on `port`.
pub fn check(exe: &Path, port: u16) -> Firewall {
    #[cfg(windows)]
    {
        windows::check(exe, port)
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, port);
        Firewall::Open
    }
}

/// Lets other devices reach `exe`, after Windows asks for an administrator,
/// and says what the firewall does now.
pub fn allow(exe: &Path, port: u16) -> Result<Firewall, AllowError> {
    #[cfg(windows)]
    {
        windows::allow(exe)?;
        Ok(windows::check(exe, port))
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, port);
        Ok(Firewall::Open)
    }
}

/// A PowerShell string literal: single-quoted, with its quotes doubled.
#[cfg_attr(not(windows), allow(dead_code))]
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The script that looks, for `exe` on `port`. Prints `open`, `blocked` or
/// `unknown`.
///
/// For each kind of network the computer is on now: a firewall that is off,
/// or lets everything in, is open; a rule turning the host away is blocked,
/// whatever else allows it, as Windows itself decides; otherwise it needs a
/// rule letting the host in, by its program or by its port.
#[cfg_attr(not(windows), allow(dead_code))]
fn check_script(exe: &str, port: u16) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $exe = {exe}
  $port = '{port}'
  $kinds = @(Get-NetConnectionProfile | ForEach-Object {{
    $c = $_.NetworkCategory.ToString(); if ($c -eq 'DomainAuthenticated') {{ 'Domain' }} else {{ $c }} }} | Select-Object -Unique)
  if ($kinds.Count -eq 0) {{ 'unknown'; exit }}
  # Nothing found comes through as one empty value, which is passed over.
  $inbound = {{ param($rules) @($rules | Where-Object {{ $_ -and "$($_.Enabled)" -eq 'True' -and "$($_.Direction)" -eq 'Inbound' }}) }}
  $mine = @(& $inbound (Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -PolicyStore ActiveStore))
  $byPort = @(& $inbound (Get-NetFirewallPortFilter -PolicyStore ActiveStore -Protocol TCP -ErrorAction SilentlyContinue | Where-Object {{ @($_.LocalPort) -contains $port }} | Get-NetFirewallRule -PolicyStore ActiveStore))
  foreach ($kind in $kinds) {{
    $fw = Get-NetFirewallProfile -PolicyStore ActiveStore -Name $kind
    if ("$($fw.Enabled)" -ne 'True') {{ continue }}
    $here = @($mine + $byPort | Where-Object {{ $p = "$($_.Profile)"; $_ -and ($p -eq 'Any' -or ($p -split ', ') -contains $kind) }})
    if (@($here | Where-Object {{ "$($_.Action)" -eq 'Block' }}).Count -gt 0) {{ 'blocked'; exit }}
    if ("$($fw.DefaultInboundAction)" -eq 'Allow') {{ continue }}
    if (@($here | Where-Object {{ "$($_.Action)" -eq 'Allow' }}).Count -eq 0) {{ 'blocked'; exit }}
  }}
  'open'
}} catch {{ 'unknown' }}
"#,
        exe = literal(exe),
    )
}

/// The script run as administrator: Basalt Host's own inbound rules are
/// replaced by one that lets it in, on private networks and on whichever
/// kinds the computer is on now. A rule left by an earlier answer of "no" is
/// among those replaced, as it would otherwise win.
#[cfg_attr(not(windows), allow(dead_code))]
fn allow_script(exe: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $exe = {exe}
  $kinds = @('Private') + @(Get-NetConnectionProfile | ForEach-Object {{
    $c = $_.NetworkCategory.ToString(); if ($c -eq 'DomainAuthenticated') {{ 'Domain' }} else {{ $c }} }}) | Select-Object -Unique
  Get-NetFirewallApplicationFilter -PolicyStore PersistentStore -Program $exe -ErrorAction SilentlyContinue |
    Get-NetFirewallRule | Where-Object {{ $_.Direction.ToString() -eq 'Inbound' }} | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName 'Basalt Host' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'Basalt Host' -Description 'Lets your other devices reach the drive this computer shares.' `
    -Direction Inbound -Action Allow -Program $exe -Profile $kinds -Enabled True | Out-Null
  exit 0
}} catch {{ exit 1 }}
"#,
        exe = literal(exe),
    )
}

/// The script run as the user: starts [`allow_script`] as administrator,
/// which is where Windows asks, and waits for it. 1223 is Windows' own
/// number for "the user said no".
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

/// What `-EncodedCommand` takes: the script as UTF-16LE, in base64. Passed
/// that way, nothing in it needs quoting for the command line.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

#[cfg(windows)]
mod windows {
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    use super::{AllowError, Firewall};

    /// No console window flashing up over the host's.
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

    pub fn check(exe: &Path, port: u16) -> Firewall {
        let script = super::check_script(&exe.to_string_lossy(), port);
        let Ok(output) = powershell(&script) else {
            return Firewall::Unknown;
        };
        match String::from_utf8_lossy(&output.stdout).trim() {
            "open" => Firewall::Open,
            "blocked" => Firewall::Blocked,
            _ => Firewall::Unknown,
        }
    }

    pub fn allow(exe: &Path) -> Result<(), AllowError> {
        let inner = super::allow_script(&exe.to_string_lossy());
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
    fn base64_is_the_standard_one() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // What PowerShell's own -EncodedCommand example gives for "dir".
        assert_eq!(encode_command("dir"), "ZABpAHIA");
    }

    #[test]
    fn a_path_with_a_quote_cannot_end_the_string_early() {
        assert_eq!(
            literal(r"C:\Users\O'Neil\x.exe"),
            r"'C:\Users\O''Neil\x.exe'"
        );
        let script = check_script(r"C:\Users\O'Neil\Basalt Host\basalt-host-shell.exe", 7742);
        assert!(script.contains(r"$exe = 'C:\Users\O''Neil\Basalt Host\basalt-host-shell.exe'"));
        assert!(script.contains("$port = '7742'"));
    }

    #[test]
    fn the_rule_lets_the_program_in_and_nothing_wider() {
        let script = allow_script(r"C:\Program Files\Basalt Host\basalt-host-shell.exe");
        assert!(script.contains("-Direction Inbound -Action Allow -Program $exe"));
        assert!(script.contains("@('Private')"));
        assert!(!script.contains("-Profile Any"));
        // The elevated script travels encoded, so its quotes never meet the
        // command line.
        let outer = elevate_script(&script);
        assert!(outer.contains("-Verb RunAs"));
        assert!(!outer.contains("New-NetFirewallRule"));
    }

    // Asks this computer's firewall, read only. Ignored by default, as the
    // answer depends on the machine: run it by hand after changing the script.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_check_runs_on_this_computer() {
        let exe = std::env::var("BASALT_FIREWALL_EXE").unwrap_or_else(|_| {
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        });
        let state = check(Path::new(&exe), 7742);
        println!("{exe}: {state:?}");
        assert_ne!(state, Firewall::Unknown);
    }

    #[cfg(not(windows))]
    #[test]
    fn elsewhere_there_is_nothing_to_do() {
        assert_eq!(
            check(Path::new("/usr/bin/basalt-host"), 7742),
            Firewall::Open
        );
    }
}
