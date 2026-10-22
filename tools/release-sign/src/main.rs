//! Basalt's release key, and signing a release with it.
//!
//! ```text
//! basalt-sign keygen --secret <path>                         make the key, once
//! basalt-sign sign --secret <path> dist/release-X.Y.Z/SHA256SUMS  sign a release
//! basalt-sign verify dist/release-X.Y.Z/SHA256SUMS             check one as the apps will
//! ```
//!
//! The key is minisign's (Ed25519). The secret half is written where
//! `--secret` says, protected by a password asked for here and never stored;
//! the public half goes into the apps, at `crates/basalt-update/release-key.pub`.
//!
//! A release is signed once, through its `SHA256SUMS`: the list of every
//! file's digest gets a minisign signature written below it, in the same
//! file, and the apps from 1.6.0 install an update only from a release whose
//! list is signed (see `crates/basalt-update/src/signature.rs`). The signed
//! comment names the release's version, read from the folder's name, so an
//! old release's list cannot be passed off as a newer one's. Before signing,
//! every file the list names is checked against it, and against its `.sha256`
//! where there is one.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use sha2::{Digest, Sha256};

/// Where the apps read the public key from, from the repository's root.
const PUBLIC_KEY: &str = "crates/basalt-update/release-key.pub";

/// Where a signature starts: the first line minisign writes. As the apps
/// split it.
const SIGNATURE_START: &str = "untrusted comment:";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("keygen") => match secret_arg(&args[1..]) {
            Ok((secret, rest)) if rest.is_empty() => keygen(&secret),
            _ => Err(USAGE.to_string()),
        },
        Some("sign") => match secret_arg(&args[1..]) {
            Ok((secret, rest)) if rest.len() == 1 => sign(&secret, &rest[0]),
            _ => Err(USAGE.to_string()),
        },
        Some("verify") if args.len() == 2 => verify(Path::new(&args[1])),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "basalt-sign keygen --secret <path>
basalt-sign sign --secret <path> dist/release-X.Y.Z/SHA256SUMS
basalt-sign verify dist/release-X.Y.Z/SHA256SUMS";

/// `--secret <path>` and what follows it.
fn secret_arg(args: &[String]) -> Result<(PathBuf, Vec<PathBuf>), String> {
    match args {
        [flag, secret, rest @ ..] if flag == "--secret" => Ok((
            PathBuf::from(secret),
            rest.iter().map(PathBuf::from).collect(),
        )),
        _ => Err(USAGE.to_string()),
    }
}

/// The repository's root, wherever this is run from inside it.
fn root() -> Result<PathBuf, String> {
    let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
    loop {
        if dir.join("crates/basalt-update/Cargo.toml").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            return Err("run this inside the Basalt repository".into());
        }
    }
}

fn keygen(secret: &Path) -> Result<(), String> {
    let public = root()?.join(PUBLIC_KEY);
    if secret.exists() {
        return Err(format!(
            "{} already exists. A new key would stop every installed copy from accepting \
             updates signed with it; nothing was changed.",
            secret.display()
        ));
    }
    if public.exists() {
        return Err(format!(
            "{} already exists: the apps already trust a key. Nothing was changed.",
            public.display()
        ));
    }
    let password =
        rpassword::prompt_password("Password for the release key: ").map_err(|e| e.to_string())?;
    if password.chars().count() < 12 {
        return Err("Use at least 12 characters. Nothing was made.".into());
    }
    let again =
        rpassword::prompt_password("The same password again: ").map_err(|e| e.to_string())?;
    if again != password {
        return Err("The two passwords differ. Nothing was made.".into());
    }
    let pair =
        minisign::KeyPair::generate_encrypted_keypair(Some(password)).map_err(|e| e.to_string())?;
    let secret_text = pair
        .sk
        .to_box(Some("Basalt release key, Refora Technologies (secret)"))
        .map_err(|e| e.to_string())?
        .into_string();
    let public_text = pair.pk.to_box().map_err(|e| e.to_string())?.into_string();
    if let Some(dir) = secret.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(secret, secret_text).map_err(|e| e.to_string())?;
    std::fs::write(&public, public_text).map_err(|e| e.to_string())?;
    println!(
        "Secret key: {} (keep a copy somewhere safe; it cannot be made again)",
        secret.display()
    );
    println!("Public key: {}", public.display());
    Ok(())
}

