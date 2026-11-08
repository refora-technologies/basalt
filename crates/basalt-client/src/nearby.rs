//! Sharing with devices nearby, without a host: two people in a café, a
//! guest's phone at home. From 1.6.4.
//!
//! A device that is ready to receive answers on the Wi-Fi with its name, its
//! kind and a short id ("K7HM": two phones called "Pixel 8" are told apart).
//! A device sharing lists them; one tapped is sent the offer, and the person
//! there answers Accept or Decline, as within a home.
//!
//! Either of them can ask for a code every time ("Always ask for a code"):
//! a file sent to the wrong "Pixel 8", and accepted there by a stranger,
//! can't be taken back. Then, once accepted, the receiver shows six digits
//! and the sender types them, so the two have to talk to each other first.
//! The two run SPAKE2 with the code, so only the device shown it gets the
//! files, and someone listening learns nothing to try codes with. A wrong
//! code is one guess; after five the offer ends.
//!
//! ```text
//! sender   → broadcast :7745   [magic "BSLTr"][version][nonce]
//! receiver → sender            [magic][version][nonce] {"id","name","form","port","key","code"}
//! sender   → receiver (TLS, pinned to "key")
//!                              {"from": {"id","name","form"}, "files": […], "code": bool}
//! receiver → sender            {"answer": "accepted" | "declined" | "code"}
//!   code:      sender → {"pake": A}; receiver → {"pake": B, "proof"}; sender → {"proof"}
//!              wrong: receiver → {"wrong": left}, and again with a new A
//! then, for each file:
//!   receiver → {"want": n}; sender → {"file": n, "length": L} and L bytes, or {"no": why}
//! receiver → sender            {"answer": "done" | "failed"}
//! ```
//!
//! The files come down the same line the offer went up, from the sender: the
//! receiver never has to reach the sender. A phone that joined another
//! device's own Wi-Fi accepts no connection there, and a computer's firewall
//! may let none in; the line the sender opened is the one that works.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use basalt_proto::hex;
use ring::hmac;
use serde::{Deserialize, Serialize};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot};

use crate::client::{Cancel, Progress, ProgressFn, TransferKind};
use crate::{ClientError, Result};

/// Where a device ready for nearby shares answers.
pub const READY_PORT: u16 = 7745;
const MAGIC: &[u8; 5] = b"BSLTr";
const VERSION: u8 = 1;
/// Wrong codes taken before the offer ends.
pub const MOST_TRIES: u32 = 5;
/// How long a look for devices nearby lasts.
pub const LOOK_FOR: Duration = Duration::from_millis(2_500);
/// How long each step between the two may take.
const STEP: Duration = Duration::from_secs(15);
/// How long an offer waits for its answer, and a code to be typed.
const ANSWER_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long the files may take, once agreed.
const TAKE_WAIT: Duration = Duration::from_secs(12 * 60 * 60);
const SENDER: &[u8] = b"basalt nearby sender";
const RECEIVER: &[u8] = b"basalt nearby receiver";

/// The letters a short id is made of: none that look like another (no 0
/// and O, 1 and I and L, 2 and Z, 5 and S, 8 and B, 6 and G).
const ID_LETTERS: &[u8] = b"ACDEFHJKMNPRTUVWXY34679";

/// A device's short id, from its own random bytes: four of [`ID_LETTERS`],
/// the same every time for the same bytes.
pub fn short_id(seed: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, seed);
    let mut n = u64::from_le_bytes(digest.as_ref()[..8].try_into().expect("eight bytes"));
    (0..4)
        .map(|_| {
            let letter = ID_LETTERS[(n % ID_LETTERS.len() as u64) as usize];
            n /= ID_LETTERS.len() as u64;
            letter as char
        })
        .collect()
}

/// Every Basalt Wi-Fi's name starts so: Android lets an app name its own
/// Wi-Fi only "DIRECT-" and two letters, then what it likes.
pub const WIFI_PREFIX: &str = "DIRECT-bs-";

/// The Wi-Fi a device ready to receive hosts for devices with no network in
/// common: "DIRECT-bs-K7HM Pixel 8", at most 32 bytes, its name made plain.
pub fn wifi_name(me: &Me) -> String {
    let plain: String = me
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut name = format!("{WIFI_PREFIX}{} {}", me.id, plain.trim());
    name.truncate(32);
    name.trim_end().to_string()
}

/// Its passphrase, from its id alone, so a device that finds it can join.
/// Not a secret: who may take files is settled by the code, always asked
/// for this way (anyone nearby could join a Wi-Fi like this).
pub fn wifi_passphrase(id: &str) -> String {
    let digest = ring::digest::digest(
        &ring::digest::SHA256,
        format!("basalt nearby wifi {id}").as_bytes(),
    );
    format!("bslt-{id}-{}", &hex::encode(digest.as_ref())[..10])
}

