//! The host's secrets, sealed to this computer when they are written down.
//!
//! The host's private key and the people's keys sit in its config file. On
//! Windows they are sealed by Windows for this computer before they are
//! written, so a copy of the file (a backup that leaks, a folder shared by
//! mistake) opens nowhere else. Sealed for the computer rather than for the
//! person signed in, because an administrator resetting that person's password
//! would otherwise lose them, and these are the keys whose loss costs every
//! pairing. The file itself is in the person's own folder, which other people
//! on the computer cannot read.
//!
//! The cost, said plainly: the file restored onto a fresh installation of
//! Windows cannot be opened there, and every device pairs again. Where nothing
//! can seal, secrets are kept as they are.

/// What a sealed secret starts with.
const PREFIX: &str = "sealed:";

/// Mixed into every seal, so a blob sealed by some other program for this
/// computer does not open as one of Basalt's, nor the other way round.
#[cfg(windows)]
const ENTROPY: &[u8] = b"basalt-host-secret/v1";

/// A secret kept in memory as it is, and sealed when written down. Never
/// shown in a log: its debug form says only whether there is one.
#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl Secret {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0.is_empty() {
            write!(f, "Secret(none)")
        } else {
            write!(f, "Secret(…)")
        }
    }
}

/// Why a sealed secret did not open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsealable;

/// Seals a secret for this computer. Empty stays empty, sealed stays as it
/// is, and a secret that cannot be sealed is kept as it is: never lost.
pub fn seal(plain: &str) -> String {
    if plain.is_empty() || is_sealed(plain) {
        return plain.to_string();
    }
    // The same secret sealed before is written as it was then: the config is
    // saved often, its secrets rarely change, and Windows takes a moment to
    // seal and check each one.
    if let Some(sealed) = sealed_before().lock().expect("seal cache lock").get(plain) {
        return sealed.clone();
    }
    match platform::protect(plain.as_bytes()) {
        Some(sealed) => {
            // Only once it is known to open again: a seal that does not round
            // trip would turn the host's key into something nobody can read.
            match platform::unprotect(&sealed) {
                Some(back) if back == plain.as_bytes() => {
                    let written = format!("{PREFIX}{}", basalt_proto::hex::encode(&sealed));
                    let mut cache = sealed_before().lock().expect("seal cache lock");
                    // A handful of secrets at most; a bound all the same.
                    if cache.len() >= 64 {
                        cache.clear();
                    }
                    cache.insert(plain.to_string(), written.clone());
                    written
                }
                _ => {
                    tracing::warn!("a sealed secret did not open again; keeping it unsealed");
                    plain.to_string()
                }
            }
        }
        None => plain.to_string(),
    }
}

/// Secrets sealed this run, and how they were written. Kept in memory only,
/// where the secrets themselves already are.
fn sealed_before() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Opens a secret. One written before sealing reads as it is.
pub fn open(stored: &str) -> Result<String, Unsealable> {
    let Some(hex) = stored.strip_prefix(PREFIX) else {
        return Ok(stored.to_string());
    };
    basalt_proto::hex::decode(hex)
        .ok()
        .and_then(|bytes| platform::unprotect(&bytes))
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or(Unsealable)
}

pub fn is_sealed(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
        CryptProtectData, CryptUnprotectData,
    };

    use super::ENTROPY;

    fn blob(bytes: &[u8]) -> Option<CRYPT_INTEGER_BLOB> {
        Some(CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(bytes.len()).ok()?,
            pbData: bytes.as_ptr().cast_mut(),
        })
    }

    fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: Windows allocated `cbData` bytes at `pbData`; they are
        // copied out before the allocation is handed back.
        let bytes =
            unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
        unsafe { LocalFree(blob.pbData.cast()) };
        bytes
    }

    pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        let input = blob(plain)?;
        let entropy = blob(ENTROPY)?;
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: every blob is valid for the call; nothing else is passed.
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        (ok != 0).then(|| take(output))
    }

    pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        let input = blob(sealed)?;
        let entropy = blob(ENTROPY)?;
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: as above.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        (ok != 0).then(|| take(output))
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn protect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
    pub fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_seals_and_opens_as_it_was() {
        let sealed = seal("the host's key");
        #[cfg(windows)]
        {
            assert!(is_sealed(&sealed));
            assert!(!sealed.contains("the host"));
        }
        assert_eq!(open(&sealed).unwrap(), "the host's key");
    }

    #[test]
    fn empty_and_already_sealed_secrets_are_left_alone() {
        assert_eq!(seal(""), "");
        let once = seal("x");
        assert_eq!(seal(&once), once);
    }

    #[test]
    fn a_secret_written_before_sealing_reads_as_it_is() {
        assert_eq!(open("plain hex").unwrap(), "plain hex");
    }

    #[test]
    fn a_seal_that_will_not_open_says_so_rather_than_returning_nothing() {
        assert_eq!(open("sealed:00ff"), Err(Unsealable));
        assert_eq!(open("sealed:zz"), Err(Unsealable));
        // A blob sealed by Windows for another purpose does not open as ours.
        #[cfg(windows)]
        {
            let other = platform_other_purpose("secret");
            assert_eq!(open(&other), Err(Unsealable));
        }
    }

    /// Sealed for this computer, without Basalt's entropy.
    #[cfg(windows)]
    fn platform_other_purpose(plain: &str) -> String {
        use windows_sys::Win32::Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CryptProtectData,
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE,
                &mut output,
            )
        };
        assert_ne!(ok, 0);
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        format!("{PREFIX}{}", basalt_proto::hex::encode(&bytes))
    }
}
