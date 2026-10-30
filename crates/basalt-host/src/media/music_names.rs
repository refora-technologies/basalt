//! Who a song is by and what it is called when its tags do not say, and
//! which album (or single) its cover is looked up as.
//!
//! The same reading as the app's (`apps/client/src/lib/music.ts`: `songOf`,
//! `nameParts`, `isMusic`), so the covers asked for online are those of the
//! songs the app shows as music, under the names it shows them by. A song
//! downloaded from a video site has no tags and a name like "Artist - Title
//! (Official Video)"; a library copied from a CD is laid out as
//! `Music/Artist/Album/01 Title.flac`. Anything else, and the sounds of the
//! programs and projects on a drive shared whole, is not asked about.

use basalt_proto::msg::MusicTrack;

/// Untagged audio shorter than this is a sound, not a song.
const SHORTEST_SONG_MS: u64 = 30_000;
/// An untagged song known only by an "Artist - Title" name is this long.
const SHORTEST_NAMED_SONG_MS: u64 = 60_000;

/// Folders that hold music, by their names.
const MUSIC_FOLDERS: &[&str] = &[
    "music",
    "my music",
    "songs",
    "song",
    "albums",
    "singles",
    "playlists",
    "mp3",
    "mp3s",
    "flac",
    "itunes",
    "itunes media",
    "musik",
    "musique",
    "musica",
    "música",
    "muziek",
    "sindu",
];

/// Folders a library is kept in, which are not an artist or an album.
const CONTAINERS: &[&str] = &[
    "music",
    "songs",
    "audio",
    "mp3",
    "flac",
    "my music",
    "itunes",
    "downloads",
];

/// Folders of programs, games and projects: their sounds are nobody's music.
const PROGRAM_FOLDERS: &[&str] = &[
    "node_modules",
    "venv",
    "site-packages",
    "packagecache",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "windows",
    "steam",
    "steamapps",
    "installed softwares",
    "assets",
    "resources",
    "resource",
    "public",
    "src",
    "build",
    "dist",
    "out",
    "bin",
    "obj",
    "debug",
    "tests",
    "test",
    "data",
    "sounds",
    "sfx",
    "cache",
    "temp",
    "tmp",
];

/// Words that say how a song was posted, not what it is called.
const POSTED: &[&str] = &[
    "official",
    "video",
    "audio",
    "lyric",
    "lyrics",
    "visualizer",
    "visualiser",
    "hd",
    "hq",
    "4k",
    "8k",
    "mv",
    "ncs",
    "explicit",
    "remaster",
    "remastered",
];
/// Pairs of words that do the same.
const POSTED_PAIRS: &[(&str, &str)] = &[
    ("full", "song"),
    ("no", "copyright"),
    ("copyright", "free"),
    ("free", "download"),
    ("out", "now"),
    ("m", "v"),
];
/// Such words left trailing after a title.
const POSTED_TRAILING: &[&str] = &[
    "official",
    "audio",
    "video",
    "music",
    "lyrics",
    "lyric",
    "visualizer",
    "visualiser",
    "hd",
    "hq",
    "4k",
    "mv",
    "album",
    "song",
    "full",
    "ncs",
    "release",
    "copyright",
    "free",
];
/// Kinds of music a channel names before "NCS" in its titles.
const STYLES: &[&str] = &[
    "melodic",
    "dubstep",
    "house",
    "trap",
    "edm",
    "electronic",
    "dnb",
    "drum",
    "bass",
    "future",
    "chill",
    "lofi",
    "hip",
    "hop",
    "pop",
    "progressive",
    "deep",
];

/// What a song's cover is looked up as: an album by who it is by, or a
/// single of one song.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CoverKey {
    pub artist: String,
    pub album: String,
    /// One song of its own, named after itself: also looked for as a song.
    pub single: bool,
}

