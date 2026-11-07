//! Sending to a device nearby by a code: a device that isn't on this host (a
//! guest's phone, a friend's laptop), on the same Wi-Fi. From 1.6.4.
//!
//! The sender shows a six-digit code; the receiver types it. Typing it is the
//! consent, and the proof: the two run SPAKE2 with the code, so only a device
//! that knows it ends up with their key, and someone listening learns nothing
//! to search the codes with. A wrong code is one guess, and the sender takes
//! only a few before the code is spent.
//!
//! ```text
//! receiver → broadcast :7744   [magic "BSLTn"][version][nonce]
//! sender   → receiver          [magic "BSLTn"][version][nonce] {"id","port"}
//! receiver → sender (TCP)      {"pake": A, "name": …}
//! sender   → receiver          {"pake": B, "proof": HMAC(K, "sender" ‖ A ‖ B)}
//! receiver → sender            {"proof": HMAC(K, "receiver" ‖ A ‖ B)}
//! sender   → receiver          {"offer": sealed}      the offer, locked with K
//! receiver → sender            {"answer": "done" | "declined" | "failed"}
//! ```
//!
//! The beacon says nothing about the device: a random id and a port. Who it
//! is comes only after the code, inside the sealed offer, which also carries
//! where its direct listener is and the key it proves there, so the files
//! themselves go over TLS pinned to that key (see [`crate::direct`]).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use basalt_proto::hex;
use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};
use ring::hmac;
use serde::{Deserialize, Serialize};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::mpsc;

use crate::direct::Endpoint;
use crate::{ClientError, Result};

/// Where senders listen for a receiver's question.
pub const NEARBY_PORT: u16 = 7744;
const MAGIC: &[u8; 5] = b"BSLTn";
const VERSION: u8 = 1;
/// Wrong codes a sender takes before its code is spent.
pub const MOST_TRIES: u32 = 5;
/// How long a receiver looks for senders.
pub const LOOK_FOR: Duration = Duration::from_secs(6);
/// How long each step between the two may take.
const STEP: Duration = Duration::from_secs(10);
const SENDER: &[u8] = b"basalt nearby sender";
const RECEIVER: &[u8] = b"basalt nearby receiver";

/// One file offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyFile {
    pub name: String,
    pub size: u64,
}

/// What the receiver gets once the code is proven: who sends, what, and
/// where to take it from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyOffer {
    /// The sending device's name, and kind.
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    pub files: Vec<NearbyFile>,
    /// Its direct listener, and what to give it (see [`crate::direct`]).
    pub endpoint: Endpoint,
    pub offer: String,
    pub token: String,
}

/// What happens on the sender's side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SenderEvent {
    /// The code was right: `to` is taking the files.
    Connected { to: String },
    /// A device tried a wrong code; `left` more are taken.
    WrongCode { left: u32 },
    /// Too many wrong codes: this one is spent.
    Spent,
    /// What the receiver said at the end: done, declined or failed.
    Answered { to: String, answer: String },
}

/// A six-digit code, at random.
pub fn new_code() -> String {
    let mut bytes = [0u8; 4];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000)
}

