//! Release signatures.
//!
//! Each release has a `SHA256SUMS`: the digest of every file in it, one line
//! each as `sha256sum` writes them, and below the list a minisign signature
//! (Ed25519) of exactly those lines, made with Refora's release key by
//! `tools/release-sign`. An app takes its installer's digest from the list
//! only once the signature is good for the key it was built with.
//!
//! The list comes from the same place as the files, so a digest on its own
//! only shows a download arrived whole. The signature shows the list came
//! from whoever holds the key, which is not GitHub: a release put up by
//! someone who got into the account would not have one. The signed comment
//! names the release's version, so an older release's list, signed in its
//! day, cannot be put up again as a newer one.

use minisign_verify::{PublicKey, Signature};

use crate::UpdateError;

/// The public half of the release key. The secret half never leaves its
/// owner, protected by a password asked for at each signing.
const RELEASE_KEY: &str = include_str!("../release-key.pub");

/// Where the signature starts: the first line minisign writes.
const SIGNATURE_START: &str = "untrusted comment:";

/// The signed comment of a release's list, as `tools/release-sign` writes it.
pub(crate) fn trusted_comment(version: &str) -> String {
    format!("basalt release {version}")
}

/// The key updates must be signed with: the release key, or for an end to end
/// test of updates, a key named in `BASALT_RELEASE_KEY`, only while
/// `BASALT_RELEASES_API` points at this machine (as `api_base` allows), so it
/// can never stand in for the real key against the real releases.
pub(crate) fn trusted_key() -> Result<PublicKey, String> {
    if crate::testing_locally()
        && let Ok(path) = std::env::var("BASALT_RELEASE_KEY")
    {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
        return PublicKey::decode(&text).map_err(|e| e.to_string());
    }
    PublicKey::decode(RELEASE_KEY).map_err(|e| e.to_string())
}

/// The digest a release's `SHA256SUMS` gives for `name`, once its signature
/// is found good for `key` and it is the list of `version`.
pub(crate) fn signed_digest(
    key: &PublicKey,
    sums: &str,
    version: &str,
    name: &str,
) -> Result<String, UpdateError> {
    let (list, Some(signature)) = split(sums) else {
        return Err(UpdateError::Unsigned);
    };
    let refused = |why: String| {
        tracing::warn!("update signature refused: {why}");
        UpdateError::BadSignature
    };
    let signature = Signature::decode(signature).map_err(|e| refused(e.to_string()))?;
    key.verify(list.as_bytes(), &signature, false)
        .map_err(|e| refused(e.to_string()))?;
    if signature.trusted_comment() != trusted_comment(version) {
        return Err(refused(format!(
            "signed as \"{}\", offered as {version}",
            signature.trusted_comment()
        )));
    }
    // Signed, but not for this file: as good as unsigned.
    listed(list, name).ok_or(UpdateError::Unsigned)
}

/// `sums` as the list, and the signature below it if there is one.
pub(crate) fn split(sums: &str) -> (&str, Option<&str>) {
    let at = if sums.starts_with(SIGNATURE_START) {
        Some(0)
    } else {
        sums.find(&format!("\n{SIGNATURE_START}")).map(|at| at + 1)
    };
    match at {
        Some(at) => (&sums[..at], Some(&sums[at..])),
        None => (sums, None),
    }
}

