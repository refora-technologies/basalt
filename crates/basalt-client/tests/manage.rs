//! Managing the host from a device, against a real host over real TLS.
//!
//! The host decides who may: a device signed in with its own key and marked as
//! managing the host. Everyone else is refused, and the host is never left with
//! nobody to manage it from afar.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use basalt_client::Basalt;
use basalt_host::{Host, HostConfig, server};
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
    host: Arc<Host>,
    addr: SocketAddr,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    /// A device paired with its own key, under `name`, and its id on the host.
    async fn paired(&self, name: &str) -> (Basalt, String) {
        let client = Basalt::open(self.dir.join(format!("{name}.json"))).unwrap();
        let before: Vec<String> = self
            .host
            .devices()
            .into_iter()
            .map(|d| d.token_hash)
            .collect();
        let requires_pin = client.begin_pairing(self.addr).await.unwrap();
        let pin = requires_pin.then(|| {
            self.host
                .pending_pairings()
                .into_iter()
                .find_map(|r| r.pin)
                .expect("the host shows a PIN")
        });
        client.finish_pairing(pin.as_deref()).await.unwrap();
        let id = self
            .host
            .devices()
            .into_iter()
            .map(|d| d.token_hash)
            .find(|id| !before.contains(id))
            .expect("a new device");
        (client, id)
    }

    /// The same device, connecting again: what it may do is told as it signs in.
    async fn reopened(&self, name: &str) -> Basalt {
        let client = Basalt::open(self.dir.join(format!("{name}.json"))).unwrap();
        client.connect_saved().await.unwrap();
        client
    }
}

