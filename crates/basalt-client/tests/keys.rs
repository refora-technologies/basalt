//! Devices signing in with keys, against a real host over real TLS.
//!
//! Two kinds of test. Through the client, the way the apps do it: pairing with
//! a key, moving a device paired with a token across, a key the host has lost,
//! a key the device has lost. And underneath the client, speaking the
//! protocol by hand, the way someone trying their luck would: a signature from
//! one connection offered on another, for the wrong purpose, by a key nobody
//! paired, a session key vouched for by the wrong key or for the wrong host or
//! out of date, a profile sign-in used from another device.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use basalt_client::Basalt;
use basalt_host::{Host, HostConfig, server};
use basalt_net::framing::{call_json, call_unit};
use basalt_net::tls::{Trust, client_binding, client_config, sni_name};
use basalt_proto::msg::*;
use basalt_proto::{ErrorCode, Op, PROTOCOL_VERSION};
use basalt_trust::message::{Purpose, device_message};
use basalt_trust::{Kind, Payload, Signer, SoftwareKey};

fn unique(prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "basalt-{prefix}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
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
    fn store(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.json"))
    }

    fn pin(&self) -> Option<String> {
        self.host.pending_pairings().into_iter().find_map(|r| r.pin)
    }

    async fn pair(&self, client: &Basalt) {
        let requires_pin = client.begin_pairing(self.addr).await.unwrap();
        let pin = requires_pin.then(|| self.pin().expect("the host shows a PIN"));
        client.finish_pairing(pin.as_deref()).await.unwrap();
    }

    fn device(&self) -> basalt_host::registry::Device {
        let devices = self.host.devices();
        assert_eq!(devices.len(), 1, "one device paired");
        devices.into_iter().next().unwrap()
    }
}

