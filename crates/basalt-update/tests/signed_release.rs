//! An update end to end, against a release served from this machine: the
//! check, the signed list, the download, and what is refused.
//!
//! The release server stands in for GitHub through `BASALT_RELEASES_API`, and
//! the key the list is signed with for the release key through
//! `BASALT_RELEASE_KEY`; both are honoured only for an address on this
//! machine. One test, run in order: the environment is the process's.

use std::sync::{Arc, Mutex};

use basalt_update::{OWNER, Product, REPO, UpdateError, check, fetch};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The installers a release carries, one per platform, all served alike, so
/// whichever this machine's copy picks is there.
const INSTALLERS: &[&str] = &[
    "Basalt-Client-Setup.exe",
    "Basalt-Client-Linux-x86_64.AppImage",
    "Basalt-Client-Linux-amd64.deb",
    "Basalt-Android.apk",
];

/// Whether `dir` is empty, or soon is. On Windows a file deleted while
/// something else has it open (an antivirus reading a new installer) is still
/// listed until that lets go, though the deletion has been done.
async fn gone_soon(dir: &std::path::Path) -> bool {
    for _ in 0..50 {
        if std::fs::read_dir(dir).unwrap().next().is_none() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

/// What the pretend GitHub serves, and what was asked of it.
#[derive(Default)]
struct Served {
    tag: String,
    sums: String,
    installer: Vec<u8>,
    installer_requests: usize,
}

type Shared = Arc<Mutex<Served>>;

async fn serve(listener: tokio::net::TcpListener, served: Shared) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let served = served.clone();
        tokio::spawn(async move {
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => request.extend_from_slice(&buffer[..n]),
                }
            }
            let request = String::from_utf8_lossy(&request);
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            let port = stream.local_addr().unwrap().port();
            let (status, body) = answer(&path, port, &served);
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        });
    }
}

fn answer(path: &str, port: u16, served: &Shared) -> (&'static str, Vec<u8>) {
    let mut served = served.lock().unwrap();
    let base = format!("http://127.0.0.1:{port}/files");
    if path == format!("/repos/{OWNER}/{REPO}/releases/latest") {
        let mut assets: Vec<serde_json::Value> = INSTALLERS
            .iter()
            .map(|name| {
                serde_json::json!({
                    "name": name,
                    "browser_download_url": format!("{base}/{name}"),
                    "size": served.installer.len(),
                })
            })
            .collect();
        if !served.sums.is_empty() {
            assets.push(serde_json::json!({
                "name": "SHA256SUMS",
                "browser_download_url": format!("{base}/SHA256SUMS"),
                "size": served.sums.len(),
            }));
        }
        let release = serde_json::json!({
            "tag_name": served.tag,
            "body": "notes",
            "html_url": "http://127.0.0.1/release",
            "draft": false,
            "prerelease": false,
            "assets": assets,
        });
        return ("200 OK", release.to_string().into_bytes());
    }
    if path == "/files/SHA256SUMS" {
        return ("200 OK", served.sums.clone().into_bytes());
    }
    if let Some(name) = path.strip_prefix("/files/")
        && INSTALLERS.contains(&name)
    {
        served.installer_requests += 1;
        return ("200 OK", served.installer.clone());
    }
    ("404 Not Found", Vec::new())
}