fn sign(secret: &Path, sums: &Path) -> Result<(), String> {
    let version = version_of(sums)?;
    let public = trusted_key()?;
    let text = read(sums)?;
    // Signed again, the old signature is replaced rather than signed over.
    let list = split(&text).0;
    check_files(list, folder_of(sums))?;

    let sealed = std::fs::read_to_string(secret)
        .map_err(|e| format!("can't read {}: {e}", secret.display()))?;
    let password =
        rpassword::prompt_password("Password for the release key: ").map_err(|e| e.to_string())?;
    let key = minisign::SecretKeyBox::from_string(&sealed)
        .and_then(|sealed| sealed.into_secret_key(Some(password)))
        .map_err(|_| "That password does not open the key.".to_string())?;
    let pk = minisign::PublicKey::from_secret_key(&key).map_err(|e| e.to_string())?;

    let signed = signed(list, &version, &key, &pk)?;
    // Checked against the key the apps carry before anything is written, so
    // a release signed with some other key is caught here and not by every
    // installed copy.
    check_signature(&public, &signed, &version)?;
    std::fs::write(sums, &signed).map_err(|e| format!("{}: {e}", sums.display()))?;
    println!("signed {} for {version}", sums.display());
    Ok(())
}

fn verify(sums: &Path) -> Result<(), String> {
    let version = version_of(sums)?;
    let text = read(sums)?;
    check_signature(&trusted_key()?, &text, &version)?;
    check_files(split(&text).0, folder_of(sums))?;
    println!("good  {} for {version}", sums.display());
    Ok(())
}

/// `list` with the signature for release `version` below it.
fn signed(
    list: &str,
    version: &str,
    key: &minisign::SecretKey,
    pk: &minisign::PublicKey,
) -> Result<String, String> {
    let mut list = list.to_string();
    if !list.ends_with('\n') {
        list.push('\n');
    }
    let signature = minisign::sign(
        Some(pk),
        key,
        list.as_bytes(),
        Some(&trusted_comment(version)),
        Some("signature from the Basalt release key"),
    )
    .map_err(|e| e.to_string())?;
    Ok(format!("{list}{}", signature.into_string()))
}

/// The signed comment the apps expect for release `version`.
fn trusted_comment(version: &str) -> String {
    format!("basalt release {version}")
}

/// Whether `text` is a list signed by `public` for release `version`.
fn check_signature(
    public: &minisign_verify::PublicKey,
    text: &str,
    version: &str,
) -> Result<(), String> {
    let (list, Some(signature)) = split(text) else {
        return Err("SHA256SUMS is not signed".into());
    };
    let signature =
        minisign_verify::Signature::decode(signature).map_err(|e| format!("the signature: {e}"))?;
    public
        .verify(list.as_bytes(), &signature, false)
        .map_err(|e| format!("the signature does not match the apps' key ({e})"))?;
    if signature.trusted_comment() != trusted_comment(version) {
        return Err(format!(
            "signed as \"{}\", not as release {version}",
            signature.trusted_comment()
        ));
    }
    Ok(())
}

/// The list, and the signature below it if there is one.
fn split(text: &str) -> (&str, Option<&str>) {
    let at = if text.starts_with(SIGNATURE_START) {
        Some(0)
    } else {
        text.find(&format!("\n{SIGNATURE_START}")).map(|at| at + 1)
    };
    match at {
        Some(at) => (&text[..at], Some(&text[at..])),
        None => (text, None),
    }
}