/// The id and name in a Basalt Wi-Fi's name, if it is one.
pub fn wifi_device(ssid: &str) -> Option<(String, String)> {
    let rest = ssid.strip_prefix(WIFI_PREFIX)?;
    let (id, name) = rest.split_once(' ').unwrap_or((rest, ""));
    (id.len() == 4 && id.bytes().all(|c| ID_LETTERS.contains(&c)))
        .then(|| (id.to_string(), name.to_string()))
}

/// A six-digit code, at random.
pub fn new_code() -> String {
    let mut bytes = [0u8; 4];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000)
}

/// This device, as others nearby see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
}

/// One file offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyFile {
    pub name: String,
    pub size: u64,
}

/// A device nearby that is ready to receive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyDevice {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    /// Where it answered, and its listener's port and key.
    pub address: String,
    pub port: u16,
    pub key: String,
    /// It asks for a code every time.
    pub code: bool,
}

// ---------------------------------------------------------------------------
// Ready to receive
// ---------------------------------------------------------------------------

/// What happens on a device ready to receive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ReadyEvent {
    /// Someone nearby wants to send files: answer with [`Ready::answer`].
    /// `code`: a code will be asked for once accepted.
    Offer {
        ask: String,
        from: Me,
        files: Vec<NearbyFile>,
        code: bool,
    },
    /// Accepted, and a code is needed: show it, for the sender to type.
    Code { ask: String, code: String },
    /// The sender typed a wrong code; `left` more tries.
    WrongCode { ask: String, left: u32 },
    /// Agreed: take each file with [`Ready::link`], then say how it went with [`Ready::finish`].
    Take { ask: String },
    /// The sender went, or the tries ran out, before it was agreed.
    Gone { ask: String, why: String },
}

type Waiting = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;
type Finishing = Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>;
type Links = Arc<Mutex<HashMap<String, Arc<NearbyLink>>>>;
type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// The line to a sender whose offer was agreed: each file is asked for, and
/// comes, down it.
pub struct NearbyLink {
    io: tokio::sync::Mutex<LinkIo>,
}

struct LinkIo {
    lines: tokio::io::Lines<BufReader<BoxRead>>,
    write: BoxWrite,
}

impl NearbyLink {
    /// Takes file `file` of the offer into `out`, as it comes.
    pub async fn take_file(
        &self,
        file: usize,
        name: &str,
        out: std::fs::File,
        progress: Option<ProgressFn>,
        cancel: Option<Cancel>,
    ) -> Result<u64> {
        let mut io = self.io.lock().await;
        send_json(&mut io.write, &serde_json::json!({ "want": file })).await?;
        let said = next_json(&mut io.lines, TAKE_WAIT).await?;
        let Some(length) = said["length"].as_u64() else {
            return Err(ClientError::Protocol(format!(
                "the device that sent it said: {}",
                said["no"].as_str().unwrap_or("no")
            )));
        };
        let reader = io.lines.get_mut();
        let mut out = tokio::fs::File::from_std(out);
        let mut buffer = vec![0u8; 256 * 1024];
        let mut done = 0u64;
        while done < length {
            if cancel.as_ref().is_some_and(Cancel::is_cancelled) {
                return Err(ClientError::Protocol("cancelled".into()));
            }
            let want = buffer.len().min((length - done) as usize);
            let n = tokio::time::timeout(STEP * 4, reader.read(&mut buffer[..want]))
                .await
                .map_err(|_| {
                    ClientError::Protocol("the device that sent it stopped part-way".into())
                })??;
            if n == 0 {
                return Err(ClientError::Protocol(
                    "the device that sent it stopped part-way".into(),
                ));
            }
            out.write_all(&buffer[..n]).await?;
            done += n as u64;
            if let Some(report) = &progress {
                report(Progress {
                    kind: TransferKind::Download,
                    path: name.to_string(),
                    transferred: done,
                    total: length,
                });
            }
        }
        out.flush().await?;
        out.sync_all().await?;
        Ok(done)
    }
}

/// Ready to receive from devices nearby, until dropped.
pub struct Ready {
    task: tokio::task::JoinHandle<()>,
    answers: Waiting,
    finishes: Finishing,
    links: Links,
}

