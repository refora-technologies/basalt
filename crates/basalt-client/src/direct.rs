//! Files that live on a device, sent straight to another device.
//!
//! A file on the drive needs none of this: the device that takes it reads it
//! from the host. A photo in a phone's gallery, or a file on a computer's
//! desktop, is on neither the host nor the receiver, so it goes across the
//! Wi-Fi from one device to the other, without the host in the middle.
//!
//! The sender listens. Its listener has a key of its own, made when it
//! starts and kept only in memory; its addresses, port and key travel inside
//! the offer, which the host carries between the two (so the host vouches for
//! who sent it). The receiver connects, accepts only that key, gives the
//! offer's one-time secret and the file's number, and gets the bytes. A
//! secret that is wrong, or an offer withdrawn or expired, gets nothing.
//!
//! The wire, inside TLS: the receiver writes one line of JSON,
//! `{"offer","token","file"}`; the sender answers `ok <bytes>` and the bytes,
//! or `no <why>`.
//!
//! A line that drops part-way is taken up again (1.6.4): the receiver asks
//! `"from"`, the bytes it already has, and a sender that can answers
//! `ok <bytes> from <n>` and sends the rest. One before 1.6.4 ignores it and
//! sends it all, and the receiver starts its copy again.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::client::{Cancel, Progress, ProgressFn, TransferKind};
use crate::{ClientError, Result};

/// Where a sender listens: what the receiver needs to reach it and to know
/// it is the right one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub addresses: Vec<String>,
    pub port: u16,
    /// The listener's key, as a host id is: what the receiver accepts.
    pub key: String,
}

/// Opens one of the files a share offers, by what the app gave for it: a
/// path on a computer, a phone's content URI.
pub type Opener = Arc<dyn Fn(&str) -> std::io::Result<std::fs::File> + Send + Sync>;