/// What `track`'s cover is looked up as, if it is music the app shows and
/// there is enough to ask by.
pub fn cover_key(track: &MusicTrack) -> Option<CoverKey> {
    let (title, artist, album) = (text(&track.title), text(&track.artist), text(&track.album));
    let by = text(&track.album_artist).or(artist);
    let key = |artist: &str, album: &str, single| {
        super::music_art::worth_asking(artist, album).then(|| CoverKey {
            artist: artist.to_string(),
            album: album.to_string(),
            single,
        })
    };
    if let (Some(by), Some(album)) = (by, album) {
        return key(by, album, false);
    }
    if let (Some(artist), Some(title)) = (artist, title) {
        return key(artist, title, true);
    }

    let parts: Vec<&str> = track.path.split('/').collect();
    let (name, folders) = parts.split_last()?;
    let lower: Vec<String> = folders.iter().map(|f| f.trim().to_lowercase()).collect();
    if lower
        .iter()
        .any(|f| PROGRAM_FOLDERS.contains(&f.as_str()) || f.starts_with('.'))
    {
        return None;
    }
    if track.duration_ms.is_some_and(|ms| ms < SHORTEST_SONG_MS) {
        return None;
    }
    let in_music = lower.iter().any(|f| MUSIC_FOLDERS.contains(&f.as_str()));
    if title.is_none() && artist.is_none() {
        let stem = name.rsplit_once('.').map_or(*name, |(stem, _)| stem);
        if let Some((artist, title)) = name_parts(stem) {
            let long = track
                .duration_ms
                .is_some_and(|ms| ms >= SHORTEST_NAMED_SONG_MS);
            return if in_music || long {
                key(&artist, &title, true)
            } else {
                None
            };
        }
    }
    if !in_music {
        return None;
    }
    // `Music/Artist/Album/01 Title.flac`: only the folders inside the music
    // folder say who and what.
    let inside = lower
        .iter()
        .rposition(|f| CONTAINERS.contains(&f.as_str()))
        .map_or(0, |i| i + 1);
    match &folders[inside..] {
        [.., artist, album] => key(artist.trim(), album.trim(), false),
        _ => None,
    }
}

/// A tag, if it says anything.
fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// Who and what a song is, from a name like "Artist - Title (Official
/// Video)". None when the name is not of that shape: "01 Opening",
/// "full-take1".
pub fn name_parts(stem: &str) -> Option<(String, String)> {
    let name = if stem.contains(' ') {
        stem.to_string()
    } else {
        stem.replace('_', " ")
    };
    let name = without_track_number(&name);
    let mut pieces = split_dashes(name);
    if pieces.len() < 2 {
        return None;
    }
    let artist = tidy(&pieces.remove(0));
    let rest: Vec<String> = pieces
        .into_iter()
        .enumerate()
        .filter(|(i, part)| *i == 0 || !says_posted(part))
        .map(|(_, part)| part)
        .collect();
    let tidied = tidy(&rest.join(" - "));
    let mut words: Vec<&str> = tidied.split(' ').collect();
    let mut dropped = false;
    while words.len() > 1 {
        let last = words[words.len() - 1].to_lowercase();
        if POSTED_TRAILING.contains(&last.as_str()) || (dropped && STYLES.contains(&last.as_str()))
        {
            dropped |= last == "ncs";
            words.pop();
        } else {
            break;
        }
    }
    let title = words
        .join(" ")
        .trim_end_matches(|c: char| c.is_whitespace() || "-|:,".contains(c))
        .trim()
        .to_string();
    let lettered = |s: &str| s.chars().any(char::is_alphabetic);
    (lettered(&artist) && lettered(&title) && artist.chars().count() <= 60)
        .then_some((artist, title))
}

/// "01 - Ana - Lanterns" or "07. Ana - Lanterns" without its number.
fn without_track_number(name: &str) -> &str {
    let trimmed = name.trim_start();
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if !(1..=3).contains(&digits) {
        return name;
    }
    let after = trimmed[digits..].trim_start();
    let Some(after) = after.strip_prefix(['-', '.', ')']) else {
        return name;
    };
    if after.starts_with(char::is_whitespace) {
        after.trim_start()
    } else {
        name
    }
}

/// The name split at each dash with space on both sides: "A - B - C".
fn split_dashes(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    let dash = |c: char| matches!(c, '-' | '\u{2013}' | '\u{2014}');
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < chars.len() {
        if dash(chars[i])
            && i > 0
            && chars[i - 1].is_whitespace()
            && chars.get(i + 1).is_some_and(|c| c.is_whitespace())
        {
            let left: String = chars[start..i].iter().collect();
            let mut next = i + 1;
            while next < chars.len() && chars[next].is_whitespace() {
                next += 1;
            }
            if !left.trim().is_empty() && next < chars.len() {
                pieces.push(left.trim_end().to_string());
                start = next;
                i = next;
                continue;
            }
        }
        i += 1;
    }
    pieces.push(chars[start..].iter().collect());
    pieces
}

/// Whether some text only says how a song was posted.
fn says_posted(text: &str) -> bool {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    words.iter().any(|w| POSTED.contains(w))
        || words
            .windows(2)
            .any(|pair| POSTED_PAIRS.contains(&(pair[0], pair[1])))
}