impl Drop for Ready {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Ready {
    /// Answers looks on `port` ([`READY_PORT`] but in tests) as `me`;
    /// `always_code` asks every sender for a code.
    pub async fn start(
        me: Me,
        always_code: bool,
        events: mpsc::UnboundedSender<ReadyEvent>,
        port: u16,
    ) -> Result<Self> {
        let identity = basalt_net::identity::HostIdentity::generate("basalt-nearby")?;
        let acceptor = basalt_net::tls::server_config(&identity)?;
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        let tcp_port = listener.local_addr()?.port();
        let udp = bind_port(port).await?;
        let answers: Waiting = Arc::default();
        let finishes: Finishing = Arc::default();
        let links: Links = Arc::default();
        let said = serde_json::json!({
            "id": me.id,
            "name": me.name,
            "form": me.form,
            "port": tcp_port,
            "key": identity.host_id,
            "code": always_code,
        })
        .to_string();
        let task = {
            let answers = Arc::clone(&answers);
            let finishes = Arc::clone(&finishes);
            let links = Arc::clone(&links);
            tokio::spawn(async move {
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
                        reply.extend_from_slice(said.as_bytes());
                        let _ = udp.send_to(&reply, from).await;
                    }
                };
                let serving = async {
                    let mut asks = 0u64;
                    loop {
                        let Ok((stream, _)) = listener.accept().await else {
                            continue;
                        };
                        asks += 1;
                        let ask = format!("n{asks}-{}", new_code());
                        let acceptor = acceptor.clone();
                        let events = events.clone();
                        let answers = Arc::clone(&answers);
                        let finishes = Arc::clone(&finishes);
                        let links = Arc::clone(&links);
                        tokio::spawn(async move {
                            let Ok(Ok(tls)) =
                                tokio::time::timeout(STEP, acceptor.accept(stream)).await
                            else {
                                return;
                            };
                            let ended = receive(
                                tls,
                                &ask,
                                always_code,
                                &events,
                                &answers,
                                &finishes,
                                &links,
                            )
                            .await;
                            answers.lock().expect("answers lock").remove(&ask);
                            finishes.lock().expect("finishes lock").remove(&ask);
                            links.lock().expect("links lock").remove(&ask);
                            if let Err(e) = ended {
                                let _ = events.send(ReadyEvent::Gone {
                                    ask,
                                    why: e.to_string(),
                                });
                            }
                        });
                    }
                };
                tokio::select! {
                    _ = answering => {}
                    _ = serving => {}
                }
            })
        };
        Ok(Self {
            task,
            answers,
            finishes,
            links,
        })
    }

    /// Accept or Decline, for an offer asked as `ask`. False if it's gone.
    pub fn answer(&self, ask: &str, accept: bool) -> bool {
        match self.answers.lock().expect("answers lock").remove(ask) {
            Some(waiting) => waiting.send(accept).is_ok(),
            None => false,
        }
    }

    /// How taking the files went: `done` or `failed`, told to the sender.
    pub fn finish(&self, ask: &str, answer: &str) {
        if let Some(waiting) = self.finishes.lock().expect("finishes lock").remove(ask) {
            let _ = waiting.send(answer.to_string());
        }
    }

    /// The line to take an agreed offer's files down.
    pub fn link(&self, ask: &str) -> Option<Arc<NearbyLink>> {
        self.links.lock().expect("links lock").get(ask).cloned()
    }
}