/// A file on the drive, passed on as it comes from the host: its size, and
/// its bytes from the offset asked. For a device nearby that isn't on the
/// host; its source is offered as `drive:<path>`.
pub type Relay = Arc<
    dyn Fn(
            String,
            u64,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::io::Result<(
                            u64,
                            Box<dyn tokio::io::AsyncRead + Send + Unpin>,
                        )>,
                    > + Send,
            >,
        > + Send
        + Sync,
>;

/// The start of a source that is a file on the drive, relayed from the host.
pub const DRIVE_SOURCE: &str = "drive:";

/// How long a share can be taken after it is offered.
const SHARE_LASTS: Duration = Duration::from_secs(30 * 60);
/// The longest a receiver may take to say what it wants.
const ASK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long each of a sender's addresses is tried.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
/// The largest request line a receiver may send.
const MAX_ASK_BYTES: usize = 1024;

struct Shared {
    token: String,
    sources: Vec<String>,
    until: Instant,
}

/// This device's listener for files it offers.
pub struct DirectServer {
    port: u16,
    key: String,
    shares: Arc<Mutex<HashMap<String, Shared>>>,
    relay: Arc<Mutex<Option<Relay>>>,
}

#[derive(Deserialize)]
struct Ask {
    offer: String,
    token: String,
    file: usize,
    /// The bytes the receiver already has: the rest is sent.
    #[serde(default)]
    from: u64,
}

/// How long a share cut off part-way is tried again, from where it got to,
/// before it is given up: a phone's Wi-Fi blinks, a laptop sleeps a moment.
const RESUME_FOR: Duration = Duration::from_secs(120);
/// The wait between tries.
const RESUME_EVERY: Duration = Duration::from_secs(2);

impl DirectServer {
    /// Starts listening on every address of this device, on a port the
    /// system picks, with a key made now.
    pub async fn start(opener: Opener) -> Result<Arc<Self>> {
        Self::start_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED), opener).await
    }

    /// The same, on one address only: tests listen on loopback.
    pub async fn start_on(ip: IpAddr, opener: Opener) -> Result<Arc<Self>> {
        let identity = basalt_net::identity::HostIdentity::generate("basalt-device")?;
        let acceptor = basalt_net::tls::server_config(&identity)?;
        let listener = tokio::net::TcpListener::bind(SocketAddr::new(ip, 0)).await?;
        let port = listener.local_addr()?.port();
        let server = Arc::new(Self {
            port,
            key: identity.host_id.clone(),
            shares: Arc::new(Mutex::new(HashMap::new())),
            relay: Arc::new(Mutex::new(None)),
        });
        let shares = Arc::clone(&server.shares);
        let relay = Arc::clone(&server.relay);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let acceptor = acceptor.clone();
                let shares = Arc::clone(&shares);
                let opener = Arc::clone(&opener);
                let relay = relay.lock().expect("relay lock").clone();
                tokio::spawn(async move {
                    if let Ok(Ok(tls)) =
                        tokio::time::timeout(ASK_TIMEOUT, acceptor.accept(stream)).await
                    {
                        let _ = serve(tls, shares, opener, relay).await;
                    }
                });
            }
        });
        Ok(server)
    }

    /// Where to reach this listener now: this device's addresses on the
    /// networks it is on, which change as it moves.
    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            addresses: basalt_net::discovery::local_addresses()
                .into_iter()
                .map(|a| a.to_string())
                .collect(),
            port: self.port,
            key: self.key.clone(),
        }
    }

    /// Offers `sources` (in order) under `offer`: the secret a receiver
    /// gives to take them.
    pub fn offer(&self, offer: &str, sources: Vec<String>) -> String {
        let mut bytes = [0u8; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
            .expect("the system's randomness");
        let token = basalt_proto::hex::encode(&bytes);
        let mut shares = self.shares.lock().expect("shares lock");
        let now = Instant::now();
        shares.retain(|_, s| s.until > now);
        shares.insert(
            offer.to_string(),
            Shared {
                token: token.clone(),
                sources,
                until: now + SHARE_LASTS,
            },
        );
        token
    }

    /// How files on the drive are passed on (`drive:<path>` sources).
    pub fn set_relay(&self, relay: Relay) {
        *self.relay.lock().expect("relay lock") = Some(relay);
    }

    /// Takes an offer back: nobody can take it any more.
    pub fn withdraw(&self, offer: &str) {
        self.shares.lock().expect("shares lock").remove(offer);
    }

    #[cfg(test)]
    fn port(&self) -> u16 {
        self.port
    }
}

async fn serve<S>(
    stream: S,
    shares: Arc<Mutex<HashMap<String, Shared>>>,
    opener: Opener,
    relay: Option<Relay>,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read.take(MAX_ASK_BYTES as u64));
    let mut line = String::new();
    tokio::time::timeout(ASK_TIMEOUT, read.read_line(&mut line))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "no question"))??;
    let ask = serde_json::from_str::<Ask>(line.trim()).ok();
    let from = ask.as_ref().map_or(0, |a| a.from);
    let source = ask.and_then(|ask| {
        let shares = shares.lock().expect("shares lock");
        let shared = shares.get(&ask.offer)?;
        // Compared in full every time: the secret is the only thing that
        // stands between a stranger on the Wi-Fi and the file.
        let right = same(shared.token.as_bytes(), ask.token.as_bytes());
        (right && shared.until > Instant::now())
            .then(|| shared.sources.get(ask.file).cloned())
            .flatten()
    });
    let Some(source) = source else {
        write.write_all(b"no that isn't offered\n").await?;
        return write.shutdown().await;
    };
    // A file on the drive: passed on from the host as it comes.
    if let Some(path) = source.strip_prefix(DRIVE_SOURCE) {
        let Some(relay) = relay else {
            write
                .write_all(b"no it can't be passed on from here\n")
                .await?;
            return write.shutdown().await;
        };
        let (length, mut reader) = match relay(path.to_string(), from).await {
            Ok(opened) => opened,
            Err(e) => {
                write.write_all(format!("no {e}\n").as_bytes()).await?;
                return write.shutdown().await;
            }
        };
        if from > 0 && from <= length {
            write
                .write_all(format!("ok {length} from {from}\n").as_bytes())
                .await?;
        } else {
            write.write_all(format!("ok {length}\n").as_bytes()).await?;
        }
        tokio::io::copy(&mut reader, &mut write).await?;
        return write.shutdown().await;
    }
    let opened = {
        let opener = Arc::clone(&opener);
        tokio::task::spawn_blocking(move || opener(&source))
            .await
            .map_err(std::io::Error::other)?
    };
    let file = match opened {
        Ok(file) => file,
        Err(e) => {
            write.write_all(format!("no {e}\n").as_bytes()).await?;
            return write.shutdown().await;
        }
    };
    let length = file.metadata()?.len();
    let mut file = tokio::fs::File::from_std(file);
    if from > 0 && from <= length {
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(from)).await?;
        write
            .write_all(format!("ok {length} from {from}\n").as_bytes())
            .await?;
    } else {
        write.write_all(format!("ok {length}\n").as_bytes()).await?;
    }
    tokio::io::copy(&mut file, &mut write).await?;
    write.shutdown().await
}

