//! Finding out whether a newer Basalt exists, and fetching it safely.
//!
//! Both apps ship from one repository, so one release carries two installers
//! and each app has to recognise its own — see [`Product`].
//!
//! **What is downloaded is verified before it is run.** A release publishes a
//! `.sha256` beside each installer, and an installer whose digest does not
//! match is deleted rather than offered. Anything less would make the update
//! path the easiest way to get code onto somebody's machine.
//!
//! Nothing here installs anything. It reports what is available, fetches it,
//! and hands back a path; starting an installer is the shell's business,
//! because only the shell knows how to close its own window first.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

mod version;
pub use version::{Version, is_newer};

/// Which installer out of a release belongs to this app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Product {
    /// The host with a window: Windows, and Linux desktops.
    Host,
    /// The host with no screen: the Linux server packages.
    HostServer,
    Client,
}

impl Product {
    /// The marker in an asset's filename.
    ///
    /// Matched on rather than the whole name so a release can rename its
    /// installers — for a version number, say — without every older copy of
    /// the app losing the ability to find them.
    fn marker(self) -> &'static str {
        match self {
            Product::Host => "host",
            Product::HostServer => "host-server",
            Product::Client => "client",
        }
    }

    /// Whether a file with this (lowercased) name is this product's. The
    /// host with a window and the one without both say "host": the window's
    /// never takes a server or Docker file, whatever order a release lists
    /// them in.
    fn owns(self, name: &str) -> bool {
        match self {
            Product::Host => {
                name.contains("host") && !name.contains("server") && !name.contains("docker")
            }
            other => name.contains(other.marker()),
        }
    }
}

/// What kind of file installs this build: an installer on Windows, a
/// package on Android, and on Linux whichever way this copy was installed.
/// One release carries them all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    Windows,
    Android,
    Linux(LinuxPackage),
}

/// How a copy on Linux was installed, which is how it is updated: an
/// AppImage replaces itself; a `.deb` or `.rpm` goes through the system's
/// package installer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxPackage {
    AppImage,
    Deb,
    Rpm,
    /// The screenless host's `.tar.gz`, copied into place by hand.
    Tarball,
}

impl LinuxPackage {
    /// How this copy was installed. An AppImage is told its own path in
    /// `APPIMAGE` when it runs; otherwise the package manager the system has
    /// says which kind of package it came from.
    pub fn here() -> LinuxPackage {
        if std::env::var_os("APPIMAGE").is_some() {
            LinuxPackage::AppImage
        } else if ["/usr/bin/dpkg", "/bin/dpkg"]
            .iter()
            .any(|p| std::path::Path::new(p).exists())
        {
            LinuxPackage::Deb
        } else if ["/usr/bin/rpm", "/bin/rpm"]
            .iter()
            .any(|p| std::path::Path::new(p).exists())
        {
            LinuxPackage::Rpm
        } else {
            LinuxPackage::AppImage
        }
    }

    fn extension(self) -> &'static str {
        match self {
            LinuxPackage::AppImage => ".appimage",
            LinuxPackage::Deb => ".deb",
            LinuxPackage::Rpm => ".rpm",
            LinuxPackage::Tarball => ".tar.gz",
        }
    }
}

impl Platform {
    fn here() -> Platform {
        if cfg!(target_os = "android") {
            Platform::Android
        } else if cfg!(target_os = "linux") {
            Platform::Linux(LinuxPackage::here())
        } else {
            Platform::Windows
        }
    }
}

/// The marker and extension of this app's file on a platform. The Android
/// app is the client; there is no Android host.
fn wanted(platform: Platform) -> &'static str {
    match platform {
        Platform::Windows => ".exe",
        Platform::Android => ".apk",
        Platform::Linux(package) => package.extension(),
    }
}

/// The names this machine's processor goes by in a Linux file name.
fn arch_names() -> &'static [&'static str] {
    match std::env::consts::ARCH {
        "x86_64" => &["x86_64", "amd64"],
        "aarch64" => &["aarch64", "arm64"],
        _ => &[],
    }
}