/// One sender, on the receiving side: its offer, the person's answer, a
/// code if asked for, and where to take the files.
async fn receive<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    ask: &str,
    always_code: bool,
    events: &mpsc::UnboundedSender<ReadyEvent>,
    answers: &Waiting,
    finishes: &Finishing,
    links: &Links,
) -> Result<()> {
    let (read, write) = tokio::io::split(stream);
    let mut lines = BufReader::new(Box::new(read) as BoxRead).lines();
    let mut write: BoxWrite = Box::new(write);
    let hello: serde_json::Value = next_json(&mut lines, STEP).await?;
    let from: Me = serde_json::from_value(hello["from"].clone())
        .map_err(|_| ClientError::Protocol("not an offer".into()))?;
    let files: Vec<NearbyFile> = serde_json::from_value(hello["files"].clone())
        .map_err(|_| ClientError::Protocol("not an offer".into()))?;
    let code_needed = always_code || hello["code"].as_bool().unwrap_or(false);

    let (tx, rx) = oneshot::channel();
    answers
        .lock()
        .expect("answers lock")
        .insert(ask.to_string(), tx);
    let _ = events.send(ReadyEvent::Offer {
        ask: ask.to_string(),
        from,
        files,
        code: code_needed,
    });
    // The sender hanging up meanwhile ends it too.
    let accepted = tokio::select! {
        said = tokio::time::timeout(ANSWER_WAIT, rx) => matches!(said, Ok(Ok(true))),
        _ = lines.next_line() => {
            return Err(ClientError::Protocol("the sender took it back".into()));
        }
    };
    if !accepted {
        send_json(&mut write, &serde_json::json!({ "answer": "declined" })).await?;
        return Ok(());
    }

    if code_needed {
        let code = new_code();
        let _ = events.send(ReadyEvent::Code {
            ask: ask.to_string(),
            code: code.clone(),
        });
        send_json(&mut write, &serde_json::json!({ "answer": "code" })).await?;
        let mut tries = 0;
        loop {
            let said: serde_json::Value = next_json(&mut lines, ANSWER_WAIT).await?;
            let a = hex::decode(said["pake"].as_str().unwrap_or_default())
                .map_err(|_| ClientError::Protocol("not a code's message".into()))?;
            let (state, b) = Spake2::<Ed25519Group>::start_b(
                &Password::new(code.as_bytes()),
                &Identity::new(SENDER),
                &Identity::new(RECEIVER),
            );
            let key = state
                .finish(&a)
                .map_err(|e| ClientError::Protocol(format!("SPAKE2: {e:?}")))?;
            send_json(
                &mut write,
                &serde_json::json!({ "pake": hex::encode(&b), "proof": proof(&key, RECEIVER, &a, &b) }),
            )
            .await?;
            let back: serde_json::Value = next_json(&mut lines, STEP).await?;
            let theirs = back["proof"].as_str().unwrap_or_default();
            if hex::constant_time_eq(proof(&key, SENDER, &a, &b).as_bytes(), theirs.as_bytes()) {
                break;
            }
            tries += 1;
            let left = MOST_TRIES.saturating_sub(tries);
            send_json(&mut write, &serde_json::json!({ "wrong": left })).await?;
            let _ = events.send(ReadyEvent::WrongCode {
                ask: ask.to_string(),
                left,
            });
            if left == 0 {
                return Err(ClientError::Config(
                    "too many wrong codes: it was stopped".into(),
                ));
            }
        }
    } else {
        send_json(&mut write, &serde_json::json!({ "answer": "accepted" })).await?;
    }

    // Agreed: the files come down this line, as each is asked for.
    let link = Arc::new(NearbyLink {
        io: tokio::sync::Mutex::new(LinkIo { lines, write }),
    });
    let (tx, rx) = oneshot::channel();
    finishes
        .lock()
        .expect("finishes lock")
        .insert(ask.to_string(), tx);
    links
        .lock()
        .expect("links lock")
        .insert(ask.to_string(), Arc::clone(&link));
    let _ = events.send(ReadyEvent::Take {
        ask: ask.to_string(),
    });
    let answer = tokio::time::timeout(TAKE_WAIT, rx)
        .await
        .ok()
        .and_then(|got| got.ok())
        .unwrap_or_else(|| "failed".into());
    let mut io = link.io.lock().await;
    send_json(&mut io.write, &serde_json::json!({ "answer": answer })).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Finding devices ready nearby
// ---------------------------------------------------------------------------

/// The devices ready to receive on this Wi-Fi, each once. `port` is
/// [`READY_PORT`] but in tests.
pub async fn find(port: u16, window: Duration) -> Result<Vec<NearbyDevice>> {
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    udp.set_broadcast(true)?;
    let mut nonce = [0u8; 8];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce);
    let mut query = MAGIC.to_vec();
    query.push(VERSION);
    query.extend_from_slice(&nonce);
    let mut found: Vec<NearbyDevice> = Vec::new();
    let deadline = tokio::time::Instant::now() + window;
    let mut buffer = [0u8; 1024];
    let mut asked = 0;
    let mut next_ask = tokio::time::Instant::now();
    while tokio::time::Instant::now() < deadline {
        if asked < 3 && tokio::time::Instant::now() >= next_ask {
            let targets: Vec<SocketAddr> = std::iter::once(IpAddr::V4(Ipv4Addr::BROADCAST))
                .chain(std::iter::once(IpAddr::V4(Ipv4Addr::LOCALHOST)))
                .chain(subnet_broadcasts())
                .map(|ip| SocketAddr::new(ip, port))
                .collect();
            for target in targets {
                let _ = udp.send_to(&query, target).await;
            }
            // Broadcasts are dropped on some Wi-Fi (a phone's chip, a router
            // keeping devices apart): every neighbour asked directly too, once.
            if asked == 0 {
                for neighbour in neighbours() {
                    let _ = udp.send_to(&query, SocketAddr::new(neighbour, port)).await;
                }
            }
            asked += 1;
            next_ask = tokio::time::Instant::now() + Duration::from_millis(600);
        }
        let wait = Duration::from_millis(200);
        if let Ok(Ok((n, from))) = tokio::time::timeout(wait, udp.recv_from(&mut buffer)).await
            && n > 14
            && &buffer[..5] == MAGIC
            && buffer[6..14] == nonce
            && let Ok(said) = serde_json::from_slice::<serde_json::Value>(&buffer[14..n])
        {
            add(&mut found, &said, from);
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(found)
}

/// A device's answer, once per device: the first address it answered from
/// (loopback only when there is nothing else).
fn add(found: &mut Vec<NearbyDevice>, said: &serde_json::Value, from: SocketAddr) {
    let Some(port) = said["port"].as_u64().and_then(|p| u16::try_from(p).ok()) else {
        return;
    };
    let (Some(id), Some(name), Some(key)) = (
        said["id"].as_str(),
        said["name"].as_str(),
        said["key"].as_str(),
    ) else {
        return;
    };
    let device = NearbyDevice {
        id: id.chars().take(8).collect(),
        name: name.chars().take(80).collect(),
        form: said["form"].as_str().map(str::to_string),
        address: from.ip().to_string(),
        port,
        key: key.to_string(),
        code: said["code"].as_bool().unwrap_or(false),
    };
    match found
        .iter_mut()
        .find(|d| d.id == device.id && d.key == device.key)
    {
        Some(known) => {
            if known
                .address
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
                && !from.ip().is_loopback()
            {
                known.address = device.address;
            }
        }
        None => found.push(device),
    }
}

// ---------------------------------------------------------------------------
// Sending to one
// ---------------------------------------------------------------------------

/// What the device sent to said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Said {
    /// Accepted: the files are being taken. Wait for the end with [`Offering::end`].
    Accepted,
    /// Declined.
    Declined,
    /// Accepted, and a code is wanted: the one shown there, given with [`Offering::code`].
    Code,
}

/// An offer to a device nearby, while it is answered.
pub struct Offering {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<TlsStream>>>,
    write: tokio::io::WriteHalf<TlsStream>,
}

/// A file being sent: its length, and its bytes from the start.
pub type Source = Box<dyn AsyncRead + Send + Unpin>;

type TlsStream = tokio_rustls::client::TlsStream<TcpStream>;

/// Offers `files` to `device`, as `me`. `always_code`: this side asks for a
/// code too. Waits for the person there to answer; once agreed, the files go
/// with [`Offering::serve`].
pub async fn offer(
    device: &NearbyDevice,
    me: &Me,
    files: &[NearbyFile],
    always_code: bool,
) -> Result<(Said, Offering)> {
    let at: IpAddr = device
        .address
        .parse()
        .map_err(|_| ClientError::Protocol("that device has no address".into()))?;
    // Tried a few times: a Wi-Fi just joined (a device's own) takes a moment
    // before this device's connections go over it.
    let mut tries = 0;
    let tcp = loop {
        tries += 1;
        match tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect(SocketAddr::new(at, device.port)),
        )
        .await
        {
            Ok(Ok(tcp)) => break tcp,
            _ if tries < 4 => tokio::time::sleep(Duration::from_millis(1_500)).await,
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => {
                return Err(ClientError::Config(format!(
                    "couldn't reach {}",
                    device.name
                )));
            }
        }
    };
    let (connector, _) =
        basalt_net::tls::client_config(basalt_net::tls::Trust::Pinned(device.key.clone()));
    let tls = tokio::time::timeout(STEP, connector.connect(basalt_net::tls::sni_name(), tcp))
        .await
        .map_err(|_| ClientError::Config(format!("{} didn't answer", device.name)))??;
    let (read, mut write) = tokio::io::split(tls);
    let mut lines = BufReader::new(read).lines();
    send_json(
        &mut write,
        &serde_json::json!({ "from": me, "files": files, "code": always_code }),
    )
    .await?;
    let answer: serde_json::Value = next_json(&mut lines, ANSWER_WAIT).await?;
    let said = match answer["answer"].as_str() {
        Some("accepted") => Said::Accepted,
        Some("code") => Said::Code,
        _ => Said::Declined,
    };
    Ok((said, Offering { lines, write }))
}

