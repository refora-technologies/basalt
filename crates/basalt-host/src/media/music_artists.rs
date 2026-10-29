//! Artist photos from the internet, with the same switch as album covers.
//!
//! Only an artist's name is sent. MusicBrainz finds the artist; then:
//!
//! - **fanart.tv**, when the host's owner has added a key of their own (free
//!   with a fanart.tv account): the artist's photo there.
//! - Otherwise, or when fanart.tv has none, the photo **Wikidata** names for
//!   the artist (MusicBrainz links the two), from **Wikimedia Commons**. Only
//!   a photo under a free licence is taken, and who took it and its licence
//!   are kept with it: those licences ask for the credit, and the app shows
//!   it on the artist's page.
//!
//! Photos are kept in the host's own folder, never on the drive. An artist
//! not found is remembered for a month, as albums are.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::music_art::{BETWEEN_LOOKUPS, ask, escape, recently_missed};

const DIR: &str = "music-art";
/// A match MusicBrainz scores lower than this is not taken as the artist.
const SURE_ENOUGH: u32 = 90;
/// The photo's longest side, as asked of Commons.
const PHOTO_SIZE: u32 = 500;
/// An artist found by fanart.tv's lookup, to check a key against: Daft Punk.
const KNOWN_ARTIST: &str = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

/// The file an artist's photo is kept in, whether or not it is there yet.
pub fn photo_path(config_dir: &Path, name: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("artist-{}.img", key(name)))
}

/// Who took it and under what licence, kept beside the photo.
fn credit_path(config_dir: &Path, name: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("artist-{}.credit", key(name)))
}

fn miss_path(config_dir: &Path, name: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("artist-{}.none", key(name)))
}

fn key(name: &str) -> String {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    blake3::hash(name.to_lowercase().as_bytes()).to_hex()[..20].to_string()
}

/// An artist's photo, if fetched, and its credit, if it needs one.
pub fn photo(config_dir: &Path, name: &str) -> Option<(PathBuf, Option<String>)> {
    let path = photo_path(config_dir, name);
    if !path.is_file() {
        return None;
    }
    let credit = std::fs::read_to_string(credit_path(config_dir, name))
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    Some((path, credit))
}

/// The one who leads a credit: "Glass Arcade feat. Ines Hale" is Glass Arcade's.
/// As the app names its artists.
pub fn lead_artist(name: &str) -> &str {
    // Lowercased letter for letter, so a place in it is the same in the name.
    let lower = name.to_ascii_lowercase();
    let cut = [
        " feat. ",
        " feat ",
        " ft. ",
        " ft ",
        " featuring ",
        " with ",
    ]
    .iter()
    .filter_map(|w| lower.find(w))
    .min();
    match cut {
        Some(at) => name[..at].trim(),
        None => name.trim(),
    }
}

/// Whether an artist is worth asking about: a person or a band, named.
pub fn worth_asking(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    !lower.is_empty()
        && !lower.starts_with("unknown")
        && !matches!(lower.as_str(), "various artists" | "various")
}

/// What one artist's lookup came to.
enum Lookup {
    Found {
        bytes: Vec<u8>,
        credit: Option<String>,
    },
    NotFound,
    Failed,
}

/// Fetches the photos of `names` not kept yet and not looked for lately,
/// from fanart.tv first when there is a key. How many arrived.
pub async fn fetch_missing(names: Vec<String>, config_dir: &Path, fanart_key: &str) -> usize {
    let wanted: Vec<String> = names
        .into_iter()
        .filter(|n| worth_asking(n))
        .filter(|n| {
            !photo_path(config_dir, n).is_file() && !recently_missed(&miss_path(config_dir, n))
        })
        .collect();
    if wanted.is_empty() {
        return 0;
    }
    if let Err(e) = std::fs::create_dir_all(config_dir.join(DIR)) {
        tracing::warn!("no artist photo folder: {e}");
        return 0;
    }
    let Some(client) = super::music_art::web_client() else {
        return 0;
    };
    let mut added = 0;
    for name in wanted {
        match fetch_one(&client, &name, fanart_key).await {
            Lookup::Found { bytes, credit } => {
                if std::fs::write(photo_path(config_dir, &name), bytes).is_ok() {
                    let credit_file = credit_path(config_dir, &name);
                    match credit {
                        Some(credit) => {
                            let _ = std::fs::write(credit_file, credit);
                        }
                        None => {
                            let _ = std::fs::remove_file(credit_file);
                        }
                    }
                    added += 1;
                }
            }
            Lookup::NotFound => {
                let _ = std::fs::write(miss_path(config_dir, &name), b"");
            }
            Lookup::Failed => {}
        }
        tokio::time::sleep(BETWEEN_LOOKUPS).await;
    }
    if added > 0 {
        tracing::info!("fetched {added} artist photo(s)");
    }
    added
}