fn hex_digest(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A release's list for `installer`, as `tools/release-sign` writes it:
/// signed with `key` for `version`, or not at all.
fn sums(installer: &[u8], signed_by: Option<(&minisign::KeyPair, &str)>) -> String {
    let digest = hex_digest(installer);
    let list: String = INSTALLERS
        .iter()
        .map(|name| format!("{digest} *{name}\n"))
        .collect();
    match signed_by {
        None => list,
        Some((pair, version)) => {
            let comment = format!("basalt release {version}");
            let signature = minisign::sign(
                Some(&pair.pk),
                &pair.sk,
                list.as_bytes(),
                Some(&comment),
                None,
            )
            .unwrap()
            .into_string();
            format!("{list}{signature}")
        }
    }
}

#[tokio::test]
async fn only_a_signed_release_is_installed() {
    let release_key = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let other_key = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let scratch =
        std::env::temp_dir().join(format!("basalt-signed-release-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();
    let key_file = scratch.join("release-key.pub");
    std::fs::write(&key_file, release_key.pk.to_box().unwrap().into_string()).unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served: Shared = Arc::default();
    tokio::spawn(serve(listener, served.clone()));
    // SAFETY: set before anything here reads the environment, and this
    // binary runs this one test.
    unsafe {
        std::env::set_var("BASALT_RELEASES_API", format!("http://127.0.0.1:{port}"));
        std::env::set_var("BASALT_RELEASE_KEY", &key_file);
    }

    let installer = b"the 1.6.0 installer".repeat(5000);
    let set = |tag: &str, sums: String, bytes: &[u8]| {
        let mut served = served.lock().unwrap();
        served.tag = tag.into();
        served.sums = sums;
        served.installer = bytes.to_vec();
        served.installer_requests = 0;
    };
    let requests = || served.lock().unwrap().installer_requests;
    let into = scratch.join("downloads");

    // Signed with the release key, for this release: installed.
    set(
        "v1.6.0",
        sums(&installer, Some((&release_key, "1.6.0"))),
        &installer,
    );
    let offer = check(Product::Client, "1.5.1")
        .await
        .expect("the release server answered")
        .expect("1.6.0 is offered");
    assert!(offer.sums_url.is_some());
    let path = fetch(&offer, &into, |_, _| {})
        .await
        .expect("a signed release downloads");
    assert_eq!(std::fs::read(&path).unwrap(), installer);
    std::fs::remove_file(&path).unwrap();

    // The installer swapped after signing: thrown away.
    set(
        "v1.6.0",
        sums(&installer, Some((&release_key, "1.6.0"))),
        b"something else",
    );
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    assert!(matches!(
        fetch(&offer, &into, |_, _| {}).await,
        Err(UpdateError::ChecksumMismatch)
    ));
    assert!(!into.join(&offer.installer_name).exists());
    assert!(gone_soon(&into).await, "nothing left behind");

    // Signed, but not with the release key: nothing downloaded at all.
    set(
        "v1.6.0",
        sums(&installer, Some((&other_key, "1.6.0"))),
        &installer,
    );
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    assert!(matches!(
        fetch(&offer, &into, |_, _| {}).await,
        Err(UpdateError::BadSignature)
    ));
    assert_eq!(
        requests(),
        0,
        "the installer was fetched for a list that failed"
    );

    // A list without a signature: the same.
    set("v1.6.0", sums(&installer, None), &installer);
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    assert!(matches!(
        fetch(&offer, &into, |_, _| {}).await,
        Err(UpdateError::Unsigned)
    ));
    assert_eq!(requests(), 0);

    // No list at all: the same.
    set("v1.6.0", String::new(), &installer);
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    assert!(offer.sums_url.is_none());
    assert!(matches!(
        fetch(&offer, &into, |_, _| {}).await,
        Err(UpdateError::Unsigned)
    ));
    assert_eq!(requests(), 0);

    // 1.6.0's genuine list and installer, put up again as 1.7.0: refused.
    set(
        "v1.7.0",
        sums(&installer, Some((&release_key, "1.6.0"))),
        &installer,
    );
    let offer = check(Product::Client, "1.6.0").await.unwrap().unwrap();
    assert_eq!(offer.version, "1.7.0");
    assert!(matches!(
        fetch(&offer, &into, |_, _| {}).await,
        Err(UpdateError::BadSignature)
    ));
    assert_eq!(requests(), 0);

    let _ = std::fs::remove_dir_all(&scratch);
}