async fn start_host() -> Fixture {
    let dir = unique("keys");
    let vault = dir.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(vault.join("notes.txt"), b"hello").unwrap();

    let config_path = dir.join("host.json");
    let mut config = HostConfig::create("keys-host").unwrap();
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

/// The store as JSON, for reading what a device kept and for changing it the
/// way a copied or restored file would be changed.
fn read_store(path: &PathBuf) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn write_store(path: &PathBuf, value: &serde_json::Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

// ---------------------------------------------------------------------------
// Through the client
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_new_device_pairs_with_its_key_and_keeps_no_token() {
    let fixture = start_host().await;
    let store = fixture.store("phone");
    let client = Basalt::open(store.clone()).unwrap();
    fixture.pair(&client).await;
    assert!(client.list("").await.is_ok());

    let kept = read_store(&store);
    let host = &kept["hosts"][0];
    assert_eq!(host["token"], "", "there never was a token");
    let key = host["key"].as_str().unwrap();
    assert!(!key.is_empty());

    let device = fixture.device();
    assert_eq!(device.public_key, key);
    assert!(device.token_retired);

    // The app opening again signs in with the key alone.
    drop(client);
    let again = Basalt::open(store).unwrap();
    again.connect_saved().await.unwrap();
    assert!(again.list("").await.is_ok());
}

#[tokio::test]
async fn a_device_paired_before_keys_moves_to_its_key_and_its_old_token_stops_working() {
    let fixture = start_host().await;
    let store = fixture.store("laptop");
    let old = Basalt::open_without_keys(store.clone()).unwrap();
    fixture.pair(&old).await;
    assert!(!fixture.device().keyed(), "paired with a token");
    drop(old);

    // Someone copies the file while it still holds the token.
    let stolen = fixture.store("stolen");
    std::fs::copy(&store, &stolen).unwrap();

    // The app is updated, and connects.
    let updated = Basalt::open(store.clone()).unwrap();
    updated.connect_saved().await.unwrap();
    assert!(updated.list("").await.is_ok());

    let device = fixture.device();
    assert!(device.keyed() && device.token_retired);
    let kept = read_store(&store);
    assert_eq!(kept["hosts"][0]["token"], "", "the token is let go");
    assert_eq!(kept["hosts"][0]["key"].as_str().unwrap(), device.public_key);

    // And the copy is worth nothing now.
    let thief = Basalt::open_without_keys(stolen).unwrap();
    let refused = thief.connect_saved().await.unwrap_err();
    assert_eq!(refused.kind(), "removed", "{refused}");

    // While the device itself goes on as before.
    drop(updated);
    let again = Basalt::open(store).unwrap();
    again.connect_saved().await.unwrap();
}

#[tokio::test]
async fn a_key_the_host_has_lost_falls_back_to_the_token_and_is_given_again() {
    let fixture = start_host().await;
    let store = fixture.store("laptop");
    let old = Basalt::open_without_keys(store.clone()).unwrap();
    fixture.pair(&old).await;
    drop(old);

    // The device believes the host has its key (say the host's files were
    // restored from before it was given it).
    let updated = Basalt::open(store.clone()).unwrap();
    let key = updated.device_key().await.unwrap().public_key().to_hex();
    drop(updated);
    let mut kept = read_store(&store);
    kept["hosts"][0]["key"] = serde_json::json!(key);
    write_store(&store, &kept);

    let updated = Basalt::open(store.clone()).unwrap();
    updated.connect_saved().await.unwrap();
    assert!(updated.list("").await.is_ok());
    let device = fixture.device();
    assert_eq!(device.public_key, key, "given the key again");
    assert!(device.token_retired);
    assert_eq!(read_store(&store)["hosts"][0]["token"], "");
}

#[tokio::test]
async fn a_device_whose_key_was_reset_is_asked_to_pair_again_and_says_why() {
    let fixture = start_host().await;
    let store = fixture.store("phone");
    let client = Basalt::open(store.clone()).unwrap();
    fixture.pair(&client).await;
    drop(client);

    // The key no longer opens: a chip reset, or files from another computer.
    let mut kept = read_store(&store);
    kept["device_key"]["sealed"] = serde_json::json!("dpapi:00");
    write_store(&store, &kept);

    let client = Basalt::open(store).unwrap();
    let refused = client.connect_saved().await.unwrap_err();
    assert_eq!(refused.kind(), "removed", "{refused}");
    assert!(
        refused.to_string().contains("security key was reset"),
        "{refused}"
    );
    assert!(client.known_hosts().is_empty(), "the pairing is dropped");

    // Pairing again works, with the new key, and is the same device.
    fixture.pair(&client).await;
    assert_eq!(fixture.host.devices().len(), 1);
}

#[tokio::test]
async fn a_removed_device_with_a_key_is_told_it_was_removed() {
    let fixture = start_host().await;
    let store = fixture.store("phone");
    let client = Basalt::open(store.clone()).unwrap();
    fixture.pair(&client).await;
    let device = fixture.device();
    assert!(fixture.host.revoke(&device.token_hash).unwrap());
    drop(client);

    let client = Basalt::open(store).unwrap();
    let refused = client.connect_saved().await.unwrap_err();
    assert_eq!(refused.kind(), "removed");
    assert!(
        refused.to_string().contains("removed this device"),
        "{refused}"
    );
}

#[tokio::test]
async fn many_connections_at_once_all_sign_in() {
    let fixture = start_host().await;
    let client = Arc::new(Basalt::open(fixture.store("phone")).unwrap());
    fixture.pair(&client).await;
    let mut lists = Vec::new();
    for _ in 0..12 {
        let client = Arc::clone(&client);
        lists.push(tokio::spawn(async move { client.list("").await }));
    }
    for list in lists {
        assert!(list.await.unwrap().is_ok());
    }
}

#[tokio::test]
async fn a_device_keeps_the_statements_made_about_it_and_they_are_taken_back_in_time() {
    let fixture = start_host().await;
    let store = fixture.store("phone");
    let client = Basalt::open(store.clone()).unwrap();
    fixture.pair(&client).await;
    drop(client);

    let client = Basalt::open(store.clone()).unwrap();
    client.connect_saved().await.unwrap();
    client.identity().await;
    let key = read_store(&store)["hosts"][0]["key"]
        .as_str()
        .unwrap()
        .to_string();

    let members = |path: &PathBuf| -> Vec<Payload> {
        read_store(path)["hosts"][0]["members"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|m| basalt_trust::statement::read_offer(m["payload"].as_str().unwrap()).unwrap())
            .collect()
    };

    // The household's, about this device's key, signed by the household.
    let kept = members(&store);
    assert_eq!(kept.len(), 1, "{kept:?}");
    let household = &kept[0];
    assert_eq!(household.profile, "");
    assert_eq!(household.subject, key);
    assert_eq!(Some(household.issuer.clone()), fixture.host.household_key());

    // Signing in to a profile adds the profile's.
    let maya = client
        .create_profile("Maya", "4821", 2, true)
        .await
        .unwrap();
    let kept = members(&store);
    assert_eq!(kept.len(), 2);
    let from_maya = kept.iter().find(|p| p.profile == maya.id).unwrap().clone();
    assert_ne!(
        from_maya.issuer, household.issuer,
        "Maya speaks with her own key"
    );

    // Signing out drops it here and takes it back at the host.
    client.sign_out_profile().await.unwrap();
    let kept = members(&store);
    assert_eq!(kept.len(), 1);
    assert!(
        fixture
            .host
            .revoked_statements()
            .contains(&from_maya.serial)
    );
    assert!(
        !fixture
            .host
            .revoked_statements()
            .contains(&household.serial)
    );

    // Removing the device takes back the household's.
    let device = fixture.device();
    fixture.host.revoke(&device.token_hash).unwrap();
    assert!(
        fixture
            .host
            .revoked_statements()
            .contains(&household.serial)
    );
}

#[tokio::test]
async fn a_statement_handed_over_on_a_background_connection_is_still_kept() {
    let fixture = start_host().await;
    let store = fixture.store("phone");
    let client = Basalt::open(store.clone()).unwrap();
    fixture.pair(&client).await;
    // The pairing connection signed in without a statement; the next ones the
    // pool opens are the first to sign in with the key.
    let client = Arc::new(client);
    let mut lists = Vec::new();
    for _ in 0..3 {
        let client = Arc::clone(&client);
        lists.push(tokio::spawn(async move { client.list("").await }));
    }
    for list in lists {
        list.await.unwrap().unwrap();
    }
    client.identity().await;
    let members = read_store(&store)["hosts"][0]["members"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(members.len(), 1, "the household's statement was kept");
}

// ---------------------------------------------------------------------------
// Underneath the client
// ---------------------------------------------------------------------------

type Tls = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

/// A connection to the host, greeted, and the id of the key it showed.
async fn raw(addr: SocketAddr, device_id: &str) -> (Tls, String) {
    let tcp = basalt_net::socket::connect(addr).await.unwrap();
    let (connector, verifier) = client_config(Trust::FirstContact);
    let mut stream = connector.connect(sni_name(), tcp).await.unwrap();
    let _: HelloResponse = call_json(
        &mut stream,
        Op::Hello,
        &HelloRequest {
            protocol: PROTOCOL_VERSION,
            device_name: "Hand-made".into(),
            device_id: device_id.into(),
        },
    )
    .await
    .unwrap();
    let host_id = verifier.seen_host_id().unwrap();
    (stream, host_id)
}

fn bound(stream: &Tls, purpose: Purpose, host_id: &str) -> Vec<u8> {
    let binding = client_binding(stream.get_ref().1).expect("TLS 1.3");
    device_message(purpose, &binding, host_id).unwrap()
}

/// Pairs by hand, with `key` or, without one, for a token. Returns the token.
async fn raw_pair(fixture: &Fixture, key: Option<&SoftwareKey>, device_id: &str) -> String {
    let (mut stream, host_id) = raw(fixture.addr, device_id).await;
    let nonce = basalt_net::pairing::random_nonce().unwrap();
    let begin: PairBeginResponse = call_json(
        &mut stream,
        Op::PairBegin,
        &PairBeginRequest {
            client_nonce: nonce.clone(),
            device_name: "Hand-made".into(),
            device_id: device_id.into(),
        },
    )
    .await
    .unwrap();
    let proof = begin.requires_pin.then(|| {
        basalt_net::pairing::compute_proof(
            &fixture.pin().unwrap(),
            &host_id,
            &nonce,
            &begin.server_nonce,
        )
        .unwrap()
    });
    let key_signature = key.map(|k| k.sign(&bound(&stream, Purpose::Pair, &host_id)).unwrap());
    let finish: PairFinishResponse = call_json(
        &mut stream,
        Op::PairFinish,
        &PairFinishRequest {
            request: begin.request,
            proof,
            device_name: "Hand-made".into(),
            key: key.map(|k| k.public_key().to_hex()),
            key_signature: key_signature.map(|s| s.to_hex()),
            key_kind: key.map(|_| KeyKind::File),
        },
    )
    .await
    .unwrap();
    finish.token
}

async fn auth(
    stream: &mut Tls,
    request: &AuthRequest,
) -> std::result::Result<AuthResponse, basalt_net::NetError> {
    call_json(stream, Op::Auth, request).await
}

fn by_key(key: &SoftwareKey, signature: basalt_trust::Signature) -> AuthRequest {
    AuthRequest {
        token: String::new(),
        key: Some(key.public_key().to_hex()),
        signature: Some(signature.to_hex()),
        session: None,
    }
}

fn code(result: std::result::Result<AuthResponse, basalt_net::NetError>) -> Option<ErrorCode> {
    result.err().and_then(|e| e.code())
}

const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test]
async fn a_signature_is_good_for_its_own_connection_and_nothing_else() {
    let fixture = start_host().await;
    let key = SoftwareKey::generate().unwrap();
    raw_pair(&fixture, Some(&key), ID_A).await;

    let (mut first, host_id) = raw(fixture.addr, ID_A).await;
    let request = by_key(
        &key,
        key.sign(&bound(&first, Purpose::Auth, &host_id)).unwrap(),
    );
    let signed_in = auth(&mut first, &request).await.unwrap();
    assert!(signed_in.retire_token);

    // The same request on another connection: refused, and not as "removed".
    let (mut second, _) = raw(fixture.addr, ID_A).await;
    assert_eq!(
        code(auth(&mut second, &request).await),
        Some(ErrorCode::Denied)
    );
    // The connection is still there to try again properly.
    let proper = by_key(
        &key,
        key.sign(&bound(&second, Purpose::Auth, &host_id)).unwrap(),
    );
    assert!(auth(&mut second, &proper).await.is_ok());

    // Signed for another purpose.
    let (mut third, _) = raw(fixture.addr, ID_A).await;
    let wrong = by_key(
        &key,
        key.sign(&bound(&third, Purpose::Enrol, &host_id)).unwrap(),
    );
    assert_eq!(
        code(auth(&mut third, &wrong).await),
        Some(ErrorCode::Denied)
    );

    // A key nobody paired, signing properly: the one unauthenticated case.
    let stranger = SoftwareKey::generate().unwrap();
    let (mut fourth, _) = raw(fixture.addr, ID_B).await;
    let unknown = by_key(
        &stranger,
        stranger
            .sign(&bound(&fourth, Purpose::Auth, &host_id))
            .unwrap(),
    );
    assert_eq!(
        code(auth(&mut fourth, &unknown).await),
        Some(ErrorCode::Unauthenticated)
    );

    // Someone else's key named, signed by the stranger.
    let posing = AuthRequest {
        key: Some(key.public_key().to_hex()),
        ..unknown.clone()
    };
    assert_eq!(
        code(auth(&mut fourth, &posing).await),
        Some(ErrorCode::Denied)
    );

    // Malformed keys and signatures.
    let garbage_key = AuthRequest {
        key: Some("00".into()),
        ..unknown.clone()
    };
    assert_eq!(
        code(auth(&mut fourth, &garbage_key).await),
        Some(ErrorCode::Denied)
    );
    let no_signature = AuthRequest {
        signature: None,
        ..request.clone()
    };
    assert_eq!(
        code(auth(&mut fourth, &no_signature).await),
        Some(ErrorCode::Denied)
    );

    // Nothing above opened the drive.
    let listed: std::result::Result<ListResponse, _> = call_json(
        &mut fourth,
        Op::List,
        &ListRequest {
            path: String::new(),
        },
    )
    .await;
    assert!(listed.is_err());
}

#[tokio::test]
async fn a_session_key_signs_in_only_when_its_own_device_vouches_for_it_here_and_now() {
    let fixture = start_host().await;
    let device = SoftwareKey::generate().unwrap();
    raw_pair(&fixture, Some(&device), ID_A).await;
    let session = SoftwareKey::generate().unwrap();

    let attempt = |issuer: &SoftwareKey, host: String, iat: i64, signer: &SoftwareKey| {
        let payload = Payload::new(
            Kind::Session,
            issuer.public_key(),
            session.public_key(),
            &host,
            "",
            iat,
        )
        .unwrap();
        let statement = basalt_trust::statement::sign(issuer, &payload).unwrap();
        (
            SignedStatement {
                payload: statement.payload,
                signature: statement.signature,
            },
            signer.public_key().clone(),
        )
    };

    let (mut stream, host_id) = raw(fixture.addr, ID_A).await;
    let request = |stream: &Tls, pass: SignedStatement, signer: &SoftwareKey| AuthRequest {
        token: String::new(),
        key: Some(device.public_key().to_hex()),
        signature: Some(
            signer
                .sign(&bound(stream, Purpose::Auth, &host_id))
                .unwrap()
                .to_hex(),
        ),
        session: Some(pass),
    };

    // Vouched for by another key.
    let stranger = SoftwareKey::generate().unwrap();
    let (pass, _) = attempt(&stranger, host_id.clone(), now(), &session);
    let r = request(&stream, pass, &session);
    assert_eq!(code(auth(&mut stream, &r).await), Some(ErrorCode::Denied));

    // For another host.
    let other_host = SoftwareKey::generate().unwrap().public_key().id();
    let (pass, _) = attempt(&device, other_host, now(), &session);
    let r = request(&stream, pass, &session);
    assert_eq!(code(auth(&mut stream, &r).await), Some(ErrorCode::Denied));

    // Out of date.
    let (pass, _) = attempt(&device, host_id.clone(), now() - 13 * 60 * 60, &session);
    let r = request(&stream, pass, &session);
    assert_eq!(code(auth(&mut stream, &r).await), Some(ErrorCode::Denied));

    // Fine, but signed by the device's key instead of the session key.
    let (pass, _) = attempt(&device, host_id.clone(), now(), &session);
    let r = request(&stream, pass.clone(), &device);
    assert_eq!(code(auth(&mut stream, &r).await), Some(ErrorCode::Denied));

    // A changed byte in the statement.
    let mut bent = pass.clone();
    let mut bytes = basalt_proto::hex::decode(&bent.payload).unwrap();
    let last = bytes.len() - 2;
    bytes[last] ^= 1;
    bent.payload = basalt_proto::hex::encode(&bytes);
    let r = request(&stream, bent, &session);
    assert_eq!(code(auth(&mut stream, &r).await), Some(ErrorCode::Denied));

    // And all of it right.
    let r = request(&stream, pass, &session);
    assert!(auth(&mut stream, &r).await.is_ok());
}

#[tokio::test]
async fn a_token_device_gives_its_key_and_the_token_is_retired_once_the_key_is_used() {
    let fixture = start_host().await;
    let token = raw_pair(&fixture, None, ID_A).await;
    assert!(!token.is_empty());
    let key = SoftwareKey::generate().unwrap();
    let with_token = AuthRequest {
        token: token.clone(),
        ..AuthRequest::default()
    };

    let (mut stream, host_id) = raw(fixture.addr, ID_A).await;
    auth(&mut stream, &with_token).await.unwrap();

    // A bad enrolment signature is refused, and changes nothing.
    let bad = EnrolRequest {
        key: key.public_key().to_hex(),
        signature: key
            .sign(&bound(&stream, Purpose::Auth, &host_id))
            .unwrap()
            .to_hex(),
        key_kind: None,
    };
    let refused = call_unit(&mut stream, Op::Enrol, &bad).await.unwrap_err();
    assert_eq!(refused.code(), Some(ErrorCode::Denied));
    assert!(!fixture.host.devices()[0].keyed());

    let enrol = EnrolRequest {
        key: key.public_key().to_hex(),
        signature: key
            .sign(&bound(&stream, Purpose::Enrol, &host_id))
            .unwrap()
            .to_hex(),
        key_kind: Some(KeyKind::System),
    };
    call_unit(&mut stream, Op::Enrol, &enrol).await.unwrap();

    // The token still works: the key has not been used yet.
    let (mut again, _) = raw(fixture.addr, ID_A).await;
    auth(&mut again, &with_token).await.unwrap();

    // The key is used; the token is retired.
    let (mut keyed, _) = raw(fixture.addr, ID_A).await;
    let request = by_key(
        &key,
        key.sign(&bound(&keyed, Purpose::Auth, &host_id)).unwrap(),
    );
    assert!(auth(&mut keyed, &request).await.unwrap().retire_token);
    // And a key-signed connection cannot give another key.
    let other = SoftwareKey::generate().unwrap();
    let swap = EnrolRequest {
        key: other.public_key().to_hex(),
        signature: other
            .sign(&bound(&keyed, Purpose::Enrol, &host_id))
            .unwrap()
            .to_hex(),
        key_kind: None,
    };
    let refused = call_unit(&mut keyed, Op::Enrol, &swap).await.unwrap_err();
    assert_eq!(refused.code(), Some(ErrorCode::Denied));

    let (mut late, _) = raw(fixture.addr, ID_A).await;
    assert_eq!(
        code(auth(&mut late, &with_token).await),
        Some(ErrorCode::Unauthenticated)
    );
}

#[tokio::test]
async fn a_profile_sign_in_works_only_on_the_device_it_was_given_to() {
    let fixture = start_host().await;
    let a = SoftwareKey::generate().unwrap();
    let b = SoftwareKey::generate().unwrap();
    raw_pair(&fixture, Some(&a), ID_A).await;
    raw_pair(&fixture, Some(&b), ID_B).await;

    let (mut on_a, host_id) = raw(fixture.addr, ID_A).await;
    let request = by_key(&a, a.sign(&bound(&on_a, Purpose::Auth, &host_id)).unwrap());
    auth(&mut on_a, &request).await.unwrap();
    let made: ProfileSession = call_json(
        &mut on_a,
        Op::ProfileCreate,
        &ProfileCreateRequest {
            name: "Maya".into(),
            pin: "4821".into(),
            color: 2,
            remember: true,
        },
    )
    .await
    .unwrap();

    let (mut on_b, _) = raw(fixture.addr, ID_B).await;
    let request = by_key(&b, b.sign(&bound(&on_b, Purpose::Auth, &host_id)).unwrap());
    auth(&mut on_b, &request).await.unwrap();
    let used: std::result::Result<ProfileUseResponse, _> = call_json(
        &mut on_b,
        Op::ProfileUse,
        &ProfileUseRequest {
            token: Some(made.token.clone()),
        },
    )
    .await;
    assert_eq!(used.unwrap_err().code(), Some(ErrorCode::SignedOut));

    // On its own device it still works.
    let (mut on_a, _) = raw(fixture.addr, ID_A).await;
    let request = by_key(&a, a.sign(&bound(&on_a, Purpose::Auth, &host_id)).unwrap());
    auth(&mut on_a, &request).await.unwrap();
    let used: ProfileUseResponse = call_json(
        &mut on_a,
        Op::ProfileUse,
        &ProfileUseRequest {
            token: Some(made.token),
        },
    )
    .await
    .unwrap();
    assert_eq!(used.profile.unwrap().name, "Maya");
}

#[tokio::test]
async fn a_device_with_a_key_cannot_take_another_devices_id() {
    let fixture = start_host().await;
    let a = SoftwareKey::generate().unwrap();
    let b = SoftwareKey::generate().unwrap();
    raw_pair(&fixture, Some(&a), ID_A).await;
    raw_pair(&fixture, Some(&b), ID_B).await;

    // B says it is A.
    let (mut stream, host_id) = raw(fixture.addr, ID_A).await;
    let request = by_key(
        &b,
        b.sign(&bound(&stream, Purpose::Auth, &host_id)).unwrap(),
    );
    auth(&mut stream, &request).await.unwrap();

    let devices = fixture.host.devices();
    let b_record = devices
        .iter()
        .find(|d| d.public_key == b.public_key().to_hex())
        .unwrap();
    assert_eq!(b_record.device_id, ID_B, "its id was settled with its key");
    assert_eq!(
        devices.iter().filter(|d| d.device_id == ID_A).count(),
        1,
        "only A is A"
    );
}

#[tokio::test]
async fn pairing_with_a_key_that_did_not_sign_the_pairing_uses_up_nothing() {
    let fixture = start_host().await;
    let key = SoftwareKey::generate().unwrap();
    let (mut stream, host_id) = raw(fixture.addr, ID_A).await;
    let nonce = basalt_net::pairing::random_nonce().unwrap();
    let begin: PairBeginResponse = call_json(
        &mut stream,
        Op::PairBegin,
        &PairBeginRequest {
            client_nonce: nonce.clone(),
            device_name: "Hand-made".into(),
            device_id: ID_A.into(),
        },
    )
    .await
    .unwrap();
    let proof = begin.requires_pin.then(|| {
        basalt_net::pairing::compute_proof(
            &fixture.pin().unwrap(),
            &host_id,
            &nonce,
            &begin.server_nonce,
        )
        .unwrap()
    });
    let mut request = PairFinishRequest {
        request: begin.request.clone(),
        proof,
        device_name: "Hand-made".into(),
        key: Some(key.public_key().to_hex()),
        // Signed for signing in, not for pairing.
        key_signature: Some(
            key.sign(&bound(&stream, Purpose::Auth, &host_id))
                .unwrap()
                .to_hex(),
        ),
        key_kind: None,
    };
    let refused: std::result::Result<PairFinishResponse, _> =
        call_json(&mut stream, Op::PairFinish, &request).await;
    assert_eq!(refused.unwrap_err().code(), Some(ErrorCode::Denied));
    assert!(fixture.host.devices().is_empty());
    assert_eq!(
        fixture.host.pending_pairings().len(),
        1,
        "the request stands"
    );

    // Signed properly, the same request completes.
    request.key_signature = Some(
        key.sign(&bound(&stream, Purpose::Pair, &host_id))
            .unwrap()
            .to_hex(),
    );
    let finished: PairFinishResponse = call_json(&mut stream, Op::PairFinish, &request)
        .await
        .unwrap();
    assert!(finished.token.is_empty());
    assert!(fixture.device().keyed());
}
