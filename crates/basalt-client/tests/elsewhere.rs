//! Using a profile made on another drive, against two real hosts over real TLS.
//!
//! Maya's profile lives on her home drive (B). A device signed in to her there
//! carries B's statement that it acts for her; shown to another drive (C), it
//! lets her in once someone who manages C approves. Her PIN never reaches C,
//! and her history and stars on C are C's.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use basalt_client::Basalt;
use basalt_host::{Host, HostConfig, server};

fn unique(prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "basalt-{prefix}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

struct Drive {
    dir: PathBuf,
    host: Arc<Host>,
    addr: SocketAddr,
}

impl Drop for Drive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start(name: &str) -> Drive {
    let dir = unique("elsewhere");
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let config_path = dir.join("host.json");
    let mut config = HostConfig::create(name).unwrap();
    config.vault_path = Some(vault);
    config.vault_name = name.into();
    config.save(&config_path).unwrap();
    let host = Host::new(config, config_path).unwrap();
    let bound = server::bind(Arc::clone(&host), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let addr = bound.addr();
    tokio::spawn(server::serve(bound));
    Drive { dir, host, addr }
}

/// Pairs the device with `drive`, leaving it connected there.
async fn pair(device: &Basalt, drive: &Drive) {
    let requires_pin = device.begin_pairing(drive.addr).await.unwrap();
    let pin = requires_pin.then(|| {
        drive
            .host
            .pending_pairings()
            .into_iter()
            .find_map(|r| r.pin)
            .expect("a PIN")
    });
    device.finish_pairing(pin.as_deref()).await.unwrap();
}

struct World {
    home: Drive,
    other: Drive,
    device: Arc<Basalt>,
    _dir: PathBuf,
}

/// Maya made on the home drive from a device, which then pairs with the
/// other drive and is connected there.
async fn world() -> World {
    let home = start("Living Room Drive").await;
    let other = start("Study Drive").await;
    let dir = unique("elsewhere-device");
    std::fs::create_dir_all(&dir).unwrap();
    let device = Arc::new(Basalt::open(dir.join("device.json")).unwrap());
    pair(&device, &home).await;
    device
        .create_profile("Maya", "2468", 3, true)
        .await
        .unwrap();
    pair(&device, &other).await;
    World {
        home,
        other,
        device,
        _dir: dir,
    }
}

#[tokio::test]
async fn a_profile_from_another_drive_is_used_once_approved() {
    let w = world().await;
    let passes = w.device.profiles_elsewhere();
    assert_eq!(passes.len(), 1, "{passes:?}");
    let pass = &passes[0];
    assert_eq!(pass.name, "Maya");
    assert_eq!(pass.color, 3);
    assert_eq!(pass.drive, "Living Room Drive");
    assert_eq!(pass.host_id, w.home.host.host_id());

    // Asked: waiting, and shown to whoever manages the other drive.
    let asked = w
        .device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, true)
        .await
        .unwrap();
    assert!(asked.waiting && asked.profile.is_none(), "{asked:?}");
    let links = w.other.host.profile_links();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].name, "Maya");
    assert_eq!(links[0].home, "Living Room Drive");

    // Asking again while waiting does not add a second request.
    w.device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, true)
        .await
        .unwrap();
    assert_eq!(w.other.host.profile_links().len(), 1);

    w.other.host.approve_profile_link(&links[0].id).unwrap();
    assert!(w.other.host.profile_links().is_empty());
    let views = w.other.host.profile_views();
    let linked = views
        .iter()
        .find(|p| p.home.is_some())
        .expect("Maya, linked");
    assert_eq!(linked.name, "Maya");
    assert!(!linked.has_pin, "no PIN is kept here");
    let home = linked.home.as_ref().unwrap();
    assert_eq!(home.label, "Living Room Drive");
    assert_eq!(home.host_id, w.home.host.host_id());

    let signed_in = w
        .device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, true)
        .await
        .unwrap();
    let profile = signed_in.profile.expect("signed in as Maya");
    assert_eq!(profile.id, linked.id);
    let identity = w.device.identity().await;
    assert_eq!(identity.profile.map(|p| p.name).as_deref(), Some("Maya"));

    // Her stars here are this drive's own.
    let star = basalt_proto::msg::Star {
        path: "notes.txt".into(),
        name: "notes.txt".into(),
        kind: "file".into(),
    };
    let stars = w.device.stars(Some(vec![star])).await.unwrap();
    assert_eq!(stars.len(), 1);

    // No PIN can be tried on her here.
    let err = w
        .device
        .sign_in_profile(&linked.id, "2468", false)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("signs in from Living Room Drive"),
        "{err}"
    );
}

#[tokio::test]
async fn a_profile_turned_away_stays_away() {
    let w = world().await;
    let pass = w.device.profiles_elsewhere().remove(0);
    w.device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, false)
        .await
        .unwrap();
    let id = w.other.host.profile_links()[0].id.clone();
    assert!(w.other.host.deny_profile_link(&id));
    assert!(w.other.host.profile_links().is_empty());

    let err = w
        .device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, false)
        .await
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("turned Maya from Living Room Drive away"),
        "{err}"
    );
    assert!(w.other.host.profile_views().is_empty());
}

#[tokio::test]
async fn removing_the_linked_profile_ends_its_sign_ins() {
    let w = world().await;
    let pass = w.device.profiles_elsewhere().remove(0);
    w.device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, true)
        .await
        .unwrap();
    let id = w.other.host.profile_links()[0].id.clone();
    w.other.host.approve_profile_link(&id).unwrap();
    let profile = w
        .device
        .use_profile_elsewhere(&pass.host_id, &pass.profile_id, true)
        .await
        .unwrap()
        .profile
        .unwrap();

    w.other.host.remove_profile(&profile.id).unwrap();
    // Acting as Maya is over: the drive answers as it would for any profile
    // removed, and keeps nothing of hers.
    let err = w.device.stars(None).await.unwrap_err();
    assert!(matches!(err.kind(), "signedout" | "denied"), "{err}");
    assert!(w.other.host.profile_views().is_empty());
}

#[tokio::test]
async fn a_profile_on_this_drive_is_not_offered_as_from_another() {
    let w = world().await;
    // Back on the home drive: Maya is this drive's own there.
    w.device
        .connect(w.home.host.host_id(), Some(&w.home.addr.to_string()))
        .await
        .unwrap();
    assert!(w.device.profiles_elsewhere().is_empty());
}
