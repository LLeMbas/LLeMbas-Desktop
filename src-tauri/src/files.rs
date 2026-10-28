//! The agent's working directory, for the explorer and the viewer: list a folder, read a file.
//!
//! Only inside the folders the agent may work in (`lembas remote` roots, as the CLI last said):
//! the page names a folder and a path inside it, and both are resolved here -- symbolic links and
//! `..` included -- before anything is opened. A path that ends up outside every root is refused,
//! whatever the page asked. Reading only: the app never writes in a project, the agent does.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// The most of a folder listed at once.
pub const MAX_ENTRIES: usize = 5000;
/// The most of a file read for the viewer; a bigger one is offered by name only.
pub const MAX_READ: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    /// From the folder the page named, with `/` between parts.
    pub path: String,
    /// `dir` or `file` (a link counts as what it points to; a broken one as a file).
    pub kind: &'static str,
    pub size: u64,
    /// Seconds since 1970, when the system says.
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Listing {
    pub root: String,
    pub path: String,
    pub entries: Vec<Entry>,
    /// More entries than `MAX_ENTRIES`: the rest are not listed.
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Opened {
    pub root: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    /// The text, when the file is text and small enough.
    pub text: Option<String>,
    /// Why there is no text: `binary` or `too_big`.
    pub withheld: Option<&'static str>,
}

/// `root` (a folder the agent may use, or one inside it) and `path` inside it, resolved, and
/// refused unless the result is inside one of `roots`. The canonical root and target.
pub fn resolve(roots: &[String], root: &str, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let base = fs::canonicalize(root).map_err(|e| format!("{root}: {e}"))?;
    let allowed = roots
        .iter()
        .filter_map(|r| fs::canonicalize(r).ok())
        .any(|r| base.starts_with(&r));
    if !allowed {
        return Err(format!(
            "{root} is not a folder the agent may work in. Add it under Settings, Project folders."
        ));
    }
    let rel = Path::new(path.trim_start_matches('/'));
    if rel.components().any(|c| matches!(c, Component::Prefix(_))) {
        return Err(format!("Not a path inside {root}: {path}"));
    }
    let target = fs::canonicalize(base.join(rel)).map_err(|e| format!("{path}: {e}"))?;
    if !target.starts_with(&base) {
        return Err(format!("{path} is outside {root}."));
    }
    Ok((base, target))
}

/// `target` from `base`, with `/` between parts ("" for the base itself).
fn relative(base: &Path, target: &Path) -> String {
    target
        .strip_prefix(base)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

pub fn list(roots: &[String], root: &str, path: &str) -> Result<Listing, String> {
    let (base, dir) = resolve(roots, root, path)?;
    if !dir.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    let mut entries = Vec::new();
    let mut more = false;
    for item in fs::read_dir(&dir).map_err(|e| format!("{path}: {e}"))? {
        let Ok(item) = item else { continue };
        if entries.len() >= MAX_ENTRIES {
            more = true;
            break;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        // A link is shown as what it points to; following it is `resolve`'s to allow or not.
        let meta = fs::metadata(item.path()).or_else(|_| item.metadata());
        let (kind, size, modified) = match meta {
            Ok(m) => (
                if m.is_dir() { "dir" } else { "file" },
                if m.is_dir() { 0 } else { m.len() },
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
            ),
            Err(_) => ("file", 0, None),
        };
        let at = relative(&base, &dir);
        entries.push(Entry {
            path: if at.is_empty() {
                name.clone()
            } else {
                format!("{at}/{name}")
            },
            name,
            kind,
            size,
            modified,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(Listing {
        root: base.to_string_lossy().into_owned(),
        path: relative(&base, &dir),
        entries,
        more,
    })
}

/// Text, as the CLI's `show` decides it: no NUL byte, and valid UTF-8.
fn as_text(data: Vec<u8>) -> Option<String> {
    if data.contains(&0) {
        return None;
    }
    String::from_utf8(data).ok()
}

pub fn read(roots: &[String], root: &str, path: &str) -> Result<Opened, String> {
    let (base, file) = resolve(roots, root, path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file."));
    }
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut opened = Opened {
        root: base.to_string_lossy().into_owned(),
        path: relative(&base, &file),
        name,
        size: meta.len(),
        text: None,
        withheld: None,
    };
    if meta.len() > MAX_READ {
        opened.withheld = Some("too_big");
        return Ok(opened);
    }
    let data = fs::read(&file).map_err(|e| format!("{path}: {e}"))?;
    match as_text(data) {
        Some(t) => opened.text = Some(t),
        None => opened.withheld = Some("binary"),
    }
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llembas-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("project/src")).unwrap();
        fs::create_dir_all(d.join("outside")).unwrap();
        fs::write(d.join("project/README.md"), "# Waybread\n").unwrap();
        fs::write(d.join("project/src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(d.join("project/blob.bin"), [0u8, 1, 2]).unwrap();
        fs::write(d.join("outside/secret.txt"), "no").unwrap();
        d
    }

    fn roots(d: &Path) -> Vec<String> {
        vec![d.join("project").to_string_lossy().into_owned()]
    }

    #[test]
    fn a_root_lists_folders_first() {
        let d = scratch("list");
        let root = d.join("project").to_string_lossy().into_owned();
        let l = list(&roots(&d), &root, "").unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "blob.bin", "README.md"]);
        assert_eq!(l.entries[0].kind, "dir");
        let inner = list(&roots(&d), &root, "src").unwrap();
        assert_eq!(inner.entries[0].path, "src/main.rs");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn nothing_outside_the_roots_is_reached() {
        let d = scratch("outside");
        let root = d.join("project").to_string_lossy().into_owned();
        let other = d.join("outside").to_string_lossy().into_owned();
        assert!(list(&roots(&d), &other, "").is_err());
        assert!(read(&roots(&d), &root, "../outside/secret.txt").is_err());
        assert!(read(&roots(&d), &root, "/../outside/secret.txt").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(d.join("outside"), d.join("project/escape")).unwrap();
            assert!(read(&roots(&d), &root, "escape/secret.txt").is_err());
            // A folder inside a root is a root of its own for the pane (an agent chat's folder).
            let sub = d.join("project/src").to_string_lossy().into_owned();
            assert!(list(&roots(&d), &sub, "").is_ok());
        }
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn text_is_read_and_the_rest_is_withheld() {
        let d = scratch("read");
        let root = d.join("project").to_string_lossy().into_owned();
        let md = read(&roots(&d), &root, "README.md").unwrap();
        assert_eq!(md.text.as_deref(), Some("# Waybread\n"));
        assert_eq!(md.path, "README.md");
        let bin = read(&roots(&d), &root, "blob.bin").unwrap();
        assert_eq!(bin.text, None);
        assert_eq!(bin.withheld, Some("binary"));
        assert!(read(&roots(&d), &root, "src").is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
