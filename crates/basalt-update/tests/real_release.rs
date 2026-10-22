//! A staged, signed release checked with the key built into the apps, before
//! it is published: what an installed copy will do with it.
//!
//! Ignored by default: it needs a release staged and signed. Run it with the
//! release's folder named:
//!
//! ```text
//! BASALT_REAL_RELEASE=dist/release-1.6.0 cargo test -p basalt-update --test real_release -- --ignored --nocapture
//! ```
//!
//! The folder is served from this machine as GitHub would serve the release,
//! and a copy that believes it is an older version updates from it, with no
//! test key: the signature must be good for the real one. Then the same files
//! with the list changed, unsigned, or put up under a later version than the
//! one it was signed for, which must all be refused before any installer is
//! fetched.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use basalt_update::{OWNER, Product, REPO, UpdateError, check, fetch};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Served {
    tag: String,
    sums: Vec<u8>,
    installer_requests: usize,
}

type Shared = Arc<Mutex<Served>>;

fn release_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("BASALT_REAL_RELEASE").expect("BASALT_REAL_RELEASE names the release folder"),
    )
}

/// The release's files, as the release page lists them.
fn assets(dir: &PathBuf) -> Vec<(String, u64)> {
    let mut files: Vec<(String, u64)> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let size = entry.metadata().unwrap().len();
            (name, size)
        })
        .filter(|(name, _)| name != "notes.md")
        .collect();
    files.sort();
    files
}

async fn serve(listener: tokio::net::TcpListener, served: Shared, dir: PathBuf) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let served = served.clone();
        let dir = dir.clone();
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
            let (status, body) = answer(&path, port, &served, &dir);
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        });
    }
}

fn answer(path: &str, port: u16, served: &Shared, dir: &PathBuf) -> (&'static str, Vec<u8>) {
    let mut served = served.lock().unwrap();
    let base = format!("http://127.0.0.1:{port}/files");
    if path == format!("/repos/{OWNER}/{REPO}/releases/latest") {
        let list: Vec<serde_json::Value> = assets(dir)
            .into_iter()
            .map(|(name, size)| {
                serde_json::json!({ "name": name, "browser_download_url": format!("{base}/{name}"), "size": size })
            })
            .collect();
        let release = serde_json::json!({
            "tag_name": served.tag, "body": "notes", "html_url": "http://127.0.0.1/release",
            "draft": false, "prerelease": false, "assets": list,
        });
        return ("200 OK", release.to_string().into_bytes());
    }
    if path == "/files/SHA256SUMS" {
        return ("200 OK", served.sums.clone());
    }
    if let Some(name) = path.strip_prefix("/files/") {
        let name = name.replace("%20", " ");
        if let Ok(bytes) = std::fs::read(dir.join(&name)) {
            served.installer_requests += 1;
            return ("200 OK", bytes);
        }
    }
    ("404 Not Found", Vec::new())
}

#[tokio::test]
#[ignore = "needs a staged, signed release: see the top of this file"]
async fn the_staged_release_is_accepted_with_the_real_key_and_tampering_is_refused() {
    let dir = release_dir();
    let signed = std::fs::read(dir.join("SHA256SUMS")).expect("the release has SHA256SUMS");
    let text = String::from_utf8(signed.clone()).unwrap();
    let version = dir
        .file_name()
        .unwrap()
        .to_string_lossy()
        .trim_start_matches("release-")
        .to_string();
    assert!(
        text.contains("untrusted comment:"),
        "SHA256SUMS is not signed yet"
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served: Shared = Arc::default();
    tokio::spawn(serve(listener, served.clone(), dir.clone()));
    // SAFETY: set before anything here reads the environment, and this
    // binary runs this one test. No BASALT_RELEASE_KEY: the real key.
    unsafe {
        std::env::set_var("BASALT_RELEASES_API", format!("http://127.0.0.1:{port}"));
        std::env::remove_var("BASALT_RELEASE_KEY");
    }
    let set = |tag: &str, sums: Vec<u8>| {
        let mut s = served.lock().unwrap();
        s.tag = tag.into();
        s.sums = sums;
        s.installer_requests = 0;
    };
    let requests = || served.lock().unwrap().installer_requests;
    let into = std::env::temp_dir().join(format!("basalt-real-release-{}", std::process::id()));

    // The release as signed: each app's installer for this machine downloads
    // and matches.
    set(&format!("v{version}"), signed.clone());
    for product in [Product::Host, Product::Client] {
        let offer = check(product, "1.5.1").await.unwrap().expect("offered");
        println!(
            "{product:?}: {} ({} bytes)",
            offer.installer_name, offer.installer_bytes
        );
        let path = fetch(&offer, &into, |_, _| {})
            .await
            .expect("the signed release is accepted");
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            offer.installer_bytes
        );
        std::fs::remove_file(&path).unwrap();
        println!("  accepted with the real key");
    }

    // One character of the list changed.
    let mut changed = text.clone();
    let at = changed.find(char::is_alphanumeric).unwrap();
    let swap = if changed.as_bytes()[at] == b'0' {
        "1"
    } else {
        "0"
    };
    changed.replace_range(at..at + 1, swap);
    set(&format!("v{version}"), changed.into_bytes());
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    let refused = fetch(&offer, &into, |_, _| {}).await;
    println!("changed list: {refused:?}");
    assert!(matches!(refused, Err(UpdateError::BadSignature)));
    assert_eq!(requests(), 0);

    // The signature taken off.
    let list = &text[..text.find("untrusted comment:").unwrap()];
    set(&format!("v{version}"), list.as_bytes().to_vec());
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    let refused = fetch(&offer, &into, |_, _| {}).await;
    println!("unsigned list: {refused:?}");
    assert!(matches!(refused, Err(UpdateError::Unsigned)));
    assert_eq!(requests(), 0);

    // The genuine list, put up as a later release.
    set("v9.9.9", signed);
    let offer = check(Product::Client, "1.5.1").await.unwrap().unwrap();
    let refused = fetch(&offer, &into, |_, _| {}).await;
    println!("the {version} list as 9.9.9: {refused:?}");
    assert!(matches!(refused, Err(UpdateError::BadSignature)));
    assert_eq!(requests(), 0);

    let _ = std::fs::remove_dir_all(&into);
}