/// Whether two secrets are the same, taking as long whatever they hold.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Takes file number `file` of `offer` from the sender at `endpoint`, into
/// `out`. Each of its addresses is tried in turn; the first that answers
/// with the right key is used. Cut off part-way (either side's Wi-Fi gone
/// a moment), it is tried again for [`RESUME_FOR`] from where it got to.
#[allow(clippy::too_many_arguments)]
pub async fn fetch(
    endpoint: &Endpoint,
    offer: &str,
    token: &str,
    file: usize,
    name: &str,
    out: std::fs::File,
    progress: Option<ProgressFn>,
    cancel: Option<Cancel>,
) -> Result<u64> {
    let mut have = 0u64;
    let mut moved_since = Instant::now();
    loop {
        let before = have;
        let tried = fetch_once(
            endpoint, offer, token, file, name, &out, &progress, &cancel, &mut have,
        )
        .await;
        let error = match tried {
            Ok(bytes) => return Ok(bytes),
            // Never reached at all: said at once, so the sender can send it
            // through the host instead. Only a share under way is taken up.
            Err(e) if !resumable(&e) || have == 0 => return Err(e),
            Err(e) => e,
        };
        if cancel.as_ref().is_some_and(Cancel::is_cancelled) {
            return Err(ClientError::Protocol("cancelled".into()));
        }
        // Counted from the last time bytes came: a slow line that keeps
        // moving is never given up on.
        if have > before {
            moved_since = Instant::now();
        }
        if moved_since.elapsed() > RESUME_FOR {
            return Err(error);
        }
        tracing::info!("a share stopped at {have} bytes ({error}); trying again");
        tokio::time::sleep(RESUME_EVERY).await;
    }
}

/// Whether a fetch that failed this way is worth trying again: the line,
/// not the sender saying no.
fn resumable(error: &ClientError) -> bool {
    match error {
        ClientError::Protocol(why) => why.contains("stopped part-way"),
        ClientError::Config(why) => why.contains("couldn't reach") || why.contains("didn't answer"),
        _ => true,
    }
}

