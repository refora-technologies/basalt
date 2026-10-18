//! Asking for hosts by mDNS, beside the broadcast in [`crate::discovery`].
//!
//! Some routers, mesh systems especially, drop broadcasts on Wi-Fi but pass
//! mDNS, which Chromecast, AirPlay and printers depend on. So a scan also
//! asks "any `_basalt._tcp` here?" by mDNS. Hosts announce that service (see
//! `basalt-host`), and the answer's sender is asked the ordinary discovery
//! question directly, so the beacon stays the one description of a host and
//! nothing here parses DNS records.
//!
//! The question goes from an ordinary port, not 5353: RFC 6762 section 5.1
//! has responders answer such a "one-shot" query directly to the sender. The
//! device then needs no mDNS responder of its own, no multicast lock on
//! Android, and no firewall rule on Windows, which lets a direct answer to a
//! multicast question in for a few seconds.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use tokio::net::UdpSocket;

/// The service hosts announce, as mDNS names it.
pub const SERVICE: &str = "_basalt._tcp.local.";

const GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const PORT: u16 = 5353;

/// A one-shot PTR question for [`SERVICE`].
fn query() -> Vec<u8> {
    // Id, flags, one question, no answers, authority or additional records.
    let mut packet = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in SERVICE.trim_end_matches('.').split('.') {
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    // Type PTR, class IN.
    packet.extend_from_slice(&[0, 12, 0, 1]);
    packet
}

/// Whether a datagram is an mDNS answer with something in it.
fn is_answer(datagram: &[u8]) -> bool {
    datagram.len() >= 12
        // The response bit.
        && datagram[2] & 0x80 != 0
        // At least one answer record.
        && u16::from_be_bytes([datagram[6], datagram[7]]) > 0
}

/// Sends the question out of every network this machine is on.
///
/// One socket, pointed at each interface in turn: a question sent without
/// choosing leaves by the default route only, which on a machine with a VPN
/// or a virtual adapter is often not the home network.
pub(crate) async fn ask() -> Option<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )
    .ok()?;
    socket.set_nonblocking(true).ok()?;
    socket
        .bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())
        .ok()?;
    // As RFC 6762 asks of every mDNS packet.
    socket.set_multicast_ttl_v4(255).ok();
    let packet = query();
    let target = SocketAddr::from((GROUP, PORT)).into();
    let mut sent = false;
    for address in crate::discovery::local_addresses() {
        if let IpAddr::V4(v4) = address
            && socket.set_multicast_if_v4(&v4).is_ok()
        {
            sent |= socket.send_to(&packet, &target).is_ok();
        }
    }
    if !sent {
        sent = socket.send_to(&packet, &target).is_ok();
    }
    if !sent {
        return None;
    }
    UdpSocket::from_std(socket.into()).ok()
}

/// Reads one answer from [`ask`]'s socket: who sent it.
pub(crate) async fn answer(socket: &UdpSocket, buf: &mut [u8]) -> Option<IpAddr> {
    let (len, from) = socket.recv_from(buf).await.ok()?;
    is_answer(&buf[..len]).then_some(from.ip())
}

/// Every address that answers within `window`: what [`crate::discovery::scan`]
/// asks for a beacon. On its own for tests, and for saying why a host was
/// not found.
pub async fn who_answers(window: std::time::Duration) -> Vec<IpAddr> {
    let Some(socket) = ask().await else {
        return Vec::new();
    };
    let mut answered = Vec::new();
    let mut buf = vec![0u8; 2048];
    let _ = tokio::time::timeout(window, async {
        loop {
            if let Some(ip) = answer(&socket, &mut buf).await
                && !answered.contains(&ip)
            {
                answered.push(ip);
            }
        }
    })
    .await;
    answered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_question_names_the_service_once() {
        let packet = query();
        assert_eq!(&packet[4..6], &[0, 1], "one question");
        assert_eq!(&packet[6..12], &[0; 6], "and nothing else");
        let name = b"\x07_basalt\x04_tcp\x05local\x00";
        assert_eq!(&packet[12..12 + name.len()], name);
        assert_eq!(&packet[12 + name.len()..], &[0, 12, 0, 1], "PTR, IN");
    }

    #[test]
    fn only_an_answer_with_records_counts() {
        let mut reply = query();
        assert!(!is_answer(&reply), "a question is not an answer");
        reply[2] |= 0x80;
        assert!(!is_answer(&reply), "an empty answer says nothing");
        reply[7] = 1;
        assert!(is_answer(&reply));
        assert!(!is_answer(&[0x84; 5]), "too short");
    }
}