/// Every file `list` names, in `folder`, is the file it describes, and its
/// `.sha256`, if it has one, says the same.
fn check_files(list: &str, folder: &Path) -> Result<(), String> {
    let mut count = 0;
    for line in list.lines().map(|line| line.trim_end_matches('\r')) {
        if line.is_empty() {
            continue;
        }
        let (digest, name) =
            parse_line(line).ok_or_else(|| format!("not a digest line: {line}"))?;
        let file = folder.join(name);
        let actual = digest_of(&file)?;
        if actual != digest {
            return Err(format!(
                "{name} is not the file SHA256SUMS describes; nothing was signed"
            ));
        }
        let beside = folder.join(format!("{name}.sha256"));
        if beside.exists() {
            let text = read(&beside)?;
            if text.split_whitespace().next().map(str::to_ascii_lowercase) != Some(digest) {
                return Err(format!("{name}.sha256 disagrees with SHA256SUMS"));
            }
        }
        count += 1;
    }
    if count == 0 {
        return Err("SHA256SUMS lists no files".into());
    }
    Ok(())
}

/// `<digest> *<name>`, or with two spaces, as `sha256sum` writes them.
fn parse_line(line: &str) -> Option<(String, &str)> {
    let (digest, name) = line.split_once(' ')?;
    let name = name.strip_prefix(['*', ' ']).unwrap_or(name);
    let digest = digest.to_ascii_lowercase();
    let looks_right = digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit());
    // A name with a path in it would point outside the release's folder.
    let plain = !name.is_empty() && !name.contains(['/', '\\']) && name != "..";
    (looks_right && plain).then_some((digest, name))
}