/// Forgets every "not found", so artists are asked about again: after a
/// fanart.tv key is added, it may know the ones Wikidata did not.
pub fn forget_misses(config_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(config_dir.join(DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("artist-") && name.ends_with(".none") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

async fn fetch_one(client: &reqwest::Client, name: &str, fanart_key: &str) -> Lookup {
    let artist = match find_artist(client, name).await {
        Ok(Some(artist)) => artist,
        Ok(None) => return Lookup::NotFound,
        Err(why) => {
            tracing::debug!("no photo for {name} this time: {why}");
            return Lookup::Failed;
        }
    };
    if !fanart_key.trim().is_empty() {
        match fanart_photo(client, &artist, fanart_key.trim()).await {
            Ok(Some(bytes)) => {
                return Lookup::Found {
                    bytes,
                    credit: None,
                };
            }
            Ok(None) => {}
            // A key turned away, or fanart.tv down: Wikidata may still have one.
            Err(why) => tracing::debug!("fanart.tv had no answer for {name}: {why}"),
        }
    }
    tokio::time::sleep(BETWEEN_LOOKUPS).await;
    match commons_photo(client, &artist).await {
        Ok(Some((bytes, credit))) => Lookup::Found {
            bytes,
            credit: Some(credit),
        },
        Ok(None) => Lookup::NotFound,
        Err(why) => {
            tracing::debug!("no photo for {name} this time: {why}");
            Lookup::Failed
        }
    }
}

#[derive(Deserialize)]
struct ArtistSearch {
    #[serde(default)]
    artists: Vec<ArtistHit>,
}

#[derive(Deserialize)]
struct ArtistHit {
    id: String,
    name: String,
    #[serde(default)]
    score: u32,
}

/// The artist on MusicBrainz by this name exactly, by its id. A near name
/// is somebody else: a photo of the wrong person is worse than none.
async fn find_artist(client: &reqwest::Client, name: &str) -> Result<Option<String>, String> {
    let query = format!("artist:\"{}\"", escape(name));
    let url = reqwest::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/artist/",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "5")],
    )
    .map_err(|e| e.to_string())?;
    let found: ArtistSearch = ask(client, url)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(found
        .artists
        .into_iter()
        .find(|a| a.score >= SURE_ENOUGH && same_name(&a.name, name))
        .map(|a| a.id))
}

fn same_name(a: &str, b: &str) -> bool {
    let plain = |s: &str| {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    plain(a) == plain(b)
}

// ---- fanart.tv ----

#[derive(Deserialize)]
struct Fanart {
    #[serde(default)]
    artistthumb: Vec<FanartImage>,
}

#[derive(Deserialize)]
struct FanartImage {
    url: String,
    #[serde(default)]
    likes: serde_json::Value,
}

impl FanartImage {
    fn likes(&self) -> u64 {
        match &self.likes {
            serde_json::Value::Number(n) => n.as_u64().unwrap_or(0),
            serde_json::Value::String(s) => s.parse().unwrap_or(0),
            _ => 0,
        }
    }
}

/// What fanart.tv said about an artist with this key.
enum FanartAnswer {
    Known(Fanart),
    /// It has nothing for this artist.
    Unknown,
    /// The key was not accepted.
    Refused,
}

/// fanart.tv's entry for an artist. A personal key is sent as one; and, if
/// turned away like that, as a project's key.
async fn fanart_entry(
    client: &reqwest::Client,
    artist: &str,
    key: &str,
) -> Result<FanartAnswer, String> {
    let url = format!("https://webservice.fanart.tv/v3.2/music/{artist}");
    for param in ["client_key", "api_key"] {
        let asked =
            reqwest::Url::parse_with_params(&url, &[(param, key)]).map_err(|e| e.to_string())?;
        let response = client.get(asked).send().await.map_err(|e| e.to_string())?;
        match response.status() {
            s if s == reqwest::StatusCode::UNAUTHORIZED || s == reqwest::StatusCode::FORBIDDEN => {
                continue;
            }
            reqwest::StatusCode::NOT_FOUND => return Ok(FanartAnswer::Unknown),
            _ => {
                let entry: Fanart = response
                    .error_for_status()
                    .map_err(|e| e.to_string())?
                    .json()
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(FanartAnswer::Known(entry));
            }
        }
    }
    Ok(FanartAnswer::Refused)
}

async fn fanart_photo(
    client: &reqwest::Client,
    artist: &str,
    key: &str,
) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match fanart_entry(client, artist, key).await? {
        FanartAnswer::Known(entry) => entry,
        FanartAnswer::Unknown => return Ok(None),
        FanartAnswer::Refused => return Err("the key was turned away".into()),
    };
    // The best liked first.
    entry
        .artistthumb
        .sort_by_key(|i| std::cmp::Reverse(i.likes()));
    let Some(best) = entry.artistthumb.first() else {
        return Ok(None);
    };
    picture(client, &best.url).await.map(Some)
}

/// Whether fanart.tv takes this key: asked about an artist it surely has.
pub async fn fanart_key_works(key: &str) -> Result<bool, String> {
    let client = super::music_art::web_client().ok_or("no web client")?;
    match fanart_entry(&client, KNOWN_ARTIST, key.trim()).await? {
        FanartAnswer::Refused => Ok(false),
        FanartAnswer::Known(_) | FanartAnswer::Unknown => Ok(true),
    }
}

// ---- Wikidata and Wikimedia Commons ----

#[derive(Deserialize)]
struct ArtistLinks {
    #[serde(default)]
    relations: Vec<Relation>,
}

#[derive(Deserialize)]
struct Relation {
    #[serde(rename = "type")]
    kind: String,
    url: Option<RelationUrl>,
}

#[derive(Deserialize)]
struct RelationUrl {
    resource: String,
}

/// The artist's photo on Commons, through Wikidata, with its credit.
async fn commons_photo(
    client: &reqwest::Client,
    artist: &str,
) -> Result<Option<(Vec<u8>, String)>, String> {
    let url = reqwest::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/artist/{artist}"),
        &[("inc", "url-rels"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let links: ArtistLinks = ask(client, url)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let link = |kind: &str| {
        links
            .relations
            .iter()
            .find(|r| r.kind == kind)
            .and_then(|r| r.url.as_ref())
            .and_then(|u| u.resource.rsplit('/').next())
            .map(str::to_string)
    };
    // Wikidata's photo first, as it is kept up to date; else the one
    // MusicBrainz links itself.
    let mut file = None;
    if let Some(item) = link("wikidata") {
        file = wikidata_photo(client, &item).await?;
    }
    if file.is_none() {
        file = link("image").map(|f| {
            let f = percent_decode(&f);
            f.strip_prefix("File:").unwrap_or(&f).to_string()
        });
    }
    let Some(file) = file else { return Ok(None) };
    let Some(info) = commons_info(client, &file).await? else {
        return Ok(None);
    };
    let Some(credit) = credit_for(&info) else {
        return Ok(None);
    };
    let bytes = picture(client, &info.thumb).await?;
    Ok(Some((bytes, credit)))
}

#[derive(Deserialize)]
struct Entity {
    entities: std::collections::HashMap<String, EntityClaims>,
}

#[derive(Deserialize)]
struct EntityClaims {
    #[serde(default)]
    claims: std::collections::HashMap<String, Vec<Claim>>,
}

#[derive(Deserialize)]
struct Claim {
    mainsnak: Snak,
}

#[derive(Deserialize)]
struct Snak {
    datavalue: Option<DataValue>,
}

#[derive(Deserialize)]
struct DataValue {
    value: serde_json::Value,
}

/// The Commons file Wikidata gives as the artist's image (P18).
async fn wikidata_photo(client: &reqwest::Client, item: &str) -> Result<Option<String>, String> {
    if !item.starts_with('Q') || !item[1..].chars().all(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    let entity: Entity = client
        .get(format!(
            "https://www.wikidata.org/wiki/Special:EntityData/{item}.json"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(entity
        .entities
        .values()
        .next()
        .and_then(|e| e.claims.get("P18"))
        .and_then(|claims| claims.first())
        .and_then(|c| c.mainsnak.datavalue.as_ref())
        .and_then(|v| v.value.as_str())
        .map(str::to_string))
}

/// A Commons file's picture at a size, and who made it under what licence.
struct CommonsInfo {
    thumb: String,
    licence: String,
    author: String,
}

async fn commons_info(client: &reqwest::Client, file: &str) -> Result<Option<CommonsInfo>, String> {
    let title = format!("File:{file}");
    let width = PHOTO_SIZE.to_string();
    let url = reqwest::Url::parse_with_params(
        "https://commons.wikimedia.org/w/api.php",
        &[
            ("action", "query"),
            ("titles", title.as_str()),
            ("prop", "imageinfo"),
            ("iiprop", "url|extmetadata"),
            ("iiurlwidth", width.as_str()),
            ("format", "json"),
        ],
    )
    .map_err(|e| e.to_string())?;
    let answer: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let Some(info) = answer["query"]["pages"]
        .as_object()
        .and_then(|pages| pages.values().next())
        .and_then(|page| page["imageinfo"].get(0))
    else {
        return Ok(None);
    };
    let meta = &info["extmetadata"];
    let field = |name: &str| {
        meta[name]["value"]
            .as_str()
            .map(plain_text)
            .unwrap_or_default()
    };
    let thumb = info["thumburl"]
        .as_str()
        .or_else(|| info["url"].as_str())
        .unwrap_or_default()
        .to_string();
    if thumb.is_empty() {
        return Ok(None);
    }
    Ok(Some(CommonsInfo {
        thumb,
        licence: field("LicenseShortName"),
        author: field("Artist"),
    }))
}

/// The credit a photo is shown with; None when its licence is not a free
/// one Basalt can show it under.
fn credit_for(info: &CommonsInfo) -> Option<String> {
    let licence = info.licence.trim();
    let lower = licence.to_lowercase();
    let free = lower.starts_with("cc by")
        || lower.starts_with("cc0")
        || lower.starts_with("public domain")
        || lower == "pd"
        || lower.starts_with("pd-");
    if !free {
        return None;
    }
    let author = info.author.trim();
    let mut credit = String::from("Photo: ");
    if !author.is_empty() {
        credit.push_str(author);
        credit.push_str(", ");
    }
    credit.push_str(licence);
    credit.push_str(", Wikimedia Commons");
    Some(credit)
}

/// Text from the bit of HTML Commons gives its fields as: tags dropped,
/// entities read, spaces tidied, and not too long.
fn plain_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 80 {
        let cut: String = out.chars().take(77).collect();
        format!("{}...", cut.trim_end())
    } else {
        out
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'_' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A picture from the web; anything that is not one is refused.
async fn picture(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if image::guess_format(&bytes).is_err() {
        return Err("not a picture".into());
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lead_artist_is_the_one_before_the_guests() {
        assert_eq!(lead_artist("Glass Arcade feat. Ines Hale"), "Glass Arcade");
        assert_eq!(lead_artist("Northline ft. Ada Moss"), "Northline");
        assert_eq!(lead_artist("Simon & Garfunkel"), "Simon & Garfunkel");
        assert_eq!(lead_artist("  Daft Punk "), "Daft Punk");
        assert_eq!(lead_artist("Ünal FEAT. X"), "Ünal");
    }

    #[test]
    fn compilations_and_unknowns_are_not_asked_about() {
        assert!(worth_asking("Daft Punk"));
        assert!(!worth_asking("Various Artists"));
        assert!(!worth_asking("Unknown artist"));
        assert!(!worth_asking("  "));
    }

    #[test]
    fn only_a_free_licence_is_shown_and_it_is_credited() {
        let info = |licence: &str, author: &str| CommonsInfo {
            thumb: "x".into(),
            licence: licence.into(),
            author: author.into(),
        };
        assert_eq!(
            credit_for(&info("CC BY-SA 4.0", "Maximilian Wild")).as_deref(),
            Some("Photo: Maximilian Wild, CC BY-SA 4.0, Wikimedia Commons")
        );
        assert_eq!(
            credit_for(&info("Public domain", "")).as_deref(),
            Some("Photo: Public domain, Wikimedia Commons")
        );
        assert!(credit_for(&info("Fair use", "Someone")).is_none());
        assert!(credit_for(&info("", "Someone")).is_none());
    }

    #[test]
    fn commons_fields_are_read_as_plain_text() {
        assert_eq!(
            plain_text("<a href=\"//x\">Maximilian&nbsp;Wild</a>\n"),
            "Maximilian Wild"
        );
        assert_eq!(plain_text("A &amp; B"), "A & B");
        assert!(plain_text(&"long ".repeat(40)).ends_with("..."));
    }

    #[test]
    fn a_linked_file_name_is_read_back() {
        assert_eq!(
            percent_decode("Daft_Punk_%282013%29.jpg"),
            "Daft Punk (2013).jpg"
        );
    }

    #[test]
    fn the_same_artist_is_the_same_whatever_the_spacing_or_case() {
        assert!(same_name("Far  Coast", "far coast"));
        assert!(!same_name("Far Coast", "Far Coasts"));
        assert_eq!(key("Daft Punk"), key(" daft  punk"));
    }
}