/// One try at each of the sender's addresses, from `have` bytes on.
#[allow(clippy::too_many_arguments)]
async fn fetch_once(
    endpoint: &Endpoint,
    offer: &str,
    token: &str,
    file: usize,
    name: &str,
    out: &std::fs::File,
    progress: &Option<ProgressFn>,
    cancel: &Option<Cancel>,
    have: &mut u64,
) -> Result<u64> {
    let mut last = ClientError::Protocol("the device that sent it has no address".into());
    for address in &endpoint.addresses {
        let Ok(ip) = address.parse::<IpAddr>() else {
            continue;
        };
        match fetch_from(
            SocketAddr::new(ip, endpoint.port),
            endpoint,
            offer,
            token,
            file,
            name,
            out,
            progress,
            cancel,
            have,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            // Reached, and refused or cut off: another address won't help.
            Err(e @ ClientError::Protocol(_)) => return Err(e),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[allow(clippy::too_many_arguments)]
async fn fetch_from(
    at: SocketAddr,
    endpoint: &Endpoint,
    offer: &str,
    token: &str,
    file: usize,
    name: &str,
    out: &std::fs::File,
    progress: &Option<ProgressFn>,
    cancel: &Option<Cancel>,
    have: &mut u64,
) -> Result<u64> {
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(at))
        .await
        .map_err(|_| {
            ClientError::Config(format!("couldn't reach the device that sent it at {at}"))
        })??;
    let (connector, _) =
        basalt_net::tls::client_config(basalt_net::tls::Trust::Pinned(endpoint.key.clone()));
    let tls = tokio::time::timeout(
        CONNECT_TIMEOUT,
        connector.connect(basalt_net::tls::sni_name(), tcp),
    )
    .await
    .map_err(|_| ClientError::Config(format!("the device at {at} didn't answer")))??;
    let (read, mut write) = tokio::io::split(tls);
    let ask = serde_json::json!({ "offer": offer, "token": token, "file": file, "from": *have });
    write.write_all(format!("{ask}\n").as_bytes()).await?;
    let mut read = BufReader::new(read);
    let mut line = String::new();
    read.read_line(&mut line).await?;
    let line = line.trim();
    let (length, from): (u64, u64) = match line.strip_prefix("ok ") {
        Some(said) => {
            let oddly = || ClientError::Protocol("the device that sent it answered oddly".into());
            let mut words = said.split(' ');
            let length = words
                .next()
                .and_then(|n| n.parse().ok())
                .ok_or_else(oddly)?;
            // "from <n>": the rest. Without it, all of it, from the start.
            let from = match (words.next(), words.next()) {
                (Some("from"), Some(n)) => n.parse().map_err(|_| oddly())?,
                _ => 0,
            };
            (length, from)
        }
        None => {
            let why = line.strip_prefix("no ").unwrap_or(line);
            return Err(ClientError::Protocol(format!(
                "the device that sent it said: {why}"
            )));
        }
    };
    let mut out = tokio::fs::File::from_std(out.try_clone()?);
    {
        use tokio::io::AsyncSeekExt;
        if from == 0 && *have > 0 {
            // A sender that can't take it up again: the copy starts over.
            out.set_len(0).await?;
        }
        out.seek(std::io::SeekFrom::Start(from)).await?;
    }
    *have = from;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut done = from;
    while done < length {
        if cancel.as_ref().is_some_and(Cancel::is_cancelled) {
            return Err(ClientError::Protocol("cancelled".into()));
        }
        let want = buffer.len().min((length - done) as usize);
        let n = read.read(&mut buffer[..want]).await?;
        if n == 0 {
            return Err(ClientError::Protocol(
                "the device that sent it stopped part-way".into(),
            ));
        }
        out.write_all(&buffer[..n]).await?;
        done += n as u64;
        *have = done;
        if let Some(report) = progress {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn opener(dir: std::path::PathBuf) -> Opener {
        Arc::new(move |source: &str| std::fs::File::open(dir.join(source)))
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("basalt-direct-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn loopback(dir: std::path::PathBuf) -> (Arc<DirectServer>, Endpoint) {
        let server = DirectServer::start_on(IpAddr::V4(Ipv4Addr::LOCALHOST), opener(dir))
            .await
            .unwrap();
        let endpoint = Endpoint {
            addresses: vec!["127.0.0.1".into()],
            port: server.port(),
            key: server.endpoint().key,
        };
        (server, endpoint)
    }

    #[tokio::test]
    async fn a_file_offered_goes_across_whole() {
        let dir = temp("whole");
        let body: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("photo.jpg"), &body).unwrap();
        let (server, endpoint) = loopback(dir.clone()).await;
        let token = server.offer("o1", vec!["photo.jpg".into()]);

        let into = dir.join("received.jpg");
        let out = std::fs::File::create(&into).unwrap();
        let seen = Arc::new(Mutex::new(0u64));
        let heard = Arc::clone(&seen);
        let report: ProgressFn =
            Arc::new(move |p: Progress| *heard.lock().unwrap() = p.transferred);
        let bytes = fetch(
            &endpoint,
            "o1",
            &token,
            0,
            "photo.jpg",
            out,
            Some(report),
            None,
        )
        .await
        .unwrap();
        assert_eq!(bytes, body.len() as u64);
        assert_eq!(std::fs::read(&into).unwrap(), body);
        assert_eq!(
            *seen.lock().unwrap(),
            body.len() as u64,
            "progress to the end"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_share_cut_off_is_taken_up_from_where_it_got_to() {
        let dir = temp("resume");
        let body: Vec<u8> = (0..2_000_000u32).map(|i| (i % 241) as u8).collect();
        std::fs::write(dir.join("film.mp4"), &body).unwrap();
        let (server, endpoint) = loopback(dir.clone()).await;
        let token = server.offer("o4", vec!["film.mp4".into()]);
        // The first 700 000 bytes came before the line dropped.
        let into = dir.join("received.mp4");
        std::fs::write(&into, &body[..700_000]).unwrap();
        let out = std::fs::OpenOptions::new().write(true).open(&into).unwrap();
        let first = Arc::new(Mutex::new(None::<u64>));
        let heard = Arc::clone(&first);
        let report: ProgressFn = Arc::new(move |p: Progress| {
            heard.lock().unwrap().get_or_insert(p.transferred);
        });
        let mut have = 700_000;
        let bytes = fetch_once(
            &endpoint,
            "o4",
            &token,
            0,
            "film.mp4",
            &out,
            &Some(report),
            &None,
            &mut have,
        )
        .await
        .unwrap();
        assert_eq!(bytes, body.len() as u64);
        assert_eq!(std::fs::read(&into).unwrap(), body, "whole, the same bytes");
        assert!(
            first.lock().unwrap().unwrap() > 700_000,
            "only the rest came: progress goes on from where it was"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn nothing_goes_without_the_secret_or_once_withdrawn() {
        let dir = temp("secret");
        std::fs::write(dir.join("notes.txt"), b"private").unwrap();
        let (server, endpoint) = loopback(dir.clone()).await;
        let token = server.offer("o2", vec!["notes.txt".into()]);
        let out = || std::fs::File::create(dir.join("out")).unwrap();

        let wrong = fetch(&endpoint, "o2", "00", 0, "notes.txt", out(), None, None).await;
        assert!(
            matches!(wrong, Err(ClientError::Protocol(_))),
            "a wrong secret: {wrong:?}"
        );
        let other = fetch(&endpoint, "o2", &token, 5, "notes.txt", out(), None, None).await;
        assert!(other.is_err(), "a file not offered");
        server.withdraw("o2");
        let gone = fetch(&endpoint, "o2", &token, 0, "notes.txt", out(), None, None).await;
        assert!(gone.is_err(), "withdrawn");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_listener_with_another_key_is_refused() {
        let dir = temp("key");
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        let (server, mut endpoint) = loopback(dir.clone()).await;
        let token = server.offer("o3", vec!["a.txt".into()]);
        endpoint.key = "0".repeat(64);
        let out = std::fs::File::create(dir.join("out")).unwrap();
        assert!(
            fetch(&endpoint, "o3", &token, 0, "a.txt", out, None, None)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
