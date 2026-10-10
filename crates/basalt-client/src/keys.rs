//! This device's key.
//!
//! One key for the device, the same at every host it pairs with, made the
//! first time it is needed and kept where it cannot be copied when there is
//! somewhere like that:
//!
//! - **A phone's Keystore**, in its secure hardware. The app supplies it
//!   through [`PhoneKeys`], since only the Java side can reach it.
//! - **A computer's TPM**, through Windows' Platform Crypto Provider.
//! - Otherwise **a key in memory**, written to disk sealed by Windows for the
//!   person signed in (a plain file where there is nothing to seal with).
//!
//! The chips never hand the private key out: the app asks them to sign, and
//! that is all. A key in a chip that has been reset is gone for good, and the
//! device has to pair again; see [`KeyError::Lost`].

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use basalt_proto::hex;
use basalt_proto::msg::{KeyKind, SignedStatement};
use basalt_trust::{PublicKey, Signature, Signer, SoftwareKey, TrustError};
use serde::{Deserialize, Serialize};

/// Which of Basalt's keys in a chip to delete, from their names: every one
/// made with `prefix` but `keep`. Nothing at all when `keep` is named and not
/// among them: the key in use cannot be seen, and with it the line between
/// what is in use and what is left over.
pub fn left_over<'a>(names: &'a [String], prefix: &str, keep: Option<&str>) -> Vec<&'a str> {
    if let Some(keep) = keep
        && !names.iter().any(|name| name == keep)
    {
        return Vec::new();
    }
    names
        .iter()
        .map(String::as_str)
        .filter(|name| name.starts_with(prefix) && Some(*name) != keep)
        .collect()
}

/// Deletes the device keys an earlier copy of Basalt left in this computer's
/// chip, all but `current`, the one in use. A key in the chip outlives the
/// app's own data, so a reinstall made a new one beside the old for good:
/// harmless, since no host trusts the old one, but never tidied. How many
/// were deleted.
#[cfg(windows)]
pub fn tidy_chip_keys(current: &StoredKey) -> usize {
    let keep = (current.backend == Backend::Tpm).then_some(current.name.as_str());
    tpm::delete_except(tpm::DEVICE_KEY_PREFIX, keep)
}

/// Deletes every device key Basalt made in this computer's chip, for this
/// person: what the uninstaller asks for when the app's data goes too.
#[cfg(windows)]
pub fn forget_chip_keys() -> usize {
    tpm::delete_except(tpm::DEVICE_KEY_PREFIX, None)
}

/// Where a key is kept, as the store records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Tpm,
    Phone,
    Software,
}

/// What the store keeps to find the key again. Never the private key in the
/// clear where it can be sealed, and never at all for a key in a chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredKey {
    pub backend: Backend,
    /// The chip's name for the key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// A software key's PKCS#8, sealed (or plain where nothing seals).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sealed: String,
    /// The public key, SubjectPublicKeyInfo hex: checked against what the
    /// backend says each time the key is loaded.
    pub public: String,
}

/// A phone's hardware key store, as the app reaches it.
///
/// `create` makes a P-256 signing key under `alias`, replacing any there, and
/// returns its SubjectPublicKeyInfo. `public` returns it, or None when there
/// is no such key. `sign` signs the message (SHA-256 with ECDSA) and returns
/// the signature in DER. Errors are the store's own words.
pub trait PhoneKeys: Send + Sync {
    fn create(&self, alias: &str) -> Result<Vec<u8>, String>;
    fn public(&self, alias: &str) -> Result<Option<Vec<u8>>, String>;
    fn sign(&self, alias: &str, message: &[u8]) -> Result<Vec<u8>, String>;
    fn delete(&self, alias: &str) -> Result<(), String>;
}

/// Which kinds of key this client may make.
#[derive(Clone)]
pub enum Policy {
    /// A key in memory only. What tests and the command line use: they open
    /// many clients, and each one must not leave a key in this machine's TPM.
    Software,
    /// The best this device offers: the phone's store when given one, the
    /// TPM on Windows, and a sealed software key otherwise.
    Platform(Option<Arc<dyn PhoneKeys>>),
    /// No key at all: a device from before keys. Only for tests.
    #[doc(hidden)]
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    /// The key is gone: its chip was reset, or the store was copied from
    /// somewhere it cannot be opened. Making a new one is the only way on.
    Lost(String),
    /// The key is there and cannot be used just now: the chip is busy or
    /// broken. Tried again later; never a reason to make a new one.
    Unavailable(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::Lost(why) => write!(f, "this device's key is gone: {why}"),
            KeyError::Unavailable(why) => write!(f, "this device's key cannot be used now: {why}"),
        }
    }
}

const PHONE_ALIAS: &str = "basalt-device-key";
/// How long after vouching for a host further offers from it are let pass.
const ENDORSE_QUIET: i64 = 60 * 60;
const SELF_TEST: &[u8] = b"basalt/self-test";

pub struct DeviceKey {
    signer: Box<dyn Signer>,
    kind: KeyKind,
    stored: StoredKey,
}

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DeviceKey({:?}, {:?})",
            self.kind,
            self.signer.public_key()
        )
    }
}