/// Where releases are published.
pub const OWNER: &str = "refora-technologies";
pub const REPO: &str = "basalt";

/// How long any one request may take to begin answering.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a download may deliver nothing at all before it is given up on.
///
/// A stall timeout rather than a deadline on the whole transfer: the client
/// installer is thirty-five megabytes and some connections are genuinely
/// slow, so any total limit generous enough to be fair is far too long to be
/// useful. What is never legitimate is a socket that has stopped sending.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("could not reach GitHub: {0}")]
    Network(String),
    #[error("GitHub answered {0}")]
    Status(u16),
    #[error("the release could not be read: {0}")]
    Malformed(String),
    #[error("this release has no installer for this app")]
    NoInstaller,
    #[error("the download did not match its checksum and was discarded")]
    ChecksumMismatch,
    #[error("the download stopped part way and did not resume")]
    Stalled,
    #[error("{0}")]
    Io(String),
}

type Result<T> = std::result::Result<T, UpdateError>;

/// A release newer than what is running.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// `1.2.0`, without the leading `v`.
    pub version: String,
    /// What the release notes say, as written.
    pub notes: String,
    /// The release page, for anyone who would rather read it there.
    pub page_url: String,
    pub installer_name: String,
    pub installer_url: String,
    pub installer_bytes: u64,
    /// The published digest. Absent means the download cannot be verified,
    /// which [`fetch`] treats as a refusal rather than a warning.
    pub checksum_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct GhAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

fn client() -> Result<reqwest::Client> {
    // reqwest is built on `rustls-no-provider`, which *panics* rather than
    // errors when no process-wide provider has been installed. The shells
    // install one the moment they talk to a host, but checking for an update
    // does not need a host — so this crate cannot assume somebody else went
    // first. `init_crypto` is idempotent, so calling it here costs nothing
    // beyond a `Once`.
    basalt_net::tls::init_crypto();

    let builder = reqwest::Client::builder();
    // Android: the certificates the system trusts, read from where it keeps
    // them. reqwest otherwise asks the platform to verify, which on Android
    // needs a Java component set up before any request — and without it the
    // update check panics rather than failing.
    #[cfg(target_os = "android")]
    let builder = builder.tls_certs_only(android_roots());

    builder
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("Basalt/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| UpdateError::Network(e.to_string()))
}

/// The newest published release, or `None` when it is not newer than `current`.
pub async fn check(product: Product, current: &str) -> Result<Option<Release>> {
    check_on(product, current, Platform::here()).await
}

/// [`check`], for a Linux copy installed as `package`: for the update helper,
/// which knows how the host it updates was installed rather than guessing it
/// from how it was itself started.
pub async fn check_linux(
    product: Product,
    current: &str,
    package: LinuxPackage,
) -> Result<Option<Release>> {
    check_on(product, current, Platform::Linux(package)).await
}

async fn check_on(product: Product, current: &str, platform: Platform) -> Result<Option<Release>> {
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/releases/latest");
    let response = client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| UpdateError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Err(UpdateError::Status(response.status().as_u16()));
    }
    let release: GhRelease = response
        .json()
        .await
        .map_err(|e| UpdateError::Malformed(e.to_string()))?;

    Ok(newer_than_on(release, product, current, platform))
}

/// The release notes of one published version, or `None` when GitHub has no
/// release of that version.
///
/// For the Play build, where Play says which version is available and its
/// notes are read from the GitHub release of the same number. A version Play
/// carries that was never released on GitHub (a test step) simply has none.
pub async fn notes_for(version: &str) -> Result<Option<String>> {
    let tag = format!("v{}", version.trim_start_matches('v'));
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/releases/tags/{tag}");
    let response = client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| UpdateError::Network(e.to_string()))?;

    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(UpdateError::Status(response.status().as_u16()));
    }
    let release: GhRelease = response
        .json()
        .await
        .map_err(|e| UpdateError::Malformed(e.to_string()))?;
    if release.draft || release.prerelease {
        return Ok(None);
    }
    Ok(Some(release.body.trim().to_string()).filter(|body| !body.is_empty()))
}

