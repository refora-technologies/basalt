//! Where a film's or an episode's intro and credits are, for the player's
//! Skip intro and Next episode buttons.
//!
//! Nothing online knows the timings of these particular files, so the host
//! works them out, while it has nothing else to do:
//!
//! 1. **Chapters.** Many files carry chapters named "Intro", "Opening",
//!    "Credits" or "Ending". Exact, and nearly free to read.
//! 2. **The same sound in every episode.** A series' intro is the same music
//!    each week, and so, mostly, are its credits. The opening minutes and the
//!    closing minutes of each episode are turned into audio fingerprints and
//!    compared with the episodes either side of it in the season: what they
//!    share is the intro, or the credits.
//!
//! A film has no other episodes to compare with: its credits come from its
//! chapters, or not at all. Nothing is skipped by itself; the player only
//! offers the button, and reaching the credits counts as watched.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusty_chromaprint::{Configuration, Fingerprinter, match_fingerprints};
use serde::{Deserialize, Serialize};

/// Sound is read at this rate, in one channel: plenty for a fingerprint.
const RATE: u32 = 11_025;
/// How much of an episode's start is searched for its intro.
const OPENING: f64 = 600.0;
/// How much of an episode's end is searched for its credits.
const CLOSING: f64 = 360.0;
/// The shortest stretch counted as an intro or credits.
const SHORTEST: f64 = 12.0;
/// The longest intro believed.
const LONGEST_INTRO: f64 = 200.0;
/// A match this close (fewer differing bits, of 32) counts as the same sound.
const ALIKE: f64 = 10.0;
/// Fingerprints place a shared stretch's end a little early (about two
/// seconds, measured); Skip intro lands this much later, so it does not play
/// the intro's last notes again.
const INTRO_END_LATER: f64 = 1.5;

/// What was found for one file, kept with its size and time so a changed
/// file is looked at again.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Found {
    pub size: u64,
    pub mtime: i64,
    /// Start and end of the intro, in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intro: Option<[f64; 2]>,
    /// Where the credits start, in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<f64>,
}

/// Every file looked at on one drive, by vault-relative path.
pub type Store = HashMap<String, Found>;

pub fn store_path(config_dir: &Path, vault_root: &Path) -> PathBuf {
    let key = blake3::hash(vault_root.to_string_lossy().as_bytes()).to_hex();
    config_dir.join(format!("segments-{}.json", &key[..16]))
}

pub fn load(path: &Path) -> Store {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, store: &Store) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec(store).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(&tmp, path)
}

/// One file to look at.
#[derive(Debug, Clone)]
pub struct Episode {
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
}

/// A chapter, as ffmpeg reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub start: f64,
    pub end: f64,
    pub title: String,
}

/// Looks at a season's episodes (or one film, alone) and says what each has.
/// Blocking, and slow: a few seconds of decoding per episode.
pub fn find(ffmpeg: &Path, episodes: &[Episode]) -> Vec<(String, Found)> {
    let probed: Vec<(f64, Vec<Chapter>)> = episodes
        .iter()
        .map(|e| probe(ffmpeg, &e.path).unwrap_or((0.0, Vec::new())))
        .collect();
    let mut found: Vec<Found> = episodes
        .iter()
        .zip(&probed)
        .map(|(e, (duration, chapters))| {
            let (intro, credits) = from_chapters(chapters, *duration);
            Found {
                size: e.size,
                mtime: e.mtime,
                intro,
                credits,
            }
        })
        .collect();

    // A film, or a season of one: nothing to compare with.
    if episodes.len() < 2 {
        return episodes.iter().map(|e| e.rel.clone()).zip(found).collect();
    }

    let config = Configuration::preset_test2();
    let openings: Vec<Option<Vec<u32>>> = episodes
        .iter()
        .zip(&probed)
        .zip(&found)
        .map(|((e, (duration, _)), f)| {
            let wanted = f.intro.is_none() && *duration > 0.0;
            wanted
                .then(|| fingerprint(ffmpeg, &e.path, 0.0, OPENING.min(duration * 0.4), &config))
                .flatten()
        })
        .collect();
    let closings: Vec<Option<(f64, Vec<u32>)>> = episodes
        .iter()
        .zip(&probed)
        .zip(&found)
        .map(|((e, (duration, _)), f)| {
            let from = (duration - CLOSING).max(duration * 0.6);
            let wanted = f.credits.is_none() && *duration > CLOSING;
            wanted
                .then(|| {
                    fingerprint(ffmpeg, &e.path, from, duration - from, &config)
                        .map(|fp| (from, fp))
                })
                .flatten()
        })
        .collect();

    for i in 0..episodes.len() {
        // The episodes either side, and one further for a first or a last.
        let partners: Vec<usize> = [i.wrapping_sub(1), i + 1, i.wrapping_sub(2), i + 2]
            .into_iter()
            .filter(|&j| j < episodes.len() && j != i)
            .collect();
        if found[i].intro.is_none()
            && let Some(mine) = &openings[i]
        {
            found[i].intro = partners
                .iter()
                .filter_map(|&j| openings[j].as_ref())
                .filter_map(|theirs| shared(mine, theirs, &config))
                .filter(|(start, length)| {
                    *start < OPENING && (SHORTEST..=LONGEST_INTRO).contains(length)
                })
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(start, length)| [start, start + length + INTRO_END_LATER]);
        }
        if found[i].credits.is_none()
            && let Some((from, mine)) = &closings[i]
        {
            found[i].credits = partners
                .iter()
                .filter_map(|&j| closings[j].as_ref())
                .filter_map(|(_, theirs)| shared(mine, theirs, &config))
                .filter(|(_, length)| *length >= SHORTEST)
                // The earliest shared stretch: the credits' first moment.
                .map(|(start, _)| from + start)
                .min_by(f64::total_cmp);
        }
    }
    episodes.iter().map(|e| e.rel.clone()).zip(found).collect()
}