async fn start_host() -> Fixture {
    let dir = unique("manage");
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();

    let config_path = dir.join("host.json");
    let mut config = HostConfig::create("manage-host").unwrap();
    config.vault_path = Some(vault);
    config.vault_name = "Test Vault".into();
    config.save(&config_path).unwrap();

    let host = Host::new(config, config_path).unwrap();
    let bound = server::bind(Arc::clone(&host), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let addr = bound.addr();
    tokio::spawn(server::serve(bound));
    Fixture { dir, host, addr }
}

fn refused(result: basalt_client::Result<serde_json::Value>) -> String {
    result.expect_err("refused").to_string()
}

#[tokio::test]
async fn a_device_that_manages_the_host_does_what_its_window_does() {
    let fixture = start_host().await;
    let (phone, phone_id) = fixture.paired("phone").await;
    drop(phone);
    fixture.host.set_owner(&phone_id, true).unwrap();
    let phone = fixture.reopened("phone").await;
    assert!(phone.status().unwrap().manage);

    let view = phone.manage(ManageAction::View).await.unwrap();
    assert_eq!(view["status"]["vault"]["name"], "Test Vault");
    assert_eq!(view["devices"].as_array().unwrap().len(), 1);
    assert!(view["drives"].is_null(), "drives only when asked for");
    assert_eq!(
        view["you"],
        phone_id.as_str(),
        "the phone is told which device it is"
    );

    let view = phone
        .manage(ManageAction::SetHostName {
            name: "Living room".into(),
        })
        .await
        .unwrap();
    assert_eq!(view["status"]["hostName"], "Living room");
    assert_eq!(fixture.host.host_name(), "Living room");

    phone
        .manage(ManageAction::SetRequirePin { require: false })
        .await
        .unwrap();
    let view = phone
        .manage(ManageAction::AddProfile {
            name: "Maya".into(),
            color: 2,
        })
        .await
        .unwrap();
    assert_eq!(view["status"]["requirePin"], false);
    assert_eq!(view["status"]["profiles"][0]["name"], "Maya");

    // Another device, renamed and made read-only from the phone.
    let (_laptop, laptop_id) = fixture.paired("laptop").await;
    phone
        .manage(ManageAction::RenameDevice {
            id: laptop_id.clone(),
            name: "Kitchen laptop".into(),
        })
        .await
        .unwrap();
    let view = phone
        .manage(ManageAction::SetWritable {
            id: laptop_id.clone(),
            writable: false,
        })
        .await
        .unwrap();
    let laptop = view["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == laptop_id.as_str())
        .unwrap()
        .clone();
    assert_eq!(laptop["name"], "Kitchen laptop");
    assert_eq!(laptop["writable"], false);

    let view = phone.manage(ManageAction::ListDrives).await.unwrap();
    assert!(view["drives"].is_array());
}

#[tokio::test]
async fn a_folder_is_found_by_browsing_shared_by_its_name_and_renamed() {
    let fixture = start_host().await;
    let (phone, phone_id) = fixture.paired("phone").await;
    drop(phone);
    fixture.host.set_owner(&phone_id, true).unwrap();
    let phone = fixture.reopened("phone").await;

    let media = fixture.dir.join("Media");
    std::fs::create_dir_all(media.join("Films")).unwrap();
    std::fs::create_dir_all(media.join(".hidden")).unwrap();
    std::fs::write(media.join("notes.txt"), "not a folder").unwrap();

    // Browsing: folders only, hidden ones left out, and the way back up.
    let view = phone
        .manage(ManageAction::ListFolders {
            path: fixture.dir.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();
    let names: Vec<&str> = view["folders"]["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Media"), "{names:?}");
    assert!(view["folders"]["parent"].is_string());
    let inside = phone
        .manage(ManageAction::ListFolders {
            path: media.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();
    let names: Vec<&str> = inside["folders"]["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Films"]);
    // The top is somewhere to start from, whatever the computer.
    let top = phone
        .manage(ManageAction::ListFolders {
            path: String::new(),
        })
        .await
        .unwrap();
    assert!(top["folders"]["folders"].is_array());
    // A folder that is not there says so.
    let why = refused(
        phone
            .manage(ManageAction::ListFolders {
                path: fixture.dir.join("gone").to_string_lossy().into_owned(),
            })
            .await,
    );
    assert!(why.contains("can’t open"), "{why}");

    // Shared with no name given: called by its own name, not its path.
    let view = phone
        .manage(ManageAction::ChooseDrive {
            path: media.to_string_lossy().into_owned(),
            name: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(view["status"]["vault"]["name"], "Media");

    let view = phone
        .manage(ManageAction::RenameDrive {
            name: "Family films".into(),
        })
        .await
        .unwrap();
    assert_eq!(view["status"]["vault"]["name"], "Family films");
    assert_eq!(fixture.host.vault_name(), "Family films");
    let why = refused(
        phone
            .manage(ManageAction::RenameDrive { name: "  ".into() })
            .await,
    );
    assert!(why.contains("needs a name"), "{why}");
}

#[tokio::test]
async fn a_device_that_does_not_manage_the_host_is_refused() {
    let fixture = start_host().await;
    let (phone, _) = fixture.paired("phone").await;
    assert!(!phone.status().unwrap().manage);
    let why = refused(phone.manage(ManageAction::View).await);
    assert!(why.contains("doesn’t manage this host"), "{why}");
    let why = refused(
        phone
            .manage(ManageAction::SetRequirePin { require: false })
            .await,
    );
    assert!(why.contains("doesn’t manage this host"), "{why}");
    assert!(fixture.host.status(true).await.require_pin);
}

#[tokio::test]
async fn a_device_on_a_pairing_code_cannot_manage() {
    let fixture = start_host().await;
    let old = Basalt::open_without_keys(fixture.dir.join("old.json")).unwrap();
    let requires_pin = old.begin_pairing(fixture.addr).await.unwrap();
    let pin = requires_pin.then(|| {
        fixture
            .host
            .pending_pairings()
            .into_iter()
            .find_map(|r| r.pin)
            .unwrap()
    });
    old.finish_pairing(pin.as_deref()).await.unwrap();
    let id = fixture.host.devices()[0].token_hash.clone();
    assert!(fixture.host.set_owner(&id, true).is_err());
    let why = refused(old.manage(ManageAction::View).await);
    assert!(why.contains("doesn’t manage this host"), "{why}");
}

#[tokio::test]
async fn a_device_no_longer_managing_is_stopped_at_its_next_request() {
    let fixture = start_host().await;
    let (phone, phone_id) = fixture.paired("phone").await;
    drop(phone);
    fixture.host.set_owner(&phone_id, true).unwrap();
    let phone = fixture.reopened("phone").await;
    phone.manage(ManageAction::View).await.unwrap();

    // Taken away at the host while the phone's connection is still open.
    fixture.host.set_owner(&phone_id, false).unwrap();
    let why = refused(phone.manage(ManageAction::View).await);
    assert!(why.contains("doesn’t manage this host"), "{why}");
}

#[tokio::test]
async fn the_last_device_managing_the_host_cannot_leave_it_from_afar() {
    let fixture = start_host().await;
    let (phone, phone_id) = fixture.paired("phone").await;
    drop(phone);
    fixture.host.set_owner(&phone_id, true).unwrap();
    let phone = fixture.reopened("phone").await;

    let why = refused(
        phone
            .manage(ManageAction::SetManages {
                id: phone_id.clone(),
                manages: false,
            })
            .await,
    );
    assert!(why.contains("only device that manages"), "{why}");
    let why = refused(
        phone
            .manage(ManageAction::RemoveDevice {
                id: phone_id.clone(),
            })
            .await,
    );
    assert!(why.contains("only device that manages"), "{why}");
    assert!(fixture.host.devices()[0].owner, "still managing");

    // With another device managing too, it may step down.
    let (laptop, laptop_id) = fixture.paired("laptop").await;
    drop(laptop);
    phone
        .manage(ManageAction::SetManages {
            id: laptop_id.clone(),
            manages: true,
        })
        .await
        .unwrap();
    phone
        .manage(ManageAction::SetManages {
            id: phone_id.clone(),
            manages: false,
        })
        .await
        .unwrap();
    let managers: Vec<String> = fixture
        .host
        .devices()
        .into_iter()
        .filter(|d| d.owner)
        .map(|d| d.token_hash)
        .collect();
    assert_eq!(managers, [laptop_id]);
}

// What was reported: a device let manage the host only showed "Manage host"
// after signing out and in again, while a change of write access shows at once.
#[tokio::test]
async fn a_watching_device_hears_at_once_that_it_may_manage_the_host() {
    let fixture = start_host().await;
    let (phone, phone_id) = fixture.paired("phone").await;
    let phone = Arc::new(phone);
    assert!(!phone.status().unwrap().manage);

    let heard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = Arc::clone(&heard);
    let _watch = phone.watch_with(
        |_| {},
        move |notice| {
            if matches!(notice, basalt_client::WatchNotice::AccessChanged) {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        },
    );
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let wait_for = |want: bool| {
        let phone = &phone;
        async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                if phone.status().unwrap().manage == want {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            false
        }
    };

    fixture.host.set_owner(&phone_id, true).unwrap();
    assert!(wait_for(true).await, "let manage, the device must show it");
    assert!(
        heard.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "and the app is told"
    );
    assert!(phone.manage(ManageAction::View).await.is_ok());

    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    fixture.host.set_owner(&phone_id, false).unwrap();
    assert!(
        wait_for(false).await,
        "no longer managing, the device must show that too"
    );
}