/// The digest `list` gives for `name`: `<digest> *<name>`, or with two
/// spaces, as `sha256sum` writes for binary and text.
fn listed(list: &str, name: &str) -> Option<String> {
    list.lines().find_map(|line| {
        let (digest, file) = line.trim_end_matches('\r').split_once(' ')?;
        let file = file.strip_prefix(['*', ' ']).unwrap_or(file);
        if file == name {
            crate::digest_from(digest)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "\
0dc0469f6685a6c68a7d19ac77fc860ba26914c4aba37c18d3a7b12812bc949e *Basalt-Android.apk
8d9bcf47116fd268369ad4b839761ca3b1cf99ff29a3f1cfcb532436a4bbc16c *Basalt-Client-Setup.exe
ce7dcb4f411151b0532803b9699ced221c955496c06e1342685a84166d4c2914  Basalt-Host-Setup.exe
";

    /// `list` with a signature below it, as `tools/release-sign` makes it,
    /// and the key that checks it.
    fn signed(list: &str, comment: &str) -> (PublicKey, String) {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let signature = minisign::sign(
            Some(&pair.pk),
            &pair.sk,
            list.as_bytes(),
            Some(comment),
            None,
        )
        .unwrap()
        .into_string();
        let public = PublicKey::decode(&pair.pk.to_box().unwrap().into_string()).unwrap();
        (public, format!("{list}{signature}"))
    }

    #[test]
    fn the_release_key_reads() {
        assert!(PublicKey::decode(RELEASE_KEY).is_ok());
    }

    #[test]
    fn a_list_as_signed_gives_its_digests() {
        let (key, sums) = signed(LIST, &trusted_comment("1.6.0"));
        assert_eq!(
            signed_digest(&key, &sums, "1.6.0", "Basalt-Client-Setup.exe").unwrap(),
            "8d9bcf47116fd268369ad4b839761ca3b1cf99ff29a3f1cfcb532436a4bbc16c"
        );
        // The two-space form too.
        assert!(signed_digest(&key, &sums, "1.6.0", "Basalt-Host-Setup.exe").is_ok());
    }

    #[test]
    fn a_changed_byte_fails() {
        let (key, sums) = signed(LIST, &trusted_comment("1.6.0"));
        let changed = sums.replacen("8d9bcf47", "8d9bcf48", 1);
        assert!(matches!(
            signed_digest(&key, &changed, "1.6.0", "Basalt-Client-Setup.exe"),
            Err(UpdateError::BadSignature)
        ));
    }

    #[test]
    fn another_keys_signature_fails() {
        let (_, sums) = signed(LIST, &trusted_comment("1.6.0"));
        let (other_key, _) = signed(LIST, &trusted_comment("1.6.0"));
        assert!(matches!(
            signed_digest(&other_key, &sums, "1.6.0", "Basalt-Client-Setup.exe"),
            Err(UpdateError::BadSignature)
        ));
    }

    #[test]
    fn an_older_releases_list_is_not_a_newer_one() {
        let (key, sums) = signed(LIST, &trusted_comment("1.6.0"));
        assert!(matches!(
            signed_digest(&key, &sums, "1.7.0", "Basalt-Client-Setup.exe"),
            Err(UpdateError::BadSignature)
        ));
    }

    #[test]
    fn a_list_without_a_signature_is_unsigned() {
        let (key, _) = signed(LIST, &trusted_comment("1.6.0"));
        assert!(matches!(
            signed_digest(&key, LIST, "1.6.0", "Basalt-Client-Setup.exe"),
            Err(UpdateError::Unsigned)
        ));
    }

    #[test]
    fn a_file_the_list_leaves_out_is_unsigned() {
        let (key, sums) = signed(LIST, &trusted_comment("1.6.0"));
        assert!(matches!(
            signed_digest(&key, &sums, "1.6.0", "Basalt-Host-Linux-amd64.deb"),
            Err(UpdateError::Unsigned)
        ));
    }

    #[test]
    fn nonsense_is_not_a_signature() {
        let (key, _) = signed(LIST, &trusted_comment("1.6.0"));
        let sums = format!("{LIST}untrusted comment: x\nnot a signature\n");
        assert!(matches!(
            signed_digest(&key, &sums, "1.6.0", "Basalt-Client-Setup.exe"),
            Err(UpdateError::BadSignature)
        ));
    }

    #[test]
    fn the_signature_is_split_from_the_list() {
        let (_, sums) = signed(LIST, &trusted_comment("1.6.0"));
        let (list, signature) = split(&sums);
        assert_eq!(list, LIST);
        assert!(signature.unwrap().starts_with(SIGNATURE_START));
        assert_eq!(split(LIST), (LIST, None));
    }
}