/// The longest stretch of sound `a` and `b` share: where it starts in `a`,
/// and how long it is, in seconds.
fn shared(a: &[u32], b: &[u32], config: &Configuration) -> Option<(f64, f64)> {
    let item = f64::from(config.item_duration_in_seconds());
    match_fingerprints(a, b, config)
        .ok()?
        .into_iter()
        .filter(|s| s.score <= ALIKE)
        .map(|s| (s.offset1 as f64 * item, s.items_count as f64 * item))
        .max_by(|x, y| x.1.total_cmp(&y.1))
}

/// Intro and credits from chapter names, where the file has them.
pub fn from_chapters(chapters: &[Chapter], duration: f64) -> (Option<[f64; 2]>, Option<f64>) {
    let named = |title: &str, words: &[&str]| {
        let t = title.trim().to_lowercase();
        words
            .iter()
            .any(|w| t == *w || t.starts_with(&format!("{w} ")) || t.ends_with(&format!(" {w}")))
    };
    let intro = chapters
        .iter()
        .find(|c| {
            named(
                &c.title,
                &[
                    "intro",
                    "introduction",
                    "opening",
                    "op",
                    "opening credits",
                    "title sequence",
                ],
            ) && c.start < OPENING
                && (SHORTEST..=LONGEST_INTRO).contains(&(c.end - c.start))
        })
        .map(|c| [c.start, c.end]);
    let credits = chapters
        .iter()
        .find(|c| {
            named(
                &c.title,
                &[
                    "credits",
                    "end credits",
                    "ending",
                    "ed",
                    "outro",
                    "closing credits",
                ],
            ) && (duration <= 0.0 || c.start > duration * 0.6)
        })
        .map(|c| c.start);
    (intro, credits)
}

/// What a file's own chapters say of its intro and credits: quick, since
/// only the file's header is read. Blocking.
pub fn from_file_chapters(ffmpeg: &Path, path: &Path) -> (Option<[f64; 2]>, Option<f64>) {
    probe(ffmpeg, path)
        .map(|(duration, chapters)| from_chapters(&chapters, duration))
        .unwrap_or((None, None))
}

/// A file's length in seconds, read by ffmpeg.
pub fn duration(ffmpeg: &Path, path: &Path) -> Option<f64> {
    probe(ffmpeg, path).map(|(d, _)| d).filter(|d| *d > 0.0)
}

