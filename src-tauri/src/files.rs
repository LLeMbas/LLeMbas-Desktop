//! The agent's working directory, for the explorer and the viewer: list a folder, read a file,
//! and -- since the Files page became a file manager -- make, rename, move, copy, delete and save.
//!
//! Only inside the folders the agent may work in (`lembas remote` roots, as the CLI last said):
//! the page names a folder and a path inside it, and both are resolved here -- symbolic links and
//! `..` included -- before anything is opened or changed. A path that ends up outside every root
//! is refused, whatever the page asked.
//!
//! Writing has one more rule (the app never writes the CLI's files): nothing is made, changed,
//! moved or deleted inside the CLI's own directories -- its configuration, data and state
//! (`kept`), and a project's `.lembas` or `.agent` -- and nothing that holds one of them is
//! moved or deleted either. They can still be read. A thing that is itself a link is renamed,
//! moved or deleted as the link it is, never as what it points to.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::kinds;
use crate::server::ApiError;

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
    /// What a file is, by its name alone (`kinds::by_name_alone`); none for a folder.
    pub file_kind: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Listing {
    pub root: String,
    pub path: String,
    pub entries: Vec<Entry>,
    /// More entries than `MAX_ENTRIES`: the rest are not listed.
    pub more: bool,
}

/// What became of one of several things moved, copied or deleted: as the server's batch says it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Outcome {
    pub path: String,
    pub ok: bool,
    /// Where it is now (a move, a copy), from the folder the page named.
    pub to: Option<String>,
    pub error: Option<String>,
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
    /// What the file is, by its name and its first bytes (`kinds::detect`).
    pub kind: &'static str,
    pub mime: &'static str,
    /// SHA-256 of the text as read: what a save says it started from.
    pub sha: Option<String>,
    /// Whether the app may save it: not one of the CLI's own files.
    pub writable: bool,
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
            file_kind: (kind == "file").then(|| kinds::by_name_alone(&name)),
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

/// The first bytes of a file: what `kinds::detect` looks at.
fn head_of(file: &Path) -> Vec<u8> {
    let mut head = Vec::with_capacity(kinds::HEAD_BYTES);
    if let Ok(f) = fs::File::open(file) {
        let _ = f.take(kinds::HEAD_BYTES as u64).read_to_end(&mut head);
    }
    head
}

/// `read_as` with no directory kept from writing: what the tests of reading ask.
#[cfg(test)]
pub fn read(roots: &[String], root: &str, path: &str) -> Result<Opened, String> {
    read_as(roots, &[], root, path)
}

/// A file for the viewer: its text when it is text and small enough, what it is either way, and
/// whether the app may save it (`kept`: the CLI's own directories).
pub fn read_as(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    path: &str,
) -> Result<Opened, String> {
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
        kind: "binary",
        mime: "application/octet-stream",
        sha: None,
        writable: may_write(kept, &file).is_ok(),
    };
    if meta.len() > MAX_READ {
        let k = kinds::detect(&opened.name, &head_of(&file));
        (opened.kind, opened.mime) = (k.kind, k.mime);
        opened.withheld = Some("too_big");
        return Ok(opened);
    }
    let data = fs::read(&file).map_err(|e| format!("{path}: {e}"))?;
    let k = kinds::detect(&opened.name, &data);
    (opened.kind, opened.mime) = (k.kind, k.mime);
    let sha = crate::python::sha256_hex(&data);
    match as_text(data) {
        Some(t) => {
            opened.text = Some(t);
            opened.sha = Some(sha);
        }
        None => opened.withheld = Some("binary"),
    }
    Ok(opened)
}

/// A file as the media scheme serves it: where it really is, what it is, how long it is.
pub fn media(
    roots: &[String],
    root: &str,
    path: &str,
) -> Result<(PathBuf, kinds::Kind, u64), String> {
    let (_, file) = resolve(roots, root, path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file."));
    }
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = kinds::detect(&name, &head_of(&file));
    Ok((file, kind, meta.len()))
}

// --- Writing ------------------------------------------------------------------------------------

/// The most that is copied in one go: a folder with more in it than this is refused whole.
const MAX_COPIED: usize = 20_000;

fn refused(detail: impl Into<String>) -> ApiError {
    ApiError::new(400, detail)
}