/// What came of a code typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CodeSaid {
    /// Right: the files are being taken.
    Right,
    /// Wrong: `left` more tries.
    Wrong { left: u32 },
}

impl Offering {
    /// The code shown on the other device, as typed here.
    pub async fn code(&mut self, code: &str) -> Result<CodeSaid> {
        let code = digits(code)?;
        let (state, a) = Spake2::<Ed25519Group>::start_a(
            &Password::new(code.as_bytes()),
            &Identity::new(SENDER),
            &Identity::new(RECEIVER),
        );
        send_json(
            &mut self.write,
            &serde_json::json!({ "pake": hex::encode(&a) }),
        )
        .await?;
        let answer: serde_json::Value = next_json(&mut self.lines, STEP).await?;
        let b = hex::decode(answer["pake"].as_str().unwrap_or_default())
            .map_err(|_| ClientError::Protocol("not a code's message".into()))?;
        let key = state
            .finish(&b)
            .map_err(|e| ClientError::Protocol(format!("SPAKE2: {e:?}")))?;
        let theirs = answer["proof"].as_str().unwrap_or_default();
        let right =
            hex::constant_time_eq(proof(&key, RECEIVER, &a, &b).as_bytes(), theirs.as_bytes());
        // Proven back only when right: a wrong code proves nothing.
        let mine = if right {
            proof(&key, SENDER, &a, &b)
        } else {
            String::new()
        };
        send_json(&mut self.write, &serde_json::json!({ "proof": mine })).await?;
        if !right {
            let said: serde_json::Value = next_json(&mut self.lines, STEP).await?;
            let left = said["wrong"].as_u64().unwrap_or(0) as u32;
            return Ok(CodeSaid::Wrong { left });
        }
        Ok(CodeSaid::Right)
    }

