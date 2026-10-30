//! Telling mDNS the host is here, for networks that drop broadcasts.
//!
//! The broadcast in `basalt_net::discovery` stays how hosts are found. Some
//! routers, mesh systems especially, drop broadcasts on Wi-Fi and pass mDNS,
//! which is what Chromecast and AirPlay use, so the host also announces
//! `_basalt._tcp`. A device that hears back asks the host's beacon directly
//! (see `basalt_net::mdns`): the announcement says only where to ask.

use std::sync::OnceLock;

use mdns_sd::{ServiceDaemon, ServiceInfo};

/// One responder for the whole process, however many hosts it runs: tests
/// run dozens, and each with its own would be dozens of threads and sockets.
fn daemon() -> Option<&'static ServiceDaemon> {
    static DAEMON: OnceLock<Option<ServiceDaemon>> = OnceLock::new();
    DAEMON
        .get_or_init(|| match ServiceDaemon::new() {
            Ok(daemon) => Some(daemon),
            Err(e) => {
                tracing::warn!("not announced by mDNS: {e}");
                None
            }
        })
        .as_ref()
}

/// The announcement, withdrawn when dropped.
pub struct Announced {
    fullname: String,
}

impl Drop for Announced {
    fn drop(&mut self) {
        if let Some(daemon) = daemon() {
            let _ = daemon.unregister(&self.fullname);
        }
    }
}

/// Announces a host serving on `port`. `None` when mDNS is not available
/// here, which costs only the networks that need it: the broadcast still
/// works everywhere else.
pub fn announce(host_id: &str, port: u16) -> Option<Announced> {
    let daemon = daemon()?;
    // Enough of the id to keep two hosts on one network apart; the name is
    // never shown, and never trusted.
    let short = &host_id[..host_id.len().min(12)];
    let instance = format!("Basalt {short}");
    let server = format!("basalt-{short}.local.");
    let info = ServiceInfo::new(
        basalt_net::mdns::SERVICE,
        &instance,
        &server,
        (),
        port,
        None::<std::collections::HashMap<String, String>>,
    )
    .map_err(|e| tracing::warn!("not announced by mDNS: {e}"))
    .ok()?
    .enable_addr_auto();
    let fullname = info.get_fullname().to_string();
    daemon
        .register(info)
        .map_err(|e| tracing::warn!("not announced by mDNS: {e}"))
        .ok()?;
    Some(Announced { fullname })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Over the real network: the announcement must be answerable by the
    // question devices ask, next to whatever mDNS responder the system runs.
    #[tokio::test]
    async fn a_host_announced_by_mdns_answers_the_question_devices_ask() {
        let id = format!("{:0>64}", std::process::id());
        let Some(_announced) = announce(&id, 7742) else {
            eprintln!("no mDNS here; skipped");
            return;
        };
        // Other hosts on the network answer too: listened to until this
        // machine has, not only until somebody has.
        let mine = basalt_net::discovery::local_addresses();
        let is_mine = |ip: &std::net::IpAddr| mine.contains(ip) || ip.is_loopback();
        let mut answered = Vec::new();
        for _ in 0..5 {
            for ip in basalt_net::mdns::who_answers(std::time::Duration::from_millis(900)).await {
                if !answered.contains(&ip) {
                    answered.push(ip);
                }
            }
            if answered.iter().any(is_mine) {
                break;
            }
        }
        assert!(
            answered.iter().any(is_mine),
            "answered by {answered:?}, this machine is {mine:?}"
        );
    }
}