/// Brackets that only say how it was posted taken out, spaces closed up.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(['(', '[', '{']) {
        let inside_from = open + 1;
        let Some(close) = rest[inside_from..].find([')', ']', '}']) else {
            break;
        };
        let close = inside_from + close;
        if says_posted(&rest[inside_from..close]) {
            out.push_str(rest[..open].trim_end());
        } else {
            out.push_str(&rest[..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_of_downloaded_songs_say_who_and_what() {
        // The same names the app's tests read (lib/music.test.ts).
        let cases = [
            (
                "Northline - Paper Lanterns (feat. Ada Moss with The Night Office)",
                "Northline",
                "Paper Lanterns (feat. Ada Moss with The Night Office)",
            ),
            (
                "Glass Arcade - Come Back Home feat. Ines Hale (NORTHBOUND Remix)",
                "Glass Arcade",
                "Come Back Home feat. Ines Hale (NORTHBOUND Remix)",
            ),
            (
                "Kavee - Sanda Eliya ft Mihi Sanda Eliya Album Official Audio",
                "Kavee",
                "Sanda Eliya ft Mihi Sanda Eliya",
            ),
            (
                "Dilan Perera - Nil Akasa (Official Music Video)",
                "Dilan Perera",
                "Nil Akasa",
            ),
            (
                "Far Coast - Where We Began (feat. Rue) Melodic Dubstep NCS - Copyright Free Music",
                "Far Coast",
                "Where We Began (feat. Rue)",
            ),
            ("Ana Marlow - Slow Tide (Lyrics)", "Ana Marlow", "Slow Tide"),
            (
                "AC-DC - Back in Black [Official Video]",
                "AC-DC",
                "Back in Black",
            ),
            ("07. Juniper Vale - Lanterns", "Juniper Vale", "Lanterns"),
            ("Juniper_Vale_-_Lanterns", "Juniper Vale", "Lanterns"),
        ];
        for (stem, artist, title) in cases {
            assert_eq!(
                name_parts(stem),
                Some((artist.to_string(), title.to_string())),
                "{stem}"
            );
        }
        for stem in ["01 Opening", "full-take1", "ep1", "Track 05", "2024 - 01"] {
            assert_eq!(name_parts(stem), None, "{stem}");
        }
    }

    fn track(path: &str, duration_ms: u64) -> MusicTrack {
        MusicTrack {
            path: path.into(),
            duration_ms: Some(duration_ms),
            ..MusicTrack::default()
        }
    }

    #[test]
    fn covers_are_asked_for_the_songs_the_app_shows() {
        let key = |path: &str| cover_key(&track(path, 200_000));
        assert_eq!(
            key("Downloads/Music/Ana Marlow - Slow Tide (Lyrics).mp3"),
            Some(CoverKey {
                artist: "Ana Marlow".into(),
                album: "Slow Tide".into(),
                single: true
            })
        );
        assert_eq!(
            key("Basalt Test/Music/The Quiet Coast/Harbour Lights/01 Track 1.mp3"),
            Some(CoverKey {
                artist: "The Quiet Coast".into(),
                album: "Harbour Lights".into(),
                single: false
            })
        );
        for path in [
            "Program Files/Steam/steamui/sounds/deck_ui_launch_game.wav",
            "Code/podcast/build/voice/episode-09/full-take1.mp3",
            "Code/video/music/rise-soundpack.mp3",
            "Downloads/Ana - Hi.mp3"
                .replace("Downloads", "Steam")
                .as_str(),
        ] {
            assert_eq!(key(path), None, "{path}");
        }
        // Too short to be known as a song by its name alone.
        assert_eq!(cover_key(&track("Downloads/Ana - Hi.mp3", 40_000)), None);
    }

    #[test]
    fn tags_come_first() {
        let tagged = MusicTrack {
            artist: Some("Juniper Vale".into()),
            title: Some("Lanterns".into()),
            ..track("x/Other - Name.mp3", 200_000)
        };
        assert_eq!(
            cover_key(&tagged),
            Some(CoverKey {
                artist: "Juniper Vale".into(),
                album: "Lanterns".into(),
                single: true
            })
        );
        let album = MusicTrack {
            album: Some("Lowlight".into()),
            album_artist: Some("Various Artists".into()),
            ..tagged
        };
        assert_eq!(cover_key(&album).map(|k| k.single), Some(false));
    }
}