/// The CLI's own directories as they really are on disk (links resolved where they exist).
pub fn kept_dirs(dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter()
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| fs::canonicalize(d).unwrap_or_else(|_| d.clone()))
        .collect()
}

/// Whether the app may write at `target` (a resolved path): never in one of the CLI's own
/// directories, never something that holds one, and never in a project's `.lembas` or `.agent`.
pub fn may_write(kept: &[PathBuf], target: &Path) -> Result<(), String> {
    let own = target.components().any(|c| {
        matches!(c, Component::Normal(n) if n == std::ffi::OsStr::new(".lembas") || n == std::ffi::OsStr::new(".agent"))
    });
    if own
        || kept
            .iter()
            .any(|k| target.starts_with(k) || k.starts_with(target))
    {
        return Err(format!(
            "{} belongs to the LLeMbas CLI: the app reads it and never changes it.",
            target.display()
        ));
    }
    Ok(())
}

/// A name for one thing in a folder: one part of a path, and nothing that could leave it.
pub fn plain_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty()
        || n == "."
        || n == ".."
        || n.contains(['/', '\\'])
        || n.chars().any(|c| c.is_control())
    {
        return Err("A name cannot be empty or hold a slash.".into());
    }
    Ok(n)
}

/// A thing that is there, as itself: its folder resolved and checked, its own name not followed
/// (a link is the link). The canonical root, the folder, and the thing.
fn entry(roots: &[String], root: &str, path: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let clean = path.trim_matches('/');
    let (dir, name) = match clean.rsplit_once('/') {
        Some((dir, name)) => (dir, name),
        None => ("", clean),
    };
    let name = plain_name(name).map_err(|_| format!("Not something inside {root}: {path}"))?;
    let (base, parent) = resolve(roots, root, dir)?;
    let at = parent.join(name);
    fs::symlink_metadata(&at).map_err(|e| format!("{path}: {e}"))?;
    Ok((base, parent, at))
}

/// A folder that is there, and may be written in.
fn folder(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    dir: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let (base, at) = resolve(roots, root, dir)?;
    if !at.is_dir() {
        return Err(format!("{dir} is not a folder."));
    }
    may_write(kept, &at)?;
    Ok((base, at))
}

fn taken(at: &Path) -> bool {
    fs::symlink_metadata(at).is_ok()
}

/// `name`, or `name (2)`, `name (3)`, ... -- the first that nothing in `dir` is called. The
/// number goes before the extension, as the server's copy has it.
pub fn free_name(dir: &Path, name: &str) -> String {
    if !taken(&dir.join(name)) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (2u32..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !taken(&dir.join(candidate)))
        .unwrap_or_else(|| name.to_string())
}

/// Make a folder called `name` in `dir`. Its path, from the folder the page named.
pub fn make_dir(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    dir: &str,
    name: &str,
) -> Result<String, String> {
    let name = plain_name(name)?;
    let (base, parent) = folder(roots, kept, root, dir)?;
    let at = parent.join(name);
    may_write(kept, &at)?;
    if taken(&at) {
        return Err(format!("There is already something called {name} here."));
    }
    fs::create_dir(&at).map_err(|e| format!("{name}: {e}"))?;
    Ok(relative(&base, &at))
}

/// Make an empty file called `name` in `dir`; never over one that is there.
pub fn make_file(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    dir: &str,
    name: &str,
) -> Result<String, String> {
    let name = plain_name(name)?;
    let (base, parent) = folder(roots, kept, root, dir)?;
    let at = parent.join(name);
    may_write(kept, &at)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&at)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("There is already something called {name} here.")
            }
            _ => format!("{name}: {e}"),
        })?;
    Ok(relative(&base, &at))
}

/// Give the thing at `path` another name, in the folder it is in.
pub fn rename(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    path: &str,
    name: &str,
) -> Result<String, String> {
    let name = plain_name(name)?;
    let (base, parent, from) = entry(roots, root, path)?;
    let to = parent.join(name);
    may_write(kept, &from)?;
    may_write(kept, &to)?;
    if from == base {
        return Err("The folder itself cannot be renamed from here.".into());
    }
    if taken(&to) {
        return Err(format!("There is already something called {name} here."));
    }
    fs::rename(&from, &to).map_err(|e| format!("{path}: {e}"))?;
    Ok(relative(&base, &to))
}