impl DeviceKey {
    /// Makes a new key, in the best place the policy allows. A chip that
    /// fails to make one, or makes one that does not sign properly, is passed
    /// over for the next place down. Blocks: call off the async runtime.
    pub fn create(policy: &Policy) -> Result<Self, KeyError> {
        if let Policy::Off = policy {
            return Err(KeyError::Unavailable("this client makes no keys".into()));
        }
        if let Policy::Platform(Some(phone)) = policy {
            match phone_create(phone) {
                Ok(key) => return Ok(key),
                Err(e) => tracing::warn!("the phone's key store could not make a key: {e}"),
            }
        }
        #[cfg(windows)]
        if let Policy::Platform(None) = policy {
            match tpm::create_key() {
                Ok(key) => return Ok(key),
                Err(e) => tracing::info!("no key in the TPM, using a sealed one: {e}"),
            }
        }
        software_create()
    }

    /// Opens the key the store recorded, checking it is still the same key.
    /// Blocks: call off the async runtime.
    pub fn load(stored: &StoredKey, policy: &Policy) -> Result<Self, KeyError> {
        let expected = PublicKey::from_hex(&stored.public)
            .map_err(|e| KeyError::Lost(format!("the recorded public key is unreadable: {e}")))?;
        let key = match stored.backend {
            Backend::Software => software_load(stored)?,
            Backend::Phone => match policy {
                Policy::Platform(Some(phone)) => phone_load(phone, stored)?,
                _ => {
                    return Err(KeyError::Unavailable(
                        "the phone's key store is not available to this app".into(),
                    ));
                }
            },
            Backend::Tpm => {
                #[cfg(windows)]
                {
                    tpm::load_key(stored)?
                }
                #[cfg(not(windows))]
                {
                    return Err(KeyError::Lost("this key was kept in a Windows TPM".into()));
                }
            }
        };
        if *key.public_key() != expected {
            return Err(KeyError::Lost(
                "the key kept is not the one recorded".into(),
            ));
        }
        Ok(key)
    }

    pub fn public_key(&self) -> &PublicKey {
        self.signer.public_key()
    }

    pub fn kind(&self) -> KeyKind {
        self.kind
    }

    pub fn stored(&self) -> &StoredKey {
        &self.stored
    }

    /// Signs. Blocks: a TPM takes tens of milliseconds.
    pub fn sign(&self, message: &[u8]) -> Result<Signature, TrustError> {
        self.signer.sign(message)
    }
}

/// This device's key, and a key in memory that signs in for it.
///
/// A key in a chip takes a tenth of a second to sign and signs one thing at a
/// time, and a device opens several connections at once: a grid of pictures
/// would wait on it. So for each host, once in a while, the device's key signs
/// a statement that a key made in memory for this run of the app signs in for
/// it, for a few hours; and that key signs each connection, at once. Pairing,
/// giving a host the key, and endorsing a host are still signed by the
/// device's key itself.
pub struct KeyRing {
    device: DeviceKey,
    session: SoftwareKey,
    /// Per host: the device's statement for the session key, and when it ends.
    passes: Mutex<HashMap<String, (SignedStatement, i64)>>,
    /// Hosts that refused the statement this run (a clock far out, say): the
    /// device's key signs every connection there instead.
    refused: Mutex<HashSet<String>>,
    /// When this device last vouched for each host. Every connection opened
    /// while an endorsement is due is offered one; the first is answered and
    /// the rest let pass for an hour, so a burst of connections does not
    /// queue at the chip for a renewal that has weeks to spare.
    endorsed: Mutex<HashMap<String, i64>>,
    /// Held while a session statement is made, so connections opening
    /// together near the end of the last one wait for one signature rather
    /// than each making their own.
    making_pass: Mutex<()>,
    /// Hosts that would not take this key this run: not asked again until
    /// the app starts afresh, so a refusal does not cost a signature on
    /// every connection.
    enrol_refused: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for KeyRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KeyRing({:?})", self.device)
    }
}

impl KeyRing {
    pub fn new(device: DeviceKey) -> Result<Self, KeyError> {
        let session = SoftwareKey::generate()
            .map_err(|e| KeyError::Unavailable(format!("could not make a session key: {e}")))?;
        Ok(Self {
            device,
            session,
            passes: Mutex::new(HashMap::new()),
            refused: Mutex::new(HashSet::new()),
            endorsed: Mutex::new(HashMap::new()),
            making_pass: Mutex::new(()),
            enrol_refused: Mutex::new(HashSet::new()),
        })
    }

    pub fn device(&self) -> &DeviceKey {
        &self.device
    }

    pub fn public_key(&self) -> &PublicKey {
        self.device.public_key()
    }

    pub fn kind(&self) -> KeyKind {
        self.device.kind()
    }

    /// Signs with the device's key. Blocks.
    pub fn sign_with_device(&self, message: &[u8]) -> Result<Signature, TrustError> {
        self.device.sign(message)
    }

    /// Signs with the key in memory. Quick.
    pub fn sign_with_session(&self, message: &[u8]) -> Result<Signature, TrustError> {
        self.session.sign(message)
    }

