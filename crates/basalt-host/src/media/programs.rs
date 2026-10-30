//! Folders that belong to a program or a project, whose pictures, sounds and
//! videos are not anybody's photos, music or films.
//!
//! Sharing a whole drive is the usual way to use Basalt, and a drive holds
//! far more than somebody's media. On one real drive, 4,091 of 14,782
//! "photos" were Steam's own pictures, 585 of 1,562 "videos" one project's
//! renders, and most of the rest coursework sites and app projects: the
//! Videos, Photos and Music sections were buried. A folder is taken for a
//! program's or a project's by what is in it, the way a person would tell:
//!
//! - a program's libraries (`.dll`, `.pak`), or a project's own file
//!   (`package.json`, `Cargo.toml`, a `.sln`, a `.git` folder);
//! - three or more files of program source (`.php`, `.js`, `.java`, `.py`);
//! - a web page with its script and its style (`.html`, `.js`, `.css`).
//!
//! Everything under such a folder stays in Files and plays there; it is
//! only left out of the sections. Things that are downloaded one at a time
//! (an installer `.exe`, a saved `index.html`) do not count, and folders
//! named as somebody's own (Downloads, Desktop, Documents) are never taken
//! for a project by their source files alone. The top of the drive is never
//! a program's.

use basalt_proto::msg::{DirEntry, EntryKind};

/// A project's own files, by name.
const PROJECT_FILES: &[&str] = &[
    "package.json",
    "cargo.toml",
    "pubspec.yaml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    "settings.gradle",
    "pyproject.toml",
    "setup.py",
    "go.mod",
    "composer.json",
    "gemfile",
    "cmakelists.txt",
    "project.godot",
];

/// A program's or a project's files, by kind.
const PROGRAM_KINDS: &[&str] = &["dll", "pak", "sln", "csproj", "vcxproj", "uproject", "iml"];

/// Folders only a project has.
const PROJECT_FOLDERS: &[&str] = &[
    ".git",
    ".idea",
    ".svn",
    "projectsettings",
    ".venv",
    "venv",
    "__pycache__",
];

/// Program source. Markup alone is not: pages are saved from the web.
const SOURCE_KINDS: &[&str] = &[
    "php", "js", "jsx", "ts", "tsx", "java", "py", "cs", "cpp", "c", "h", "hpp", "kt", "swift",
    "go", "rs", "rb", "dart", "vue", "svelte", "lua", "gd", "jsp",
];

/// How many source files make a folder a project's.
const SOURCE_FILES: usize = 3;

/// Folders that are somebody's own, never a project by their source alone.
const PERSONAL: &[&str] = &[
    "downloads",
    "desktop",
    "documents",
    "my documents",
    "pictures",
    "my pictures",
    "videos",
    "my videos",
    "music",
    "my music",
    "onedrive",
    "dropbox",
    "google drive",
];

/// Whether the folder at `dir` (vault-relative, "" for the top) is a
/// program's or a project's, from what it holds, hidden entries included.
pub fn marks(dir: &str, entries: &[DirEntry]) -> bool {
    if dir.is_empty() {
        return false;
    }
    let own = dir.rsplit('/').next().unwrap_or(dir).trim().to_lowercase();
    let personal = PERSONAL.contains(&own.as_str());
    let mut source = 0;
    let (mut html, mut js, mut css) = (false, false, false);
    for entry in entries {
        let name = entry.name.to_lowercase();
        let kind = name.rsplit_once('.').map_or("", |(_, ext)| ext);
        match entry.kind {
            EntryKind::Dir => {
                if PROJECT_FOLDERS.contains(&name.as_str()) || kind == "xcodeproj" {
                    return true;
                }
            }
            EntryKind::File => {
                if PROJECT_FILES.contains(&name.as_str()) || PROGRAM_KINDS.contains(&kind) {
                    return true;
                }
                html |= matches!(kind, "html" | "htm");
                js |= kind == "js";
                css |= kind == "css";
                if SOURCE_KINDS.contains(&kind) {
                    source += 1;
                }
                if !personal && (source >= SOURCE_FILES || (html && js && css)) {
                    return true;
                }
            }
        }
    }
    false
}

/// Whether `path` is inside a program's or a project's folder, looking at
/// each folder above it: for a file that arrived between walks.
pub fn within(vault: &crate::vault::Vault, path: &str) -> bool {
    let mut dir = String::new();
    let folders: Vec<&str> = path.split('/').collect();
    for folder in &folders[..folders.len().saturating_sub(1)] {
        if !dir.is_empty() {
            dir.push('/');
        }
        dir.push_str(folder);
        if vault.list(&dir).is_ok_and(|entries| marks(&dir, &entries)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(names: &[&str]) -> Vec<DirEntry> {
        names
            .iter()
            .map(|name| {
                let (name, kind) = match name.strip_suffix('/') {
                    Some(dir) => (dir, EntryKind::Dir),
                    None => (*name, EntryKind::File),
                };
                DirEntry {
                    name: name.to_string(),
                    kind,
                    size: 1,
                    mtime: 0,
                    readonly: false,
                    hidden: false,
                }
            })
            .collect()
    }

    #[test]
    fn programs_and_projects_are_told_by_what_they_hold() {
        for held in [
            &["steam.exe", "steam.dll", "steamui/"][..],
            &["package.json", "src/", "logo.png"],
            &["Cargo.toml"],
            &["My Game.sln", "Assets/"],
            &[".git/", "photo.jpg"],
            &["Chat.php", "cart.php", "index.php", "ProductPic/"],
            &["index.html", "script.js", "style.css", "Attack__000.png"],
        ] {
            assert!(marks("Somewhere/Thing", &entries(held)), "{held:?}");
        }
    }

    #[test]
    fn somebodys_own_folders_are_not() {
        for held in [
            // An installer and a saved page, downloaded one at a time.
            &[
                "setup.exe",
                "index.html",
                "cart.html",
                "checkout.html",
                "film.mkv",
            ][..],
            &["IMG_0001.jpg", "IMG_0002.jpg", "notes.txt"],
            &["a.js", "b.js", "c.js"],
        ] {
            let folder = if held.contains(&"a.js") {
                "Downloads"
            } else {
                "Me/Stuff"
            };
            assert!(!marks(folder, &entries(held)), "{held:?}");
        }
        // The top of the drive, whatever is in it.
        assert!(!marks("", &entries(&["package.json", ".git/"])));
        // Downloads with a real project file still counts.
        assert!(marks("Downloads", &entries(&["package.json"])));
    }
}