/// Copy a file, a link (as the link it is) or a whole folder. `left` counts down what may still
/// be copied: a folder too large is stopped, not half-finished silently.
fn copy_tree(from: &Path, to: &Path, left: &mut usize) -> std::io::Result<()> {
    if *left == 0 {
        return Err(std::io::Error::other("too many files to copy at once"));
    }
    *left -= 1;
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(fs::read_link(from)?, to);
        #[cfg(not(unix))]
        return Err(std::io::Error::other("a link is not copied on this system"));
    }
    if meta.is_dir() {
        fs::create_dir(to)?;
        for item in fs::read_dir(from)? {
            let item = item?;
            copy_tree(&item.path(), &to.join(item.file_name()), left)?;
        }
        return Ok(());
    }
    fs::copy(from, to).map(|_| ())
}

fn remove_tree(at: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(at)?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(at)
    } else {
        fs::remove_file(at)
    }
}

fn outcome(path: &str, done: Result<String, String>) -> Outcome {
    match done {
        Ok(to) => Outcome {
            path: path.to_string(),
            ok: true,
            to: Some(to),
            error: None,
        },
        Err(error) => Outcome {
            path: path.to_string(),
            ok: false,
            to: None,
            error: Some(error),
        },
    }
}

/// Move or copy each of `paths` into the folder `to`, one by one: what worked stays done, and
/// each that did not says why. A move never replaces what is there; a copy takes a free name.
pub fn transfer(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    paths: &[String],
    to: &str,
    copy: bool,
) -> Result<Vec<Outcome>, String> {
    let (base, dest) = folder(roots, kept, root, to)?;
    let one = |path: &str| -> Result<String, String> {
        let (_, parent, from) = entry(roots, root, path)?;
        if from == base {
            return Err("The folder itself cannot be moved from here.".into());
        }
        let name = from
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // A folder is never put inside itself: where it really is decides, not how it was named.
        let real = fs::canonicalize(&from).unwrap_or_else(|_| from.clone());
        let is_dir = fs::symlink_metadata(&from)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir && dest.starts_with(&real) {
            return Err(format!("{path} cannot be put inside itself."));
        }
        if copy {
            let target = dest.join(free_name(&dest, &name));
            may_write(kept, &target)?;
            let mut left = MAX_COPIED;
            if let Err(e) = copy_tree(&from, &target, &mut left) {
                let _ = remove_tree(&target);
                return Err(format!("{path}: {e}"));
            }
            return Ok(relative(&base, &target));
        }
        may_write(kept, &from)?;
        if parent == dest {
            return Err(format!("{name} is already in that folder."));
        }
        let target = dest.join(&name);
        may_write(kept, &target)?;
        if taken(&target) {
            return Err(format!("There is already something called {name} here."));
        }
        match fs::rename(&from, &target) {
            Ok(()) => {}
            // Another disk: copied across, and the original removed once the copy is whole.
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                let mut left = MAX_COPIED;
                if let Err(e) = copy_tree(&from, &target, &mut left) {
                    let _ = remove_tree(&target);
                    return Err(format!("{path}: {e}"));
                }
                remove_tree(&from).map_err(|e| format!("{path}: {e}"))?;
            }
            Err(e) => return Err(format!("{path}: {e}")),
        }
        Ok(relative(&base, &target))
    };
    Ok(paths
        .iter()
        .map(|p| outcome(p.as_str(), one(p.as_str())))
        .collect())
}

/// Delete each of `paths` with `trash` (the system's trash: lib.rs), one by one.
pub fn delete(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    paths: &[String],
    trash: &dyn Fn(&Path) -> Result<(), String>,
) -> Vec<Outcome> {
    let one = |path: &str| -> Result<String, String> {
        let (base, _, at) = entry(roots, root, path)?;
        if at == base {
            return Err("The folder itself cannot be deleted from here.".into());
        }
        may_write(kept, &at)?;
        trash(&at)?;
        Ok(String::new())
    };
    paths
        .iter()
        .map(|p| {
            let mut o = outcome(p.as_str(), one(p.as_str()));
            o.to = None;
            o
        })
        .collect()
}