    /// Signs an endorsement a host offered, with the device's key, once it
    /// has passed [`basalt_trust::statement::check_endorse_offer`]. Blocks.
    pub fn sign_endorsement(
        &self,
        offer: &str,
        pinned_host: &str,
        now: i64,
    ) -> Result<Option<SignedStatement>, TrustError> {
        // Checked before anything else: an unfair offer is refused, never
        // let pass as if it had been answered.
        let payload = basalt_trust::statement::read_offer(offer)?;
        basalt_trust::statement::check_endorse_offer(
            &payload,
            self.device.public_key(),
            pinned_host,
            now,
        )?;
        // Claimed before signing, under the lock, so connections offered one
        // together cannot all find the hour free; given back if signing fails.
        let earlier = {
            let mut endorsed = self.endorsed.lock().expect("endorsed lock");
            let earlier = endorsed.get(pinned_host).copied();
            if earlier.is_some_and(|at| (now - at).abs() < ENDORSE_QUIET) {
                return Ok(None);
            }
            endorsed.insert(pinned_host.to_string(), now);
            earlier
        };
        let signed = match basalt_trust::statement::sign_offered(&*self.device.signer, offer) {
            Ok(signed) => signed,
            Err(e) => {
                let mut endorsed = self.endorsed.lock().expect("endorsed lock");
                match earlier {
                    Some(at) => endorsed.insert(pinned_host.to_string(), at),
                    None => endorsed.remove(pinned_host),
                };
                return Err(e);
            }
        };
        Ok(Some(SignedStatement {
            payload: signed.payload,
            signature: signed.signature,
        }))
    }

    /// Whether `host_id` refused this key earlier in this run.
    pub fn enrol_refused_at(&self, host_id: &str) -> bool {
        self.enrol_refused
            .lock()
            .expect("enrol lock")
            .contains(host_id)
    }

    /// `host_id` would not take this key: not asked again this run.
    pub fn enrol_refused(&self, host_id: &str) {
        self.enrol_refused
            .lock()
            .expect("enrol lock")
            .insert(host_id.to_string());
    }

    /// The endorsement just signed for `host_id` did not reach it: the next
    /// offer is answered rather than let pass.
    pub fn endorsement_not_delivered(&self, host_id: &str) {
        self.endorsed.lock().expect("endorsed lock").remove(host_id);
    }

    /// The statement for `host_id` while it has more than an hour left.
    pub fn pass(&self, host_id: &str, now: i64) -> Option<SignedStatement> {
        if self.refused.lock().expect("refused lock").contains(host_id) {
            return None;
        }
        let passes = self.passes.lock().expect("passes lock");
        passes
            .get(host_id)
            .filter(|(_, ends)| ends - now > basalt_trust::statement::SESSION_RENEW_WITHIN)
            .map(|(statement, _)| statement.clone())
    }

    /// Whether the device's key should sign at `host_id` instead.
    pub fn direct_at(&self, host_id: &str) -> bool {
        self.refused.lock().expect("refused lock").contains(host_id)
    }

    /// Makes a new statement for `host_id`, signed by the device's key, and
    /// keeps it. Blocks.
    pub fn make_pass(&self, host_id: &str, now: i64) -> Result<SignedStatement, TrustError> {
        let _one_at_a_time = self.making_pass.lock().unwrap_or_else(|e| e.into_inner());
        // Made by another connection while this one waited.
        if let Some(pass) = self.pass(host_id, now) {
            return Ok(pass);
        }
        let payload = basalt_trust::Payload::new(
            basalt_trust::Kind::Session,
            self.device.public_key(),
            self.session.public_key(),
            host_id,
            "",
            now,
        )?;
        let signed = basalt_trust::statement::sign(&*self.device.signer, &payload)?;
        let pass = SignedStatement {
            payload: signed.payload,
            signature: signed.signature,
        };
        self.passes
            .lock()
            .expect("passes lock")
            .insert(host_id.to_string(), (pass.clone(), payload.exp));
        Ok(pass)
    }

    /// `host_id` would not take the statement: sign there with the device's
    /// key for the rest of this run.
    pub fn refused_at(&self, host_id: &str) {
        self.refused
            .lock()
            .expect("refused lock")
            .insert(host_id.to_string());
    }
}

/// Signs `message` and checks the result, so a key that cannot sign is
/// found out when it is made, not the first time it matters.
fn self_test(signer: &dyn Signer) -> Result<(), String> {
    let signature = signer.sign(SELF_TEST).map_err(|e| e.to_string())?;
    if signer.public_key().verify(SELF_TEST, &signature) {
        Ok(())
    } else {
        Err("its signature did not verify".into())
    }
}

// ---------------------------------------------------------------------------
// Software
// ---------------------------------------------------------------------------

fn software_create() -> Result<DeviceKey, KeyError> {
    let key = SoftwareKey::generate().map_err(|e| KeyError::Unavailable(e.to_string()))?;
    let sealed = crate::store::secret::seal(&hex::encode(key.pkcs8()));
    let kind = if crate::store::secret::is_sealed(&sealed) {
        KeyKind::System
    } else {
        KeyKind::File
    };
    let stored = StoredKey {
        backend: Backend::Software,
        name: String::new(),
        sealed,
        public: key.public_key().to_hex(),
    };
    Ok(DeviceKey {
        signer: Box::new(key),
        kind,
        stored,
    })
}

