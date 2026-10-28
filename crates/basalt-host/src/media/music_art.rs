//! Album covers from the internet, for albums whose songs carry none.
//!
//! Off unless switched on, like posters for films: a lookup tells a service
//! what music is on the drive. When on, only an album's name and who it is
//! by are sent, to two open, free services:
//!
//! - **MusicBrainz**, the open music encyclopaedia, finds the album. Its data
//!   is free for any use; it asks for no more than one request a second and
//!   a User-Agent saying who is asking, both kept here.
//! - **Cover Art Archive** (run by the Internet Archive with MusicBrainz)
//!   has the album's front cover.
//!
//! Covers are kept in the host's own folder, never on the drive. An album not
//! found is remembered for a month, so a library is not asked about again on
//! every start.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

const DIR: &str = "music-art";
/// MusicBrainz asks for one request a second at most; a little slower.
const BETWEEN_LOOKUPS: Duration = Duration::from_millis(1100);
/// How long an album not found is left before it is asked about again.
const RETRY_AFTER: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// A match MusicBrainz scores lower than this is not taken as the album.
const SURE_ENOUGH: u32 = 90;
const TIMEOUT: Duration = Duration::from_secs(20);

/// The file an album's cover is kept in, whether or not it is there yet.
pub fn art_path(config_dir: &Path, artist: &str, album: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("{}.img", key(artist, album)))
}

/// Whether an album's cover has been fetched.
pub fn has_art(config_dir: &Path, artist: &str, album: &str) -> bool {
    art_path(config_dir, artist, album).is_file()
}

fn miss_path(config_dir: &Path, artist: &str, album: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("{}.none", key(artist, album)))
}

fn key(artist: &str, album: &str) -> String {
    let id = format!(
        "{}\u{0}{}",
        artist.trim().to_lowercase(),
        album.trim().to_lowercase()
    );
    blake3::hash(id.as_bytes()).to_hex()[..20].to_string()
}

/// Whether an album is worth asking about: named, and by somebody known.
pub fn worth_asking(artist: &str, album: &str) -> bool {
    let unknown = |s: &str| {
        let s = s.trim().to_lowercase();
        s.is_empty() || s.starts_with("unknown")
    };
    !unknown(artist) && !unknown(album)
}

/// Fetches the covers of `albums` (artist, album) that are not kept yet and
/// were not looked for lately. How many arrived.
pub async fn fetch_missing(albums: Vec<(String, String)>, config_dir: &Path) -> usize {
    let wanted: Vec<(String, String)> = albums
        .into_iter()
        .filter(|(artist, album)| worth_asking(artist, album))
        .filter(|(artist, album)| {
            !has_art(config_dir, artist, album)
                && !recently_missed(&miss_path(config_dir, artist, album))
        })
        .collect();
    if wanted.is_empty() {
        return 0;
    }
    if let Err(e) = std::fs::create_dir_all(config_dir.join(DIR)) {
        tracing::warn!("no album cover folder: {e}");
        return 0;
    }
    let client = match reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!(
            "Basalt/",
            env!("CARGO_PKG_VERSION"),
            " ( https://basalt.reforatech.com )"
        ))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!("could not start the album cover client: {e}");
            return 0;
        }
    };

    let mut added = 0;
    for (artist, album) in wanted {
        match fetch_one(&client, &artist, &album).await {
            Lookup::Found(bytes) => {
                if std::fs::write(art_path(config_dir, &artist, &album), bytes).is_ok() {
                    added += 1;
                }
            }
            // Remembered only when the services said so: a refusal or a
            // network failure is tried again next time, not a month later.
            Lookup::NotFound => {
                let _ = std::fs::write(miss_path(config_dir, &artist, &album), b"");
            }
            Lookup::Failed => {}
        }
        tokio::time::sleep(BETWEEN_LOOKUPS).await;
    }
    if added > 0 {
        tracing::info!("fetched {added} album cover(s)");
    }
    added
}

