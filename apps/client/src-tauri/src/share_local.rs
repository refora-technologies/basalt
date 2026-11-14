//! Files on this device chosen to share: the files themselves, and every file
//! in a folder chosen, each with its folder inside it (1.6.4).
//!
//! A folder is shared as its files, each knowing where it sat
//! (`Holiday/Day 1`), so the device taking them makes the same folders. What
//! nobody means to send stays behind: hidden and system files (desktop.ini,
//! Thumbs.db, .DS_Store), and links, which are never followed, so a folder
//! that links to itself, or out to the rest of the disk, sends only what is
//! really in it.

use std::path::Path;

use basalt_proto::folder::{clean_folder, MOST_SHARE_FILES};

/// A file on this device, to offer: where it is here (only this device knows),
/// its name and size, and its folder inside a shared folder.
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LocalFile {
    pub source: String,
    pub name: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder: String,
}

/// Files chosen to share, and why some couldn't be, said plainly.
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct Chosen {
    pub files: Vec<LocalFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// The files at `paths`: each file, and each folder's files.
pub fn gather(paths: &[String]) -> Chosen {
    gather_at_most(paths, MOST_SHARE_FILES)
}

fn gather_at_most(paths: &[String], most: usize) -> Chosen {
    let mut files = Vec::new();
    let mut empty: Option<String> = None;
    for path in paths {
        let at = Path::new(path);
        // What was chosen is taken as it is, a link or not.
        let Ok(meta) = std::fs::metadata(at) else {
            continue;
        };
        let Some(name) = at.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if meta.is_file() {
            files.push(LocalFile {
                source: path.clone(),
                name,
                size: meta.len(),
                folder: String::new(),
            });
        } else if meta.is_dir() {
            let before = files.len();
            if walk(at, &name, &mut files, most).is_err() {
                return Chosen {
                    files: Vec::new(),
                    problem: Some(too_many(most)),
                };
            }
            if files.len() == before {
                empty = Some(name);
            }
        }
        if files.len() > most {
            return Chosen {
                files: Vec::new(),
                problem: Some(too_many(most)),
            };
        }
    }
    let problem = match (&empty, files.is_empty()) {
        (Some(name), true) => Some(format!("“{name}” has no files to share.")),
        _ => None,
    };
    Chosen { files, problem }
}

fn too_many(most: usize) -> String {
    format!("That’s more than {most} files. Share the folder in parts, or as a zip.")
}

/// Every file under `dir`, whose own folder is `folder`, in name order;
/// `Err` once there are more than `most`.
fn walk(dir: &Path, folder: &str, out: &mut Vec<LocalFile>, most: usize) -> Result<(), ()> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    let mut entries: Vec<std::fs::DirEntry> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        // Not followed: a link is what it points at, somewhere else.
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if left_behind(&name, &meta) {
            continue;
        }
        if meta.is_dir() {
            walk(&entry.path(), &format!("{folder}/{name}"), out, most)?;
        } else if meta.is_file() {
            out.push(LocalFile {
                source: entry.path().to_string_lossy().into_owned(),
                name,
                size: meta.len(),
                folder: clean_folder(folder),
            });
            if out.len() > most {
                return Err(());
            }
        }
    }
    Ok(())
}

/// What a folder holds that nobody means to send: links, hidden and system
/// files, and the ones systems make for themselves.
fn left_behind(name: &str, meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() || name.starts_with('.') {
        return true;
    }
    if ["desktop.ini", "thumbs.db", "ehthumbs.db"].contains(&name.to_ascii_lowercase().as_str()) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        // A junction is a link too.
        const REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & (HIDDEN | SYSTEM | REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("basalt-share-local-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn arg(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_folder_is_its_files_each_with_its_folder_inside_it() {
        let dir = temp("tree");
        let holiday = dir.join("Holiday");
        put(&holiday.join("b.jpg"), b"bb");
        put(&holiday.join("Day 1").join("a.jpg"), b"a");
        put(&holiday.join("Day 1").join("Morning").join("c.jpg"), b"ccc");
        put(&dir.join("notes.txt"), b"notes");
        let chosen = gather(&[arg(&holiday), arg(&dir.join("notes.txt"))]);
        assert_eq!(chosen.problem, None);
        let seen: Vec<(&str, &str, u64)> = chosen
            .files
            .iter()
            .map(|f| (f.folder.as_str(), f.name.as_str(), f.size))
            .collect();
        assert_eq!(
            seen,
            [
                ("Holiday", "b.jpg", 2),
                ("Holiday/Day 1", "a.jpg", 1),
                ("Holiday/Day 1/Morning", "c.jpg", 3),
                ("", "notes.txt", 5),
            ]
        );
        assert!(chosen.files[0].source.ends_with("b.jpg"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn what_nobody_means_to_send_stays_behind() {
        let dir = temp("hidden");
        let top = dir.join("Work");
        put(&top.join("report.pdf"), b"r");
        put(&top.join(".git").join("config"), b"x");
        put(&top.join(".DS_Store"), b"x");
        put(&top.join("desktop.ini"), b"x");
        put(&top.join("Thumbs.db"), b"x");
        let chosen = gather(&[arg(&top)]);
        let names: Vec<&str> = chosen.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["report.pdf"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_is_never_followed() {
        let dir = temp("links");
        let top = dir.join("Loop");
        put(&top.join("a.txt"), b"a");
        std::os::unix::fs::symlink(&top, top.join("again")).unwrap();
        std::os::unix::fs::symlink("/etc", top.join("etc")).unwrap();
        let chosen = gather(&[arg(&top)]);
        assert_eq!(chosen.files.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn too_many_or_none_is_said_plainly() {
        let dir = temp("many");
        let top = dir.join("Many");
        for n in 0..6 {
            put(&top.join(format!("{n}.txt")), b"x");
        }
        let chosen = gather_at_most(&[arg(&top)], 5);
        assert!(chosen.files.is_empty());
        assert!(chosen.problem.unwrap().contains("more than 5 files"));
        std::fs::create_dir_all(dir.join("Empty").join("Inside")).unwrap();
        let chosen = gather(&[arg(&dir.join("Empty"))]);
        assert!(chosen.files.is_empty());
        assert_eq!(chosen.problem.as_deref(), Some("“Empty” has no files to share."));
        let _ = std::fs::remove_dir_all(dir);
    }
}
