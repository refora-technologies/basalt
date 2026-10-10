//! Messages a person reads are single-spaced.
//!
//! A sentence split across two source lines needs a `\` at the end of the
//! first, or the next line's indentation lands in the middle of it: eight
//! messages once read "It may be                stopped or restarting".

use std::path::Path;

fn walk(dir: &Path, found: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, found);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let text = std::fs::read_to_string(&path).unwrap();
            for (no, line) in text.lines().enumerate() {
                // Inside a string literal: letters, a run of spaces, letters.
                let Some(open) = line.find('"') else { continue };
                let quoted = &line[open..];
                let gap = quoted.as_bytes().windows(7).any(|w| {
                    w[0].is_ascii_alphabetic()
                        && w[1..6].iter().all(|b| *b == b' ')
                        && w[6].is_ascii_alphabetic()
                });
                if gap && !line.trim_start().starts_with("//") {
                    found.push(format!("{}:{}: {}", path.display(), no + 1, line.trim()));
                }
            }
        }
    }
}

#[test]
fn no_message_has_a_run_of_spaces_in_it() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut found = Vec::new();
    for name in [
        "basalt-host",
        "basalt-client",
        "basalt-net",
        "basalt-update",
        "basalt-proto",
    ] {
        walk(&crates.join(name).join("src"), &mut found);
    }
    assert!(
        found.is_empty(),
        "spaces in the middle of a message:\n{}",
        found.join("\n")
    );
}
