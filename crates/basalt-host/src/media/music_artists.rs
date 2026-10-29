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

/// Marks an artist whose photo was taken down as the wrong person: never
/// looked for again.
fn refused_path(config_dir: &Path, name: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("artist-{}.refused", key(name)))
}

/// Takes an artist's photo down, as of somebody else of the same name, and
/// keeps it from being fetched again.
pub fn refuse(config_dir: &Path, name: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir.join(DIR))?;
    std::fs::write(refused_path(config_dir, name), b"")?;
    for path in [photo_path(config_dir, name), credit_path(config_dir, name)] {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// The artist's MusicBrainz id, once found: not searched for again.
fn mbid_path(config_dir: &Path, name: &str) -> PathBuf {
    config_dir
        .join(DIR)
        .join(format!("artist-{}.mbid", key(name)))
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

/// The credit a fanart.tv photo is shown with.
const FANART_CREDIT: &str = "Photo: fanart.tv";

/// Between questions to fanart.tv: it publishes no limit, and is asked
/// gently all the same.
const FANART_PAUSE: std::time::Duration = std::time::Duration::from_millis(600);

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
            !photo_path(config_dir, n).is_file()
                && !refused_path(config_dir, n).is_file()
                && !recently_missed(&miss_path(config_dir, n))
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
        match fetch_one(&client, config_dir, &name, fanart_key).await {
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

async fn fetch_one(
    client: &reqwest::Client,
    config_dir: &Path,
    name: &str,
    fanart_key: &str,
) -> Lookup {
    match photo_by_musicbrainz(client, config_dir, name, fanart_key).await {
        Ok(Some(found)) => return found,
        Ok(None) => {}
        Err(why) => {
            tracing::debug!("no photo for {name} this time: {why}");
            return Lookup::Failed;
        }
    }
    // Not on MusicBrainz, or no photo there: many artists, Sri Lanka's among
    // them, are on Wikidata all the same.
    match photo_by_wikidata(client, name).await {
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

/// The artist found on MusicBrainz, then their photo on fanart.tv (with a
/// key) or the one MusicBrainz links. `Ok(None)`: none that way.
async fn photo_by_musicbrainz(
    client: &reqwest::Client,
    config_dir: &Path,
    name: &str,
    fanart_key: &str,
) -> Result<Option<Lookup>, String> {
    let Some(artist) = artist_id(client, config_dir, name).await? else {
        return Ok(None);
    };
    if !fanart_key.trim().is_empty() {
        match fanart_photo(client, &artist, fanart_key.trim()).await {
            // Said where it is from, as every photo is.
            Ok(Some(bytes)) => {
                return Ok(Some(Lookup::Found {
                    bytes,
                    credit: Some(FANART_CREDIT.into()),
                }));
            }
            Ok(None) => {}
            // A key turned away, or fanart.tv down: Wikidata may still have one.
            Err(why) => tracing::debug!("fanart.tv had no answer for {name}: {why}"),
        }
    }
    tokio::time::sleep(BETWEEN_LOOKUPS).await;
    Ok(commons_photo(client, &artist)
        .await?
        .map(|(bytes, credit)| Lookup::Found {
            bytes,
            credit: Some(credit),
        }))
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

/// The artist's MusicBrainz id: kept from an earlier search, else searched
/// for (and kept). MusicBrainz is asked once a second at most, and an artist
/// it was asked about once is not asked about again.
async fn artist_id(
    client: &reqwest::Client,
    config_dir: &Path,
    name: &str,
) -> Result<Option<String>, String> {
    let kept = mbid_path(config_dir, name);
    if let Ok(id) = std::fs::read_to_string(&kept) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return Ok(Some(id));
        }
    }
    let found = find_artist(client, name).await?;
    if let Some(id) = &found {
        let _ = std::fs::write(&kept, id);
    }
    Ok(found)
}

/// Photos fetched before a fanart.tv key was added, looked up there again:
/// one found replaces the one kept. Those taken down stay down; an artist
/// fanart.tv does not have keeps the photo they had. How many changed.
pub async fn upgrade_to_fanart(names: Vec<String>, config_dir: &Path, fanart_key: &str) -> usize {
    let key = fanart_key.trim();
    if key.is_empty() {
        return 0;
    }
    let wanted: Vec<String> = names
        .into_iter()
        .filter(|n| worth_asking(n) && !refused_path(config_dir, n).is_file())
        .filter(|n| match photo(config_dir, n) {
            Some((_, credit)) => credit.as_deref() != Some(FANART_CREDIT),
            None => false,
        })
        .collect();
    if wanted.is_empty() {
        return 0;
    }
    let Some(client) = super::music_art::web_client() else {
        return 0;
    };
    let mut changed = 0;
    for name in wanted {
        let searched = !mbid_path(config_dir, &name).is_file();
        let artist = match artist_id(&client, config_dir, &name).await {
            Ok(Some(artist)) => artist,
            Ok(None) => continue,
            Err(why) => {
                tracing::debug!("not looked up on fanart.tv this time: {name}: {why}");
                continue;
            }
        };
        if searched {
            tokio::time::sleep(BETWEEN_LOOKUPS).await;
        }
        match fanart_photo(&client, &artist, key).await {
            Ok(Some(bytes)) => {
                if std::fs::write(photo_path(config_dir, &name), bytes).is_ok() {
                    let _ = std::fs::write(credit_path(config_dir, &name), FANART_CREDIT);
                    changed += 1;
                }
            }
            Ok(None) => {}
            Err(why) => {
                tracing::debug!("fanart.tv had no answer for {name}: {why}");
                // Turned away: the rest would be too.
                if why.contains("turned away") {
                    break;
                }
            }
        }
        tokio::time::sleep(FANART_PAUSE).await;
    }
    if changed > 0 {
        tracing::info!("{changed} artist photo(s) now from fanart.tv");
    }
    changed
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
    /// Wide pictures of the artist: the middle of one stands in for a portrait.
    #[serde(default)]
    artistbackground: Vec<FanartImage>,
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
        let response = get_politely(client, asked).await?;
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
    // A portrait, the best liked; else the best liked wide picture.
    let pictures = if entry.artistthumb.is_empty() {
        &mut entry.artistbackground
    } else {
        &mut entry.artistthumb
    };
    pictures.sort_by_key(|i| std::cmp::Reverse(i.likes()));
    let Some(best) = pictures.first() else {
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
    commons_file(client, &file).await
}

/// A Commons file at the photo's size, with its credit; None when its
/// licence is not one it can be shown under.
async fn commons_file(
    client: &reqwest::Client,
    file: &str,
) -> Result<Option<(Vec<u8>, String)>, String> {
    let Some(info) = commons_info(client, file).await? else {
        return Ok(None);
    };
    let Some(credit) = credit_for(&info) else {
        return Ok(None);
    };
    let bytes = picture(client, &info.thumb).await?;
    Ok(Some((bytes, credit)))
}

/// What Wikidata says someone does, or what something is, that makes them
/// a musician or a band: singer, playback singer, vocalist, musician,
/// singer-songwriter, composer, music director, rapper, DJ, record producer,
/// instrumentalists; musical group, band, duo.
/// Between questions to Wikidata and Commons.
const WIKIMEDIA_PAUSE: std::time::Duration = std::time::Duration::from_millis(400);

const MUSICAL: &[&str] = &[
    "Q177220", "Q2405480", "Q2643890", "Q639669", "Q488205", "Q36834", "Q1198887", "Q1415090",
    "Q2252262", "Q130857", "Q183945", "Q855091", "Q486748", "Q1259917", "Q386854", "Q1075651",
    "Q158852", "Q822146", "Q215380", "Q2088357", "Q9212979", "Q216337", "Q641066", "Q5741069",
];

#[derive(Deserialize)]
struct WikidataSearch {
    /// Always there in an answer: without it, Wikidata said no (too many
    /// questions for now), which is not "nobody of that name".
    search: Vec<WikidataHit>,
}

#[derive(Deserialize)]
struct WikidataHit {
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    aliases: Vec<String>,
}

/// The language a name is searched in: Sinhala or Tamil when written in
/// that script, else English.
fn search_language(name: &str) -> &'static str {
    if name.chars().any(|c| ('\u{0D80}'..='\u{0DFF}').contains(&c)) {
        "si"
    } else if name.chars().any(|c| ('\u{0B80}'..='\u{0BFF}').contains(&c)) {
        "ta"
    } else {
        "en"
    }
}

/// The artist on Wikidata by this name exactly, as a musician or a band,
/// then their photo. Two musicians of the same name and it is left: a
/// photo of the wrong person is worse than none.
async fn photo_by_wikidata(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<(Vec<u8>, String)>, String> {
    let language = search_language(name);
    let url = reqwest::Url::parse_with_params(
        "https://www.wikidata.org/w/api.php",
        &[
            ("action", "wbsearchentities"),
            ("format", "json"),
            ("type", "item"),
            ("limit", "7"),
            ("language", language),
            ("uselang", language),
            ("search", name),
        ],
    )
    .map_err(|e| e.to_string())?;
    let found: WikidataSearch = get_politely(client, url)
        .await?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut musicians = Vec::new();
    for hit in found
        .search
        .into_iter()
        .filter(|h| same_name(&h.label, name) || h.aliases.iter().any(|a| same_name(a, name)))
    {
        // Wikidata asks to be asked one thing at a time, unhurried.
        tokio::time::sleep(WIKIMEDIA_PAUSE).await;
        let claims = entity_claims(client, &hit.id).await?;
        let is = |property: &str| {
            claims.get(property).is_some_and(|all| {
                all.iter().any(|c| {
                    c.mainsnak
                        .datavalue
                        .as_ref()
                        .and_then(|v| v.value["id"].as_str())
                        .is_some_and(|id| MUSICAL.contains(&id))
                })
            })
        };
        if is("P106") || is("P31") {
            musicians.push(claims);
        }
    }
    let [only] = musicians.as_slice() else {
        return Ok(None);
    };
    let Some(file) = image_of(only) else {
        return Ok(None);
    };
    tokio::time::sleep(WIKIMEDIA_PAUSE).await;
    commons_file(client, &file).await
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
    Ok(image_of(&entity_claims(client, item).await?))
}

type Claims = std::collections::HashMap<String, Vec<Claim>>;

fn image_of(claims: &Claims) -> Option<String> {
    claims
        .get("P18")
        .and_then(|all| all.first())
        .and_then(|c| c.mainsnak.datavalue.as_ref())
        .and_then(|v| v.value.as_str())
        .map(str::to_string)
}

/// What Wikidata says of an item; nothing for an id that is not one.
async fn entity_claims(client: &reqwest::Client, item: &str) -> Result<Claims, String> {
    if !item.starts_with('Q') || !item[1..].chars().all(|c| c.is_ascii_digit()) {
        return Ok(Claims::new());
    }
    let url = reqwest::Url::parse(&format!(
        "https://www.wikidata.org/wiki/Special:EntityData/{item}.json"
    ))
    .map_err(|e| e.to_string())?;
    let entity: Entity = get_politely(client, url)
        .await?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(entity
        .entities
        .into_values()
        .next()
        .map(|e| e.claims)
        .unwrap_or_default())
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
    let answer: serde_json::Value = get_politely(client, url)
        .await?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if answer.get("error").is_some() {
        return Err(format!("Commons said no: {}", answer["error"]["info"]));
    }
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
        author: without_brackets(&field("Artist")),
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

/// A name without what follows it in brackets: "Mr A. Ratnaweera (in
/// Sinhala)" is "Mr A. Ratnaweera". Whole when nothing is left outside.
fn without_brackets(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    for c in text.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = out.trim_end_matches([',', ';', ':']).trim().to_string();
    if out.is_empty() {
        text.trim().to_string()
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

/// A GET that waits when the service asks it to: "429 too many" or "503
/// busy" is asked again after the wait it names (Retry-After, at most a
/// minute; 5 s when it names none), twice, before giving up for now.
async fn get_politely(
    client: &reqwest::Client,
    url: reqwest::Url,
) -> Result<reqwest::Response, String> {
    let mut tries = 0;
    loop {
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let slow_down = status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE;
        if !slow_down || tries == 2 {
            return Ok(response);
        }
        tries += 1;
        let wait = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(5)
            .clamp(1, 60);
        tracing::debug!(
            "{} asked to wait {wait} s",
            url.host_str().unwrap_or("a service")
        );
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
    }
}

/// A picture from the web; anything that is not one is refused.
async fn picture(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let bytes = get_politely(client, url)
        .await?
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
    fn a_photographer_is_named_without_the_notes_after() {
        assert_eq!(
            without_brackets("Mr Anuradha Ratnaweera (අනුරාධ රත්නවීර මහතා)"),
            "Mr Anuradha Ratnaweera"
        );
        assert_eq!(
            without_brackets(
                "Mrs Leela Herath (Copyright holder Leela Herath (nee Ratnayaka) has granted ..."
            ),
            "Mrs Leela Herath"
        );
        assert_eq!(without_brackets("(Unknown)"), "(Unknown)");
    }

    #[test]
    fn a_wikidata_refusal_is_not_an_empty_search() {
        let refused = r#"{"error":{"code":"maxlag","info":"Waiting"}}"#;
        assert!(serde_json::from_str::<WikidataSearch>(refused).is_err());
        let empty = r#"{"searchinfo":{"search":"x"},"search":[],"success":1}"#;
        assert!(
            serde_json::from_str::<WikidataSearch>(empty)
                .unwrap()
                .search
                .is_empty()
        );
    }

    #[test]
    fn a_linked_file_name_is_read_back() {
        assert_eq!(
            percent_decode("Daft_Punk_%282013%29.jpg"),
            "Daft Punk (2013).jpg"
        );
    }

    #[test]
    fn a_photo_taken_down_is_not_fetched_again() {
        let dir = std::env::temp_dir().join(format!("basalt-refuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(DIR)).unwrap();
        std::fs::write(photo_path(&dir, "Rowan"), b"jpeg").unwrap();
        std::fs::write(credit_path(&dir, "Rowan"), b"Photo: someone").unwrap();
        assert!(photo(&dir, "Rowan").is_some());
        refuse(&dir, "rowan").unwrap();
        assert!(photo(&dir, "Rowan").is_none(), "gone, whatever the case");
        // Not asked about again: nothing is fetched, without any network.
        let fetched = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fetch_missing(vec!["Rowan".into()], &dir, ""));
        assert_eq!(fetched, 0);
        assert!(!miss_path(&dir, "Rowan").exists(), "not even looked up");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_a_key_only_photos_from_elsewhere_are_looked_up_again() {
        let dir = std::env::temp_dir().join(format!("basalt-upgrade-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(DIR)).unwrap();
        // Already from fanart.tv, and taken down: neither is asked about,
        // so nothing goes to the network here.
        std::fs::write(photo_path(&dir, "Daft Punk"), b"jpeg").unwrap();
        std::fs::write(credit_path(&dir, "Daft Punk"), FANART_CREDIT).unwrap();
        refuse(&dir, "Rowan").unwrap();
        let changed = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(upgrade_to_fanart(
                vec!["Daft Punk".into(), "Rowan".into(), "Nobody Yet".into()],
                &dir,
                "a key",
            ));
        assert_eq!(changed, 0);
        assert!(!mbid_path(&dir, "Daft Punk").exists(), "not searched for");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_is_searched_in_its_own_script() {
        assert_eq!(search_language("Yohani"), "en");
        assert_eq!(search_language("අමරදේව"), "si");
        assert_eq!(search_language("இளையராஜா"), "ta");
    }

    #[test]
    fn the_same_artist_is_the_same_whatever_the_spacing_or_case() {
        assert!(same_name("Far  Coast", "far coast"));
        assert!(!same_name("Far Coast", "Far Coasts"));
        assert_eq!(key("Daft Punk"), key(" daft  punk"));
    }
}