/// Save `text` as the file at `path`, which must be there. `base` is the `sha` the page read:
/// when the file holds something else by now, a 409 and nothing is written, unless `force`.
pub fn write(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    path: &str,
    text: &str,
    base: Option<&str>,
    force: bool,
) -> Result<Opened, ApiError> {
    let (_, file) = resolve(roots, root, path).map_err(refused)?;
    if !file.is_file() {
        return Err(refused(format!("{path} is not a file.")));
    }
    may_write(kept, &file).map_err(refused)?;
    if text.len() as u64 > MAX_READ {
        return Err(ApiError::new(
            413,
            "This is too much text to save from here.",
        ));
    }
    if !force {
        if let Some(base) = base {
            let now = fs::read(&file).map_err(|e| refused(format!("{path}: {e}")))?;
            if crate::python::sha256_hex(&now) != base {
                return Err(ApiError::new(
                    409,
                    "This file changed since you opened it. Reload it, or save anyway.",
                ));
            }
        }
    }
    fs::write(&file, text.as_bytes()).map_err(|e| refused(format!("{path}: {e}")))?;
    read_as(roots, kept, root, path).map_err(refused)
}

/// Where a file brought into `dir` under `name` would go: a free name there, never over
/// something. For a download from the server into a folder of the agent's.
pub fn incoming(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    dir: &str,
    name: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let name = plain_name(name)?;
    let (base, parent) = folder(roots, kept, root, dir)?;
    let at = parent.join(free_name(&parent, name));
    may_write(kept, &at)?;
    Ok((base, at))
}