/// Turns a release into an offer, or nothing when there is nothing to offer.
///
/// Separated from the request so the decision is testable without a network:
/// which release counts, which asset belongs to this app, and whether the
/// version is actually an advance.
fn newer_than_on(
    release: GhRelease,
    product: Product,
    current: &str,
    platform: Platform,
) -> Option<Release> {
    // A draft is not published and a prerelease was not offered to everyone.
    if release.draft || release.prerelease {
        return None;
    }
    if !is_newer(&release.tag_name, current) {
        return None;
    }

    let installer = pick_for(&release.assets, product, platform)?;
    let checksum = release
        .assets
        .iter()
        .find(|asset| asset.name == format!("{}.sha256", installer.name))
        .map(|asset| asset.browser_download_url.clone());

    Some(Release {
        version: release.tag_name.trim_start_matches('v').to_string(),
        notes: release.body.trim().to_string(),
        page_url: release.html_url,
        installer_name: installer.name.clone(),
        installer_url: installer.browser_download_url.clone(),
        installer_bytes: installer.size,
        checksum_url: checksum,
    })
}

/// The certificate authorities Android trusts, from the system's own store.
///
/// The updatable copy first — since Android 14 it lives in the Conscrypt
/// module and is refreshed by the Play system updates — then the one baked
/// into the system image.
#[cfg(target_os = "android")]
fn android_roots() -> Vec<reqwest::Certificate> {
    for dir in [
        "/apex/com.android.conscrypt/cacerts",
        "/system/etc/security/cacerts",
    ] {
        let certs: Vec<reqwest::Certificate> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| std::fs::read(entry.path()).ok())
            .filter_map(|pem| reqwest::Certificate::from_pem(&pem).ok())
            .collect();
        if !certs.is_empty() {
            return certs;
        }
    }
    Vec::new()
}

/// The installer in this release that belongs to this app on `platform`.
fn pick_for(assets: &[GhAsset], product: Product, platform: Platform) -> Option<&GhAsset> {
    let extension = wanted(platform);
    let owns = |name: &str| match platform {
        // The Android app is the client; there is no Android host.
        Platform::Android => name.contains("android"),
        _ => product.owns(name),
    };
    assets.iter().find(|asset| {
        let name = asset.name.to_ascii_lowercase();
        let linux_fits = match platform {
            // A Linux file says it is for Linux, and for this processor.
            Platform::Linux(_) => {
                name.contains("linux") && arch_names().iter().any(|arch| name.contains(arch))
            }
            _ => true,
        };
        name.ends_with(extension) && owns(&name) && linux_fits
    })
}

