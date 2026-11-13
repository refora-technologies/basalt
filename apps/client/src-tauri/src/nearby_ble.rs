//! Devices nearby found by Bluetooth, on a computer (1.6.4).
//!
//! A computer ready to receive used to keep a Wi-Fi of its own open all the
//! time, for devices with no Wi-Fi in common; its one radio then hopped
//! between that and the Wi-Fi it was on, and everything on the computer's
//! Wi-Fi ran several times slower (21 against 125 Mbit/s to a host, on the
//! user's laptop). Now it says it's here over Bluetooth Low Energy instead,
//! and answers two things there:
//!
//! - INFO (read): who it is, as JSON: `{"v":1,"id","name","form","ssid","code"}`.
//! - OPEN (write, answered once done): open the Wi-Fi in `ssid`, for whoever
//!   asked. It closes again once nobody has been sharing over it a while.
//!
//! Sharing, it looks for devices saying so, reads each one's INFO, and asks
//! the one chosen to OPEN, then joins its Wi-Fi as before. Android does the
//! same in `NearbyBle.kt`, with the same ids.
//!
//! Some computers' Bluetooth can look but can't be found (this PC's Realtek,
//! driver of 2022: every advertisement of ours stays "waiting" or aborts).
//! Such a computer, ready, listens instead: a device sharing says "sharing
//! nearby" (BEACON) while its Share is open, and answers HERE (write). The
//! computer that hears it opens its own Wi-Fi, for as long as someone nearby
//! is sharing, and writes its INFO to HERE; the sharing device lists it, its
//! Wi-Fi already open. Two devices that both can't be found reach each other
//! on the same Wi-Fi only.
//!
//! Windows only; elsewhere on a computer (Linux) there is none of it yet, and
//! [`reach`] says so.

use serde::Serialize;

/// A ready device found by Bluetooth: where it is (for this computer only),
/// what it said about itself, and how strong.
#[derive(Debug, Clone, Serialize)]
pub struct Seen {
    pub address: String,
    pub info: String,
    pub rssi: i16,
    /// It told us it's here, its Wi-Fi already open (it can't be found by
    /// Bluetooth itself): nothing to ask, only to join.
    pub open: bool,
}

