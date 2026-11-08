//! Whether Windows Firewall lets other devices reach a Basalt program, and
//! letting them: for the app, which listens for devices nearby (1.6.4).
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
            AllowError::Declined => f.write_str(
                "Windows did not allow it. Try again, and choose Yes when Windows asks.",
            ),
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
    #[cfg(not(windows))]
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
    #[cfg(not(windows))]
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