/// Sending with `code`: answers receivers looking, and gives `offer` to the
/// one that knows the code. Stops when dropped.
pub struct NearbySender {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for NearbySender {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl NearbySender {
    /// Starts answering on `NEARBY_PORT` (`port` in tests); events go to
    /// `events` as they happen.
    pub async fn start(
        code: &str,
        offer: NearbyOffer,
        events: mpsc::UnboundedSender<SenderEvent>,
        port: u16,
    ) -> Result<Self> {
        let code = digits(code)?;
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        let tcp_port = listener.local_addr()?.port();
        let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port))
            .await
            .map_err(|e| {
                ClientError::Config(format!(
                    "another device here is already sending with a code ({e})"
                ))
            })?;
        let id = new_code();
        let offer = Arc::new(offer);
        let task = tokio::spawn(async move {
            let answering = async {
                let mut buffer = [0u8; 64];
                loop {
                    let Ok((n, from)) = udp.recv_from(&mut buffer).await else {
                        continue;
                    };
                    if n < 14 || &buffer[..5] != MAGIC || buffer[5] != VERSION {
                        continue;
                    }
                    let mut reply = buffer[..14].to_vec();
                    reply.extend_from_slice(
                        serde_json::json!({ "id": id, "port": tcp_port })
                            .to_string()
                            .as_bytes(),
                    );
                    let _ = udp.send_to(&reply, from).await;
                }
            };
            let serving = async {
                let mut wrong = 0u32;
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        continue;
                    };
                    match tokio::time::timeout(
                        Duration::from_secs(6 * 60 * 60),
                        give(stream, &code, &offer, &events),
                    )
                    .await
                    {
                        Ok(Ok(true)) => {}
                        Ok(Ok(false)) => {
                            wrong += 1;
                            if wrong >= MOST_TRIES {
                                let _ = events.send(SenderEvent::Spent);
                                return;
                            }
                            let _ = events.send(SenderEvent::WrongCode {
                                left: MOST_TRIES - wrong,
                            });
                        }
                        // Gone half-way: not a guess at the code.
                        _ => {}
                    }
                }
            };
            tokio::select! {
                _ = answering => {}
                _ = serving => {}
            }
        });
        Ok(Self { task })
    }
}

/// One receiver: the code checked; if right, the offer given and its answer
/// awaited. False for a wrong code.
async fn give(
    stream: TcpStream,
    code: &str,
    offer: &NearbyOffer,
    events: &mpsc::UnboundedSender<SenderEvent>,
) -> Result<bool> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let hello: serde_json::Value = next_json(&mut lines).await?;
    let a = hex::decode(hello["pake"].as_str().unwrap_or_default())
        .map_err(|_| ClientError::Protocol("not a code's message".into()))?;
    let name = hello["name"].as_str().unwrap_or("A device").to_string();
    let (state, b) = Spake2::<Ed25519Group>::start_b(
        &Password::new(code.as_bytes()),
        &Identity::new(RECEIVER),
        &Identity::new(SENDER),
    );
    let key = state
        .finish(&a)
        .map_err(|e| ClientError::Protocol(format!("SPAKE2: {e:?}")))?;
    send_json(
        &mut write,
        &serde_json::json!({ "pake": hex::encode(&b), "proof": proof(&key, SENDER, &a, &b) }),
    )
    .await?;
    let back: serde_json::Value = next_json(&mut lines).await?;
    let theirs = back["proof"].as_str().unwrap_or_default();
    if !hex::constant_time_eq(proof(&key, RECEIVER, &a, &b).as_bytes(), theirs.as_bytes()) {
        return Ok(false);
    }
    let _ = events.send(SenderEvent::Connected { to: name.clone() });
    let sealed = seal(
        &key,
        &serde_json::to_vec(offer).expect("an offer serialises"),
    )?;
    send_json(&mut write, &serde_json::json!({ "offer": sealed })).await?;
    // The receiver says when it's done; a closed line is a failure.
    let answer =
        match tokio::time::timeout(Duration::from_secs(6 * 60 * 60), lines.next_line()).await {
            Ok(Ok(Some(line))) => serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v["answer"].as_str().map(str::to_string))
                .unwrap_or_else(|| "failed".into()),
            _ => "failed".into(),
        };
    let _ = events.send(SenderEvent::Answered { to: name, answer });
    Ok(true)
}

/// A receiver's line back to the sender, kept open until it has the files.
#[derive(Debug)]
pub struct NearbyLink {
    write: tokio::net::tcp::OwnedWriteHalf,
}

impl NearbyLink {
    /// Tells the sender how it ended: `done`, `declined` or `failed`.
    pub async fn answer(mut self, answer: &str) -> Result<()> {
        send_json(&mut self.write, &serde_json::json!({ "answer": answer })).await
    }
}