fn recently_missed(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|when| when.elapsed().ok())
        .is_some_and(|age| age < RETRY_AFTER)
}

#[derive(Deserialize)]
struct Search {
    #[serde(rename = "release-groups", default)]
    release_groups: Vec<ReleaseGroup>,
}

#[derive(Deserialize)]
struct ReleaseGroup {
    id: String,
    #[serde(default)]
    score: u32,
}

/// What one album's lookup came to.
enum Lookup {
    Found(Vec<u8>),
    /// MusicBrainz has no album it is sure of, or the album has no cover.
    NotFound,
    /// The network, or a service turning requests away for a while.
    Failed,
}

/// The album found on MusicBrainz, then its front cover.
async fn fetch_one(client: &reqwest::Client, artist: &str, album: &str) -> Lookup {
    match find_cover(client, artist, album).await {
        Ok(Some(bytes)) => Lookup::Found(bytes),
        Ok(None) => Lookup::NotFound,
        Err(()) => Lookup::Failed,
    }
}

/// `Ok(None)`: a definite "there is none".
async fn find_cover(
    client: &reqwest::Client,
    artist: &str,
    album: &str,
) -> Result<Option<Vec<u8>>, ()> {
    let query = lucene_query(artist, album);
    let url = reqwest::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/release-group/",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "3")],
    )
    .map_err(|_| ())?;
    let found: Search = client
        .get(url)
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?
        .json()
        .await
        .map_err(|_| ())?;
    let Some(group) = found
        .release_groups
        .into_iter()
        .find(|g| g.score >= SURE_ENOUGH)
    else {
        return Ok(None);
    };
    tokio::time::sleep(BETWEEN_LOOKUPS).await;
    let response = client
        .get(format!(
            "https://coverartarchive.org/release-group/{}/front-500",
            group.id
        ))
        .send()
        .await
        .map_err(|_| ())?;
    // The album is known and has no cover there.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let bytes = response
        .error_for_status()
        .map_err(|_| ())?
        .bytes()
        .await
        .map_err(|_| ())?;
    // Only a picture is kept: anything else is not a cover.
    if image::guess_format(&bytes).is_err() {
        return Err(());
    }
    Ok(Some(bytes.to_vec()))
}

/// The search MusicBrainz is asked: this album name, by this artist. A
/// compilation is asked for by name alone.
fn lucene_query(artist: &str, album: &str) -> String {
    let album = escape(album);
    let various = matches!(
        artist.trim().to_lowercase().as_str(),
        "various artists" | "various"
    );
    if various {
        format!("releasegroup:\"{album}\"")
    } else {
        format!("releasegroup:\"{album}\" AND artist:\"{}\"", escape(artist))
    }
}

/// Lucene's special characters, escaped, so a title cannot change the search.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if r#"+-&|!(){}[]^"~*?:\/"#.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_names_the_album_and_the_artist() {
        assert_eq!(
            lucene_query("Juniper Vale", "Lowlight"),
            r#"releasegroup:"Lowlight" AND artist:"Juniper Vale""#
        );
        assert_eq!(
            lucene_query("Various Artists", "Hits"),
            r#"releasegroup:"Hits""#
        );
    }

    #[test]
    fn a_title_cannot_change_the_search() {
        assert_eq!(escape(r#"AC/DC: "Live""#), r#"AC\/DC\: \"Live\""#);
    }

    #[test]
    fn unknown_albums_are_not_asked_about() {
        assert!(!worth_asking("Unknown artist", "Lowlight"));
        assert!(!worth_asking("Juniper Vale", ""));
        assert!(worth_asking("Juniper Vale", "Lowlight"));
    }

    #[test]
    fn one_album_one_file_whatever_the_case() {
        let dir = Path::new("cfg");
        assert_eq!(
            art_path(dir, "Juniper Vale", "Lowlight"),
            art_path(dir, " juniper vale", "LOWLIGHT ")
        );
    }
}
