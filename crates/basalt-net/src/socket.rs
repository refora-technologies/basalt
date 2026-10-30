//! Socket setup, with the settings Phase 0 measured.
//!
//! The receive buffer is the single most valuable line in this crate. Measured
//! end to end over the real link:
//!
//! | Buffer | Throughput |
//! |---|---|
//! | 64 KiB | 7.4 MB/s |
//! | 256 KiB | 17.4 MB/s |
//! | 1 MiB | 22.1 MB/s |
//! | 2 MiB | 22.7 MB/s |
//! | 8 MiB | 20.1 MB/s (bufferbloat) |
//!
//! A threefold spread from one socket option, with the Windows default landing
//! in the middle at 20.4 MB/s.

use std::net::SocketAddr;

use tokio::net::{TcpListener, TcpSocket, TcpStream};

use crate::{NetError, Result};

/// Receive buffer for every connection: inside the flat optimum, clear of the
/// regression at 8 MiB.
pub const RECV_BUFFER: u32 = 2 * 1024 * 1024;

/// Default port. Clear of anything common, and the same one the Phase 0
/// harness used.
pub const DEFAULT_PORT: u16 = 7742;

/// Connects with the measured tuning applied.
///
/// `SO_RCVBUF` has to be set *before* connecting, because it determines the
/// window scale negotiated in the handshake. Setting it afterwards resizes the
/// buffer but leaves the scale where it was, silently capping how much data can
/// be in flight — the option appears to work and does nothing. That is why this
/// builds the socket by hand instead of using `TcpStream::connect`.
pub async fn connect(addr: SocketAddr) -> Result<TcpStream> {
    let socket = if addr.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    // Best effort: an OS is free to clamp or ignore the request, and there is
    // nothing useful to do about it if it does.
    let _ = socket.set_recv_buffer_size(RECV_BUFFER);

    // A host on the same network answers in milliseconds. One that has gone
    // to sleep, or moved, leaves the request unanswered, and the operating
    // system waits for it: about twenty seconds on Windows, two minutes on
    // Android, with the app showing nothing but a dimmed screen. Given up on
    // here instead, as the transient failure it is, so the caller can look
    // for the host elsewhere or say it is offline.
    let stream = give_up_after(CONNECT_TIMEOUT, addr, socket.connect(addr)).await?;
    tune(&stream);
    Ok(stream)
}

/// Waits `wait` for a connection to open, and fails as a transient I/O error
/// if it has not.
async fn give_up_after<T>(
    wait: std::time::Duration,
    addr: SocketAddr,
    connecting: impl std::future::Future<Output = std::io::Result<T>>,
) -> Result<T> {
    let opened = tokio::time::timeout(wait, connecting).await.map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("{addr} did not answer"),
        )
    })??;
    Ok(opened)
}

/// How long a connection may take to open. Generous for a home network, where
/// it takes a few milliseconds, and short enough that nobody gives up first.
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Binds a listener for the host.
pub async fn listen(addr: SocketAddr) -> Result<TcpListener> {
    TcpListener::bind(addr).await.map_err(NetError::Io)
}

/// Per-connection tuning applied on both sides after the socket exists.
///
/// `TCP_NODELAY` matters because browsing and the pairing handshake are
/// latency-bound request/response exchanges, and Nagle's algorithm would add up
/// to 40 ms to each one. Bulk transfers write in megabyte chunks and never form
/// the small segments Nagle exists to coalesce, so there is nothing to lose.
///
/// Keepalive is for a connection that dies without saying so: Wi-Fi dropping,
/// a laptop going to sleep, a router restarting. Nothing is sent to close it,
/// so without probes a request in flight waits for its answer for ever — a
/// transfer stuck at the same percentage, a folder that never finishes
/// loading, a watch that stops hearing of changes. With them the operating
/// system notices within about a minute, the request fails as offline, and
/// the apps retry as they do for any outage. It cannot cut off anything slow
/// but alive, such as the host copying a large folder: a live peer answers
/// the probes however long the work takes.
pub fn tune(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL);
    let _ = socket2::SockRef::from(stream).set_tcp_keepalive(&keepalive);
}

/// Silence before the first keepalive probe.
pub const KEEPALIVE_IDLE: std::time::Duration = std::time::Duration::from_secs(15);
/// Between probes once silence has gone on. Windows gives up after ten
/// unanswered, Android after nine: roughly a minute in all.
pub const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Resolves a host string to a socket address, defaulting the port.
///
/// Accepts `192.168.1.10`, `192.168.1.10:7742`, `laptop-b`, and bracketed IPv6.
pub async fn resolve(host: &str, default_port: u16) -> Result<SocketAddr> {
    resolve_all(host, default_port).await.map(|all| all[0])
}

/// Every address a host string resolves to, IPv4 first.
///
/// A computer's name often resolves to several: Windows answers for its
/// VirtualBox, WSL and VPN adapters too, and lists them first as often as
/// not. Only one is reachable from another device, and nothing here can
/// tell which, so they are all tried. IPv4 first, because a host listens on
/// IPv4 and names often come back with IPv6 first.
pub async fn resolve_all(host: &str, default_port: u16) -> Result<Vec<SocketAddr>> {
    match resolve_exactly(host, default_port).await {
        Ok(found) => Ok(found),
        // A computer's bare name ("LIVINGROOM") is found by Windows on its own
        // network, but on Linux only as "LIVINGROOM.local", which every Windows,
        // Mac and Linux machine answers for itself. Tried as that too.
        Err(first) => match with_local(host) {
            Some(local) => resolve_exactly(&local, default_port)
                .await
                .map_err(|_| first),
            None => Err(first),
        },
    }
}