/// Finds the device sending with `code` on this Wi-Fi, proves the code with
/// it, and answers what it offers. `my_name` is shown to the sender. `port`
/// is [`NEARBY_PORT`] but in tests.
pub async fn receive(code: &str, my_name: &str, port: u16) -> Result<(NearbyOffer, NearbyLink)> {
    let code = digits(code)?;
    let senders = look(port, LOOK_FOR).await?;
    if senders.is_empty() {
        return Err(ClientError::Config(
            "no device sending with a code was found on this Wi-Fi".into(),
        ));
    }
    let mut wrong = false;
    for sender in senders {
        match tokio::time::timeout(STEP * 2, take(sender, &code, my_name)).await {
            Ok(Ok(Some(found))) => return Ok(found),
            Ok(Ok(None)) => wrong = true,
            _ => {}
        }
    }
    Err(ClientError::Config(if wrong {
        "that code isn't right: check it on the other device".into()
    } else {
        "the device sending with a code couldn't be reached".into()
    }))
}

/// The code with one sender: its offer and the line back, or None for a
/// code it doesn't share.
async fn take(
    sender: SocketAddr,
    code: &str,
    my_name: &str,
) -> Result<Option<(NearbyOffer, NearbyLink)>> {
    let stream = tokio::time::timeout(STEP, TcpStream::connect(sender))
        .await
        .map_err(|_| ClientError::Protocol("the sender didn't answer".into()))??;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let (state, a) = Spake2::<Ed25519Group>::start_a(
        &Password::new(code.as_bytes()),
        &Identity::new(RECEIVER),
        &Identity::new(SENDER),
    );
    send_json(
        &mut write,
        &serde_json::json!({ "pake": hex::encode(&a), "name": my_name }),
    )
    .await?;
    let answer: serde_json::Value = next_json(&mut lines).await?;
    let b = hex::decode(answer["pake"].as_str().unwrap_or_default())
        .map_err(|_| ClientError::Protocol("not a code's message".into()))?;
    let key = state
        .finish(&b)
        .map_err(|e| ClientError::Protocol(format!("SPAKE2: {e:?}")))?;
    let theirs = answer["proof"].as_str().unwrap_or_default();
    if !hex::constant_time_eq(proof(&key, SENDER, &a, &b).as_bytes(), theirs.as_bytes()) {
        // Not ours to prove anything to: a wrong code, or not this sender.
        let _ = send_json(&mut write, &serde_json::json!({ "proof": "" })).await;
        return Ok(None);
    }
    send_json(
        &mut write,
        &serde_json::json!({ "proof": proof(&key, RECEIVER, &a, &b) }),
    )
    .await?;
    let sealed: serde_json::Value = next_json(&mut lines).await?;
    let plain = open(&key, sealed["offer"].as_str().unwrap_or_default())?;
    let offer: NearbyOffer = serde_json::from_slice(&plain)
        .map_err(|e| ClientError::Protocol(format!("the offer: {e}")))?;
    Ok(Some((offer, NearbyLink { write })))
}