/// `at` from `base`, as the page names paths.
pub fn relative_to(base: &Path, at: &Path) -> String {
    relative(base, at)
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

    fn all(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn what_a_file_is_and_what_a_save_starts_from() {
        let d = scratch("kinds");
        let root = d.join("project").to_string_lossy().into_owned();
        fs::write(d.join("project/map.png"), b"\x89PNG\r\n\x1a\n\0\0").unwrap();
        fs::write(d.join("project/fake.png"), "only words").unwrap();
        let l = list(&roots(&d), &root, "").unwrap();
        let kind = |name: &str| l.entries.iter().find(|e| e.name == name).unwrap().file_kind;
        assert_eq!(kind("src"), None);
        assert_eq!(kind("README.md"), Some("markdown"));
        assert_eq!(kind("map.png"), Some("image"));
        // The listing goes by the name; whoever opens the file is told by its bytes.
        assert_eq!(kind("fake.png"), Some("image"));
        assert_eq!(read(&roots(&d), &root, "fake.png").unwrap().kind, "text");
        let png = read(&roots(&d), &root, "map.png").unwrap();
        assert_eq!(
            (png.kind, png.mime, png.withheld),
            ("image", "image/png", Some("binary"))
        );
        assert_eq!(png.sha, None);
        let md = read_as(&roots(&d), &[], &root, "README.md").unwrap();
        assert_eq!(md.kind, "markdown");
        assert_eq!(md.sha.as_deref().map(str::len), Some(64));
        assert!(md.writable);
        let (at, k, len) = media(&roots(&d), &root, "map.png").unwrap();
        assert!(at.ends_with("project/map.png"));
        assert_eq!((k.mime, len), ("image/png", 10));
        assert!(media(&roots(&d), &root, "../outside/secret.txt").is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn new_rename_move_copy_and_save_inside_a_root() {
        let d = scratch("write");
        let r = roots(&d);
        let root = d.join("project").to_string_lossy().into_owned();
        assert_eq!(make_dir(&r, &[], &root, "", "docs").unwrap(), "docs");
        assert_eq!(
            make_file(&r, &[], &root, "docs", "notes.md").unwrap(),
            "docs/notes.md"
        );
        assert!(make_file(&r, &[], &root, "docs", "notes.md").is_err());
        assert!(make_dir(&r, &[], &root, "", "docs").is_err());
        // Saved from what was read; a file changed meanwhile is a 409 and is not written.
        let opened = read_as(&r, &[], &root, "docs/notes.md").unwrap();
        let saved = write(
            &r,
            &[],
            &root,
            "docs/notes.md",
            "one\n",
            opened.sha.as_deref(),
            false,
        )
        .unwrap();
        assert_eq!(saved.text.as_deref(), Some("one\n"));
        fs::write(d.join("project/docs/notes.md"), "someone else\n").unwrap();
        let conflict = write(
            &r,
            &[],
            &root,
            "docs/notes.md",
            "two\n",
            saved.sha.as_deref(),
            false,
        )
        .unwrap_err();
        assert_eq!(conflict.status, 409);
        assert_eq!(
            fs::read_to_string(d.join("project/docs/notes.md")).unwrap(),
            "someone else\n"
        );
        write(
            &r,
            &[],
            &root,
            "docs/notes.md",
            "two\n",
            saved.sha.as_deref(),
            true,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(d.join("project/docs/notes.md")).unwrap(),
            "two\n"
        );
        // A save never makes a file, and never writes a folder.
        assert_eq!(
            write(&r, &[], &root, "docs/none.md", "x", None, false)
                .unwrap_err()
                .status,
            400
        );
        assert!(write(&r, &[], &root, "docs", "x", None, true).is_err());
        assert_eq!(
            rename(&r, &[], &root, "docs/notes.md", "plan.md").unwrap(),
            "docs/plan.md"
        );
        assert!(rename(&r, &[], &root, "docs/plan.md", "../up.md").is_err());
        assert!(
            rename(&r, &[], &root, "README.md", "blob.bin").is_err(),
            "never over something"
        );
        // A copy takes a free name; a move never replaces, and a folder is not put inside itself.
        let copied = transfer(
            &r,
            &[],
            &root,
            &all(&["docs/plan.md", "README.md", "nothing"]),
            "docs",
            true,
        )
        .unwrap();
        assert_eq!(copied[0].to.as_deref(), Some("docs/plan (2).md"));
        assert_eq!(copied[1].to.as_deref(), Some("docs/README.md"));
        assert!(!copied[2].ok && copied[2].error.is_some());
        let moved = transfer(
            &r,
            &[],
            &root,
            &all(&["README.md", "blob.bin", "docs", "src"]),
            "docs",
            false,
        )
        .unwrap();
        assert!(!moved[0].ok, "docs/README.md is there already");
        assert_eq!(moved[1].to.as_deref(), Some("docs/blob.bin"));
        assert!(!moved[2].ok, "a folder into itself");
        assert_eq!(moved[3].to.as_deref(), Some("docs/src"));
        assert!(d.join("project/docs/src/main.rs").is_file());
        assert!(d.join("project/README.md").is_file());
        let tree = transfer(&r, &[], &root, &all(&["docs"]), "", true).unwrap();
        assert_eq!(tree[0].to.as_deref(), Some("docs (2)"));
        assert!(d.join("project/docs (2)/src/main.rs").is_file());
        assert!(
            transfer(&r, &[], &root, &all(&["README.md"]), "README.md", true).is_err(),
            "into a file"
        );
        // Deleted through the system's trash, here a stand-in that says what it was given.
        let seen = std::cell::RefCell::new(Vec::new());
        let trash = |p: &Path| {
            seen.borrow_mut().push(p.to_path_buf());
            fs::remove_dir_all(p)
                .or_else(|_| fs::remove_file(p))
                .map_err(|e| e.to_string())
        };
        let gone = delete(
            &r,
            &[],
            &root,
            &all(&["docs (2)", "README.md", "nothing"]),
            &trash,
        );
        assert_eq!(
            gone.iter().map(|o| o.ok).collect::<Vec<_>>(),
            vec![true, true, false]
        );
        assert_eq!(seen.borrow().len(), 2);
        assert!(!d.join("project/README.md").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn nothing_outside_the_roots_is_written() {
        let d = scratch("escape");
        let r = roots(&d);
        let root = d.join("project").to_string_lossy().into_owned();
        let other = d.join("outside").to_string_lossy().into_owned();
        let never =
            |_: &Path| -> Result<(), String> { panic!("nothing outside reaches the trash") };
        // By its own name, by `..`, and from a folder that is no root at all.
        assert!(make_file(&r, &[], &other, "", "x.txt").is_err());
        assert!(make_dir(&r, &[], &root, "../outside", "x").is_err());
        assert!(make_file(&r, &[], &root, "", "../outside/x.txt").is_err());
        assert!(make_file(&r, &[], &root, "", "..").is_err());
        assert!(write(&r, &[], &root, "../outside/secret.txt", "mine", None, true).is_err());
        assert!(rename(&r, &[], &root, "../outside/secret.txt", "taken.txt").is_err());
        assert!(rename(&r, &[], &root, "README.md", "/tmp/x").is_err());
        assert!(transfer(&r, &[], &root, &all(&["README.md"]), "../outside", false).is_err());
        assert!(transfer(&r, &[], &root, &all(&["README.md"]), "../outside", true).is_err());
        let out = transfer(
            &r,
            &[],
            &root,
            &all(&["../outside/secret.txt"]),
            "src",
            false,
        )
        .unwrap();
        assert!(!out[0].ok);
        assert!(!delete(
            &r,
            &[],
            &root,
            &all(&["../outside/secret.txt", "..", ""]),
            &never
        )
        .iter()
        .any(|o| o.ok));
        assert!(incoming(&r, &[], &root, "../outside", "x.txt").is_err());
        assert!(incoming(&r, &[], &root, "", "a/b.txt").is_err());
        #[cfg(unix)]
        {
            // Through a link that leaves the root: the folder it leads to, and a file in it.
            std::os::unix::fs::symlink(d.join("outside"), d.join("project/escape")).unwrap();
            std::os::unix::fs::symlink(d.join("outside/secret.txt"), d.join("project/alias.txt"))
                .unwrap();
            assert!(make_file(&r, &[], &root, "escape", "x.txt").is_err());
            assert!(make_dir(&r, &[], &root, "escape", "x").is_err());
            assert!(write(&r, &[], &root, "escape/secret.txt", "mine", None, true).is_err());
            assert!(write(&r, &[], &root, "alias.txt", "mine", None, true).is_err());
            assert!(rename(&r, &[], &root, "escape/secret.txt", "taken.txt").is_err());
            assert!(transfer(&r, &[], &root, &all(&["README.md"]), "escape", false).is_err());
            assert!(transfer(&r, &[], &root, &all(&["README.md"]), "escape", true).is_err());
            assert!(
                !transfer(&r, &[], &root, &all(&["escape/secret.txt"]), "src", false).unwrap()[0]
                    .ok
            );
            assert!(!delete(&r, &[], &root, &all(&["escape/secret.txt"]), &never)[0].ok);
            assert!(incoming(&r, &[], &root, "escape", "x.txt").is_err());
            // The link itself is the root's: renamed and deleted as a link, what it points to untouched.
            assert_eq!(
                rename(&r, &[], &root, "alias.txt", "link.txt").unwrap(),
                "link.txt"
            );
            let unlink = |p: &Path| fs::remove_file(p).map_err(|e| e.to_string());
            assert!(
                delete(&r, &[], &root, &all(&["link.txt", "escape"]), &unlink)
                    .iter()
                    .all(|o| o.ok)
            );
            // A copied folder keeps a link as a link: nothing from outside is read into the root.
            std::os::unix::fs::symlink(
                d.join("outside/secret.txt"),
                d.join("project/src/alias.txt"),
            )
            .unwrap();
            let copied = transfer(&r, &[], &root, &all(&["src"]), "", true).unwrap();
            assert_eq!(copied[0].to.as_deref(), Some("src (2)"));
            assert!(fs::symlink_metadata(d.join("project/src (2)/alias.txt"))
                .unwrap()
                .file_type()
                .is_symlink());
        }
        assert_eq!(
            fs::read_to_string(d.join("outside/secret.txt")).unwrap(),
            "no"
        );
        assert_eq!(fs::read_dir(d.join("outside")).unwrap().count(), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_clis_own_files_are_read_and_never_written() {
        let d = scratch("kept");
        // The home is a root, and the CLI's configuration and state are inside it.
        let home = d.join("project");
        fs::create_dir_all(home.join(".config/lembas")).unwrap();
        fs::create_dir_all(home.join(".local/state/lembas")).unwrap();
        fs::create_dir_all(home.join("work/.lembas")).unwrap();
        fs::create_dir_all(home.join("work/.agent")).unwrap();
        fs::write(home.join(".config/lembas/lembas.json"), "{}").unwrap();
        fs::write(home.join("work/.lembas/config.yaml"), "a: 1\n").unwrap();
        let r = roots(&d);
        let root = home.to_string_lossy().into_owned();
        let kept = kept_dirs(&[
            home.join(".config/lembas"),
            home.join(".local/state/lembas"),
            d.join("not-there/lembas"),
            PathBuf::new(),
        ]);
        assert_eq!(kept.len(), 3);
        let never =
            |_: &Path| -> Result<(), String> { panic!("the CLI's files never reach the trash") };
        // Read, and said not to be writable.
        let own = read_as(&r, &kept, &root, ".config/lembas/lembas.json").unwrap();
        assert_eq!(own.text.as_deref(), Some("{}"));
        assert!(!own.writable);
        assert!(read_as(&r, &kept, &root, "README.md").unwrap().writable);
        // Not saved, made, renamed, moved, copied into or deleted -- nor the folders that hold them.
        assert!(write(
            &r,
            &kept,
            &root,
            ".config/lembas/lembas.json",
            "{\"x\":1}",
            None,
            true
        )
        .is_err());
        assert!(write(
            &r,
            &kept,
            &root,
            "work/.lembas/config.yaml",
            "a: 2\n",
            None,
            true
        )
        .is_err());
        assert!(make_file(&r, &kept, &root, ".config/lembas", "connections.yaml").is_err());
        assert!(make_dir(&r, &kept, &root, ".local/state/lembas", "x").is_err());
        assert!(make_file(&r, &kept, &root, "work/.agent", "x").is_err());
        assert!(
            make_dir(&r, &kept, &root, "work", ".lembas2").is_ok(),
            "only the CLI's own names"
        );
        assert!(make_dir(&r, &kept, &root, "src", ".lembas").is_err());
        assert!(rename(&r, &kept, &root, ".config/lembas/lembas.json", "old.json").is_err());
        assert!(rename(&r, &kept, &root, ".config/lembas", "gone").is_err());
        assert!(
            rename(&r, &kept, &root, ".config", "gone").is_err(),
            "a folder that holds it"
        );
        assert!(rename(&r, &kept, &root, "README.md", ".lembas").is_err());
        for copy in [false, true] {
            assert!(transfer(
                &r,
                &kept,
                &root,
                &all(&["README.md"]),
                ".config/lembas",
                copy
            )
            .is_err());
            assert!(
                transfer(&r, &kept, &root, &all(&["README.md"]), "work/.lembas", copy).is_err()
            );
        }
        let moved = transfer(
            &r,
            &kept,
            &root,
            &all(&[".config/lembas/lembas.json", ".config", "work/.lembas"]),
            "src",
            false,
        )
        .unwrap();
        assert!(moved.iter().all(|o| !o.ok));
        assert!(delete(
            &r,
            &kept,
            &root,
            &all(&[
                ".config/lembas/lembas.json",
                ".config/lembas",
                ".config",
                ".local",
                "work/.agent"
            ]),
            &never
        )
        .iter()
        .all(|o| !o.ok));
        assert!(incoming(&r, &kept, &root, ".config/lembas", "x.json").is_err());
        #[cfg(unix)]
        {
            // Nor through a link to it from somewhere that looks harmless.
            std::os::unix::fs::symlink(home.join(".config/lembas"), home.join("src/settings"))
                .unwrap();
            assert!(write(
                &r,
                &kept,
                &root,
                "src/settings/lembas.json",
                "x",
                None,
                true
            )
            .is_err());
            assert!(make_file(&r, &kept, &root, "src/settings", "x").is_err());
            assert!(
                !transfer(
                    &r,
                    &kept,
                    &root,
                    &all(&["src/settings/lembas.json"]),
                    "src",
                    false
                )
                .unwrap()[0]
                    .ok
            );
        }
        assert_eq!(
            fs::read_to_string(home.join(".config/lembas/lembas.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(home.join("work/.lembas/config.yaml")).unwrap(),
            "a: 1\n"
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_free_name_is_numbered_before_the_extension() {
        let d = scratch("names");
        let p = d.join("project");
        assert_eq!(free_name(&p, "new.md"), "new.md");
        assert_eq!(free_name(&p, "README.md"), "README (2).md");
        fs::write(p.join("README (2).md"), "").unwrap();
        assert_eq!(free_name(&p, "README.md"), "README (3).md");
        assert_eq!(free_name(&p, "src"), "src (2)");
        fs::write(p.join(".env"), "").unwrap();
        assert_eq!(free_name(&p, ".env"), ".env (2)");
        assert!(plain_name(" a.txt ").is_ok());
        for bad in ["", " ", ".", "..", "a/b", "a\\b", "a\nb"] {
            assert!(plain_name(bad).is_err(), "{bad:?}");
        }
        fs::remove_dir_all(&d).unwrap();
    }
}