fn software_load(stored: &StoredKey) -> Result<DeviceKey, KeyError> {
    // One that will not open is not taken for lost: Windows can fail to open
    // a sealed secret for a moment (early at sign-in, say), and making a new
    // key would cost every pairing that knows only this one. A store copied
    // from another person or computer stays unopenable, and that device
    // pairs again by hand.
    let opened = crate::store::secret::open(&stored.sealed);
    if opened.is_empty() {
        return Err(KeyError::Unavailable(
            "Windows could not open this device's key just now".into(),
        ));
    }
    let pkcs8 = hex::decode(&opened)
        .ok()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| KeyError::Lost("the kept key is unreadable".into()))?;
    let key = SoftwareKey::from_pkcs8(&pkcs8)
        .map_err(|e| KeyError::Lost(format!("the kept key is unreadable: {e}")))?;
    let kind = if crate::store::secret::is_sealed(&stored.sealed) {
        KeyKind::System
    } else {
        KeyKind::File
    };
    Ok(DeviceKey {
        signer: Box::new(key),
        kind,
        stored: stored.clone(),
    })
}

// ---------------------------------------------------------------------------
// A phone's Keystore
// ---------------------------------------------------------------------------

struct PhoneSigner {
    phone: Arc<dyn PhoneKeys>,
    alias: String,
    public: PublicKey,
}

impl Signer for PhoneSigner {
    fn public_key(&self) -> &PublicKey {
        &self.public
    }

    fn sign(&self, message: &[u8]) -> Result<Signature, TrustError> {
        let der = self
            .phone
            .sign(&self.alias, message)
            .map_err(TrustError::Signing)?;
        basalt_trust::der::signature_from_der(&der)
    }
}

fn phone_create(phone: &Arc<dyn PhoneKeys>) -> Result<DeviceKey, String> {
    let spki = phone.create(PHONE_ALIAS)?;
    let public = PublicKey::from_spki(&spki).map_err(|e| e.to_string())?;
    let signer = PhoneSigner {
        phone: Arc::clone(phone),
        alias: PHONE_ALIAS.into(),
        public,
    };
    if let Err(e) = self_test(&signer) {
        let _ = phone.delete(PHONE_ALIAS);
        return Err(format!("the new key did not sign properly: {e}"));
    }
    Ok(DeviceKey {
        stored: StoredKey {
            backend: Backend::Phone,
            name: PHONE_ALIAS.into(),
            sealed: String::new(),
            public: signer.public.to_hex(),
        },
        signer: Box::new(signer),
        kind: KeyKind::Chip,
    })
}

fn phone_load(phone: &Arc<dyn PhoneKeys>, stored: &StoredKey) -> Result<DeviceKey, KeyError> {
    let spki = phone
        .public(&stored.name)
        .map_err(KeyError::Unavailable)?
        .ok_or_else(|| KeyError::Lost("the phone's key store no longer has it".into()))?;
    let public = PublicKey::from_spki(&spki)
        .map_err(|e| KeyError::Lost(format!("the phone's key is unreadable: {e}")))?;
    Ok(DeviceKey {
        signer: Box::new(PhoneSigner {
            phone: Arc::clone(phone),
            alias: stored.name.clone(),
            public,
        }),
        kind: KeyKind::Chip,
        stored: stored.clone(),
    })
}