/// Senders answering on this network: asked a few times, every half second.
async fn look(port: u16, window: Duration) -> Result<Vec<SocketAddr>> {
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    udp.set_broadcast(true)?;
    let mut nonce = [0u8; 8];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce);
    let mut query = MAGIC.to_vec();
    query.push(VERSION);
    query.extend_from_slice(&nonce);
    // By the sender's id: one device answers on each of its networks, and
    // each try at it is a guess at the code.
    let mut found: Vec<(String, SocketAddr)> = Vec::new();
    let deadline = tokio::time::Instant::now() + window;
    let mut buffer = [0u8; 512];
    let mut asked = 0;
    while tokio::time::Instant::now() < deadline {
        if asked < 4 {
            let targets: Vec<SocketAddr> = std::iter::once(IpAddr::V4(Ipv4Addr::BROADCAST))
                .chain(std::iter::once(IpAddr::V4(Ipv4Addr::LOCALHOST)))
                .chain(subnet_broadcasts())
                .map(|ip| SocketAddr::new(ip, port))
                .collect();
            for target in targets {
                let _ = udp.send_to(&query, target).await;
            }
            asked += 1;
        }
        match tokio::time::timeout(Duration::from_millis(500), udp.recv_from(&mut buffer)).await {
            Ok(Ok((n, from))) if n > 14 && &buffer[..5] == MAGIC && buffer[6..14] == nonce => {
                let Ok(said) = serde_json::from_slice::<serde_json::Value>(&buffer[14..n]) else {
                    continue;
                };
                add(&mut found, &said, from);
                // One answered: a moment more for any other, then on.
                if found.len() == 1 {
                    let rest = tokio::time::Instant::now() + Duration::from_millis(700);
                    if rest < deadline {
                        let all = collect_more(&udp, &nonce, found, rest).await;
                        return Ok(all.into_iter().map(|(_, at)| at).collect());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(found.into_iter().map(|(_, at)| at).collect())
}

/// A sender's answer, once per sender: the first address it answered from
/// (loopback only when there is nothing else).
fn add(found: &mut Vec<(String, SocketAddr)>, said: &serde_json::Value, from: SocketAddr) {
    let Some(tcp) = said["port"].as_u64().and_then(|p| u16::try_from(p).ok()) else {
        return;
    };
    let id = said["id"].as_str().unwrap_or_default().to_string();
    let at = SocketAddr::new(from.ip(), tcp);
    match found.iter_mut().find(|(seen, _)| *seen == id) {
        Some(known) if known.1.ip().is_loopback() && !at.ip().is_loopback() => known.1 = at,
        Some(_) => {}
        None => found.push((id, at)),
    }
}

async fn collect_more(
    udp: &UdpSocket,
    nonce: &[u8; 8],
    mut found: Vec<(String, SocketAddr)>,
    until: tokio::time::Instant,
) -> Vec<(String, SocketAddr)> {
    let mut buffer = [0u8; 512];
    while let Ok(Ok((n, from))) = tokio::time::timeout_at(until, udp.recv_from(&mut buffer)).await {
        if n <= 14 || &buffer[..5] != MAGIC || &buffer[6..14] != nonce {
            continue;
        }
        if let Ok(said) = serde_json::from_slice::<serde_json::Value>(&buffer[14..n]) {
            add(&mut found, &said, from);
        }
    }
    found
}

/// Each local IPv4 network's broadcast address, taken as a /24: Wi-Fi that
/// drops 255.255.255.255 still passes its own.
fn subnet_broadcasts() -> Vec<IpAddr> {
    basalt_net::discovery::local_addresses()
        .into_iter()
        .filter_map(|ip| match ip {
            IpAddr::V4(v4) => {
                let [a, b, c, _] = v4.octets();
                Some(IpAddr::V4(Ipv4Addr::new(a, b, c, 255)))
            }
            IpAddr::V6(_) => None,
        })
        .collect()
}

fn digits(code: &str) -> Result<String> {
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if code.len() != 6 {
        return Err(ClientError::Config("a code is six digits".into()));
    }
    Ok(code)
}

fn proof(key: &[u8], side: &[u8], a: &[u8], b: &[u8]) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let mut context = hmac::Context::with_key(&key);
    context.update(side);
    context.update(a);
    context.update(b);
    hex::encode(context.sign().as_ref())
}

/// The key that locks the offer: made from SPAKE2's, for this alone.
fn offer_key(key: &[u8]) -> LessSafeKey {
    let mac = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, key),
        b"basalt nearby offer",
    );
    LessSafeKey::new(
        UnboundKey::new(&CHACHA20_POLY1305, &mac.as_ref()[..32]).expect("a 32-byte key"),
    )
}

fn seal(key: &[u8], plain: &[u8]) -> Result<String> {
    let mut data = plain.to_vec();
    offer_key(key)
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key([0; 12]),
            Aad::from(b"offer"),
            &mut data,
        )
        .map_err(|_| ClientError::Protocol("the offer couldn't be locked".into()))?;
    Ok(hex::encode(&data))
}

