//! One authenticated connection to a host.
//!
//! A session is a TLS stream that has already proved the host is the pinned one
//! and has already presented this device's token. Everything above it can
//! assume both.

use std::net::SocketAddr;
use std::sync::Arc;

use basalt_net::framing::{
    call_json, call_unit, read_response, read_response_header, write_request,
};
use basalt_net::socket;
use basalt_net::tls::{Trust, client_config, sni_name};
use basalt_proto::msg::*;
use basalt_proto::ops::Op;
use basalt_proto::{ErrorCode, PROTOCOL_VERSION};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

use crate::keys::KeyRing;
use crate::{ClientError, Result};

/// How long a host has to complete the handshake and sign-in once its
/// computer has accepted the connection. A host on the same network does it in
/// a fraction of a second.
pub const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// What the host said about itself when this session opened.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub host_id: String,
    pub host_name: String,
    pub vault: String,
    pub writable: bool,
    pub address: SocketAddr,
    /// Signed in with this device's key, rather than a pairing token.
    pub by_key: bool,
    /// The host's owner made this device an owner.
    pub owner: bool,
    /// This device may manage the host from here: the host can be managed
    /// from a device, and this one manages it, signed in with its key.
    pub manage: bool,
    /// The host shares a drive. False on a host just set up, until its
    /// manager chooses one.
    pub has_vault: bool,
}

pub struct Session {
    stream: TlsStream<TcpStream>,
    info: SessionInfo,
    /// How this session signed in, and what the host said about keys.
    pub(crate) signed_in: SignedIn,
    /// Which of the pool's profile choices this connection has told the host
    /// about. See `Pool::set_profile`.
    pub(crate) profile_gen: u64,
}

/// What a device has to sign in with, at one host.
#[derive(Clone, Default)]
pub struct Credentials {
    /// The device token. Empty once the host has retired it, or for a device
    /// that paired with its key.
    pub token: String,
    /// This device's key, when it has one.
    pub key: Option<Arc<KeyRing>>,
    /// Whether the host has this key on record, so it is tried first.
    pub key_on_host: bool,
    /// Why there is no key just now, when it is there and could not be used
    /// (a chip that is busy). Said as the reason a device with nothing else
    /// to sign in with cannot, rather than taken for a key that is gone.
    pub key_problem: Option<String>,
    /// The host has a key on record for this device, whether or not it is
    /// the one this device holds now. Then the host may well have retired the
    /// token, and a refused token is no news about the pairing.
    pub key_expected: bool,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the token.
        f.debug_struct("Credentials")
            .field("token", &(!self.token.is_empty()))
            .field("key", &self.key)
            .field("key_on_host", &self.key_on_host)
            .field("key_problem", &self.key_problem)
            .field("key_expected", &self.key_expected)
            .finish()
    }
}

/// How a session signed in, and what the host said while it did.
#[derive(Debug, Clone, Default)]
pub struct SignedIn {
    /// With the key, rather than the token.
    pub by_key: bool,
    /// The host can take a key: see [`HelloResponse::keys`].
    pub host_keys: bool,
    /// The host no longer accepts this device's token.
    pub retire_token: bool,
    /// The host's owner made this device an owner.
    pub owner: bool,
    /// An endorsement the host would like signed, its payload hex.
    pub endorse: Option<String>,
    /// The household's statement about this device, when a new one was due.
    pub member: Option<SignedStatement>,
    /// The key was tried and the host said it knows no such key: it needs
    /// giving again.
    pub key_unknown: bool,
}

/// Who this device is, as it introduces itself to a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Me {
    /// What the host lists it as.
    pub name: String,
    /// The id it made for itself once, the same on every connection. See
    /// [`HelloRequest::device_id`].
    pub id: String,
}

impl Me {
    pub fn new(name: impl Into<String>, id: impl Into<String>) -> Self {
        Me {
            name: name.into(),
            id: id.into(),
        }
    }
}

/// A pairing the host is currently displaying.
///
/// Holds everything the proof is bound to, so the second step cannot be
/// computed against different nonces or a different key than the first.
#[derive(Debug, Clone)]
pub struct PairChallenge {
    pub request: String,
    pub requires_pin: bool,
    /// What the host checks is its setup code: it has no screen, and the
    /// device that pairs becomes its first manager.
    pub setup: bool,
    pub client_nonce: String,
    pub server_nonce: String,
    /// The key the host actually presented, not anything it claimed.
    pub host_id: String,
    /// The name this device asked under.
    pub device_name: String,
    /// Whether the host can take a key, so the device pairs with one.
    pub host_keys: bool,
}