/// `name.local` for a bare computer name, with its port if it had one; None
/// for an address, or a name with dots already.
fn with_local(host: &str) -> Option<String> {
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) if has_explicit_port(host) => (name, Some(port)),
        _ => (host, None),
    };
    let name = name.trim();
    if name.is_empty() || name.contains('.') || name.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(match port {
        Some(port) => format!("{name}.local:{port}"),
        None => format!("{name}.local"),
    })
}

async fn resolve_exactly(host: &str, default_port: u16) -> Result<Vec<SocketAddr>> {
    let target = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        // A bare IPv6 address needs brackets before a port can be appended.
        format!("[{host}]:{default_port}")
    } else if has_explicit_port(host) {
        host.to_string()
    } else {
        format!("{host}:{default_port}")
    };

    let mut addresses: Vec<SocketAddr> = Vec::new();
    for address in tokio::net::lookup_host(&target)
        .await
        .map_err(|e| NetError::Protocol(format!("could not resolve {target}: {e}")))?
    {
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    addresses.sort_by_key(|a| !a.is_ipv4());
    if addresses.is_empty() {
        return Err(NetError::Protocol(format!(
            "{target} resolved to no addresses"
        )));
    }
    Ok(addresses)
}

/// Whether a host string already carries a `:port`.
///
/// The awkward case is IPv6, which is full of colons. A bracketed address has
/// an explicit port only when a colon follows the closing bracket.
fn has_explicit_port(host: &str) -> bool {
    match host.rfind(']') {
        Some(bracket) => host[bracket..].contains(':'),
        None => host.matches(':').count() == 1,
    }
}

#[cfg(test)]
mod local_name_tests {
    use super::with_local;

    #[test]
    fn a_bare_computer_name_is_also_tried_as_dot_local() {
        assert_eq!(
            with_local("LIVINGROOM").as_deref(),
            Some("LIVINGROOM.local")
        );
        assert_eq!(
            with_local("living-room-pc:7742").as_deref(),
            Some("living-room-pc.local:7742")
        );
    }

    #[test]
    fn addresses_and_full_names_are_left_as_they_are() {
        assert_eq!(with_local("192.168.1.90"), None);
        assert_eq!(with_local("192.168.1.90:7742"), None);
        assert_eq!(with_local("fst.local"), None);
        assert_eq!(with_local("nas.example.com"), None);
        assert_eq!(with_local("fe80::1"), None);
        assert_eq!(with_local("[fe80::1]:7742"), None);
        assert_eq!(with_local(""), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A host asleep, or gone from the network, never answers. The connection
    // gives up, as a failure worth retrying elsewhere, rather than leaving the
    // app waiting on the operating system. A connection that never completes
    // stands in for it, so the test sends nothing anywhere.
    #[tokio::test]
    async fn a_host_that_never_answers_is_given_up_on() {
        let addr: SocketAddr = "127.0.0.1:7742".parse().unwrap();
        let never = std::future::pending::<std::io::Result<()>>();
        let wait = std::time::Duration::from_millis(50);
        let error = give_up_after(wait, addr, never)
            .await
            .expect_err("nothing answered");
        assert!(error.is_transient(), "a reason to look elsewhere: {error}");
        assert!(CONNECT_TIMEOUT <= std::time::Duration::from_secs(5));
    }

    // A connection that dies silently is only noticed if both ends probe it:
    // the app for its requests, the host to let go of devices that are gone.
    #[tokio::test]
    async fn both_ends_of_a_connection_probe_for_a_silent_death() {
        let listener = listen("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (client, accepted) = tokio::join!(connect(addr), listener.accept());
        let client = client.unwrap();
        let (host_side, _) = accepted.unwrap();
        tune(&host_side);

        assert!(
            socket2::SockRef::from(&client).keepalive().unwrap(),
            "the app's end"
        );
        assert!(
            socket2::SockRef::from(&host_side).keepalive().unwrap(),
            "the host's end"
        );
    }

    #[test]
    fn explicit_ports_are_recognised() {
        assert!(has_explicit_port("192.168.1.10:7742"));
        assert!(has_explicit_port("laptop-b:7742"));
        assert!(has_explicit_port("[fe80::1]:7742"));

        assert!(!has_explicit_port("192.168.1.10"));
        assert!(!has_explicit_port("laptop-b"));
        assert!(!has_explicit_port("[fe80::1]"));
        assert!(
            !has_explicit_port("fe80::1:2:3"),
            "a bare IPv6 address is all colons and no port"
        );
    }

    #[tokio::test]
    async fn resolving_applies_the_default_port() {
        let addr = resolve("127.0.0.1", 7742).await.unwrap();
        assert_eq!(addr.port(), 7742);
        assert_eq!(addr.ip().to_string(), "127.0.0.1");
    }

    #[tokio::test]
    async fn an_explicit_port_wins_over_the_default() {
        let addr = resolve("127.0.0.1:9000", 7742).await.unwrap();
        assert_eq!(addr.port(), 9000);
    }

    #[tokio::test]
    async fn a_bare_ipv6_address_gets_bracketed() {
        let addr = resolve("::1", 7742).await.unwrap();
        assert_eq!(addr.port(), 7742);
        assert!(addr.is_ipv6());
    }

    #[tokio::test]
    async fn an_unresolvable_name_is_an_error_not_a_hang() {
        assert!(
            resolve("this-host-does-not-exist.invalid", 7742)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_bound_listener_reports_the_port_the_os_chose() {
        let listener = listen("127.0.0.1:0".parse().unwrap()).await.unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), 0);
    }

    #[tokio::test]
    async fn connecting_applies_nodelay() {
        let listener = listen("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accept = tokio::spawn(async move { listener.accept().await });

        let stream = connect(addr).await.unwrap();
        assert!(stream.nodelay().unwrap());
        accept.await.unwrap().unwrap();
    }
}