/// A file's length and chapters, read by ffmpeg.
fn probe(ffmpeg: &Path, path: &Path) -> Option<(f64, Vec<Chapter>)> {
    let output = quiet(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(path)
        .args(["-f", "ffmetadata", "-"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let duration = stderr
        .lines()
        .find_map(|l| l.trim().strip_prefix("Duration: "))
        .and_then(|rest| rest.split(',').next())
        .and_then(parse_clock)
        .unwrap_or(0.0);
    Some((
        duration,
        parse_chapters(&String::from_utf8_lossy(&output.stdout)),
    ))
}

/// `01:02:03.45` as seconds.
fn parse_clock(text: &str) -> Option<f64> {
    let mut parts = text.trim().split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// The chapters in ffmpeg's metadata text.
pub fn parse_chapters(text: &str) -> Vec<Chapter> {
    let mut chapters = Vec::new();
    let mut current: Option<(f64, i64, i64, String)> = None;
    let close = |c: Option<(f64, i64, i64, String)>, out: &mut Vec<Chapter>| {
        if let Some((base, start, end, title)) = c {
            out.push(Chapter {
                start: start as f64 * base,
                end: end as f64 * base,
                title,
            });
        }
    };
    for line in text.lines() {
        if line.trim() == "[CHAPTER]" {
            close(current.take(), &mut chapters);
            current = Some((0.001, 0, 0, String::new()));
            continue;
        }
        if line.starts_with('[') {
            close(current.take(), &mut chapters);
            continue;
        }
        let Some(chapter) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_uppercase().as_str() {
            "TIMEBASE" => {
                if let Some((n, d)) = value.split_once('/')
                    && let (Ok(n), Ok(d)) = (n.trim().parse::<f64>(), d.trim().parse::<f64>())
                    && d > 0.0
                {
                    chapter.0 = n / d;
                }
            }
            "START" => chapter.1 = value.trim().parse().unwrap_or(0),
            "END" => chapter.2 = value.trim().parse().unwrap_or(0),
            "TITLE" => chapter.3 = value.trim().to_string(),
            _ => {}
        }
    }
    close(current, &mut chapters);
    chapters
}

/// The fingerprint of `seconds` of sound from `from`, decoded by ffmpeg.
fn fingerprint(
    ffmpeg: &Path,
    path: &Path,
    from: f64,
    seconds: f64,
    config: &Configuration,
) -> Option<Vec<u32>> {
    if seconds < SHORTEST {
        return None;
    }
    let mut child = quiet(ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-ss",
            &format!("{from:.3}"),
            "-t",
        ])
        .arg(format!("{seconds:.3}"))
        .arg("-i")
        .arg(path)
        .args([
            "-vn",
            "-sn",
            "-ac",
            "1",
            "-ar",
            &RATE.to_string(),
            "-f",
            "s16le",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut bytes = Vec::new();
    child.stdout.take()?.read_to_end(&mut bytes).ok()?;
    let _ = child.wait();
    let samples: Vec<i16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b))
        .collect();
    if samples.len() < (RATE as f64 * SHORTEST) as usize {
        return None;
    }
    let mut printer = Fingerprinter::new(config);
    printer.start(RATE, 1).ok()?;
    printer.consume(&samples);
    printer.finish();
    Some(printer.fingerprint().to_vec())
}

/// A command that shows no console window on Windows.
fn quiet(program: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    const METADATA: &str = ";FFMETADATA1\ntitle=Episode\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=62000\ntitle=Cold open\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=62000\nEND=121500\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=121500\nEND=2400000\ntitle=Part 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2400000\nEND=2520000\ntitle=End Credits\n";

    #[test]
    fn chapters_are_read_from_ffmpegs_metadata() {
        let chapters = parse_chapters(METADATA);
        assert_eq!(chapters.len(), 4);
        assert_eq!(
            chapters[1],
            Chapter {
                start: 62.0,
                end: 121.5,
                title: "Opening".into()
            }
        );
    }

    #[test]
    fn named_chapters_give_the_intro_and_the_credits() {
        let (intro, credits) = from_chapters(&parse_chapters(METADATA), 2520.0);
        assert_eq!(intro, Some([62.0, 121.5]));
        assert_eq!(credits, Some(2400.0));
    }

    #[test]
    fn unnamed_or_misplaced_chapters_give_nothing() {
        let chapters = vec![
            Chapter {
                start: 0.0,
                end: 600.0,
                title: "Chapter 1".into(),
            },
            // "Credits" in the first half is not the end credits.
            Chapter {
                start: 600.0,
                end: 700.0,
                title: "Credits".into(),
            },
            // An "intro" of twenty minutes is not one.
            Chapter {
                start: 0.0,
                end: 1200.0,
                title: "Intro".into(),
            },
        ];
        assert_eq!(from_chapters(&chapters, 2400.0), (None, None));
    }

    #[test]
    fn clocks_read_as_seconds() {
        assert_eq!(parse_clock("00:42:10.50"), Some(2530.5));
        assert_eq!(parse_clock("nonsense"), None);
    }
}