fn open(key: &[u8], sealed: &str) -> Result<Vec<u8>> {
    let mut data = hex::decode(sealed).map_err(|_| ClientError::Protocol("not an offer".into()))?;
    let plain = offer_key(key)
        .open_in_place(
            Nonce::assume_unique_for_key([0; 12]),
            Aad::from(b"offer"),
            &mut data,
        )
        .map_err(|_| ClientError::Protocol("the offer was changed on the way".into()))?;
    Ok(plain.to_vec())
}

async fn next_json(
    lines: &mut tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
) -> Result<serde_json::Value> {
    let line = tokio::time::timeout(STEP, lines.next_line())
        .await
        .map_err(|_| ClientError::Protocol("the other device stopped answering".into()))??
        .ok_or_else(|| ClientError::Protocol("the other device hung up".into()))?;
    if line.len() > 64 * 1024 {
        return Err(ClientError::Protocol("too long a message".into()));
    }
    serde_json::from_str(&line).map_err(|e| ClientError::Protocol(format!("not a message: {e}")))
}

async fn send_json(
    write: &mut tokio::net::tcp::OwnedWriteHalf,
    value: &serde_json::Value,
) -> Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    write.write_all(line.as_bytes()).await?;
    write.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer() -> NearbyOffer {
        NearbyOffer {
            from: "Maya's phone".into(),
            form: Some("phone".into()),
            files: vec![NearbyFile {
                name: "Holiday 2026.mkv".into(),
                size: 4_200,
            }],
            endpoint: Endpoint {
                addresses: vec!["127.0.0.1".into()],
                port: 1234,
                key: "ab".repeat(32),
            },
            offer: "o1".into(),
            token: "t1".into(),
        }
    }

    #[tokio::test]
    async fn the_right_code_gets_the_offer_and_the_sender_hears_the_end() {
        let (tx, mut events) = mpsc::unbounded_channel();
        let port = 47_744;
        let _sender = NearbySender::start("482 915", offer(), tx, port)
            .await
            .unwrap();
        let (got, link) = receive("482915", "Kasun's phone", port).await.unwrap();
        assert_eq!(got, offer());
        assert_eq!(
            events.recv().await,
            Some(SenderEvent::Connected {
                to: "Kasun's phone".into()
            })
        );
        link.answer("done").await.unwrap();
        assert_eq!(
            events.recv().await,
            Some(SenderEvent::Answered {
                to: "Kasun's phone".into(),
                answer: "done".into()
            })
        );
    }

    #[tokio::test]
    async fn a_wrong_code_gets_nothing_and_too_many_spend_it() {
        let (tx, mut events) = mpsc::unbounded_channel();
        let port = 47_745;
        let _sender = NearbySender::start("111111", offer(), tx, port)
            .await
            .unwrap();
        for left in (1..MOST_TRIES).rev() {
            let wrong = receive("222222", "Somebody", port).await;
            let said = wrong.unwrap_err().to_string();
            assert!(said.contains("isn't right"), "{said}");
            assert_eq!(events.recv().await, Some(SenderEvent::WrongCode { left }));
        }
        assert!(receive("333333", "Somebody", port).await.is_err());
        assert_eq!(events.recv().await, Some(SenderEvent::Spent));
        // Spent: even the right code finds nobody now.
        assert!(receive("111111", "Somebody", port).await.is_err());
    }

    #[test]
    fn a_code_is_six_digits_and_a_changed_offer_is_refused() {
        assert_eq!(new_code().len(), 6);
        assert!(digits("12345").is_err());
        assert_eq!(digits("482 915").unwrap(), "482915");
        let sealed = seal(&[7; 32], b"hello").unwrap();
        assert_eq!(open(&[7; 32], &sealed).unwrap(), b"hello");
        assert!(open(&[8; 32], &sealed).is_err());
    }
}