// ---------------------------------------------------------------------------
// Windows TPM
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub(crate) mod tpm {
    //! A key in the TPM, through Windows' Platform Crypto Provider.
    //!
    //! The key is the person's own (not the machine's), persisted by Windows
    //! under a name the store records, and never exportable: Windows hands
    //! out its public half and signs with it, and that is all.

    use std::sync::Mutex;

    use basalt_trust::{PublicKey, Signature, Signer, TrustError};
    use windows_sys::Win32::Foundation::{NTE_BAD_KEYSET, NTE_NOT_FOUND};
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDSA_P256_ALGORITHM, BCRYPT_ECDSA_PUBLIC_P256_MAGIC,
        MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_SILENT_FLAG, NCryptCreatePersistedKey, NCryptDeleteKey,
        NCryptEnumKeys, NCryptExportKey, NCryptFinalizeKey, NCryptFreeBuffer, NCryptFreeObject,
        NCryptKeyName, NCryptOpenKey, NCryptOpenStorageProvider, NCryptSignHash,
    };
    use windows_sys::core::HRESULT;

    use super::{Backend, DeviceKey, KeyError, StoredKey, self_test};

    #[derive(Debug)]
    pub enum Failure {
        /// No key by that name.
        Missing,
        Other(String),
    }

    impl std::fmt::Display for Failure {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Failure::Missing => write!(f, "the TPM has no such key"),
                Failure::Other(why) => write!(f, "{why}"),
            }
        }
    }

    /// An NCrypt handle, freed when dropped.
    struct Handle(usize);

    impl Drop for Handle {
        fn drop(&mut self) {
            if self.0 != 0 {
                // SAFETY: a handle NCrypt gave out and nothing has freed.
                unsafe { NCryptFreeObject(self.0) };
            }
        }
    }

    pub struct TpmKey {
        // Dropped in this order: the key before the provider it came from.
        key: Handle,
        _provider: Handle,
        /// One signature at a time; Windows does not promise a key handle is
        /// safe to use from two threads at once.
        lock: Mutex<()>,
        public: PublicKey,
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(result: HRESULT, what: &str) -> Result<(), Failure> {
        match result {
            0 => Ok(()),
            NTE_BAD_KEYSET | NTE_NOT_FOUND => Err(Failure::Missing),
            other => Err(Failure::Other(format!(
                "{what} failed (0x{:08x})",
                other as u32
            ))),
        }
    }

    fn provider() -> Result<Handle, Failure> {
        let mut handle = 0usize;
        // SAFETY: a valid out-pointer and a static provider name.
        let result =
            unsafe { NCryptOpenStorageProvider(&mut handle, MS_PLATFORM_CRYPTO_PROVIDER, 0) };
        // Never "missing": the TPM itself not being there just now says
        // nothing about whether the key is, and a missing key is what makes
        // a new one.
        check(result, "opening the TPM").map_err(|e| match e {
            Failure::Missing => Failure::Other(format!(
                "the TPM is not available (0x{:08x})",
                result as u32
            )),
            other => other,
        })?;
        Ok(Handle(handle))
    }

    impl TpmKey {
        /// Makes and persists a new key under `name`.
        pub fn create(name: &str) -> Result<Self, Failure> {
            let provider = provider()?;
            let name = wide(name);
            let mut key = 0usize;
            // SAFETY: valid handles and NUL-terminated strings that outlive
            // the call.
            check(
                unsafe {
                    NCryptCreatePersistedKey(
                        provider.0,
                        &mut key,
                        BCRYPT_ECDSA_P256_ALGORITHM,
                        name.as_ptr(),
                        0,
                        0,
                    )
                },
                "making a key in the TPM",
            )?;
            let key = Handle(key);
            // SAFETY: a key handle just created and not yet finalised.
            check(
                unsafe { NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG) },
                "finishing the key in the TPM",
            )?;
            Self::wrap(provider, key)
        }

        /// Opens the key persisted under `name`.
        pub fn open(name: &str) -> Result<Self, Failure> {
            let provider = provider()?;
            let name = wide(name);
            let mut key = 0usize;
            // SAFETY: as in `create`.
            check(
                unsafe {
                    NCryptOpenKey(provider.0, &mut key, name.as_ptr(), 0, NCRYPT_SILENT_FLAG)
                },
                "opening the key in the TPM",
            )?;
            Self::wrap(provider, Handle(key))
        }

        fn wrap(provider: Handle, key: Handle) -> Result<Self, Failure> {
            let public = export_public(&key)?;
            Ok(Self {
                key,
                _provider: provider,
                lock: Mutex::new(()),
                public,
            })
        }

        /// Deletes the key from the TPM for good.
        pub fn delete(mut self) -> Result<(), Failure> {
            let key = std::mem::replace(&mut self.key.0, 0);
            // SAFETY: a valid key handle, which NCryptDeleteKey frees whether
            // or not it succeeds; it is taken out of `self` so it is not
            // freed a second time.
            check(unsafe { NCryptDeleteKey(key, 0) }, "deleting the key")
        }
    }

    /// The public half, as the 72-byte `BCRYPT_ECCKEY_BLOB` Windows writes.
    fn export_public(key: &Handle) -> Result<PublicKey, Failure> {
        let mut blob = [0u8; 8 + 64];
        let mut written = 0u32;
        // SAFETY: the buffer is as long as the length passed.
        check(
            unsafe {
                NCryptExportKey(
                    key.0,
                    0,
                    BCRYPT_ECCPUBLIC_BLOB,
                    std::ptr::null(),
                    blob.as_mut_ptr(),
                    blob.len() as u32,
                    &mut written,
                    0,
                )
            },
            "reading the key's public half",
        )?;
        let magic = u32::from_le_bytes(blob[0..4].try_into().expect("4 bytes"));
        let length = u32::from_le_bytes(blob[4..8].try_into().expect("4 bytes"));
        if written as usize != blob.len() || magic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC || length != 32
        {
            return Err(Failure::Other("the TPM's key is not a P-256 key".into()));
        }
        let mut point = [0u8; 65];
        point[0] = 0x04;
        point[1..].copy_from_slice(&blob[8..]);
        PublicKey::from_point(&point).map_err(|e| Failure::Other(e.to_string()))
    }

    impl Signer for TpmKey {
        fn public_key(&self) -> &PublicKey {
            &self.public
        }

        fn sign(&self, message: &[u8]) -> Result<Signature, TrustError> {
            let digest = ring::digest::digest(&ring::digest::SHA256, message);
            let mut signature = [0u8; 64];
            let mut written = 0u32;
            let _one_at_a_time = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            // SAFETY: the digest and the signature buffer are as long as the
            // lengths passed, and the key handle is valid for `self`'s life.
            let result = unsafe {
                NCryptSignHash(
                    self.key.0,
                    std::ptr::null(),
                    digest.as_ref().as_ptr(),
                    digest.as_ref().len() as u32,
                    signature.as_mut_ptr(),
                    signature.len() as u32,
                    &mut written,
                    NCRYPT_SILENT_FLAG,
                )
            };
            check(result, "signing in the TPM").map_err(|e| TrustError::Signing(e.to_string()))?;
            if written != 64 {
                return Err(TrustError::Signing(
                    "the TPM's signature was the wrong length".into(),
                ));
            }
            Ok(Signature(signature))
        }
    }

    /// What every device key Basalt makes in the TPM is called, before its
    /// serial: how one left over is told from anything else's.
    pub(super) const DEVICE_KEY_PREFIX: &str = "Basalt device key ";

    /// The names of the keys in this person's TPM key store.
    fn names() -> Result<Vec<String>, String> {
        let mut provider = 0;
        // SAFETY: a provider handle to fill, and the provider's own name.
        check(
            unsafe { NCryptOpenStorageProvider(&mut provider, MS_PLATFORM_CRYPTO_PROVIDER, 0) },
            "opening the TPM's key store",
        )
        .map_err(|e| e.to_string())?;
        let mut state: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut names = Vec::new();
        loop {
            let mut key: *mut NCryptKeyName = std::ptr::null_mut();
            // SAFETY: the provider opened above; `key` and `state` are filled
            // by the call and freed below with NCryptFreeBuffer.
            let status = unsafe {
                NCryptEnumKeys(
                    provider,
                    std::ptr::null(),
                    &mut key,
                    &mut state,
                    NCRYPT_SILENT_FLAG,
                )
            };
            if status != 0 || key.is_null() {
                break;
            }
            // SAFETY: a key name the call handed back, read before it is freed.
            names.push(unsafe { from_wide((*key).pszName) });
            // SAFETY: allocated by NCryptEnumKeys.
            unsafe { NCryptFreeBuffer(key.cast()) };
        }
        // SAFETY: as above; the provider is freed once, here.
        unsafe {
            if !state.is_null() {
                NCryptFreeBuffer(state);
            }
            NCryptFreeObject(provider);
        }
        Ok(names)
    }

    fn from_wide(text: *const u16) -> String {
        if text.is_null() {
            return String::new();
        }
        let mut length = 0;
        // SAFETY: a NUL-terminated wide string from the key store.
        unsafe {
            while *text.add(length) != 0 {
                length += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(text, length))
        }
    }

    /// Deletes this person's TPM keys named with `prefix`, all but `keep`:
    /// see [`super::left_over`]. How many were deleted.
    pub(super) fn delete_except(prefix: &str, keep: Option<&str>) -> usize {
        let names = match names() {
            Ok(names) => names,
            Err(e) => {
                tracing::debug!("could not list the TPM's keys: {e}");
                return 0;
            }
        };
        let mut deleted = 0;
        for name in super::left_over(&names, prefix, keep) {
            match TpmKey::open(name).and_then(TpmKey::delete) {
                Ok(()) => deleted += 1,
                Err(e) => tracing::debug!("could not delete {name}: {e}"),
            }
        }
        deleted
    }

    /// A new device key in the TPM, tested before it is trusted.
    pub(super) fn create_key() -> Result<DeviceKey, String> {
        let name = format!(
            "{DEVICE_KEY_PREFIX}{}",
            basalt_trust::statement::new_serial().map_err(|e| e.to_string())?
        );
        let key = TpmKey::create(&name).map_err(|e| e.to_string())?;
        if let Err(e) = self_test(&key) {
            let _ = key.delete();
            return Err(format!("the TPM's key did not sign properly: {e}"));
        }
        let public = key.public.to_hex();
        Ok(DeviceKey {
            signer: Box::new(key),
            kind: basalt_proto::msg::KeyKind::Chip,
            stored: StoredKey {
                backend: Backend::Tpm,
                name,
                sealed: String::new(),
                public,
            },
        })
    }

    pub(super) fn load_key(stored: &StoredKey) -> Result<DeviceKey, KeyError> {
        let key = TpmKey::open(&stored.name).map_err(|e| match e {
            Failure::Missing => KeyError::Lost("the TPM no longer has it".into()),
            Failure::Other(why) => KeyError::Unavailable(why),
        })?;
        Ok(DeviceKey {
            signer: Box::new(key),
            kind: basalt_proto::msg::KeyKind::Chip,
            stored: stored.clone(),
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // Uses this computer's real TPM, so it only runs when asked:
        // `cargo test -p basalt-client tpm -- --ignored`. The key it makes is
        // deleted before it ends, pass or fail.
        #[test]
        #[ignore = "uses this computer's TPM"]
        fn a_key_made_in_the_tpm_signs_reopens_and_is_deleted() {
            let name = format!(
                "Basalt test key {}",
                basalt_trust::statement::new_serial().unwrap()
            );
            let key = TpmKey::create(&name).expect("this computer has a working TPM");
            struct Cleanup(String);
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    if let Ok(key) = TpmKey::open(&self.0) {
                        let _ = key.delete();
                    }
                }
            }
            let _cleanup = Cleanup(name.clone());

            let started = std::time::Instant::now();
            let signature = key.sign(b"hello").unwrap();
            eprintln!("one TPM signature took {:?}", started.elapsed());
            assert!(key.public_key().verify(b"hello", &signature));
            assert!(!key.public_key().verify(b"hellp", &signature));

            let again = TpmKey::open(&name).unwrap();
            assert_eq!(again.public_key(), key.public_key());
            let signature = again.sign(b"again").unwrap();
            assert!(key.public_key().verify(b"again", &signature));

            drop(again);
            key.delete().unwrap();
            assert!(matches!(TpmKey::open(&name), Err(Failure::Missing)));
        }

        #[test]
        #[ignore = "uses this computer's TPM"]
        fn a_device_key_in_the_tpm_survives_being_loaded_from_the_store() {
            let made = create_key().expect("this computer has a working TPM");
            let stored = made.stored().clone();
            let loaded = load_key(&stored).unwrap();
            assert_eq!(loaded.public_key(), made.public_key());
            let signature = loaded.sign(b"m").unwrap();
            assert!(made.public_key().verify(b"m", &signature));
            drop(loaded);
            drop(made);
            TpmKey::open(&stored.name).unwrap().delete().unwrap();
            assert!(matches!(load_key(&stored), Err(KeyError::Lost(_))));
        }

        #[test]
        fn a_name_the_tpm_does_not_have_is_missing_not_broken() {
            // Opening only reads: nothing is made, so this runs every time.
            match TpmKey::open("Basalt key that was never made 0000") {
                Err(Failure::Missing) => {}
                // A computer without a TPM cannot say either way.
                Err(Failure::Other(_)) => {}
                Ok(_) => panic!("a key nobody made was found"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_basalt_keys_left_over_are_deleted() {
        let names: Vec<String> = [
            "Basalt device key 1111",
            "Basalt device key 2222",
            "Basalt device key 3333",
            "Somebody else's key",
            "Basalt test key 4444",
        ]
        .map(String::from)
        .to_vec();
        let prefix = "Basalt device key ";
        // The one in use is kept, and nothing that is not a Basalt device
        // key is touched.
        assert_eq!(
            left_over(&names, prefix, Some("Basalt device key 2222")),
            ["Basalt device key 1111", "Basalt device key 3333"]
        );
        // The key in use cannot be seen: nothing is deleted at all.
        assert!(left_over(&names, prefix, Some("Basalt device key 9999")).is_empty());
        // Uninstalling: every Basalt device key, and still nothing else.
        assert_eq!(
            left_over(&names, prefix, None),
            [
                "Basalt device key 1111",
                "Basalt device key 2222",
                "Basalt device key 3333"
            ]
        );
    }

    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A phone's key store, played by software keys.
    #[derive(Default)]
    struct FakePhone {
        keys: Mutex<HashMap<String, basalt_trust::SoftwareKey>>,
        broken: bool,
    }

    impl PhoneKeys for FakePhone {
        fn create(&self, alias: &str) -> Result<Vec<u8>, String> {
            if self.broken {
                return Err("the key store is broken".into());
            }
            let key = basalt_trust::SoftwareKey::generate().map_err(|e| e.to_string())?;
            let spki = key.public_key().spki().to_vec();
            self.keys.lock().unwrap().insert(alias.into(), key);
            Ok(spki)
        }
        fn public(&self, alias: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .keys
                .lock()
                .unwrap()
                .get(alias)
                .map(|k| k.public_key().spki().to_vec()))
        }
        fn sign(&self, alias: &str, message: &[u8]) -> Result<Vec<u8>, String> {
            let keys = self.keys.lock().unwrap();
            let key = keys.get(alias).ok_or("missing")?;
            // Signed in DER, as the real store does.
            let rng = ring::rand::SystemRandom::new();
            let der = ring::signature::EcdsaKeyPair::from_pkcs8(
                &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
                key.pkcs8(),
                &rng,
            )
            .unwrap()
            .sign(&rng, message)
            .unwrap();
            Ok(der.as_ref().to_vec())
        }
        fn delete(&self, alias: &str) -> Result<(), String> {
            self.keys.lock().unwrap().remove(alias);
            Ok(())
        }
    }

    #[test]
    fn a_software_key_is_made_sealed_where_it_can_be_and_loads_back() {
        let key = DeviceKey::create(&Policy::Software).unwrap();
        assert_eq!(key.stored().backend, Backend::Software);
        #[cfg(windows)]
        assert_eq!(key.kind(), KeyKind::System, "sealed by Windows");
        assert!(!key.stored().sealed.is_empty());

        let loaded = DeviceKey::load(key.stored(), &Policy::Software).unwrap();
        assert_eq!(loaded.public_key(), key.public_key());
        let signature = loaded.sign(b"m").unwrap();
        assert!(key.public_key().verify(b"m", &signature));
    }

    #[test]
    fn a_stored_key_that_will_not_open_or_does_not_match_is_lost() {
        let key = DeviceKey::create(&Policy::Software).unwrap();

        // One that will not open now is not taken for lost.
        let mut copied = key.stored().clone();
        copied.sealed = "dpapi:00ff".into();
        assert!(matches!(
            DeviceKey::load(&copied, &Policy::Software),
            Err(KeyError::Unavailable(_))
        ));

        let other = DeviceKey::create(&Policy::Software).unwrap();
        let mut swapped = key.stored().clone();
        swapped.public = other.public_key().to_hex();
        assert!(matches!(
            DeviceKey::load(&swapped, &Policy::Software),
            Err(KeyError::Lost(_))
        ));

        let mut garbled = key.stored().clone();
        garbled.public = "zz".into();
        assert!(matches!(
            DeviceKey::load(&garbled, &Policy::Software),
            Err(KeyError::Lost(_))
        ));
    }

    #[test]
    fn a_phone_key_is_made_in_the_phone_and_signs_through_it() {
        let phone: Arc<dyn PhoneKeys> = Arc::new(FakePhone::default());
        let policy = Policy::Platform(Some(Arc::clone(&phone)));
        let key = DeviceKey::create(&policy).unwrap();
        assert_eq!(key.kind(), KeyKind::Chip);
        assert_eq!(key.stored().backend, Backend::Phone);
        assert!(key.stored().sealed.is_empty(), "nothing secret is stored");

        let loaded = DeviceKey::load(key.stored(), &policy).unwrap();
        let signature = loaded.sign(b"m").unwrap();
        assert!(key.public_key().verify(b"m", &signature));

        // Reset on the phone: gone, and said so.
        phone.delete(PHONE_ALIAS).unwrap();
        assert!(matches!(
            DeviceKey::load(key.stored(), &policy),
            Err(KeyError::Lost(_))
        ));
        // And a phone key cannot be opened without the phone's store.
        assert!(matches!(
            DeviceKey::load(key.stored(), &Policy::Software),
            Err(KeyError::Unavailable(_))
        ));
    }

    #[test]
    fn a_broken_phone_store_falls_back_to_a_software_key() {
        let phone: Arc<dyn PhoneKeys> = Arc::new(FakePhone {
            broken: true,
            ..FakePhone::default()
        });
        let key = DeviceKey::create(&Policy::Platform(Some(phone))).unwrap();
        assert_eq!(key.stored().backend, Backend::Software);
    }

    #[test]
    fn a_ring_makes_one_pass_per_host_and_renews_it_near_its_end() {
        let ring = KeyRing::new(DeviceKey::create(&Policy::Software).unwrap()).unwrap();
        let host = "aa".repeat(32);
        let now = 1_800_000_000;
        assert!(ring.pass(&host, now).is_none());
        let pass = ring.make_pass(&host, now).unwrap();
        assert_eq!(ring.pass(&host, now + 60), Some(pass.clone()));

        let statement = basalt_trust::Statement {
            payload: pass.payload.clone(),
            signature: pass.signature.clone(),
        };
        let payload = basalt_trust::statement::verify(
            &statement,
            basalt_trust::statement::Expect {
                kind: basalt_trust::Kind::Session,
                issuer: Some(ring.public_key()),
                subject: None,
                host: Some(&host),
                now,
            },
        )
        .unwrap();
        // What the pass vouches for is the key that signs connections.
        let signature = ring.sign_with_session(b"m").unwrap();
        assert!(payload.subject_key().unwrap().verify(b"m", &signature));
        assert!(!ring.public_key().verify(b"m", &signature));

        // Within the last hour, a new one is made.
        let late = now + basalt_trust::statement::SESSION_LIFETIME
            - basalt_trust::statement::SESSION_RENEW_WITHIN;
        assert!(ring.pass(&host, late).is_none());
        // Another host has its own.
        assert!(ring.pass(&"bb".repeat(32), now).is_none());

        ring.refused_at(&host);
        assert!(ring.direct_at(&host));
        assert!(ring.pass(&host, now).is_none());
    }

    #[test]
    fn a_ring_signs_only_a_fair_endorsement() {
        let ring = KeyRing::new(DeviceKey::create(&Policy::Software).unwrap()).unwrap();
        let host = basalt_trust::SoftwareKey::generate().unwrap();
        let host_id = host.public_key().id();
        let now = 1_800_000_000;
        let offer = |issuer: &PublicKey, subject: &PublicKey, kind| {
            let payload =
                basalt_trust::Payload::new(kind, issuer, subject, &host_id, "", now).unwrap();
            hex::encode(&serde_json::to_vec(&payload).unwrap())
        };
        let fair = offer(
            ring.public_key(),
            host.public_key(),
            basalt_trust::Kind::Endorse,
        );
        assert!(
            ring.sign_endorsement(&fair, &host_id, now)
                .unwrap()
                .is_some()
        );
        // Offered again within the hour: let pass, without signing.
        assert!(
            ring.sign_endorsement(&fair, &host_id, now + 60)
                .unwrap()
                .is_none()
        );
        // About another key, as another kind, at another host, or long ago.
        let other = basalt_trust::SoftwareKey::generate().unwrap();
        let wrong_subject = offer(
            ring.public_key(),
            other.public_key(),
            basalt_trust::Kind::Endorse,
        );
        assert!(
            ring.sign_endorsement(&wrong_subject, &host_id, now)
                .is_err()
        );
        let member = offer(
            ring.public_key(),
            host.public_key(),
            basalt_trust::Kind::Member,
        );
        assert!(ring.sign_endorsement(&member, &host_id, now).is_err());
        assert!(
            ring.sign_endorsement(&fair, &other.public_key().id(), now)
                .is_err()
        );
        assert!(ring.sign_endorsement(&fair, &host_id, now + 3600).is_err());
        assert!(ring.sign_endorsement("zz", &host_id, now).is_err());
    }

    #[test]
    fn the_stored_record_is_written_without_empty_fields() {
        let key = DeviceKey::create(&Policy::Software).unwrap();
        let json = serde_json::to_string(key.stored()).unwrap();
        assert!(json.contains("\"backend\":\"software\""));
        assert!(!json.contains("\"name\""));
        let back: StoredKey = serde_json::from_str(&json).unwrap();
        assert_eq!(&back, key.stored());
    }
}
