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

use super::music_names::CoverKey;

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

/// Fetches the covers of `albums` that are not kept yet and were not looked
/// for lately. How many arrived.
pub async fn fetch_missing(albums: Vec<CoverKey>, config_dir: &Path) -> usize {
    let wanted: Vec<CoverKey> = albums
        .into_iter()
        .filter(|k| worth_asking(&k.artist, &k.album))
        .filter(|k| {
            !has_art(config_dir, &k.artist, &k.album)
                && !recently_missed(&miss_path(config_dir, &k.artist, &k.album))
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
    for CoverKey {
        artist,
        album,
        single,
    } in wanted
    {
        match fetch_one(&client, &artist, &album, single).await {
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

/// The album found on MusicBrainz, then its front cover. A single of one
/// song may be on MusicBrainz only as the song: looked for as that too.
async fn fetch_one(client: &reqwest::Client, artist: &str, album: &str, single: bool) -> Lookup {
    for name in names_to_ask(album) {
        let found = match find_cover(client, artist, &name).await {
            Ok(None) if single => {
                tokio::time::sleep(BETWEEN_LOOKUPS).await;
                find_song_cover(client, artist, &name).await
            }
            found => found,
        };
        match found {
            Ok(Some(bytes)) => return Lookup::Found(bytes),
            Ok(None) => tokio::time::sleep(BETWEEN_LOOKUPS).await,
            Err(why) => {
                tracing::debug!("no cover for {album} by {artist} this time: {why}");
                return Lookup::Failed;
            }
        }
    }
    Lookup::NotFound
}

/// The ways an album or song is asked for: as named; without the guests
/// ("Paper Lanterns (feat. Ada Moss)" is "Paper Lanterns" there); without
/// anything in brackets ("Come Back Home (NORTHBOUND Remix)").
fn names_to_ask(name: &str) -> Vec<String> {
    let mut names = vec![name.trim().to_string()];
    for other in [without_guests(name), without_brackets(name)] {
        if !other.is_empty() && !names.contains(&other) {
            names.push(other);
        }
    }
    names
}

/// "Title (feat. Ana)", "Title feat. Ana (Remix)", "Title ft Ana": the title,
/// and any other brackets.
fn without_guests(name: &str) -> String {
    let guest = |text: &str| {
        let lower = text.trim_start().to_lowercase();
        ["feat.", "feat ", "ft.", "ft ", "featuring ", "with "]
            .iter()
            .any(|w| lower.starts_with(w))
    };
    let mut out = String::new();
    let mut rest = name;
    while !rest.is_empty() {
        let next_bracket = rest.find(['(', '[']);
        // A guest named outside brackets runs to the next bracket.
        let words_end = next_bracket.unwrap_or(rest.len());
        let plain = &rest[..words_end];
        let cut = [" feat.", " feat ", " ft.", " ft ", " featuring "]
            .iter()
            .filter_map(|w| plain.to_lowercase().find(w))
            .min();
        out.push_str(&plain[..cut.unwrap_or(plain.len())]);
        let Some(open) = next_bracket else { break };
        let close = rest[open..]
            .find([')', ']'])
            .map_or(rest.len(), |c| open + c + 1);
        let inside = &rest[open + 1..close.saturating_sub(1).max(open + 1)];
        if !guest(inside) {
            out.push(' ');
            out.push_str(&rest[open..close]);
        }
        rest = &rest[close..];
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn without_brackets(name: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    for c in name.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    without_guests(&out)
}

/// The cover of a song's release: the song found on MusicBrainz, then the
/// first of its releases (a single before an album) whose cover is kept.
async fn find_song_cover(
    client: &reqwest::Client,
    artist: &str,
    title: &str,
) -> Result<Option<Vec<u8>>, String> {
    let query = format!(
        "recording:\"{}\" AND artist:\"{}\"",
        escape(title),
        escape(artist)
    );
    let url = reqwest::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/recording/",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "5")],
    )
    .map_err(|e| e.to_string())?;
    let found: Recordings = ask(client, url)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let Some(song) = found
        .recordings
        .into_iter()
        .find(|r| r.score >= SURE_ENOUGH && !r.releases.is_empty())
    else {
        return Ok(None);
    };
    let mut groups: Vec<ReleaseGroupRef> = Vec::new();
    for release in song.releases {
        if let Some(group) = release.release_group
            && !groups.iter().any(|g| g.id == group.id)
        {
            groups.push(group);
        }
    }
    let rank = |g: &ReleaseGroupRef| match g.primary_type.as_deref() {
        Some("Single") => 0,
        Some("Album") => 1,
        _ => 2,
    };
    groups.sort_by_key(rank);
    for group in groups.into_iter().take(3) {
        tokio::time::sleep(BETWEEN_LOOKUPS).await;
        if let Some(bytes) = front_cover(client, &group.id).await? {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
struct Recordings {
    #[serde(default)]
    recordings: Vec<Recording>,
}

#[derive(Deserialize)]
struct Recording {
    #[serde(default)]
    score: u32,
    #[serde(default)]
    releases: Vec<ReleaseRef>,
}

#[derive(Deserialize)]
struct ReleaseRef {
    #[serde(rename = "release-group")]
    release_group: Option<ReleaseGroupRef>,
}

#[derive(Deserialize)]
struct ReleaseGroupRef {
    id: String,
    #[serde(rename = "primary-type")]
    primary_type: Option<String>,
}

/// A MusicBrainz search. It answers "503" when asked faster than it allows,
/// or when it is busy: asked again a little later, twice, before the album
/// is left for the next time.
async fn ask(client: &reqwest::Client, url: reqwest::Url) -> Result<reqwest::Response, String> {
    let mut wait = Duration::from_secs(3);
    for _ in 0..2 {
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if response.status() != reqwest::StatusCode::SERVICE_UNAVAILABLE {
            return response.error_for_status().map_err(|e| e.to_string());
        }
        tokio::time::sleep(wait).await;
        wait *= 2;
    }
    client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())
}

/// A release group's front cover from the Cover Art Archive; `Ok(None)` when
/// it has none there.
async fn front_cover(client: &reqwest::Client, group: &str) -> Result<Option<Vec<u8>>, String> {
    let response = client
        .get(format!(
            "https://coverartarchive.org/release-group/{group}/front-500"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let bytes = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    // Only a picture is kept: anything else is not a cover.
    if image::guess_format(&bytes).is_err() {
        return Err("the cover is not a picture".into());
    }
    Ok(Some(bytes.to_vec()))
}

/// `Ok(None)`: a definite "there is none".
async fn find_cover(
    client: &reqwest::Client,
    artist: &str,
    album: &str,
) -> Result<Option<Vec<u8>>, String> {
    let query = lucene_query(artist, album);
    let url = reqwest::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/release-group/",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "3")],
    )
    .map_err(|e| e.to_string())?;
    let found: Search = ask(client, url)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    // The album is known: the first of its likely matches with a cover.
    for group in found
        .release_groups
        .into_iter()
        .filter(|g| g.score >= SURE_ENOUGH)
        .take(3)
    {
        tokio::time::sleep(BETWEEN_LOOKUPS).await;
        if let Some(bytes) = front_cover(client, &group.id).await? {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
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
    fn songs_are_asked_for_without_their_guests_too() {
        assert_eq!(
            names_to_ask("Paper Lanterns (feat. Ada Moss with The Night Office)"),
            vec![
                "Paper Lanterns (feat. Ada Moss with The Night Office)".to_string(),
                "Paper Lanterns".to_string()
            ]
        );
        assert_eq!(
            names_to_ask("Come Back Home feat. Ines Hale (NORTHBOUND Remix)"),
            vec![
                "Come Back Home feat. Ines Hale (NORTHBOUND Remix)".to_string(),
                "Come Back Home (NORTHBOUND Remix)".to_string(),
                "Come Back Home".to_string()
            ]
        );
        assert_eq!(
            names_to_ask("Sanda Eliya ft Mihi Sanda Eliya"),
            vec![
                "Sanda Eliya ft Mihi Sanda Eliya".to_string(),
                "Sanda Eliya".to_string()
            ]
        );
        assert_eq!(names_to_ask("Lowlight"), vec!["Lowlight".to_string()]);
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