/// Downloads an installer and returns its path, having checked its digest.
///
/// `progress` is called with bytes received and the total expected.
pub async fn fetch(
    release: &Release,
    into: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};

    let Some(checksum_url) = release.checksum_url.as_deref() else {
        // Refused rather than warned about. An unverified installer is the
        // one thing an update path must never hand to somebody.
        return Err(UpdateError::ChecksumMismatch);
    };

    let http = client()?;
    let expected = digest_from(
        &http
            .get(checksum_url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| UpdateError::Network(e.to_string()))?
            .text()
            .await
            .map_err(|e| UpdateError::Network(e.to_string()))?,
    )
    .ok_or_else(|| UpdateError::Malformed("the checksum file made no sense".into()))?;

    std::fs::create_dir_all(into).map_err(|e| UpdateError::Io(e.to_string()))?;
    let target = into.join(&release.installer_name);
    let part = target.with_extension("part");

    let response = http
        .get(&release.installer_url)
        .send()
        .await
        .map_err(|e| UpdateError::Network(e.to_string()))?;
    if !response.status().is_success() {
        return Err(UpdateError::Status(response.status().as_u16()));
    }

    let total = response.content_length().unwrap_or(release.installer_bytes);
    let mut file = std::fs::File::create(&part).map_err(|e| UpdateError::Io(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut had = 0u64;
    let mut stream = response.bytes_stream();

    loop {
        let next = tokio::time::timeout(STALL_TIMEOUT, stream.next()).await;
        let chunk = match next {
            Err(_) => {
                let _ = std::fs::remove_file(&part);
                return Err(UpdateError::Stalled);
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                let _ = std::fs::remove_file(&part);
                return Err(UpdateError::Network(e.to_string()));
            }
            Ok(Some(Ok(chunk))) => chunk,
        };

        use std::io::Write;
        file.write_all(&chunk)
            .map_err(|e| UpdateError::Io(e.to_string()))?;
        hasher.update(&chunk);
        had += chunk.len() as u64;
        progress(had, total);
    }
    drop(file);

    let got = hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(&expected) {
        // Removed, not left lying about. A file that failed its check is not
        // something to leave on disk where somebody might run it by hand.
        let _ = std::fs::remove_file(&part);
        return Err(UpdateError::ChecksumMismatch);
    }

    let _ = std::fs::remove_file(&target);
    std::fs::rename(&part, &target).map_err(|e| UpdateError::Io(e.to_string()))?;
    Ok(target)
}

/// Reads the digest out of a `.sha256` file.
///
/// Handles both shapes these come in: the bare digest, and the
/// `<digest>  <filename>` that `sha256sum` writes.
pub fn digest_from(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?;
    let token = token.trim_start_matches('*');
    let looks_right = token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit());
    looks_right.then(|| token.to_ascii_lowercase())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The releases in these tests are Windows ones: matched as on Windows,
    /// whichever system runs the tests.
    fn newer_than(release: GhRelease, product: Product, current: &str) -> Option<Release> {
        newer_than_on(release, product, current, Platform::Windows)
    }

    /// Building the HTTP client must not depend on somebody else having set
    /// up rustls first.
    ///
    /// It did once, and the failure was a *panic* rather than an error: a
    /// freshly installed client that had never paired with a host had never
    /// built a TLS config either, so opening About — which checks quietly on
    /// open — took the whole app down. Nothing else in this test binary
    /// installs a provider, which is exactly the situation being guarded.
    #[test]
    fn an_http_client_can_be_built_before_anything_has_touched_tls() {
        assert!(client().is_ok());
    }

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.into(),
            browser_download_url: format!("https://example.test/{name}"),
            size: 10,
        }
    }

    fn release(tag: &str, names: &[&str]) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            body: "notes".into(),
            html_url: "https://example.test/release".into(),
            draft: false,
            prerelease: false,
            assets: names.iter().map(|n| asset(n)).collect(),
        }
    }

    /// One release carries both installers, and each app must take its own.
    #[test]
    fn each_app_finds_its_own_installer() {
        let assets = [
            asset("Basalt-Client-1.1.0-setup.exe"),
            asset("Basalt-Host-1.1.0-setup.exe"),
        ];
        assert_eq!(
            pick_for(&assets, Product::Client, Platform::Windows)
                .unwrap()
                .name,
            "Basalt-Client-1.1.0-setup.exe"
        );
        assert_eq!(
            pick_for(&assets, Product::Host, Platform::Windows)
                .unwrap()
                .name,
            "Basalt-Host-1.1.0-setup.exe"
        );
    }

    /// The Android app takes the package, and the Windows apps never do.
    #[test]
    fn the_android_app_takes_the_package() {
        let assets = [
            asset("Basalt-Client-1.4.0-setup.exe"),
            asset("Basalt-Host-1.4.0-setup.exe"),
            asset("Basalt-Android-1.4.0.apk"),
            asset("Basalt-Android-1.4.0.apk.sha256"),
        ];
        assert_eq!(
            pick_for(&assets, Product::Client, Platform::Android)
                .unwrap()
                .name,
            "Basalt-Android-1.4.0.apk"
        );
        assert_eq!(
            pick_for(&assets, Product::Client, Platform::Windows)
                .unwrap()
                .name,
            "Basalt-Client-1.4.0-setup.exe"
        );
        let windows_only = [asset("Basalt-Client-1.4.0-setup.exe")];
        assert!(pick_for(&windows_only, Product::Client, Platform::Android).is_none());
    }

    /// A Linux host finds the file for the way it was installed, for its own
    /// processor, and never a Windows installer.
    #[test]
    #[cfg(target_arch = "x86_64")]
    fn a_linux_host_finds_the_package_it_was_installed_from() {
        let names = [
            "Basalt-Host-Setup.exe",
            "Basalt-Client-Setup.exe",
            "Basalt-Android.apk",
            "Basalt-Host-Linux-x86_64.AppImage",
            "Basalt-Host-Linux-x86_64.AppImage.sha256",
            "Basalt-Host-Linux-amd64.deb",
            "Basalt-Host-Linux-x86_64.rpm",
            "Basalt-Host-Linux-aarch64.AppImage",
        ];
        let assets: Vec<GhAsset> = names.iter().map(|name| asset(name)).collect();
        let found = |package| {
            pick_for(&assets, Product::Host, Platform::Linux(package)).map(|a| a.name.clone())
        };
        assert_eq!(
            found(LinuxPackage::AppImage).as_deref(),
            Some("Basalt-Host-Linux-x86_64.AppImage")
        );
        assert_eq!(
            found(LinuxPackage::Deb).as_deref(),
            Some("Basalt-Host-Linux-amd64.deb")
        );
        assert_eq!(
            found(LinuxPackage::Rpm).as_deref(),
            Some("Basalt-Host-Linux-x86_64.rpm")
        );
        // Windows still finds its own, and nothing Linux.
        assert_eq!(
            pick_for(&assets, Product::Host, Platform::Windows)
                .unwrap()
                .name,
            "Basalt-Host-Setup.exe"
        );
        // A release with no Linux file offers a Linux host nothing.
        let windows_only = [asset("Basalt-Host-Setup.exe")];
        assert!(
            pick_for(
                &windows_only,
                Product::Host,
                Platform::Linux(LinuxPackage::Deb)
            )
            .is_none()
        );
    }

    /// The host with a window and the one without both carry "Host" in their
    /// names. Each takes only its own, whatever order the release lists them.
    #[test]
    #[cfg(target_arch = "x86_64")]
    fn the_screenless_host_and_the_desktop_host_never_take_each_others_files() {
        // Server files first, so order alone would hand the desktop the wrong one.
        let names = [
            "Basalt-Host-Docker-amd64.tar.gz",
            "Basalt-Host-Server-Linux-amd64.deb",
            "Basalt-Host-Server-Linux-x86_64.rpm",
            "Basalt-Host-Server-Linux-x86_64.tar.gz",
            "Basalt-Host-Server-Linux-aarch64.tar.gz",
            "Basalt-Host-Linux-amd64.deb",
            "Basalt-Host-Linux-x86_64.rpm",
            "Basalt-Host-Linux-x86_64.AppImage",
        ];
        let assets: Vec<GhAsset> = names.iter().map(|name| asset(name)).collect();
        let found = |product, package| {
            pick_for(&assets, product, Platform::Linux(package)).map(|a| a.name.clone())
        };
        assert_eq!(
            found(Product::Host, LinuxPackage::Deb).as_deref(),
            Some("Basalt-Host-Linux-amd64.deb")
        );
        assert_eq!(
            found(Product::Host, LinuxPackage::Rpm).as_deref(),
            Some("Basalt-Host-Linux-x86_64.rpm")
        );
        assert_eq!(found(Product::Host, LinuxPackage::Tarball), None);
        assert_eq!(
            found(Product::HostServer, LinuxPackage::Deb).as_deref(),
            Some("Basalt-Host-Server-Linux-amd64.deb")
        );
        assert_eq!(
            found(Product::HostServer, LinuxPackage::Rpm).as_deref(),
            Some("Basalt-Host-Server-Linux-x86_64.rpm")
        );
        assert_eq!(
            found(Product::HostServer, LinuxPackage::Tarball).as_deref(),
            Some("Basalt-Host-Server-Linux-x86_64.tar.gz")
        );
        assert_eq!(found(Product::HostServer, LinuxPackage::AppImage), None);
    }

    /// Releases name their files without a version, so a download link to the
    /// latest release never changes. Every app still finds its own file, and
    /// the checksum beside it.
    #[test]
    fn files_named_without_a_version_are_found() {
        let names = [
            "Basalt-Host-Setup.exe",
            "Basalt-Host-Setup.exe.sha256",
            "Basalt-Client-Setup.exe",
            "Basalt-Client-Setup.exe.sha256",
            "Basalt-Android.apk",
            "Basalt-Android.apk.sha256",
        ];
        let assets: Vec<GhAsset> = names.iter().map(|name| asset(name)).collect();
        let found = |product, platform| pick_for(&assets, product, platform).unwrap().name.clone();
        assert_eq!(
            found(Product::Host, Platform::Windows),
            "Basalt-Host-Setup.exe"
        );
        assert_eq!(
            found(Product::Client, Platform::Windows),
            "Basalt-Client-Setup.exe"
        );
        assert_eq!(
            found(Product::Client, Platform::Android),
            "Basalt-Android.apk"
        );

        let update =
            newer_than(release("v9.0.0", &names), Product::Host, "1.4.0").expect("an update");
        assert!(
            update
                .checksum_url
                .unwrap()
                .ends_with("/Basalt-Host-Setup.exe.sha256")
        );
    }

    #[test]
    fn a_release_missing_this_app_offers_nothing() {
        let only_host = release("v2.0.0", &["Basalt-Host-2.0.0-setup.exe"]);
        assert!(newer_than(only_host, Product::Client, "1.0.0").is_none());
    }

    #[test]
    fn a_draft_or_prerelease_is_not_offered() {
        let mut draft = release("v2.0.0", &["Basalt-Client-2.0.0-setup.exe"]);
        draft.draft = true;
        assert!(newer_than(draft, Product::Client, "1.0.0").is_none());

        let mut early = release("v2.0.0", &["Basalt-Client-2.0.0-setup.exe"]);
        early.prerelease = true;
        assert!(newer_than(early, Product::Client, "1.0.0").is_none());
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        let same = release("v1.0.0", &["Basalt-Client-1.0.0-setup.exe"]);
        assert!(newer_than(same, Product::Client, "1.0.0").is_none());
    }

    #[test]
    fn a_newer_release_carries_its_notes_and_its_checksum() {
        let found = newer_than(
            release(
                "v1.1.0",
                &[
                    "Basalt-Client-1.1.0-setup.exe",
                    "Basalt-Client-1.1.0-setup.exe.sha256",
                ],
            ),
            Product::Client,
            "1.0.0",
        )
        .expect("an update");

        assert_eq!(found.version, "1.1.0");
        assert_eq!(found.notes, "notes");
        assert!(found.checksum_url.unwrap().ends_with(".sha256"));
    }

    /// The checksum belongs to *this* installer, not to whichever one is
    /// listed first — a release holds two of each.
    #[test]
    fn the_checksum_matches_the_installer_it_belongs_to() {
        let found = newer_than(
            release(
                "v1.1.0",
                &[
                    "Basalt-Host-1.1.0-setup.exe",
                    "Basalt-Host-1.1.0-setup.exe.sha256",
                    "Basalt-Client-1.1.0-setup.exe",
                    "Basalt-Client-1.1.0-setup.exe.sha256",
                ],
            ),
            Product::Client,
            "1.0.0",
        )
        .expect("an update");
        assert!(found.checksum_url.unwrap().contains("Client"));
    }

    #[test]
    fn a_digest_is_read_in_either_shape() {
        let bare = "a".repeat(64);
        assert_eq!(digest_from(&bare), Some(bare.clone()));
        assert_eq!(
            digest_from(&format!("{bare}  installer.exe")),
            Some(bare.clone())
        );
        // What `sha256sum` writes in binary mode.
        assert_eq!(digest_from(&format!("{bare} *installer.exe")), Some(bare));
    }

    #[test]
    fn nonsense_is_not_mistaken_for_a_digest() {
        assert_eq!(digest_from(""), None);
        assert_eq!(digest_from("not a hash"), None);
        assert_eq!(digest_from(&"a".repeat(63)), None, "too short");
        assert_eq!(digest_from(&"z".repeat(64)), None, "not hex");
    }
}