#[cfg(windows)]
mod imp {
    use super::Seen;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use windows::core::{Ref, Result as WinResult, GUID};
    use windows::Devices::Bluetooth::Advertisement::{
        BluetoothLEAdvertisement, BluetoothLEAdvertisementFilter,
        BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher,
        BluetoothLEScanningMode,
    };
    use windows::Devices::Bluetooth::GenericAttributeProfile::{
        GattCharacteristic, GattCharacteristicProperties, GattCommunicationStatus, GattLocalCharacteristic,
        GattLocalCharacteristicParameters, GattProtectionLevel, GattReadRequestedEventArgs,
        GattServiceProvider, GattServiceProviderAdvertisingParameters, GattWriteOption,
        GattWriteRequestedEventArgs,
    };
    use windows::Devices::Bluetooth::{
        BluetoothAdapter, BluetoothAddressType, BluetoothCacheMode, BluetoothError,
        BluetoothLEDevice,
    };
    use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};

    const SERVICE: GUID = GUID::from_u128(0xe5795d3a_c372_4b39_a44e_b20b2422a26b);
    const INFO: GUID = GUID::from_u128(0xc93fb84e_04a4_4001_8827_b05e8e879009);
    const OPEN: GUID = GUID::from_u128(0x7387b09a_e6eb_4948_a7e1_cc09f9f36479);
    /// A device sharing says so, while its Share is open.
    const BEACON: GUID = GUID::from_u128(0x52f5ac84_78b4_4fa7_b2c6_3c245c2f96be);
    /// Where a device that can't be found writes its INFO, to the one sharing.
    const HERE: GUID = GUID::from_u128(0x1ee8afff_ceb1_4ef5_a210_8e00471b34d6);
    /// Listening, our own Wi-Fi stays open this long after the last "sharing nearby".
    const SHARING_GONE: Duration = Duration::from_secs(60);
    /// A device sharing is told we're here again after this long.
    const TELL_AGAIN: Duration = Duration::from_secs(15);
    /// Listening because saying it's here failed: tried again after this.
    const FOUND_AGAIN: Duration = Duration::from_secs(2 * 60);
    /// How long a device heard sharing is given to find this computer on its
    /// Wi-Fi before this computer opens its own.
    const LAN_FIRST: Duration = Duration::from_secs(5);
    /// When "sharing nearby" was last heard from anyone.
    static LAST_SHARING_AD: Mutex<Option<Instant>> = Mutex::new(None);

    /// A device not heard from for this long leaves the list.
    const SEEN_FOR: Duration = Duration::from_secs(20);
    /// Its INFO read again after this long.
    const INFO_AGAIN: Duration = Duration::from_secs(60);
    /// Our own Wi-Fi, opened for someone, closes if no offer comes within this.
    const NOBODY_CAME: Duration = Duration::from_secs(3 * 60);
    /// And once the last offer over it has ended, after this.
    const ALL_DONE: Duration = Duration::from_secs(45);

    struct Heard {
        address: u64,
        random: bool,
        rssi: i16,
        seen: Instant,
        info: Option<String>,
        asked: Option<Instant>,
    }

    /// Opens and closes this computer's own Wi-Fi for whoever asks.
    pub type Opener = Arc<dyn Fn(bool) -> std::result::Result<(), String> + Send + Sync>;

    #[derive(Default)]
    pub struct State {
        /// The service, with its two answers: all three kept while ready, or
        /// Windows lets the service go and stops saying it's here.
        provider: Mutex<Option<(GattServiceProvider, GattLocalCharacteristic, GattLocalCharacteristic)>>,
        info: Arc<Mutex<Vec<u8>>>,
        watcher: Mutex<Option<BluetoothLEAdvertisementWatcher>>,
        heard: Arc<Mutex<HashMap<u64, Heard>>>,
        /// Since when our own Wi-Fi is open for someone who asked.
        opened: Arc<Mutex<Option<Instant>>>,
        /// One conversation with another device's Bluetooth at a time.
        talking: Arc<Mutex<()>>,
        /// Sharing: "sharing nearby", with its HERE answer.
        beacon: Mutex<Option<(GattServiceProvider, GattLocalCharacteristic)>>,
        /// Sharing: the devices that told us they're here, by id: (INFO, when).
        here: Arc<Mutex<HashMap<String, (String, Instant)>>>,
        /// Ready but can't be found: listening for devices sharing.
        listening: Mutex<Option<BluetoothLEAdvertisementWatcher>>,
        /// Since when, to try being found again now and then: one abort
        /// (the radio busy a moment) isn't for good.
        listening_since: Mutex<Option<Instant>>,
        /// When "sharing nearby" was last heard, listening.
        sharing_heard: Arc<Mutex<Option<Instant>>>,
        /// Each device sharing, when we last told it we're here.
        told: Arc<Mutex<HashMap<u64, Instant>>>,
    }

    fn fail(what: impl Into<String>) -> windows::core::Error {
        windows::core::Error::new(windows::core::HRESULT(0x8000_4005_u32 as i32), what.into())
    }

    fn buffer(bytes: &[u8]) -> WinResult<IBuffer> {
        let w = DataWriter::new()?;
        w.WriteBytes(bytes)?;
        w.DetachBuffer()
    }

    fn bytes(b: &IBuffer) -> WinResult<Vec<u8>> {
        let r = DataReader::FromBuffer(b)?;
        let mut v = vec![0u8; r.UnconsumedBufferLength()? as usize];
        r.ReadBytes(&mut v)?;
        Ok(v)
    }

    fn radio() -> Option<Radio> {
        let radios = Radio::GetRadiosAsync().ok()?.get().ok()?;
        radios.into_iter().find(|r| r.Kind().ok() == Some(RadioKind::Bluetooth))
    }

    /// `ready`, `bluetooth` (off), or `unsupported` (none, or it can't say it's here).
    pub fn reach() -> String {
        let adapter = BluetoothAdapter::GetDefaultAsync().ok().and_then(|op| op.get().ok());
        let Some(adapter) = adapter else {
            return "unsupported".into();
        };
        let able = adapter.IsLowEnergySupported().unwrap_or(false)
            && adapter.IsPeripheralRoleSupported().unwrap_or(false)
            && adapter.IsCentralRoleSupported().unwrap_or(false);
        if !able {
            return "unsupported".into();
        }
        match radio().and_then(|r| r.State().ok()) {
            Some(RadioState::On) => "ready".into(),
            Some(_) => "bluetooth".into(),
            None => "unsupported".into(),
        }
    }

    /// Bluetooth switched on, where Windows lets an app; else its settings
    /// opened, for the person to. Where things stand after.
    pub fn turn_on() -> String {
        let allowed = Radio::RequestAccessAsync()
            .ok()
            .and_then(|op| op.get().ok())
            .map(|a| a == RadioAccessStatus::Allowed)
            .unwrap_or(false);
        let switched = allowed
            && radio()
                .and_then(|r| r.SetStateAsync(RadioState::On).ok())
                .and_then(|op| op.get().ok())
                .is_some();
        if switched {
            // A moment for it to come up.
            for _ in 0..20 {
                if reach() == "ready" {
                    break;
                }
                std::thread::sleep(Duration::from_millis(150));
            }
        }
        if reach() == "bluetooth" {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", "", "ms-settings:bluetooth"])
                .spawn();
        }
        reach()
    }

    /// Ready (`info` Some), saying it's here and answering INFO and OPEN; or
    /// not, and our own Wi-Fi closed if it was open for someone.
    pub fn ready(state: &State, info: Option<Vec<u8>>, open: Opener) -> std::result::Result<(), String> {
        let Some(info) = info else {
            if let Some((provider, _, _)) = state.provider.lock().expect("provider").take() {
                let _ = provider.StopAdvertising();
            }
            if let Some(w) = state.listening.lock().expect("listening").take() {
                let _ = w.Stop();
            }
            if state.opened.lock().expect("opened").take().is_some() {
                let _ = open(false);
            }
            return Ok(());
        };
        *state.info.lock().expect("info") = info;
        // Listening already (this computer can't be found): carried on, and
        // being found tried again every so often.
        {
            let mut listening = state.listening.lock().expect("listening");
            if listening.is_some() {
                let since = *state.listening_since.lock().expect("listening since");
                if since.is_some_and(|at| at.elapsed() < FOUND_AGAIN) {
                    return Ok(());
                }
                if let Some(w) = listening.take() {
                    let _ = w.Stop();
                }
                basalt_client::nearby::note("bluetooth: trying again to be found");
            }
        }
        // One at a time, held throughout: two services with the same id at
        // once and Windows aborts both.
        let mut current = state.provider.lock().expect("provider");
        if let Some((provider, _, _)) = current.as_ref() {
            use windows::Devices::Bluetooth::GenericAttributeProfile::GattServiceProviderAdvertisementStatus as Status;
            match provider.AdvertisementStatus() {
                // Saying it's here, or on its way to: kept.
                Ok(Status::Started) | Ok(Status::StartedWithoutAllAdvertisementData) | Ok(Status::Created) => {
                    return Ok(())
                }
                // Dropped by Windows (aborted when the radio was busy, or stopped): started again.
                other => {
                    basalt_client::nearby::note(&format!("bluetooth: saying it's here was {other:?}; starting again"));
                    let _ = provider.StopAdvertising();
                    *current = None;
                }
            }
        }
        let started = start(state, Arc::clone(&open));
        // Given a few seconds to start: some adapters never do.
        let saying = match started {
            Ok(started) => {
                use windows::Devices::Bluetooth::GenericAttributeProfile::GattServiceProviderAdvertisementStatus as Status;
                let mut status = started.0.AdvertisementStatus();
                for _ in 0..20 {
                    if matches!(status, Ok(Status::Started) | Ok(Status::StartedWithoutAllAdvertisementData)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    status = started.0.AdvertisementStatus();
                }
                basalt_client::nearby::note(&format!("bluetooth: saying it's here: {status:?}"));
                if matches!(status, Ok(Status::Started) | Ok(Status::StartedWithoutAllAdvertisementData)) {
                    Some(started)
                } else {
                    let _ = started.0.StopAdvertising();
                    None
                }
            }
            Err(e) => {
                basalt_client::nearby::note(&format!("bluetooth: can't say it's here: {}", e.message()));
                None
            }
        };
        if let Some(started) = saying {
            *current = Some(started);
            return Ok(());
        }
        drop(current);
        basalt_client::nearby::note("bluetooth: this computer can't be found; listening for devices sharing instead");
        let watcher = listen(state, open).map_err(|e| format!("Bluetooth couldn't listen here: {}", e.message()))?;
        *state.listening.lock().expect("listening") = Some(watcher);
        *state.listening_since.lock().expect("listening since") = Some(Instant::now());
        Ok(())
    }

    /// Ready, but can't be found: listens for devices sharing nearby, opens
    /// our own Wi-Fi while one is, and tells each that we're here.
    fn listen(state: &State, open: Opener) -> WinResult<BluetoothLEAdvertisementWatcher> {
        let watcher = BluetoothLEAdvertisementWatcher::new()?;
        watcher.SetScanningMode(BluetoothLEScanningMode::Active)?;
        let filter = BluetoothLEAdvertisementFilter::new()?;
        let ad = BluetoothLEAdvertisement::new()?;
        ad.ServiceUuids()?.Append(BEACON)?;
        filter.SetAdvertisement(&ad)?;
        watcher.SetAdvertisementFilter(&filter)?;
        let heard = Arc::clone(&state.sharing_heard);
        let told = Arc::clone(&state.told);
        let opened = Arc::clone(&state.opened);
        let info = Arc::clone(&state.info);
        let talking = Arc::clone(&state.talking);
        watcher.Received(&TypedEventHandler::new(
            move |_, args: Ref<BluetoothLEAdvertisementReceivedEventArgs>| {
                let a = args.as_ref().ok_or_else(|| fail("no advertisement"))?;
                let address = a.BluetoothAddress()?;
                let random = a.BluetoothAddressType()? == BluetoothAddressType::Random;
                *LAST_SHARING_AD.lock().expect("last ad") = Some(Instant::now());
                let due = {
                    let mut told = told.lock().expect("told");
                    let due = told.get(&address).is_none_or(|at| at.elapsed() > TELL_AGAIN);
                    if due {
                        told.insert(address, Instant::now());
                    }
                    due
                };
                if !due {
                    return Ok(());
                }
                let opened = Arc::clone(&opened);
                let open = Arc::clone(&open);
                let info = Arc::clone(&info);
                let talking = Arc::clone(&talking);
                let heard = Arc::clone(&heard);
                std::thread::spawn(move || {
                    // A device sharing on this computer's Wi-Fi looks for it
                    // there within moments, and finds it: then there is
                    // nothing to open. Opened anyway, its own Wi-Fi made this
                    // one's slow and broke a send over it (a phone on the
                    // same Wi-Fi: three tries timed out).
                    let waited = Instant::now();
                    while waited.elapsed() < LAN_FIRST {
                        if basalt_client::nearby::looked_for_within(LAN_FIRST + Duration::from_secs(3)) {
                            basalt_client::nearby::note("bluetooth: someone nearby is sharing, and found this computer on its Wi-Fi");
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                    // And only if it's still sharing: the last word of one
                    // that just stopped (its app left the screen) isn't a reason.
                    let still = LAST_SHARING_AD
                        .lock()
                        .expect("last ad")
                        .is_some_and(|at| at > waited + Duration::from_secs(1));
                    if !still {
                        return;
                    }
                    // Heard sharing, and not on this Wi-Fi: our own stays open
                    // while it goes on (see `close_when_done`).
                    *heard.lock().expect("heard") = Some(Instant::now());
                    let _one = talking.lock().expect("talking");
                    if opened.lock().expect("opened").is_none() {
                        basalt_client::nearby::note("bluetooth: someone nearby is sharing; opening this computer's Wi-Fi");
                        match open(true) {
                            Ok(()) => {
                                *opened.lock().expect("opened") = Some(Instant::now());
                                close_when_done(Arc::clone(&opened), Arc::clone(&open), Some(heard));
                            }
                            Err(why) => {
                                basalt_client::nearby::note(&format!("bluetooth: couldn't open its Wi-Fi: {why}"));
                                return;
                            }
                        }
                    }
                    let said = info.lock().expect("info").clone();
                    let told = (|| -> WinResult<GattCommunicationStatus> {
                        let ch = characteristic(address, random, BEACON, HERE)?;
                        ch.WriteValueWithResultAndOptionAsync(&buffer(&said)?, GattWriteOption::WriteWithResponse)?
                            .get()?
                            .Status()
                    })();
                    basalt_client::nearby::note(&format!("bluetooth: told {address:012x} this computer is here: {told:?}"));
                });
                Ok(())
            },
        ))?;
        watcher.Start()?;
        Ok(watcher)
    }

    fn start(
        state: &State,
        open: Opener,
    ) -> WinResult<(GattServiceProvider, GattLocalCharacteristic, GattLocalCharacteristic)> {
        let made = GattServiceProvider::CreateAsync(SERVICE)?.get()?;
        if made.Error()? != BluetoothError::Success {
            return Err(fail(format!("{:?}", made.Error()?)));
        }
        let provider = made.ServiceProvider()?;
        let service = provider.Service()?;

        let p = GattLocalCharacteristicParameters::new()?;
        p.SetCharacteristicProperties(GattCharacteristicProperties::Read)?;
        p.SetReadProtectionLevel(GattProtectionLevel::Plain)?;
        let info_ch = service.CreateCharacteristicAsync(INFO, &p)?.get()?.Characteristic()?;
        let info = Arc::clone(&state.info);
        info_ch.ReadRequested(&TypedEventHandler::new(
            move |_, args: Ref<GattReadRequestedEventArgs>| {
                let args = args.as_ref().ok_or_else(|| fail("no request"))?;
                let deferral = args.GetDeferral()?;
                let request = args.GetRequestAsync()?.get()?;
                let bytes = info.lock().expect("info").clone();
                let at = (request.Offset()? as usize).min(bytes.len());
                request.RespondWithValue(&buffer(&bytes[at..])?)?;
                deferral.Complete()?;
                Ok(())
            },
        ))?;

        let p = GattLocalCharacteristicParameters::new()?;
        p.SetCharacteristicProperties(GattCharacteristicProperties::Write)?;
        p.SetWriteProtectionLevel(GattProtectionLevel::Plain)?;
        let open_ch = service.CreateCharacteristicAsync(OPEN, &p)?.get()?.Characteristic()?;
        let opened = Arc::clone(&state.opened);
        open_ch.WriteRequested(&TypedEventHandler::new(
            move |_, args: Ref<GattWriteRequestedEventArgs>| {
                let args = args.as_ref().ok_or_else(|| fail("no request"))?;
                let deferral = args.GetDeferral()?;
                let request = args.GetRequestAsync()?.get()?;
                let from = String::from_utf8_lossy(&bytes(&request.Value()?)?).to_string();
                basalt_client::nearby::note(&format!("bluetooth: {from} asks this computer to open its Wi-Fi"));
                let result = open(true);
                match &result {
                    Ok(()) => {
                        let first = opened.lock().expect("opened").replace(Instant::now()).is_none();
                        if first {
                            close_when_done(Arc::clone(&opened), Arc::clone(&open), None);
                        }
                        basalt_client::nearby::note("bluetooth: its Wi-Fi is open");
                    }
                    Err(why) => basalt_client::nearby::note(&format!("bluetooth: couldn't open its Wi-Fi: {why}")),
                }
                if request.Option()? == GattWriteOption::WriteWithResponse {
                    if result.is_ok() {
                        request.Respond()?;
                    } else {
                        // "Unlikely error": the asker is told it couldn't.
                        request.RespondWithProtocolError(0x0E)?;
                    }
                }
                deferral.Complete()?;
                Ok(())
            },
        ))?;

        let params = GattServiceProviderAdvertisingParameters::new()?;
        params.SetIsConnectable(true)?;
        params.SetIsDiscoverable(true)?;
        provider.StartAdvertisingWithParameters(&params)?;
        Ok((provider, info_ch, open_ch))
    }

    /// Watches our own Wi-Fi, opened for someone: closed once no offer came
    /// within [`NOBODY_CAME`], or [`ALL_DONE`] after the last one ended; and,
    /// opened because someone nearby was sharing (`sharing`), not while they
    /// still are.
    fn close_when_done(opened: Arc<Mutex<Option<Instant>>>, open: Opener, sharing: Option<Arc<Mutex<Option<Instant>>>>) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(10));
            let Some(since) = *opened.lock().expect("opened") else {
                return;
            };
            let (now, quiet) = basalt_client::nearby::receiving();
            if now > 0 {
                continue;
            }
            let still_sharing = sharing
                .as_ref()
                .and_then(|s| *s.lock().expect("sharing"))
                .is_some_and(|at| at.elapsed() < SHARING_GONE);
            if still_sharing {
                continue;
            }
            let close = match quiet {
                Some(q) if q > since => q.elapsed() > ALL_DONE,
                _ => since.elapsed() > NOBODY_CAME,
            };
            if close {
                *opened.lock().expect("opened") = None;
                basalt_client::nearby::note("bluetooth: closing its Wi-Fi, nobody sharing over it");
                let _ = open(false);
                return;
            }
        });
    }

    /// Looks for ready devices while `on`, reading each one's INFO.
    pub fn look(state: &State, on: bool) -> std::result::Result<(), String> {
        let mut watching = state.watcher.lock().expect("watcher");
        if !on {
            if let Some(w) = watching.take() {
                let _ = w.Stop();
            }
            if let Some((b, _)) = state.beacon.lock().expect("beacon").take() {
                let _ = b.StopAdvertising();
            }
            state.here.lock().expect("here").clear();
            return Ok(());
        }
        if watching.is_some() {
            return Ok(());
        }
        // "Sharing nearby", for devices that can't be found to come forward:
        // as far as this computer's Bluetooth can say it.
        match beacon(state) {
            Ok(b) => {
                let watched = b.0.clone();
                *state.beacon.lock().expect("beacon") = Some(b);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let status = watched.AdvertisementStatus();
                    basalt_client::nearby::note(&format!("bluetooth: saying it's sharing: {status:?}"));
                });
            }
            Err(e) => basalt_client::nearby::note(&format!("bluetooth: can't say it's sharing: {}", e.message())),
        }
        let watcher = watch(state).map_err(|e| format!("Bluetooth couldn't look for devices: {}", e.message()))?;
        *watching = Some(watcher);
        Ok(())
    }

    fn watch(state: &State) -> WinResult<BluetoothLEAdvertisementWatcher> {
        let watcher = BluetoothLEAdvertisementWatcher::new()?;
        watcher.SetScanningMode(BluetoothLEScanningMode::Active)?;
        let filter = BluetoothLEAdvertisementFilter::new()?;
        let ad = BluetoothLEAdvertisement::new()?;
        ad.ServiceUuids()?.Append(SERVICE)?;
        filter.SetAdvertisement(&ad)?;
        watcher.SetAdvertisementFilter(&filter)?;
        let heard = Arc::clone(&state.heard);
        let talking = Arc::clone(&state.talking);
        watcher.Received(&TypedEventHandler::new(
            move |_, args: Ref<BluetoothLEAdvertisementReceivedEventArgs>| {
                let a = args.as_ref().ok_or_else(|| fail("no advertisement"))?;
                let address = a.BluetoothAddress()?;
                let random = a.BluetoothAddressType()? == BluetoothAddressType::Random;
                let rssi = a.RawSignalStrengthInDBm()?;
                let ask = {
                    let mut list = heard.lock().expect("heard");
                    let h = list.entry(address).or_insert(Heard { address, random, rssi, seen: Instant::now(), info: None, asked: None });
                    h.rssi = rssi;
                    h.seen = Instant::now();
                    let due = match (&h.info, h.asked) {
                        (_, None) => true,
                        (Some(_), Some(at)) => at.elapsed() > INFO_AGAIN,
                        (None, Some(at)) => at.elapsed() > Duration::from_secs(10),
                    };
                    if due {
                        h.asked = Some(Instant::now());
                    }
                    due
                };
                if ask {
                    let heard = Arc::clone(&heard);
                    let talking = Arc::clone(&talking);
                    std::thread::spawn(move || {
                        let _one = talking.lock().expect("talking");
                        match read_info(address, random) {
                            Ok(info) => {
                                if let Some(h) = heard.lock().expect("heard").get_mut(&address) {
                                    h.info = Some(info);
                                }
                            }
                            Err(e) => basalt_client::nearby::note(&format!(
                                "bluetooth: couldn't ask {address:012x} who it is: {}",
                                e.message()
                            )),
                        }
                    });
                }
                Ok(())
            },
        ))?;
        watcher.Start()?;
        Ok(watcher)
    }

    fn beacon(state: &State) -> WinResult<(GattServiceProvider, GattLocalCharacteristic)> {
        let made = GattServiceProvider::CreateAsync(BEACON)?.get()?;
        if made.Error()? != BluetoothError::Success {
            return Err(fail(format!("{:?}", made.Error()?)));
        }
        let provider = made.ServiceProvider()?;
        let p = GattLocalCharacteristicParameters::new()?;
        p.SetCharacteristicProperties(GattCharacteristicProperties::Write)?;
        p.SetWriteProtectionLevel(GattProtectionLevel::Plain)?;
        let here_ch = provider.Service()?.CreateCharacteristicAsync(HERE, &p)?.get()?.Characteristic()?;
        let here = Arc::clone(&state.here);
        here_ch.WriteRequested(&TypedEventHandler::new(
            move |_, args: Ref<GattWriteRequestedEventArgs>| {
                let args = args.as_ref().ok_or_else(|| fail("no request"))?;
                let deferral = args.GetDeferral()?;
                let request = args.GetRequestAsync()?.get()?;
                let info = String::from_utf8_lossy(&bytes(&request.Value()?)?).to_string();
                if let Ok(said) = serde_json::from_str::<serde_json::Value>(&info) {
                    if let Some(id) = said["id"].as_str() {
                        basalt_client::nearby::note(&format!("bluetooth: {id} says it's here"));
                        here.lock().expect("here").insert(id.to_string(), (info.clone(), Instant::now()));
                    }
                }
                if request.Option()? == GattWriteOption::WriteWithResponse {
                    request.Respond()?;
                }
                deferral.Complete()?;
                Ok(())
            },
        ))?;
        provider.StartAdvertisingWithParameters(&advertising_parameters()?)?;
        Ok((provider, here_ch))
    }

    /// Found and talked to: what both services advertise with.
    fn advertising_parameters() -> WinResult<GattServiceProviderAdvertisingParameters> {
        let params = GattServiceProviderAdvertisingParameters::new()?;
        params.SetIsConnectable(true)?;
        params.SetIsDiscoverable(true)?;
        Ok(params)
    }

    /// The devices heard lately whose INFO was read, and those that told us
    /// they're here.
    pub fn seen(state: &State) -> Vec<Seen> {
        let mut list = state.heard.lock().expect("heard");
        list.retain(|_, h| h.seen.elapsed() < SEEN_FOR);
        let mut out: Vec<Seen> = list
            .values()
            .filter_map(|h| {
                h.info.as_ref().map(|info| Seen {
                    address: format!("{:012x}{}", h.address, if h.random { "r" } else { "p" }),
                    info: info.clone(),
                    rssi: h.rssi,
                    open: false,
                })
            })
            .collect();
        let mut here = state.here.lock().expect("here");
        // Told again every few seconds while it's there.
        here.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(45));
        out.extend(here.iter().map(|(id, (info, _))| Seen {
            address: format!("here:{id}"),
            info: info.clone(),
            rssi: -60,
            open: true,
        }));
        out
    }

    fn characteristic(address: u64, random: bool, service: GUID, which: GUID) -> WinResult<GattCharacteristic> {
        let kind = if random { BluetoothAddressType::Random } else { BluetoothAddressType::Public };
        let device = BluetoothLEDevice::FromBluetoothAddressWithBluetoothAddressTypeAsync(address, kind)?.get()?;
        let services = device.GetGattServicesForUuidWithCacheModeAsync(service, BluetoothCacheMode::Uncached)?.get()?;
        if services.Status()? != GattCommunicationStatus::Success || services.Services()?.Size()? == 0 {
            return Err(fail("that device isn't ready for Basalt any more"));
        }
        let service = services.Services()?.GetAt(0)?;
        let chars = service.GetCharacteristicsForUuidWithCacheModeAsync(which, BluetoothCacheMode::Uncached)?.get()?;
        if chars.Status()? != GattCommunicationStatus::Success || chars.Characteristics()?.Size()? == 0 {
            return Err(fail("that device didn't answer"));
        }
        chars.Characteristics()?.GetAt(0)
    }

    fn read_info(address: u64, random: bool) -> WinResult<String> {
        let ch = characteristic(address, random, SERVICE, INFO)?;
        let read = ch.ReadValueWithCacheModeAsync(BluetoothCacheMode::Uncached)?.get()?;
        if read.Status()? != GattCommunicationStatus::Success {
            return Err(fail("it didn't say who it is"));
        }
        Ok(String::from_utf8_lossy(&bytes(&read.Value()?)?).to_string())
    }

    /// Asks the device at `address` (as [`seen`] gave it) to open its Wi-Fi.
    pub fn wake(state: &State, address: &str, from: &str) -> std::result::Result<(), String> {
        let (hex, kind) = address.split_at(address.len().saturating_sub(1));
        let number = u64::from_str_radix(hex, 16).map_err(|_| "That device has gone.".to_string())?;
        let _one = state.talking.lock().expect("talking");
        let asked = (|| -> WinResult<GattCommunicationStatus> {
            let ch = characteristic(number, kind == "r", SERVICE, OPEN)?;
            ch.WriteValueWithResultAndOptionAsync(&buffer(from.as_bytes())?, GattWriteOption::WriteWithResponse)?
                .get()?
                .Status()
        })();
        match asked {
            Ok(GattCommunicationStatus::Success) => Ok(()),
            Ok(_) => Err("That device couldn't open its Wi-Fi.".into()),
            Err(e) => Err(format!("That device didn't answer over Bluetooth ({}).", e.message())),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Seen;
    use std::sync::Arc;

    pub type Opener = Arc<dyn Fn(bool) -> std::result::Result<(), String> + Send + Sync>;

    #[derive(Default)]
    pub struct State;

    const NONE: &str = "Only devices on the same Wi-Fi can be reached from here.";

    pub fn reach() -> String {
        "unsupported".into()
    }
    pub fn turn_on() -> String {
        reach()
    }
    pub fn ready(_: &State, _: Option<Vec<u8>>, _: Opener) -> Result<(), String> {
        Ok(())
    }
    pub fn look(_: &State, _: bool) -> Result<(), String> {
        Ok(())
    }
    pub fn seen(_: &State) -> Vec<Seen> {
        Vec::new()
    }
    pub fn wake(_: &State, _: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
}

pub use imp::{look, reach, ready, seen, turn_on, wake, Opener, State};