fn digest_of(file: &Path) -> Result<String, String> {
    let mut reader = std::fs::File::open(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| format!("{}: {e}", file.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The release a `SHA256SUMS` belongs to, from its folder: `release-1.6.0`.
fn version_of(sums: &Path) -> Result<String, String> {
    let folder = folder_of(sums)
        .canonicalize()
        .map_err(|e| format!("{}: {e}", sums.display()))?;
    let name = folder.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let version = name.strip_prefix("release-").unwrap_or("");
    let plain = version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if sums.file_name().and_then(|n| n.to_str()) != Some("SHA256SUMS") || !plain {
        return Err(format!(
            "{}: sign the release's SHA256SUMS, in its folder: dist/release-X.Y.Z/SHA256SUMS",
            sums.display()
        ));
    }
    Ok(version.to_string())
}

fn folder_of(sums: &Path) -> &Path {
    match sums.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn trusted_key() -> Result<minisign_verify::PublicKey, String> {
    let path = root()?.join(PUBLIC_KEY);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "{}: {e} (make the key first: basalt-sign keygen)",
            path.display()
        )
    })?;
    minisign_verify::PublicKey::decode(&text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> (minisign::KeyPair, String, minisign_verify::PublicKey) {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let text = pair.pk.to_box().unwrap().into_string();
        let public = minisign_verify::PublicKey::decode(&text).unwrap();
        (pair, text, public)
    }

    /// A release folder holding `files`, and its SHA256SUMS path.
    fn release(version: &str, files: &[(&str, &[u8])]) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let folder = std::env::temp_dir()
            .join(format!(
                "basalt-sign-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ))
            .join(format!("release-{version}"));
        std::fs::create_dir_all(&folder).unwrap();
        let mut list = String::new();
        for (name, data) in files {
            std::fs::write(folder.join(name), data).unwrap();
            let digest = digest_of(&folder.join(name)).unwrap();
            std::fs::write(
                folder.join(format!("{name}.sha256")),
                format!("{digest} *{name}\n"),
            )
            .unwrap();
            list.push_str(&format!("{digest} *{name}\n"));
        }
        std::fs::write(folder.join("SHA256SUMS"), list).unwrap();
        folder.join("SHA256SUMS")
    }

    /// What this signs is what the apps accept: checked by the apps' own code.
    #[test]
    fn a_signed_list_is_one_the_apps_accept() {
        let (pair, public_text, public) = keys();
        let sums = release(
            "1.6.0",
            &[
                ("Basalt-Client-Setup.exe", b"client"),
                ("Basalt-Android.apk", b"apk"),
            ],
        );
        let list = read(&sums).unwrap();
        let signed = signed(&list, "1.6.0", &pair.sk, &pair.pk).unwrap();
        assert!(check_signature(&public, &signed, "1.6.0").is_ok());
        let digest = basalt_update::check_signed_list(
            &public_text,
            &signed,
            "1.6.0",
            "Basalt-Client-Setup.exe",
        )
        .expect("the apps accept it");
        assert_eq!(
            digest,
            digest_of(&sums.with_file_name("Basalt-Client-Setup.exe")).unwrap()
        );
        // For that release only.
        assert!(
            basalt_update::check_signed_list(
                &public_text,
                &signed,
                "1.6.1",
                "Basalt-Client-Setup.exe"
            )
            .is_err()
        );
    }

    #[test]
    fn signing_again_replaces_the_signature() {
        let (pair, public_text, public) = keys();
        let sums = release("1.6.0", &[("Basalt-Host-Setup.exe", b"host")]);
        let once = signed(&read(&sums).unwrap(), "1.6.0", &pair.sk, &pair.pk).unwrap();
        let twice = signed(split(&once).0, "1.6.0", &pair.sk, &pair.pk).unwrap();
        assert_eq!(twice.matches(SIGNATURE_START).count(), 1);
        assert!(check_signature(&public, &twice, "1.6.0").is_ok());
        assert!(
            basalt_update::check_signed_list(
                &public_text,
                &twice,
                "1.6.0",
                "Basalt-Host-Setup.exe"
            )
            .is_ok()
        );
    }

    #[test]
    fn another_key_or_version_is_refused() {
        let (pair, _, public) = keys();
        let (_, _, other) = keys();
        let sums = release("1.6.0", &[("Basalt-Host-Setup.exe", b"host")]);
        let signed = signed(&read(&sums).unwrap(), "1.6.0", &pair.sk, &pair.pk).unwrap();
        assert!(check_signature(&other, &signed, "1.6.0").is_err());
        assert!(check_signature(&public, &signed, "1.5.1").is_err());
        assert!(
            check_signature(&public, &read(&sums).unwrap(), "1.6.0").is_err(),
            "unsigned"
        );
    }

    #[test]
    fn a_list_that_does_not_match_its_files_is_not_signed() {
        let sums = release("1.6.0", &[("Basalt-Host-Setup.exe", b"host")]);
        let folder = folder_of(&sums).to_path_buf();
        assert!(check_files(&read(&sums).unwrap(), &folder).is_ok());

        std::fs::write(folder.join("Basalt-Host-Setup.exe"), b"rebuilt").unwrap();
        assert!(check_files(&read(&sums).unwrap(), &folder).is_err());

        let gone = release("1.6.0", &[("Basalt-Host-Setup.exe", b"host")]);
        std::fs::remove_file(gone.with_file_name("Basalt-Host-Setup.exe")).unwrap();
        assert!(check_files(&read(&gone).unwrap(), folder_of(&gone)).is_err());

        let stale = release("1.6.0", &[("Basalt-Host-Setup.exe", b"host")]);
        std::fs::write(
            stale.with_file_name("Basalt-Host-Setup.exe.sha256"),
            format!("{} *x\n", "0".repeat(64)),
        )
        .unwrap();
        assert!(check_files(&read(&stale).unwrap(), folder_of(&stale)).is_err());
    }

    #[test]
    fn names_with_paths_are_not_listed_files() {
        let digest = "a".repeat(64);
        assert!(parse_line(&format!("{digest} *Basalt-Android.apk")).is_some());
        assert!(parse_line(&format!("{digest}  Basalt-Android.apk")).is_some());
        assert!(parse_line(&format!("{digest} *../secret")).is_none());
        assert!(parse_line(&format!("{digest} *C:\\x")).is_none());
        assert!(parse_line("short *Basalt-Android.apk").is_none());
    }

    #[test]
    fn the_version_comes_from_the_release_folder() {
        let sums = release("1.6.0", &[("a", b"a")]);
        assert_eq!(version_of(&sums).unwrap(), "1.6.0");
        let loose = sums.parent().unwrap().parent().unwrap().join("SHA256SUMS");
        std::fs::write(&loose, "").unwrap();
        assert!(version_of(&loose).is_err());
        assert!(version_of(&sums.with_file_name("a")).is_err());
    }
}