    /// Sends each file as the other device asks for it (`open` gives its
    /// length and bytes), telling `progress` the bytes sent so far, until it
    /// says how it ended: `done` or `failed`.
    pub async fn serve<F, Fut>(mut self, open: F, progress: impl Fn(u64)) -> String
    where
        F: Fn(usize) -> Fut,
        Fut: std::future::Future<Output = std::io::Result<(u64, Source)>>,
    {
        let mut sent = 0u64;
        loop {
            let said = match next_json(&mut self.lines, TAKE_WAIT).await {
                Ok(said) => said,
                Err(_) => return "failed".into(),
            };
            let Some(file) = said["want"].as_u64() else {
                return said["answer"].as_str().unwrap_or("failed").to_string();
            };
            let (length, mut source) = match open(file as usize).await {
                Ok(opened) => opened,
                Err(e) => {
                    if send_json(&mut self.write, &serde_json::json!({ "no": e.to_string() }))
                        .await
                        .is_err()
                    {
                        return "failed".into();
                    }
                    continue;
                }
            };
            if send_json(
                &mut self.write,
                &serde_json::json!({ "file": file, "length": length }),
            )
            .await
            .is_err()
            {
                return "failed".into();
            }
            let mut buffer = vec![0u8; 256 * 1024];
            let mut left = length;
            while left > 0 {
                let want = buffer.len().min(left as usize);
                let n = match source.read(&mut buffer[..want]).await {
                    Ok(0) | Err(_) => return "failed".into(),
                    Ok(n) => n,
                };
                if self.write.write_all(&buffer[..n]).await.is_err() {
                    return "failed".into();
                }
                left -= n as u64;
                sent += n as u64;
                progress(sent);
            }
            if self.write.flush().await.is_err() {
                return "failed".into();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The parts both sides use
// ---------------------------------------------------------------------------

/// The ready port, tried for a second: one just stopped frees it a moment later.
async fn bind_port(port: u16) -> Result<UdpSocket> {
    let mut tries = 0;
    loop {
        match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).await {
            Ok(udp) => return Ok(udp),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && tries < 10 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                return Err(ClientError::Config(format!(
                    "something else on this device is using Basalt's nearby port ({port}): close it and try again"
                )));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Every other address of each local IPv4 network, taken as a /24.
fn neighbours() -> Vec<IpAddr> {
    let mut all = Vec::new();
    for ip in basalt_net::discovery::local_addresses() {
        let IpAddr::V4(v4) = ip else { continue };
        if v4.is_loopback() || v4.is_link_local() {
            continue;
        }
        let [a, b, c, mine] = v4.octets();
        for d in 1..=254u8 {
            if d != mine {
                all.push(IpAddr::V4(Ipv4Addr::new(a, b, c, d)));
            }
        }
    }
    all
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

async fn next_json<R: AsyncRead + Unpin>(
    lines: &mut tokio::io::Lines<BufReader<R>>,
    wait: Duration,
) -> Result<serde_json::Value> {
    let line = tokio::time::timeout(wait, lines.next_line())
        .await
        .map_err(|_| ClientError::Protocol("the other device stopped answering".into()))??
        .ok_or_else(|| ClientError::Protocol("the other device hung up".into()))?;
    if line.len() > 64 * 1024 {
        return Err(ClientError::Protocol("too long a message".into()));
    }
    serde_json::from_str(&line).map_err(|e| ClientError::Protocol(format!("not a message: {e}")))
}

async fn send_json<W: AsyncWrite + Unpin>(write: &mut W, value: &serde_json::Value) -> Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    write.write_all(line.as_bytes()).await?;
    write.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(id: &str, name: &str) -> Me {
        Me {
            id: id.into(),
            name: name.into(),
            form: Some("phone".into()),
        }
    }

    /// The bytes of the one file offered.
    fn body() -> Vec<u8> {
        (0..700_000u32).map(|i| (i % 239) as u8).collect()
    }

    fn files() -> Vec<NearbyFile> {
        vec![NearbyFile {
            name: "Holiday 2026.mkv".into(),
            size: 700_000,
        }]
    }

    /// What the sender opens when the file is asked for.
    async fn open(file: usize) -> std::io::Result<(u64, Source)> {
        if file != 0 {
            return Err(std::io::Error::other("no such file"));
        }
        let bytes = body();
        Ok((
            bytes.len() as u64,
            Box::new(std::io::Cursor::new(bytes)) as Source,
        ))
    }

    async fn found(port: u16, id: &str) -> NearbyDevice {
        let all = find(port, Duration::from_millis(1_500)).await.unwrap();
        all.into_iter()
            .find(|d| d.id == id)
            .expect("the ready device is found")
    }

    async fn next(events: &mut mpsc::UnboundedReceiver<ReadyEvent>) -> ReadyEvent {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("an event in time")
            .expect("an event")
    }

    /// Takes the one file down the agreed line, and checks it.
    async fn take_it(ready: &Ready, ask: &str, name: &str) {
        let link = ready.link(ask).expect("a line to take it down");
        let into =
            std::env::temp_dir().join(format!("basalt-nearby-{name}-{}", std::process::id()));
        let out = std::fs::File::create(&into).unwrap();
        let bytes = link
            .take_file(0, "Holiday 2026.mkv", out, None, None)
            .await
            .unwrap();
        assert_eq!(bytes, 700_000);
        assert_eq!(std::fs::read(&into).unwrap(), body(), "the same bytes");
        let _ = std::fs::remove_file(into);
    }

    #[test]
    fn a_short_id_is_four_letters_that_cannot_be_mistaken_and_stays_the_same() {
        let id = short_id(b"this phone");
        assert_eq!(id.len(), 4);
        assert!(id.bytes().all(|c| ID_LETTERS.contains(&c)), "{id}");
        assert_eq!(id, short_id(b"this phone"));
        assert_ne!(id, short_id(b"another phone"));
    }

    #[test]
    fn a_devices_own_wifi_is_named_for_it_and_read_back() {
        let ssid = wifi_name(&me("K7HM", "Maya’s very long phone name here"));
        assert!(ssid.starts_with("DIRECT-bs-K7HM Maya_s"), "{ssid}");
        assert!(ssid.len() <= 32);
        assert_eq!(
            wifi_device(&ssid).map(|(id, _)| id),
            Some("K7HM".to_string())
        );
        assert_eq!(wifi_device("DIRECT-xy-Printer"), None);
        assert_eq!(wifi_device("Home Wi-Fi"), None);
        let pass = wifi_passphrase("K7HM");
        assert!(pass.len() >= 8 && pass.len() <= 63);
        assert_eq!(pass, wifi_passphrase("K7HM"), "the same on both sides");
    }

    #[tokio::test]
    async fn a_ready_device_is_found_offered_accepted_and_given_the_file_down_the_same_line() {
        let port = 47_745;
        let (tx, mut events) = mpsc::unbounded_channel();
        let ready = Ready::start(me("K7HM", "Sam's phone"), false, tx, port)
            .await
            .unwrap();
        let device = found(port, "K7HM").await;
        assert_eq!(device.name, "Sam's phone");
        assert!(!device.code);

        let sending = tokio::spawn(async move {
            let (said, offering) = offer(&device, &me("ACDE", "Maya's laptop"), &files(), false)
                .await
                .unwrap();
            let sent = Arc::new(Mutex::new(0u64));
            let counted = Arc::clone(&sent);
            let end = offering
                .serve(open, move |bytes| *counted.lock().unwrap() = bytes)
                .await;
            let sent = *sent.lock().unwrap();
            (said, end, sent)
        });
        let ReadyEvent::Offer {
            ask,
            from,
            files: offered,
            code,
        } = next(&mut events).await
        else {
            panic!("an offer first");
        };
        assert_eq!(from.id, "ACDE");
        assert_eq!(offered, files());
        assert!(!code);
        assert!(ready.answer(&ask, true));
        assert!(matches!(next(&mut events).await, ReadyEvent::Take { .. }));
        take_it(&ready, &ask, "plain").await;
        ready.finish(&ask, "done");
        let (said, end, sent) = sending.await.unwrap();
        assert_eq!(said, Said::Accepted);
        assert_eq!(end, "done");
        assert_eq!(sent, 700_000, "the sender counts what it sent");
    }

    #[tokio::test]
    async fn declined_is_said_to_the_sender_and_nothing_is_given() {
        let port = 47_746;
        let (tx, mut events) = mpsc::unbounded_channel();
        let ready = Ready::start(me("MNPR", "Pixel 8"), false, tx, port)
            .await
            .unwrap();
        let device = found(port, "MNPR").await;
        let sending = tokio::spawn(async move {
            offer(&device, &me("ACDE", "Maya's laptop"), &files(), false)
                .await
                .unwrap()
                .0
        });
        let ReadyEvent::Offer { ask, .. } = next(&mut events).await else {
            panic!("an offer");
        };
        assert!(ready.answer(&ask, false));
        assert_eq!(sending.await.unwrap(), Said::Declined);
        assert!(ready.link(&ask).is_none(), "no line to take anything down");
    }

    #[tokio::test]
    async fn with_a_code_asked_the_files_go_only_after_the_right_one() {
        let port = 47_747;
        let (tx, mut events) = mpsc::unbounded_channel();
        // The receiver asks for a code every time.
        let ready = Ready::start(me("TUVW", "Pixel 8"), true, tx, port)
            .await
            .unwrap();
        let device = found(port, "TUVW").await;
        assert!(device.code, "it says so when found");
        let (shown_tx, shown_rx) = oneshot::channel::<String>();
        let sending = tokio::spawn(async move {
            let (said, mut offering) =
                offer(&device, &me("ACDE", "Maya's laptop"), &files(), false)
                    .await
                    .unwrap();
            assert_eq!(said, Said::Code);
            let shown = shown_rx.await.unwrap();
            let mistyped = format!("{:06}", (shown.parse::<u32>().unwrap() + 1) % 1_000_000);
            let wrong = offering.code(&mistyped).await.unwrap();
            let right = offering.code(&shown).await.unwrap();
            (wrong, right, offering.serve(open, |_| {}).await)
        });
        let ReadyEvent::Offer { ask, code, .. } = next(&mut events).await else {
            panic!("an offer");
        };
        assert!(code);
        assert!(ready.answer(&ask, true));
        let ReadyEvent::Code { code: shown, .. } = next(&mut events).await else {
            panic!("a code to show");
        };
        assert!(
            ready.link(&ask).is_none(),
            "nothing to take before the code"
        );
        shown_tx.send(shown).unwrap();
        assert!(
            matches!(
                next(&mut events).await,
                ReadyEvent::WrongCode { left: 4, .. }
            ),
            "a wrong code first"
        );
        assert!(
            matches!(next(&mut events).await, ReadyEvent::Take { .. }),
            "agreed after the right code"
        );
        take_it(&ready, &ask, "coded").await;
        ready.finish(&ask, "done");
        let (wrong, right, end) = sending.await.unwrap();
        assert_eq!(wrong, CodeSaid::Wrong { left: 4 });
        assert_eq!(right, CodeSaid::Right);
        assert_eq!(end, "done");
    }

    #[tokio::test]
    async fn an_offer_taken_back_while_asked_leaves_nothing_to_accept() {
        let port = 47_749;
        let (tx, mut events) = mpsc::unbounded_channel();
        let ready = Ready::start(me("HJKM", "Pixel 8"), false, tx, port)
            .await
            .unwrap();
        let device = found(port, "HJKM").await;
        let sending = tokio::spawn(async move {
            offer(&device, &me("ACDE", "Maya's laptop"), &files(), false).await
        });
        let ReadyEvent::Offer { ask, .. } = next(&mut events).await else {
            panic!("an offer");
        };
        // Cancel on the sender: its side of the line goes.
        sending.abort();
        assert!(
            matches!(next(&mut events).await, ReadyEvent::Gone { ask: gone, .. } if gone == ask),
            "the question goes on this side too"
        );
        assert!(!ready.answer(&ask, true), "nothing left to accept");
    }

    #[tokio::test]
    async fn the_sender_asking_for_a_code_is_enough() {
        let port = 47_748;
        let (tx, mut events) = mpsc::unbounded_channel();
        let ready = Ready::start(me("XY34", "Pixel 8"), false, tx, port)
            .await
            .unwrap();
        let device = found(port, "XY34").await;
        let sending = tokio::spawn(async move {
            offer(&device, &me("ACDE", "Maya's laptop"), &files(), true)
                .await
                .unwrap()
                .0
        });
        let ReadyEvent::Offer { ask, code, .. } = next(&mut events).await else {
            panic!("an offer");
        };
        assert!(code, "the sender's setting reaches the receiver");
        assert!(ready.answer(&ask, true));
        assert_eq!(sending.await.unwrap(), Said::Code);
    }
}
