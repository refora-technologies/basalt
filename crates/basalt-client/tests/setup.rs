//! Setting up a host with no screen from a device, against a real host over
//! real TLS.
//!
//! A screenless host that nobody manages asks for its setup code, read on the
//! machine, in place of a PIN; the device that pairs with it manages the host,
//! and the code is used up. Guessing it replaces it. A host with a window never
//! does any of this.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use basalt_client::Basalt;
use basalt_host::{Host, HostConfig, server, setup};
use basalt_proto::msg::ManageAction;

fn unique(prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "basalt-{prefix}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

struct Fixture {
    dir: PathBuf,
    config_path: PathBuf,
    host: Arc<Host>,
    addr: SocketAddr,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    fn device(&self, name: &str) -> Basalt {
        Basalt::open(self.dir.join(format!("{name}.json"))).unwrap()
    }

    fn code(&self) -> String {
        self.host.setup_code().unwrap().expect("a setup code")
    }

    /// A drive to share, made on demand.
    fn drive(&self) -> PathBuf {
        let drive = self.dir.join("Media");
        std::fs::create_dir_all(&drive).unwrap();
        std::fs::write(drive.join("hello.txt"), "hello").unwrap();
        drive
    }
}

/// A host as a service starts it: no drive, nobody managing it, no screen.
async fn start_headless(headless: bool) -> Fixture {
    let dir = unique("setup");
    std::fs::create_dir_all(&dir).unwrap();
    let config_path = dir.join("host.json");
    let config = HostConfig::create("basement-pi").unwrap();
    config.save(&config_path).unwrap();

    let host = Host::new(config, config_path.clone()).unwrap();
    host.set_headless(headless);
    let bound = server::bind(Arc::clone(&host), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let addr = bound.addr();
    tokio::spawn(server::serve(bound));
    Fixture {
        dir,
        config_path,
        host,
        addr,
    }
}

/// Types a code the way a person might: lower case, with the dash.
fn typed(code: &str) -> String {
    basalt_net::pairing::format_setup_code(code).to_lowercase()
}

#[tokio::test]
async fn a_screenless_host_is_set_up_with_its_code_and_then_given_a_drive() {
    let fixture = start_headless(true).await;
    assert!(fixture.host.in_setup());
    assert!(fixture.host.beacon().needs_setup, "the drive list says so");
    let code = fixture.code();

    let phone = fixture.device("phone");
    let start = phone
        .begin_pairing_at(&fixture.addr.to_string())
        .await
        .unwrap();
    assert!(start.setup && start.requires_pin, "{start:?}");
    phone.finish_pairing(Some(&typed(&code))).await.unwrap();

    let status = phone.status().unwrap();
    assert!(status.manage, "the device that set it up manages it");
    assert!(!status.has_vault, "and it shares nothing yet");
    assert!(!fixture.host.in_setup(), "the host has left setup");
    assert!(!fixture.host.beacon().needs_setup);
    assert_eq!(
        setup::read_code(&fixture.config_path),
        None,
        "the code is used up"
    );
    let device = &fixture.host.devices()[0];
    assert!(device.owner && !device.public_key.is_empty());

    // Choosing the drive from the phone: the phone knows at once.
    let drive = fixture.drive();
    let view = phone
        .manage(ManageAction::ChooseDrive {
            path: drive.to_string_lossy().into_owned(),
            name: "Media".into(),
        })
        .await
        .unwrap();
    assert_eq!(view["status"]["vault"]["name"], "Media");
    let status = phone.status().unwrap();
    assert!(status.has_vault);
    assert_eq!(status.vault, "Media");
    let files = phone.list("").await.unwrap();
    assert!(files.iter().any(|f| f.name == "hello.txt"), "{files:?}");
}

#[tokio::test]
async fn a_wrong_code_is_refused_and_the_right_one_still_works() {
    let fixture = start_headless(true).await;
    let code = fixture.code();
    let phone = fixture.device("phone");

    phone.begin_pairing(fixture.addr).await.unwrap();
    let wrong = if code.starts_with('A') {
        "BBBBBBBB"
    } else {
        "AAAAAAAA"
    };
    let err = phone.finish_pairing(Some(wrong)).await.unwrap_err();
    assert!(err.to_string().contains("setup code is not right"), "{err}");
    assert!(fixture.host.devices().is_empty());

    phone.begin_pairing(fixture.addr).await.unwrap();
    phone.finish_pairing(Some(&code)).await.unwrap();
    assert!(phone.status().unwrap().manage);
}

#[tokio::test]
async fn the_code_works_once_and_then_pairing_asks_the_manager_for_a_pin() {
    let fixture = start_headless(true).await;
    let code = fixture.code();
    let phone = fixture.device("phone");
    phone.begin_pairing(fixture.addr).await.unwrap();
    phone.finish_pairing(Some(&code)).await.unwrap();

    // A second device with the same code: the host asks for a PIN now, which
    // the code is not.
    let tablet = fixture.device("tablet");
    let start = tablet
        .begin_pairing_at(&fixture.addr.to_string())
        .await
        .unwrap();
    assert!(!start.setup && start.requires_pin, "{start:?}");
    assert!(tablet.finish_pairing(Some(&code)).await.is_err());

    // The PIN shows on the phone's Manage host, as the screen it does not
    // have would have shown it.
    tablet.begin_pairing(fixture.addr).await.unwrap();
    let view = phone.manage(ManageAction::View).await.unwrap();
    let pairing = &view["pairings"][0];
    assert_eq!(pairing["setup"], false);
    let pin = pairing["pin"]
        .as_str()
        .expect("a PIN for the manager")
        .to_string();
    tablet.finish_pairing(Some(&pin)).await.unwrap();
    assert_eq!(fixture.host.devices().len(), 2);
    assert!(
        !tablet.status().unwrap().manage,
        "only the first device manages it"
    );
}

#[tokio::test]
async fn guessing_replaces_the_code() {
    let fixture = start_headless(true).await;
    let code = fixture.code();
    let wrong = if code.starts_with('A') {
        "BBBBBBBB"
    } else {
        "AAAAAAAA"
    };
    let stranger = fixture.device("stranger");
    for _ in 0..setup::MAX_WRONG_CODES {
        stranger.begin_pairing(fixture.addr).await.unwrap();
        assert!(stranger.finish_pairing(Some(wrong)).await.is_err());
    }
    let replaced = fixture.code();
    assert_ne!(
        replaced, code,
        "after too many wrong codes there is a new one"
    );

    // The old code is worthless now; the new one, from the machine, works.
    let phone = fixture.device("phone");
    phone.begin_pairing(fixture.addr).await.unwrap();
    assert!(phone.finish_pairing(Some(&code)).await.is_err());
    phone.begin_pairing(fixture.addr).await.unwrap();
    phone.finish_pairing(Some(&replaced)).await.unwrap();
    assert!(phone.status().unwrap().manage);
}

// The managing phone was lost: `basalt-host setup-code --reset` on the
// machine lets another device in as a manager.
#[tokio::test]
async fn a_code_made_again_on_the_machine_lets_another_manager_in() {
    let fixture = start_headless(true).await;
    let code = fixture.code();
    let phone = fixture.device("phone");
    phone.begin_pairing(fixture.addr).await.unwrap();
    phone.finish_pairing(Some(&code)).await.unwrap();
    assert!(!fixture.host.in_setup());

    let again = setup::new_code(&fixture.config_path).unwrap();
    assert!(fixture.host.in_setup());
    let laptop = fixture.device("laptop");
    let start = laptop
        .begin_pairing_at(&fixture.addr.to_string())
        .await
        .unwrap();
    assert!(start.setup);
    laptop.finish_pairing(Some(&again)).await.unwrap();
    assert!(laptop.status().unwrap().manage);
    assert_eq!(fixture.host.managers(), 2);
    assert!(!fixture.host.in_setup());
}

#[tokio::test]
async fn an_app_without_keys_is_asked_to_update_first() {
    let fixture = start_headless(true).await;
    let code = fixture.code();
    let old = Basalt::open_without_keys(fixture.dir.join("old.json")).unwrap();
    old.begin_pairing(fixture.addr).await.unwrap();
    let err = old.finish_pairing(Some(&code)).await.unwrap_err();
    assert!(err.to_string().contains("up-to-date Basalt"), "{err}");
    assert!(fixture.host.devices().is_empty());
    assert!(
        fixture.host.in_setup(),
        "the code is still there for the right device"
    );
}

#[tokio::test]
async fn a_host_with_a_window_never_asks_for_a_setup_code() {
    let fixture = start_headless(false).await;
    assert!(!fixture.host.in_setup());
    assert_eq!(fixture.host.setup_code().unwrap(), None);
    assert!(!fixture.host.beacon().needs_setup);
    let phone = fixture.device("phone");
    let start = phone
        .begin_pairing_at(&fixture.addr.to_string())
        .await
        .unwrap();
    assert!(!start.setup);
    assert_eq!(setup::read_code(&fixture.config_path), None);
}