/// Signs a message with the device's key, off the async threads: a TPM takes
/// tens of milliseconds and holds its caller for all of them.
async fn sign(key: &Arc<KeyRing>, message: Vec<u8>) -> Result<basalt_trust::Signature> {
    let key = Arc::clone(key);
    tokio::task::spawn_blocking(move || key.sign_with_device(&message))
        .await
        .map_err(|e| ClientError::Key(format!("signing stopped: {e}")))?
        .map_err(|e| ClientError::Key(format!("this device's key could not sign: {e}")))
}

/// The message for `purpose`, bound to this connection.
fn bound_message(
    stream: &TlsStream<TcpStream>,
    purpose: basalt_trust::message::Purpose,
    host_id: &str,
) -> Result<Vec<u8>> {
    let binding = basalt_net::tls::client_binding(stream.get_ref().1).ok_or_else(|| {
        ClientError::Key("signing in with a key needs a TLS 1.3 connection".into())
    })?;
    basalt_trust::message::device_message(purpose, &binding, host_id)
        .map_err(|e| ClientError::Key(e.to_string()))
}

/// Builds the message for `purpose` and signs it with the device's key.
async fn signed_message(
    stream: &TlsStream<TcpStream>,
    key: &Arc<KeyRing>,
    purpose: basalt_trust::message::Purpose,
    host_id: &str,
) -> Result<basalt_trust::Signature> {
    let message = bound_message(stream, purpose, host_id)?;
    sign(key, message).await
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Opens a TLS connection and reads the host's greeting.
///
/// Returns the stream and the greeting separately because pairing and
/// reconnecting need the same first half and diverge afterwards.
async fn open(
    addr: SocketAddr,
    trust: Trust,
    me: &Me,
) -> Result<(TlsStream<TcpStream>, HelloResponse, String)> {
    let tcp = socket::connect(addr).await?;
    let (connector, verifier) = client_config(trust);
    let mut stream = connector.connect(sni_name(), tcp).await.map_err(|e| {
        // The pin failing is the one connection error worth explaining
        // precisely, because it means something is wrong rather than merely
        // unavailable.
        ClientError::Net(basalt_net::NetError::Io(e))
    })?;

    let hello: HelloResponse = call_json(
        &mut stream,
        Op::Hello,
        &HelloRequest {
            protocol: PROTOCOL_VERSION,
            device_name: me.name.clone(),
            device_id: me.id.clone(),
        },
    )
    .await?;

    if hello.protocol != PROTOCOL_VERSION {
        return Err(ClientError::Incompatible {
            ours: PROTOCOL_VERSION,
            theirs: hello.protocol,
        });
    }

    // The id the certificate actually carried, not the one in the greeting. A
    // host that lies in `host_id` cannot lie about the key it signed with.
    let presented = verifier
        .seen_host_id()
        .ok_or_else(|| ClientError::Protocol("the handshake produced no host identity".into()))?;

    Ok((stream, hello, presented))
}

impl Session {
    /// Reconnects to a host already paired with.
    pub async fn connect(
        addr: SocketAddr,
        host_id: &str,
        credentials: &Credentials,
        me: &Me,
    ) -> Result<Self> {
        // The connection itself gives up after a few seconds, but a host that
        // has frozen, asleep or stuck, still has the computer accept it, and
        // then never answers: the handshake and the sign-in waited forever,
        // and a film being picked up again sat on "picking up" for good.
        tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            Self::connect_now(addr, host_id, credentials, me),
        )
        .await
        .map_err(|_| {
            ClientError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{addr} accepted the connection and then did not answer"),
            ))
        })?
    }

    async fn connect_now(
        addr: SocketAddr,
        host_id: &str,
        credentials: &Credentials,
        me: &Me,
    ) -> Result<Self> {
        let (mut stream, hello, presented) =
            open(addr, Trust::Pinned(host_id.to_string()), me).await?;

        // Belt and braces: the TLS verifier has already refused anything else,
        // so this can only fire if that check were ever weakened.
        if presented != host_id {
            return Err(ClientError::WrongHost {
                expected: host_id.to_string(),
                got: presented,
            });
        }

        // The key first, when the host has it; the token if the key is
        // refused for any reason and the device still has one, on the same
        // connection. A refusal leaves the connection open for another try.
        let key = credentials
            .key
            .as_ref()
            .filter(|_| hello.keys && credentials.key_on_host);
        let mut key_error = None;
        if let Some(key) = key {
            match Self::auth_with_key(&mut stream, key, &presented).await {
                Ok(auth) => {
                    return Ok(Self::signed_in(stream, presented, hello, auth, addr, true));
                }
                // Only a refusal leaves anything to try; a dropped connection
                // does not.
                Err(e) if e.code().is_some() || matches!(e, ClientError::Key(_)) => {
                    tracing::warn!("signing in with this device's key failed: {e}");
                    key_error = Some(e);
                }
                Err(e) => return Err(e),
            }
        }

        if credentials.token.is_empty() {
            return Err(match key_error {
                Some(e) => e,
                // The key is there and could not be used just now: tried
                // again later, and never a reason to drop the pairing.
                None if credentials.key.is_none() && credentials.key_problem.is_some() => {
                    ClientError::Key(credentials.key_problem.clone().unwrap_or_default())
                }
                None if !hello.keys => ClientError::HostTooOld,
                // The host has a key for this device that it no longer has,
                // and there is nothing else to sign in with.
                None if credentials.key_expected => ClientError::KeyGone,
                // Nothing to sign in with, and no key the host knows of: as
                // good as removed, and paired again the same way.
                None => {
                    ClientError::Net(basalt_net::NetError::Remote(basalt_proto::WireError::new(
                        ErrorCode::Unauthenticated,
                        "this device has nothing left to sign in to this host with",
                    )))
                }
            });
        }
        let key_unknown = key_error.as_ref().is_some_and(|e| e.kind() == "unpaired");
        let answer: Result<AuthResponse> = call_json(
            &mut stream,
            Op::Auth,
            &AuthRequest {
                token: credentials.token.clone(),
                ..AuthRequest::default()
            },
        )
        .await
        .map_err(Into::into);
        match answer {
            Ok(auth) => {
                let mut session = Self::signed_in(stream, presented, hello, auth, addr, false);
                session.signed_in.key_unknown = key_unknown;
                Ok(session)
            }
            // The token refused. That is "removed" only when the key could not
            // have been the reason: when the host knows no key for this device,
            // or refused the key as unknown too. Otherwise the host retired the
            // token for the key, and what went wrong is the key's.
            Err(refused) if refused.kind() == "unpaired" => Err(match key_error {
                Some(key_error) if key_error.kind() != "unpaired" => key_error,
                Some(_) => refused,
                None if !credentials.key_expected => refused,
                None => match &credentials.key_problem {
                    Some(problem) => ClientError::Key(problem.clone()),
                    // A key, and not the one the host knows: it was reset.
                    None => ClientError::KeyGone,
                },
            }),
            Err(other) => Err(other),
        }
    }

    /// Signs in with the key in memory, vouched for by the device's key; or,
    /// at a host that will not take that, with the device's key itself.
    async fn auth_with_key(
        stream: &mut TlsStream<TcpStream>,
        key: &Arc<KeyRing>,
        host_id: &str,
    ) -> Result<AuthResponse> {
        let message = bound_message(stream, basalt_trust::message::Purpose::Auth, host_id)?;
        if !key.direct_at(host_id) {
            let now = unix_now();
            let pass = match key.pass(host_id, now) {
                Some(pass) => pass,
                None => {
                    let ring = Arc::clone(key);
                    let host = host_id.to_string();
                    tokio::task::spawn_blocking(move || ring.make_pass(&host, now))
                        .await
                        .map_err(|e| ClientError::Key(format!("signing stopped: {e}")))?
                        .map_err(|e| {
                            ClientError::Key(format!("this device's key could not sign: {e}"))
                        })?
                }
            };
            let signature = key
                .sign_with_session(&message)
                .map_err(|e| ClientError::Key(e.to_string()))?;
            let answer = call_json(
                stream,
                Op::Auth,
                &AuthRequest {
                    token: String::new(),
                    key: Some(key.public_key().to_hex()),
                    signature: Some(signature.to_hex()),
                    session: Some(pass),
                },
            )
            .await;
            match answer {
                Ok(auth) => return Ok(auth),
                // Refused as not vouched for: the device's key signs here
                // from now on. Anything else is the answer.
                Err(e) if e.code() == Some(ErrorCode::Denied) => {
                    tracing::warn!("the host would not take this device's session key: {e}");
                    key.refused_at(host_id);
                }
                Err(e) => return Err(e.into()),
            }
        }
        let signature = sign(key, message).await?;
        Ok(call_json(
            stream,
            Op::Auth,
            &AuthRequest {
                token: String::new(),
                key: Some(key.public_key().to_hex()),
                signature: Some(signature.to_hex()),
                session: None,
            },
        )
        .await?)
    }

    fn signed_in(
        stream: TlsStream<TcpStream>,
        host_id: String,
        hello: HelloResponse,
        auth: AuthResponse,
        address: SocketAddr,
        by_key: bool,
    ) -> Self {
        Self {
            stream,
            profile_gen: 0,
            signed_in: SignedIn {
                by_key,
                host_keys: hello.keys,
                retire_token: auth.retire_token,
                owner: auth.owner,
                endorse: auth.endorse,
                member: auth.member,
                key_unknown: false,
            },
            info: SessionInfo {
                host_id,
                host_name: hello.host_name,
                vault: auth.vault,
                writable: auth.writable,
                address,
                by_key,
                owner: auth.owner,
                manage: hello.manage && by_key && auth.owner,
                has_vault: hello.has_vault,
            },
        }
    }

    /// Gives the host this device's key, on a session signed in with its
    /// token. The host goes on taking the token until the key has been used.
    pub async fn enrol(&mut self, key: &Arc<KeyRing>) -> Result<()> {
        let signature = signed_message(
            &self.stream,
            key,
            basalt_trust::message::Purpose::Enrol,
            &self.info.host_id,
        )
        .await?;
        call_unit(
            &mut self.stream,
            Op::Enrol,
            &EnrolRequest {
                key: key.public_key().to_hex(),
                signature: signature.to_hex(),
                key_kind: Some(key.kind()),
            },
        )
        .await?;
        Ok(())
    }

    /// Answers the endorsement the host offered as this session signed in,
    /// if it offered one: checked, signed by the device's key, and returned.
    ///
    /// Never fails the session. An offer that does not check out is refused
    /// and noted; one that could not be returned is offered again next time.
    pub async fn answer_endorsement(&mut self, key: &Arc<KeyRing>) {
        let Some(offer) = self.signed_in.endorse.take() else {
            return;
        };
        if !self.signed_in.by_key {
            return;
        }
        let ring = Arc::clone(key);
        let host_id = self.info.host_id.clone();
        let now = unix_now();
        let signed =
            tokio::task::spawn_blocking(move || ring.sign_endorsement(&offer, &host_id, now)).await;
        let statement = match signed {
            Ok(Ok(Some(statement))) => statement,
            // Answered on another connection a moment ago.
            Ok(Ok(None)) => return,
            Ok(Err(e)) => {
                tracing::warn!("did not endorse the host: {e}");
                return;
            }
            Err(e) => {
                tracing::warn!("endorsing the host stopped: {e}");
                return;
            }
        };
        if let Err(e) =
            call_unit(&mut self.stream, Op::Endorse, &EndorseRequest { statement }).await
        {
            tracing::warn!("the host did not take this device's endorsement: {e}");
            key.endorsement_not_delivered(&self.info.host_id);
        }
    }

    /// Looks at a host without pairing, so the client can show what it found.
    pub async fn probe(addr: SocketAddr, me: &Me) -> Result<HelloResponse> {
        let (_stream, hello, presented) = open(addr, Trust::FirstContact, me).await?;
        // Report the key that was actually presented rather than the claim in
        // the body, so the id shown to the user is the one that will be pinned.
        Ok(HelloResponse {
            host_id: presented,
            ..hello
        })
    }

    /// Asks a host to pair, which is what makes it display the request.
    ///
    /// Split from [`Session::finish_pair`] because the PIN is generated *by the
    /// asking*. Doing both in one call meant the second attempt — the one
    /// carrying the PIN — opened a new request with a new number, so the one on
    /// the host's screen was stale before it could be typed. The session stays
    /// open between the two steps, and the challenge identifies the request the
    /// host is showing.
    ///
    /// Trust is [`Trust::FirstContact`] here because there is nothing to
    /// compare against yet — which is exactly why the PIN proof is bound to the
    /// key that turned up. See [`basalt_net::pairing`].
    pub async fn begin_pair(addr: SocketAddr, me: &Me) -> Result<(Self, PairChallenge)> {
        let (mut stream, hello, presented) = open(addr, Trust::FirstContact, me).await?;

        let client_nonce = basalt_net::pairing::random_nonce()
            .map_err(|e| ClientError::Protocol(format!("no randomness available: {e}")))?;

        let begin: PairBeginResponse = call_json(
            &mut stream,
            Op::PairBegin,
            &PairBeginRequest {
                client_nonce: client_nonce.clone(),
                device_name: me.name.clone(),
                device_id: me.id.clone(),
            },
        )
        .await?;

        let challenge = PairChallenge {
            request: begin.request,
            requires_pin: begin.requires_pin,
            setup: begin.setup,
            client_nonce,
            server_nonce: begin.server_nonce,
            host_id: presented.clone(),
            device_name: me.name.clone(),
            host_keys: hello.keys,
        };

        Ok((
            Self {
                stream,
                profile_gen: 0,
                signed_in: SignedIn {
                    host_keys: hello.keys,
                    ..SignedIn::default()
                },
                info: SessionInfo {
                    host_id: presented,
                    host_name: hello.host_name,
                    vault: hello.vault,
                    // Replaced by what the host says once pairing completes.
                    writable: true,
                    address: addr,
                    by_key: false,
                    owner: false,
                    manage: false,
                    has_vault: hello.has_vault,
                },
            },
            challenge,
        ))
    }

    /// Completes a pairing the host is displaying.
    ///
    /// With a key, to a host that takes one, the device pairs with the key and
    /// no token is returned (an empty one). Otherwise, the device token.
    pub async fn finish_pair(
        &mut self,
        challenge: &PairChallenge,
        pin: Option<&str>,
        key: Option<&Arc<KeyRing>>,
    ) -> Result<String> {
        let proof = if challenge.requires_pin {
            let pin = pin.ok_or(ClientError::PinRequired)?;
            Some(
                basalt_net::pairing::compute_proof(
                    pin,
                    &challenge.host_id,
                    &challenge.client_nonce,
                    &challenge.server_nonce,
                )
                .map_err(|e| ClientError::Protocol(format!("could not build the proof: {e}")))?,
            )
        } else {
            None
        };

        let key = key.filter(|_| challenge.host_keys);
        // A key that cannot sign just now does not cost the pairing: the
        // device pairs with a token, and gives the host its key next time.
        let key_signature = match key {
            Some(key) => match signed_message(
                &self.stream,
                key,
                basalt_trust::message::Purpose::Pair,
                &challenge.host_id,
            )
            .await
            {
                Ok(signature) => Some(signature.to_hex()),
                Err(e) => {
                    tracing::warn!("pairing with a token instead: {e}");
                    None
                }
            },
            None => None,
        };
        let key = key.filter(|_| key_signature.is_some());

        let finish: PairFinishResponse = call_json(
            &mut self.stream,
            Op::PairFinish,
            &PairFinishRequest {
                request: challenge.request.clone(),
                proof,
                // This device's own name. It used to be `info.host_name` — the
                // host's — and every device was listed on the host under the
                // name of the machine it was connecting to.
                device_name: challenge.device_name.clone(),
                key: key.map(|k| k.public_key().to_hex()),
                key_signature,
                key_kind: key.map(|k| k.kind()),
            },
        )
        .await
        .map_err(|e| match e.code() {
            // The host refusing the proof almost always means the PIN was
            // mistyped, and saying so is more useful than the wire message.
            Some(ErrorCode::PairingRefused) => ClientError::BadPin(e.to_string()),
            _ => ClientError::Net(e),
        })?;

        self.info.vault = finish.vault;
        if key.is_some() {
            self.signed_in.by_key = true;
            self.info.by_key = true;
            // Set a host with no screen up: it manages it from now, and the
            // app shows Manage host without signing in again first.
            self.info.owner = finish.manages;
            self.info.manage = finish.manages;
            // Paired with a key: there never was a token to keep.
            return Ok(String::new());
        }
        if finish.token.is_empty() {
            return Err(ClientError::Protocol(
                "the host finished pairing without a token or a key".into(),
            ));
        }
        Ok(finish.token)
    }

    pub fn info(&self) -> &SessionInfo {
        &self.info
    }

    // -----------------------------------------------------------------------
    // Operations
    // -----------------------------------------------------------------------

    pub async fn ping(&mut self) -> Result<()> {
        write_request(&mut self.stream, Op::Ping, &[]).await?;
        read_response(&mut self.stream).await?;
        Ok(())
    }

    /// Asks the host to forget this device. The connection is unusable after.
    pub async fn unpair(&mut self) -> Result<()> {
        write_request(&mut self.stream, Op::Unpair, &[]).await?;
        read_response(&mut self.stream).await?;
        Ok(())
    }

    pub async fn list(&mut self, path: &str) -> Result<Vec<DirEntry>> {
        let response: ListResponse = call_json(
            &mut self.stream,
            Op::List,
            &ListRequest {
                path: path.to_string(),
            },
        )
        .await?;
        Ok(response.entries)
    }

    pub async fn stat(&mut self, path: &str) -> Result<DirEntry> {
        let response: StatResponse = call_json(
            &mut self.stream,
            Op::Stat,
            &StatRequest {
                path: path.to_string(),
            },
        )
        .await?;
        Ok(response.entry)
    }

    pub async fn space(&mut self) -> Result<(u64, u64)> {
        let response: SpaceResponse =
            call_json(&mut self.stream, Op::Space, &serde_json::json!({})).await?;
        Ok((response.free, response.total))
    }

    /// The media index, or nothing new if `known_revision` still matches.
    pub async fn library(&mut self, known_revision: u64) -> Result<LibraryResponse> {
        call_json(
            &mut self.stream,
            Op::Library,
            &LibraryRequest { known_revision },
        )
        .await
        .map_err(Into::into)
    }

    /// Every video, song and photo the host has sorted, unless unchanged.
    pub async fn collections(
        &mut self,
        known_revision: u64,
    ) -> Result<basalt_proto::msg::CollectionsResponse> {
        call_json(
            &mut self.stream,
            Op::Collections,
            &basalt_proto::msg::CollectionsRequest { known_revision },
        )
        .await
        .map_err(Into::into)
    }

    /// A preview image of a video or photo, as JPEG bytes.
    pub async fn thumbnail(&mut self, path: &str, size: u32) -> Result<Vec<u8>> {
        write_request(
            &mut self.stream,
            Op::Thumbnail,
            &serde_json::to_vec(&basalt_proto::msg::ThumbnailRequest {
                path: path.to_string(),
                size,
            })
            .map_err(|e| ClientError::Protocol(e.to_string()))?,
        )
        .await?;
        Ok(read_response(&mut self.stream).await?)
    }

    /// Poster bytes for one item.
    pub async fn art(&mut self, id: &str) -> Result<Vec<u8>> {
        write_request(
            &mut self.stream,
            Op::LibraryArt,
            &serde_json::to_vec(&ArtRequest { id: id.to_string() })
                .map_err(|e| ClientError::Protocol(e.to_string()))?,
        )
        .await?;
        Ok(read_response(&mut self.stream).await?)
    }

    /// The household's profiles.
    /// Asks the host to do what its window would: see [`ManageRequest`].
    ///
    /// [`ManageRequest`]: basalt_proto::msg::ManageRequest
    pub async fn manage(
        &mut self,
        action: basalt_proto::msg::ManageAction,
    ) -> Result<basalt_proto::msg::ManageResponse> {
        call_json(
            &mut self.stream,
            Op::Manage,
            &basalt_proto::msg::ManageRequest { action },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn profiles(&mut self) -> Result<basalt_proto::msg::ProfilesResponse> {
        call_json(&mut self.stream, Op::Profiles, &serde_json::json!({}))
            .await
            .map_err(Into::into)
    }

    pub async fn profile_create(
        &mut self,
        request: &basalt_proto::msg::ProfileCreateRequest,
    ) -> Result<basalt_proto::msg::ProfileSession> {
        call_json(&mut self.stream, Op::ProfileCreate, request)
            .await
            .map_err(Into::into)
    }

    pub async fn profile_sign_in(
        &mut self,
        request: &basalt_proto::msg::ProfileSignInRequest,
    ) -> Result<basalt_proto::msg::ProfileSession> {
        call_json(&mut self.stream, Op::ProfileSignIn, request)
            .await
            .map_err(Into::into)
    }

    /// Says which profile this connection acts for; None for the device.
    pub async fn profile_use(
        &mut self,
        token: Option<&str>,
    ) -> Result<basalt_proto::msg::ProfileUseResponse> {
        call_json(
            &mut self.stream,
            Op::ProfileUse,
            &basalt_proto::msg::ProfileUseRequest {
                token: token.map(str::to_string),
            },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn profile_sign_out(&mut self, token: &str) -> Result<()> {
        write_request(
            &mut self.stream,
            Op::ProfileSignOut,
            &serde_json::to_vec(&basalt_proto::msg::ProfileSignOutRequest {
                token: token.to_string(),
            })
            .map_err(|e| ClientError::Protocol(e.to_string()))?,
        )
        .await?;
        read_response(&mut self.stream).await?;
        Ok(())
    }

    /// Starts a conversion. The pieces follow, by [`Session::convert_next`].
    pub async fn convert_begin(
        &mut self,
        path: &str,
        start: f64,
    ) -> Result<basalt_proto::msg::ConvertStarted> {
        call_json(
            &mut self.stream,
            Op::Convert,
            &basalt_proto::msg::ConvertRequest {
                path: path.to_string(),
                start,
                check: false,
            },
        )
        .await
        .map_err(Into::into)
    }

    /// Whether the host could convert a file now, and on what.
    pub async fn convert_check(&mut self, path: &str) -> Result<basalt_proto::msg::ConvertStarted> {
        call_json(
            &mut self.stream,
            Op::Convert,
            &basalt_proto::msg::ConvertRequest {
                path: path.to_string(),
                start: 0.0,
                check: true,
            },
        )
        .await
        .map_err(Into::into)
    }

    /// The next piece of a conversion, or `None` at its end.
    pub async fn convert_next(&mut self) -> Result<Option<Vec<u8>>> {
        let piece = read_response(&mut self.stream).await?;
        Ok((!piece.is_empty()).then_some(piece))
    }

    /// The subtitles for one video, and others that might be meant for it.
    pub async fn subtitles(&mut self, path: &str) -> Result<basalt_proto::msg::SubtitlesResponse> {
        call_json(
            &mut self.stream,
            Op::Subtitles,
            &basalt_proto::msg::SubtitlesRequest {
                path: path.to_string(),
            },
        )
        .await
        .map_err(Into::into)
    }

    /// A profile's stars, replaced first when `set` is given.
    pub async fn stars(
        &mut self,
        set: Option<Vec<basalt_proto::msg::Star>>,
    ) -> Result<basalt_proto::msg::StarsResponse> {
        call_json(
            &mut self.stream,
            Op::Stars,
            &basalt_proto::msg::StarsRequest { set },
        )
        .await
        .map_err(Into::into)
    }

    /// Records and reads watch progress in one round trip.
    pub async fn progress(&mut self, request: ProgressRequest) -> Result<ProgressResponse> {
        call_json(&mut self.stream, Op::Progress, &request)
            .await
            .map_err(Into::into)
    }

    /// Opens a watch. **This session is dedicated to it from now on.**
    ///
    /// Nothing else may be sent on it: the host answers with a response per
    /// change and will keep doing so until the connection closes, so a second
    /// request would be read as if it were part of that stream.
    pub async fn watch_begin(&mut self) -> Result<()> {
        write_request(
            &mut self.stream,
            Op::Watch,
            &serde_json::to_vec(&WatchRequest { profiles: true })
                .map_err(|e| ClientError::Protocol(e.to_string()))?,
        )
        .await?;
        Ok(())
    }

    /// Waits for the next change. Returns an error when the host goes away.
    pub async fn watch_next(&mut self) -> Result<Change> {
        let body = read_response(&mut self.stream).await?;
        let event: WatchEvent = serde_json::from_slice(&body)
            .map_err(|e| ClientError::Protocol(format!("a change did not parse: {e}")))?;
        Ok(event.change)
    }

    /// Reads a byte range. Shorter than requested at the end of the file.
    pub async fn read_range(&mut self, path: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        let body = serde_json::to_vec(&ReadRequest {
            path: path.to_string(),
            offset,
            length,
        })
        .map_err(|e| ClientError::Protocol(format!("could not encode the read: {e}")))?;
        write_request(&mut self.stream, Op::Read, &body).await?;
        Ok(read_response(&mut self.stream).await?)
    }

    /// Streams a byte range into a writer without buffering it whole.
    ///
    /// This is what a download uses: a 2 GB file must never exist in memory,
    /// on a host with 5.9 GB of RAM or on a client either.
    pub async fn read_range_into<W>(
        &mut self,
        path: &str,
        offset: u64,
        length: u64,
        out: &mut W,
    ) -> Result<u64>
    where
        W: tokio::io::AsyncWrite + Unpin,
    {
        self.send_read(path, offset, length).await?;
        self.receive_read_into(out).await
    }

    /// Asks for a byte range without waiting for it.
    ///
    /// Half of a pipelined read: the host answers requests on a connection in
    /// the order they arrived, so several can be asked for before the first
    /// answer is read. That is what keeps the link busy while the host reads
    /// the next piece off its disk. Each one must be matched by exactly one
    /// [`Session::receive_read_into`], in order.
    pub async fn send_read(&mut self, path: &str, offset: u64, length: u64) -> Result<()> {
        let body = serde_json::to_vec(&ReadRequest {
            path: path.to_string(),
            offset,
            length,
        })
        .map_err(|e| ClientError::Protocol(format!("could not encode the read: {e}")))?;
        write_request(&mut self.stream, Op::Read, &body).await?;
        Ok(())
    }

    /// Streams the answer to the oldest range asked for into a writer.
    pub async fn receive_read_into<W>(&mut self, out: &mut W) -> Result<u64>
    where
        W: tokio::io::AsyncWrite + Unpin,
    {
        let (status, len) = read_response_header(&mut self.stream).await?;
        if status != basalt_proto::STATUS_OK {
            // Drain the error body so the connection stays usable, then report
            // it the same way a buffered read would.
            let mut body = vec![0u8; len as usize];
            self.stream.read_exact(&mut body).await?;
            return Err(ClientError::Net(basalt_net::NetError::Remote(
                serde_json::from_slice(&body).unwrap_or_else(|_| {
                    basalt_proto::WireError::new(
                        ErrorCode::Io,
                        String::from_utf8_lossy(&body).into_owned(),
                    )
                }),
            )));
        }

        let mut remaining = len;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let want = buf.len().min(remaining as usize);
            let n = self.stream.read(&mut buf[..want]).await?;
            if n == 0 {
                return Err(ClientError::Protocol(format!(
                    "the host stopped with {remaining} bytes still owed"
                )));
            }
            out.write_all(&buf[..n]).await?;
            remaining -= n as u64;
        }
        Ok(len)
    }

    /// Fetches many files as one batch stream, already decompressed.
    pub async fn read_batch(&mut self, paths: Vec<String>) -> Result<Vec<basalt_proto::Entry>> {
        let body = serde_json::to_vec(&basalt_proto::BatchRequest::new(paths))
            .map_err(|e| ClientError::Protocol(format!("could not encode the manifest: {e}")))?;
        write_request(&mut self.stream, Op::ReadBatch, &body).await?;
        let stream = read_response(&mut self.stream).await?;

        // Decoding is CPU work on a potentially large buffer, so it runs off
        // the runtime rather than stalling every other connection.
        tokio::task::spawn_blocking(move || {
            basalt_proto::frame::BatchReader::new(stream.as_slice())?
                .collect::<basalt_proto::Result<Vec<_>>>()
        })
        .await
        .map_err(|e| ClientError::Protocol(format!("decoding failed: {e}")))?
        .map_err(Into::into)
    }

    // --- writing -----------------------------------------------------------

    pub async fn write_begin(
        &mut self,
        path: &str,
        size: u64,
        overwrite: bool,
        resume: Option<&str>,
    ) -> Result<WriteBeginResponse> {
        call_json(
            &mut self.stream,
            Op::WriteBegin,
            &WriteBeginRequest {
                path: path.to_string(),
                size,
                overwrite,
                resume: resume.map(str::to_string),
            },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn write_chunk(&mut self, upload: &str, offset: u64, data: &[u8]) -> Result<()> {
        self.send_chunk(upload, offset, data).await?;
        self.confirm_chunk().await
    }

    /// Sends one chunk of an upload without waiting for the host to write it.
    ///
    /// Half of a pipelined upload; see [`Session::send_read`] for why several
    /// may be in flight on one connection. Each must be matched by exactly one
    /// [`Session::confirm_chunk`], in order.
    pub async fn send_chunk(&mut self, upload: &str, offset: u64, data: &[u8]) -> Result<()> {
        let id = parse_upload_id(upload)?;
        let payload = encode_chunk(&id, offset, data);
        write_request(&mut self.stream, Op::WriteChunk, &payload).await?;
        Ok(())
    }

    /// Waits for the host to say the oldest chunk sent has been written.
    pub async fn confirm_chunk(&mut self) -> Result<()> {
        read_response(&mut self.stream).await?;
        Ok(())
    }

    pub async fn write_commit(
        &mut self,
        upload: &str,
        blake3: &str,
        mtime: Option<i64>,
    ) -> Result<()> {
        call_unit(
            &mut self.stream,
            Op::WriteCommit,
            &WriteCommitRequest {
                upload: upload.to_string(),
                blake3: blake3.to_string(),
                mtime,
            },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn write_abort(&mut self, upload: &str) -> Result<()> {
        call_unit(
            &mut self.stream,
            Op::WriteAbort,
            &WriteAbortRequest {
                upload: upload.to_string(),
            },
        )
        .await
        .map_err(Into::into)
    }

    // --- mutations ---------------------------------------------------------

    pub async fn mkdir(&mut self, path: &str) -> Result<()> {
        call_unit(
            &mut self.stream,
            Op::Mkdir,
            &MkdirRequest {
                path: path.to_string(),
            },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        call_unit(
            &mut self.stream,
            Op::Rename,
            &RenameRequest {
                from: from.to_string(),
                to: to.to_string(),
            },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn copy(&mut self, from: &str, to: &str) -> Result<()> {
        call_unit(
            &mut self.stream,
            Op::Copy,
            &CopyRequest {
                from: from.to_string(),
                to: to.to_string(),
            },
        )
        .await
        .map_err(Into::into)
    }

    pub async fn remove(&mut self, path: &str, recursive: bool) -> Result<()> {
        call_unit(
            &mut self.stream,
            Op::Remove,
            &RemoveRequest {
                path: path.to_string(),
                recursive,
            },
        )
        .await
        .map_err(Into::into)
    }
}
