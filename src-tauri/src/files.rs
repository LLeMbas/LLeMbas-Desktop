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
//! (`kept`), and a project's `.lembas` or `.agent`, however a disk that folds case spells them --
//! and no folder that has one of them anywhere under it is renamed, moved or deleted either
//! (`may_move`). They can still be read; a copy of a folder leaves them out and says so. A thing
//! that is itself a link is renamed, moved or deleted as the link it is, never as what it points
//! to.
//!
//! Nothing is ever written in place or through a name somebody else could have put there: a save
//! and a download are written to a file made new under a random name beside where they are going
//! (`Fresh`) and take their name only once whole, so a link planted there -- symbolic or hard --
//! is replaced, never written through. A copy reads only ordinary files, from the handle it
//! opened, and on a failure removes what it made itself and nothing else.

use std::fs;
use std::io::{Read, Write};
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
    /// What the person should know of something that worked: what a copy left out.
    pub note: Option<String>,
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
    if let Ok((f, _)) = open_regular(file, true) {
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
/// The most looked at under a folder before it is renamed, moved or deleted: one with more in it
/// than this cannot be said to hold none of the CLI's files, and is refused.
const MAX_WALKED: usize = 200_000;

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

/// One of the CLI's own names in a project. Compared without case: on a disk that folds it,
/// `.LEMBAS` is the same folder.
fn own_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|n| n.eq_ignore_ascii_case(".lembas") || n.eq_ignore_ascii_case(".agent"))
}

/// Whether `path` is `prefix` or inside it, letters compared without their case.
fn within(path: &Path, prefix: &Path) -> bool {
    let mut have = path.components();
    prefix.components().all(|want| {
        have.next().is_some_and(|part| {
            part == want
                || part.as_os_str().to_string_lossy().to_lowercase()
                    == want.as_os_str().to_string_lossy().to_lowercase()
        })
    })
}

/// Whether `at` (a resolved path) is the CLI's: in one of its directories, or in a project's
/// `.lembas` or `.agent`.
fn is_own(kept: &[PathBuf], at: &Path) -> bool {
    at.components()
        .any(|c| matches!(c, Component::Normal(n) if own_name(n)))
        || kept.iter().any(|k| within(at, k))
}

/// Whether the app may write at `target` (a resolved path): never in one of the CLI's own
/// directories, never something that holds one, and never in a project's `.lembas` or `.agent`.
pub fn may_write(kept: &[PathBuf], target: &Path) -> Result<(), String> {
    if is_own(kept, target) || kept.iter().any(|k| within(k, target)) {
        return Err(format!(
            "{} belongs to the LLeMbas CLI: the app reads it and never changes it.",
            target.display()
        ));
    }
    Ok(())
}

/// Whether the folder `at` has a project's `.lembas` or `.agent` anywhere under it. Links are
/// not followed (a link is moved as the link it is). An error when that cannot be said: more
/// under it than `most`, or a folder in it that cannot be listed.
fn holds_own(at: &Path, most: usize) -> Result<bool, String> {
    let is_dir = fs::symlink_metadata(at)
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if !is_dir {
        return Ok(false);
    }
    let unsure = || {
        format!(
            "{} could not be checked for files of the LLeMbas CLI, so it is left where it is.",
            at.display()
        )
    };
    let mut left = most;
    let mut todo = vec![at.to_path_buf()];
    while let Some(dir) = todo.pop() {
        for item in fs::read_dir(&dir).map_err(|_| unsure())? {
            let item = item.map_err(|_| unsure())?;
            if left == 0 {
                return Err(unsure());
            }
            left -= 1;
            if own_name(&item.file_name()) {
                return Ok(true);
            }
            if item.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                todo.push(item.path());
            }
        }
    }
    Ok(false)
}

/// Whether the thing at `at` may be renamed, moved or deleted: `may_write`, and for a folder,
/// nothing of the CLI's anywhere under it -- moving the folder would take those files along.
pub fn may_move(kept: &[PathBuf], at: &Path) -> Result<(), String> {
    may_write(kept, at)?;
    if holds_own(at, MAX_WALKED)? {
        return Err(format!(
            "{} holds files of the LLeMbas CLI: the app reads them and never moves or deletes them.",
            at.display()
        ));
    }
    Ok(())
}

/// Open `at` to read it, only if it is an ordinary file: a pipe or a device would be waited on
/// for ever, and is refused without being read. Unless `follow`, a link in its last name is
/// refused as well. The handle, and what the system says of the handle -- not of the name, which
/// could be something else by now.
pub fn open_regular(at: &Path, follow: bool) -> std::io::Result<(fs::File, fs::Metadata)> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | if follow { 0 } else { libc::O_NOFOLLOW });
    }
    #[cfg(not(unix))]
    let _ = follow;
    let file = options.open(at)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not an ordinary file",
        ));
    }
    Ok((file, meta))
}

/// Where an open file really is, where the system says (Linux).
#[cfg(target_os = "linux")]
fn really_at(file: &fs::File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(not(target_os = "linux"))]
fn really_at(_file: &fs::File) -> Option<PathBuf> {
    None
}

/// The room left on the disk `dest` is going to, where the system says.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
pub fn room_for(dest: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let dir = dest.parent().filter(|d| !d.as_os_str().is_empty())?;
    let dir = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut said = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `dir` is a NUL-terminated path, and `said` is room for the one answer the call fills.
    let done = unsafe { libc::statvfs(dir.as_ptr(), said.as_mut_ptr()) };
    if done != 0 {
        return None;
    }
    // SAFETY: the call succeeded, so the answer is written (and it was zeroed before).
    let said = unsafe { said.assume_init() };
    Some((said.f_bavail as u64).saturating_mul(said.f_frsize as u64))
}

#[cfg(not(unix))]
pub fn room_for(_dest: &Path) -> Option<u64> {
    None
}

/// A file being written beside where it is going: made new, under a name nothing else has
/// (`create_new`: never through a link, never over anything), and removed again when it is let
/// go before it was given its real name. Only ever a file this made is removed.
pub struct Fresh {
    at: PathBuf,
    file: fs::File,
    settled: bool,
    /// The folder it is in, held open, and the name it is written under there (Unix): what
    /// follows -- its real name, or its going -- is done by name inside that open folder, never
    /// by walking the path again. A part of the path swapped meanwhile redirects nothing.
    #[cfg(unix)]
    held: Option<(fs::File, std::ffi::CString)>,
}

#[cfg(unix)]
fn c_name(name: Option<&std::ffi::OsStr>) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    let name = name.ok_or_else(|| std::io::Error::other("no name to write under"))?;
    std::ffi::CString::new(name.as_bytes()).map_err(|_| std::io::Error::other("not a name"))
}

impl Fresh {
    /// A new, empty file in the folder `dest` is in.
    pub fn beside(dest: &Path) -> std::io::Result<Fresh> {
        Self::make(dest, false)
    }

    /// The same, where the folder is one that was checked (resolved, inside the agent's
    /// folders): the folder opened here must be that very folder, where the system can say
    /// which folder an open one is (Linux) -- one whose path leads somewhere else by now is
    /// refused before anything is made.
    pub fn within(dest: &Path) -> std::io::Result<Fresh> {
        Self::make(dest, true)
    }

    #[cfg(unix)]
    fn make(dest: &Path, checked: bool) -> std::io::Result<Fresh> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::OpenOptionsExt;
        let dir = dest
            .parent()
            .ok_or_else(|| std::io::Error::other("no folder to write in"))?;
        let folder = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY)
            .open(dir)?;
        if checked {
            if let Some(real) = really_at(&folder) {
                if real != dir {
                    return Err(std::io::Error::other("the folder is not where it was"));
                }
            }
        }
        for _ in 0..8 {
            let name = format!(".llembas-{}.part", crate::random::hex(8));
            let c = c_name(Some(std::ffi::OsStr::new(&name)))?;
            // Made new, in the open folder, never through a link and never over anything.
            let fd = unsafe {
                libc::openat(
                    folder.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o666 as libc::c_uint,
                )
            };
            if fd >= 0 {
                return Ok(Fresh {
                    at: dir.join(name),
                    file: unsafe { fs::File::from_raw_fd(fd) },
                    settled: false,
                    held: Some((folder, c)),
                });
            }
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e);
            }
        }
        Err(std::io::Error::other("no free name to write under"))
    }

    #[cfg(not(unix))]
    fn make(dest: &Path, _checked: bool) -> std::io::Result<Fresh> {
        let dir = dest
            .parent()
            .ok_or_else(|| std::io::Error::other("no folder to write in"))?;
        for _ in 0..8 {
            let at = dir.join(format!(".llembas-{}.part", crate::random::hex(8)));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&at)
            {
                Ok(file) => {
                    return Ok(Fresh {
                        at,
                        file,
                        settled: false,
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other("no free name to write under"))
    }

    pub fn path(&self) -> &Path {
        &self.at
    }

    pub fn file(&mut self) -> &mut fs::File {
        &mut self.file
    }

    /// Whole: on the disk, then called `dest` in one step, in place of whatever was called that
    /// (a link there is replaced, not followed; another name of the same file is left as it was).
    pub fn replace(mut self, dest: &Path) -> std::io::Result<()> {
        self.file.sync_all()?;
        #[cfg(unix)]
        if let Some((folder, part)) = &self.held {
            use std::os::fd::AsRawFd;
            let to = c_name(dest.file_name())?;
            let fd = folder.as_raw_fd();
            if unsafe { libc::renameat(fd, part.as_ptr(), fd, to.as_ptr()) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            self.settled = true;
            return Ok(());
        }
        fs::rename(&self.at, dest)?;
        self.settled = true;
        Ok(())
    }

    /// Whole: on the disk, then called `dest`, which nothing may be called yet -- something that
    /// took the name meanwhile is left alone, and this is the error.
    pub fn settle_new(mut self, dest: &Path) -> std::io::Result<()> {
        self.file.sync_all()?;
        #[cfg(unix)]
        if let Some((folder, part)) = &self.held {
            use std::os::fd::AsRawFd;
            let to = c_name(dest.file_name())?;
            let fd = folder.as_raw_fd();
            // A second name for it, which fails where the name is taken; the name it was
            // written under goes when this is dropped.
            if unsafe { libc::linkat(fd, part.as_ptr(), fd, to.as_ptr(), 0) } == 0 {
                return Ok(());
            }
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(e);
            }
            // A disk that has no second names: looked at, then renamed, inside the open folder.
            let mut seen: libc::stat = unsafe { std::mem::zeroed() };
            let there =
                unsafe { libc::fstatat(fd, to.as_ptr(), &mut seen, libc::AT_SYMLINK_NOFOLLOW) }
                    == 0;
            if there {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "there is already something called that",
                ));
            }
            if unsafe { libc::renameat(fd, part.as_ptr(), fd, to.as_ptr()) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            self.settled = true;
            return Ok(());
        }
        match fs::hard_link(&self.at, dest) {
            // The name it was written under goes when this is dropped.
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e),
            // A disk that has no second names: looked at, then renamed.
            Err(_) if taken(dest) => Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "there is already something called that",
            )),
            Err(_) => {
                fs::rename(&self.at, dest)?;
                self.settled = true;
                Ok(())
            }
        }
    }
}

impl Drop for Fresh {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        #[cfg(unix)]
        if let Some((folder, part)) = &self.held {
            use std::os::fd::AsRawFd;
            unsafe { libc::unlinkat(folder.as_raw_fd(), part.as_ptr(), 0) };
            return;
        }
        let _ = fs::remove_file(&self.at);
    }
}

/// Whether a name is one this app writes a file under before it is whole (`Fresh`).
pub fn is_part(name: &str) -> bool {
    name.strip_prefix(".llembas-")
        .and_then(|rest| rest.strip_suffix(".part"))
        .is_some_and(|hex| hex.len() == 16 && hex.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Remove what a transfer left half-written in the agent's folders when the app went away
/// under it (it was killed; the power went): ordinary files with exactly the name this app
/// writes under, and nothing else -- and only ones nothing has written to for `idle` (one that
/// is being written right now is somebody's transfer). Run once after the app has started.
/// Links are not followed; at most `most` entries are looked at. How many were removed.
pub fn sweep_parts(roots: &[String], most: usize, idle: std::time::Duration) -> usize {
    let mut removed = 0;
    let mut seen = 0;
    let mut stack: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > most {
                return removed;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file()
                && entry.file_name().to_str().is_some_and(is_part)
                && entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|at| at.elapsed().ok())
                    .is_some_and(|age| age >= idle)
                && fs::remove_file(entry.path()).is_ok()
            {
                removed += 1;
            }
        }
    }
    removed
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
    if from == base {
        return Err("The folder itself cannot be renamed from here.".into());
    }
    may_move(kept, &from)?;
    may_write(kept, &to)?;
    if taken(&to) {
        return Err(format!("There is already something called {name} here."));
    }
    fs::rename(&from, &to).map_err(|e| format!("{path}: {e}"))?;
    Ok(relative(&base, &to))
}

/// What a copy left out, for the person to be told.
#[derive(Debug, Default, PartialEq)]
struct LeftOut {
    /// The CLI's own files and folders.
    own: usize,
    /// What is neither a file, a folder nor a link: a pipe, a socket, a device.
    special: usize,
}

impl LeftOut {
    fn note(&self) -> Option<String> {
        let mut parts = Vec::new();
        if self.own > 0 {
            parts.push(format!("the LLeMbas CLI's own files ({})", self.own));
        }
        if self.special > 0 {
            parts.push(format!("what is not a file or a folder ({})", self.special));
        }
        (!parts.is_empty()).then(|| format!("Left out of the copy: {}.", parts.join("; ")))
    }
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

#[cfg(not(unix))]
fn copy_link(_from: &Path, _to: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("a link is not copied on this system"))
}

/// One copy of a file, a link (as the link it is) or a whole folder, as it goes.
struct Copying<'a> {
    kept: &'a [PathBuf],
    /// Where the thing copied really is: nothing from outside it is read into the copy.
    inside: &'a Path,
    /// A move to another disk: all of it, or none -- nothing is left out and then deleted.
    whole: bool,
    /// What may still be copied: a folder too large is stopped, not half-finished silently.
    left: usize,
    /// Everything this copy made, in the order it made it, and whether it is a folder.
    made: Vec<(PathBuf, bool)>,
    out: LeftOut,
}

impl Copying<'_> {
    fn changed() -> std::io::Error {
        std::io::Error::other("it changed while it was being copied")
    }

    /// One thing is left out of the copy -- which a move cannot do.
    fn leave_out(&mut self, own: bool) -> std::io::Result<()> {
        if self.whole {
            return Err(std::io::Error::other(
                "it holds something that cannot be copied to another disk",
            ));
        }
        if own {
            self.out.own += 1;
        } else {
            self.out.special += 1;
        }
        Ok(())
    }

    fn copy(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
        if self.left == 0 {
            return Err(std::io::Error::other("too many files to copy at once"));
        }
        self.left -= 1;
        let kind = fs::symlink_metadata(from)?.file_type();
        if kind.is_symlink() {
            copy_link(from, to)?;
            self.made.push((to.to_path_buf(), false));
            return Ok(());
        }
        if kind.is_dir() {
            // Still the folder it was: one swapped for a link since is not walked.
            if !fs::canonicalize(from)?.starts_with(self.inside) {
                return Err(Self::changed());
            }
            fs::create_dir(to)?;
            self.made.push((to.to_path_buf(), true));
            for item in fs::read_dir(from)? {
                let item = item?;
                let (name, child) = (item.file_name(), item.path());
                if own_name(&name) || self.kept.iter().any(|k| within(&child, k)) {
                    self.leave_out(true)?;
                    continue;
                }
                self.copy(&child, &to.join(&name))?;
            }
            return Ok(());
        }
        if !kind.is_file() {
            // A pipe would be read for ever, a device is not a file's worth of bytes.
            return self.leave_out(false);
        }
        // Read from the handle, which is checked: never through a link put there since the
        // look above, and only when what was opened is an ordinary file inside what is copied.
        let (mut source, meta) = open_regular(from, false)?;
        if really_at(&source).is_some_and(|real| !real.starts_with(self.inside)) {
            return Err(Self::changed());
        }
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)?;
        self.made.push((to.to_path_buf(), false));
        std::io::copy(&mut source, &mut target)?;
        target.set_permissions(meta.permissions())
    }

    /// Remove what this copy made, newest first, and nothing else: a folder something else has
    /// put a file in meanwhile stays, with that file.
    fn undo(&self) {
        for (at, dir) in self.made.iter().rev() {
            let _ = if *dir {
                fs::remove_dir(at)
            } else {
                fs::remove_file(at)
            };
        }
    }
}

/// Copy the thing at `from` (really at `real`) to `to`, which nothing may be called yet. What
/// was left out; on a failure everything this copy made is removed again, and only that.
fn copy_whole(
    kept: &[PathBuf],
    from: &Path,
    real: &Path,
    to: &Path,
    whole: bool,
) -> Result<LeftOut, String> {
    let mut copying = Copying {
        kept,
        inside: real,
        whole,
        left: MAX_COPIED,
        made: Vec::new(),
        out: LeftOut::default(),
    };
    match copying.copy(from, to) {
        // The thing itself was left out: nothing was copied, and that is not a copy.
        Ok(()) if copying.made.is_empty() => Err("it is not a file or a folder".into()),
        Ok(()) => Ok(copying.out),
        Err(e) => {
            copying.undo();
            Err(e.to_string())
        }
    }
}

fn remove_tree(at: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(at)?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(at)
    } else {
        fs::remove_file(at)
    }
}

/// Where a thing is now, and what the person should be told of how it got there.
type Done = (String, Option<String>);

fn outcome(path: &str, done: Result<Done, String>) -> Outcome {
    match done {
        Ok((to, note)) => Outcome {
            path: path.to_string(),
            ok: true,
            to: Some(to),
            error: None,
            note,
        },
        Err(error) => Outcome {
            path: path.to_string(),
            ok: false,
            to: None,
            error: Some(error),
            note: None,
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
    let one = |path: &str| -> Result<Done, String> {
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
            if is_own(kept, &from) {
                return Err(format!(
                    "{} belongs to the LLeMbas CLI: the app reads it and never copies it.",
                    from.display()
                ));
            }
            let target = dest.join(free_name(&dest, &name));
            may_write(kept, &target)?;
            let out = copy_whole(kept, &from, &real, &target, false)
                .map_err(|e| format!("{path}: {e}"))?;
            return Ok((relative(&base, &target), out.note()));
        }
        may_move(kept, &from)?;
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
            // Another disk: copied across -- all of it, or the move is not made -- and the
            // original removed once the copy is whole.
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                copy_whole(kept, &from, &real, &target, true)
                    .map_err(|e| format!("{path}: {e}"))?;
                remove_tree(&from).map_err(|e| format!("{path}: {e}"))?;
            }
            Err(e) => return Err(format!("{path}: {e}")),
        }
        Ok((relative(&base, &target), None))
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
    let one = |path: &str| -> Result<Done, String> {
        let (base, _, at) = entry(roots, root, path)?;
        if at == base {
            return Err("The folder itself cannot be deleted from here.".into());
        }
        may_move(kept, &at)?;
        trash(&at)?;
        Ok((String::new(), None))
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
/// when the file holds something else by now, a 409 and nothing is written, unless `force`; a
/// save that does not say what it started from is not made either. The text is written to a new
/// file beside it, which then takes its name in one step: a save that breaks off leaves the file
/// as it was, and another name of the same file (a hard link) keeps what it had.
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
    let meta = fs::metadata(&file).map_err(|e| refused(format!("{path}: {e}")))?;
    if !meta.is_file() {
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
        let now = fs::read(&file).map_err(|e| refused(format!("{path}: {e}")))?;
        if base != Some(crate::python::sha256_hex(&now).as_str()) {
            return Err(ApiError::new(
                409,
                "This file changed since you opened it. Reload it, or save anyway.",
            ));
        }
    }
    let failed = |e: std::io::Error| refused(format!("{path}: {e}"));
    let mut fresh = Fresh::within(&file).map_err(failed)?;
    may_write(kept, fresh.path()).map_err(refused)?;
    fresh.file().write_all(text.as_bytes()).map_err(failed)?;
    // It stays as readable, writable and runnable as it was.
    fresh
        .file()
        .set_permissions(meta.permissions())
        .map_err(failed)?;
    fresh.replace(&file).map_err(failed)?;
    read_as(roots, kept, root, path).map_err(refused)
}

/// Put a whole new file into `dir`: `bytes` under `name` (as `plain_name` has it, trimmed), in
/// one step -- written beside its place under a name of its own, then called what it should be,
/// so nothing half-written and nothing empty is ever left under that name. `free`: a taken name
/// gets a number (files dropped in from outside); otherwise a taken name is the refusal (a file
/// that must have exactly this name). Never over anything, never among the CLI's own files, and
/// only inside the agent's folders. Its path, from the folder the page named.
pub fn bring_in(
    roots: &[String],
    kept: &[PathBuf],
    root: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
    free: bool,
) -> Result<String, String> {
    let name = plain_name(name)?;
    let (base, parent) = folder(roots, kept, root, dir)?;
    let at = if free {
        parent.join(free_name(&parent, name))
    } else {
        parent.join(name)
    };
    may_write(kept, &at)?;
    if !free && taken(&at) {
        return Err(format!("There is already something called {name} here."));
    }
    let failed = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::AlreadyExists => {
            format!("There is already something called {name} here.")
        }
        _ => format!("{name}: {e}"),
    };
    let mut fresh = Fresh::within(&at).map_err(failed)?;
    fresh.file().write_all(bytes).map_err(failed)?;
    fresh.settle_new(&at).map_err(failed)?;
    Ok(relative(&base, &at))
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

    /// The names in a folder, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_folder_that_holds_the_clis_files_is_not_renamed_moved_or_deleted() {
        let d = scratch("holds");
        let home = d.join("project");
        fs::create_dir_all(home.join("work/deep/.lembas")).unwrap();
        fs::create_dir_all(home.join("tool/.agent")).unwrap();
        fs::create_dir_all(home.join("plain/inner")).unwrap();
        fs::write(home.join("work/deep/.lembas/config.yaml"), "a: 1\n").unwrap();
        fs::write(home.join("work/notes.md"), "notes\n").unwrap();
        fs::write(home.join("plain/inner/a.txt"), "a").unwrap();
        let r = roots(&d);
        let root = home.to_string_lossy().into_owned();
        let never =
            |_: &Path| -> Result<(), String> { panic!("the CLI's files never reach the trash") };
        // Not the folder with a project in it, however deep the project's own folder lies.
        assert!(rename(&r, &[], &root, "work", "job").is_err());
        assert!(rename(&r, &[], &root, "work/deep", "shallow").is_err());
        assert!(rename(&r, &[], &root, "tool", "tools").is_err());
        let moved = transfer(&r, &[], &root, &all(&["work", "tool"]), "plain", false).unwrap();
        assert!(moved.iter().all(|o| !o.ok));
        assert!(moved[0].error.as_deref().unwrap().contains("LLeMbas CLI"));
        assert!(
            delete(&r, &[], &root, &all(&["work", "work/deep", "tool"]), &never)
                .iter()
                .all(|o| !o.ok)
        );
        assert!(home.join("work/deep/.lembas/config.yaml").is_file());
        // What holds none of them is as free as it was; so is a file beside them.
        assert_eq!(rename(&r, &[], &root, "plain", "simple").unwrap(), "simple");
        assert_eq!(
            rename(&r, &[], &root, "work/notes.md", "plan.md").unwrap(),
            "work/plan.md"
        );
        // A folder too large to look through is left where it is, and says so.
        assert_eq!(holds_own(&home.join("simple"), 100), Ok(false));
        assert!(holds_own(&home.join("simple"), 1).is_err());
        assert_eq!(holds_own(&home.join("work"), 100), Ok(true));
        assert_eq!(holds_own(&home.join("work/plan.md"), 100), Ok(false));
        // A copy leaves the CLI's files out and says so; they are never copied by name either.
        let copied = transfer(&r, &[], &root, &all(&["work"]), "simple", true).unwrap();
        assert!(copied[0].ok);
        assert_eq!(copied[0].to.as_deref(), Some("simple/work"));
        assert!(copied[0].note.as_deref().unwrap().contains("LLeMbas CLI"));
        assert!(home.join("simple/work/plan.md").is_file());
        assert_eq!(names(&home.join("simple/work/deep")), Vec::<String>::new());
        let own = transfer(
            &r,
            &[],
            &root,
            &all(&["work/deep/.lembas", "work/deep/.lembas/config.yaml"]),
            "simple",
            true,
        )
        .unwrap();
        assert!(own.iter().all(|o| !o.ok));
        assert_eq!(names(&home.join("simple")), vec!["inner", "work"]);
        // A plain copy has nothing to say.
        let plain = transfer(&r, &[], &root, &all(&["README.md"]), "simple", true).unwrap();
        assert_eq!(plain[0].note, None);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_clis_names_are_its_own_however_they_are_spelled() {
        let d = scratch("case");
        let home = d.join("project");
        fs::create_dir_all(home.join("work/.LEMBAS")).unwrap();
        fs::create_dir_all(home.join("tool/.Agent")).unwrap();
        fs::create_dir_all(home.join(".config/lembas")).unwrap();
        fs::write(home.join("work/.LEMBAS/config.yaml"), "a: 1\n").unwrap();
        let r = roots(&d);
        let root = home.to_string_lossy().into_owned();
        let kept = kept_dirs(&[home.join(".config/lembas")]);
        assert!(make_dir(&r, &kept, &root, "src", ".Lembas").is_err());
        assert!(make_file(&r, &kept, &root, "src", ".AGENT").is_err());
        assert!(make_file(&r, &kept, &root, "work/.LEMBAS", "x").is_err());
        assert!(write(
            &r,
            &kept,
            &root,
            "work/.LEMBAS/config.yaml",
            "a: 2\n",
            None,
            true
        )
        .is_err());
        assert!(rename(&r, &kept, &root, "README.md", ".lEmBaS").is_err());
        assert!(rename(&r, &kept, &root, "work", "job").is_err());
        assert!(rename(&r, &kept, &root, "tool", "tools").is_err());
        assert!(
            !read_as(&r, &kept, &root, "work/.LEMBAS/config.yaml")
                .unwrap()
                .writable
        );
        // The CLI's directories too: on a disk that folds case another spelling is the same one.
        let real = fs::canonicalize(&home).unwrap();
        assert!(may_write(&kept, &real.join(".Config/Lembas/lembas.json")).is_err());
        assert!(may_write(&kept, &real.join(".CONFIG")).is_err());
        assert!(may_write(&kept, &real.join(".configuration/lembas")).is_ok());
        assert!(within(Path::new("/a/B/c"), Path::new("/A/b")));
        assert!(!within(Path::new("/a"), Path::new("/a/b")));
        assert!(!within(Path::new("/a/bc"), Path::new("/a/b")));
        assert_eq!(
            fs::read_to_string(home.join("work/.LEMBAS/config.yaml")).unwrap(),
            "a: 1\n"
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_save_takes_the_files_name_whole_and_never_writes_through_another_name_of_it() {
        let d = scratch("atomic");
        let r = roots(&d);
        let root = d.join("project").to_string_lossy().into_owned();
        // Another name of a file outside the folder, planted inside it: a hard link.
        fs::hard_link(d.join("outside/secret.txt"), d.join("project/linked.txt")).unwrap();
        let opened = read_as(&r, &[], &root, "linked.txt").unwrap();
        assert_eq!(opened.text.as_deref(), Some("no"));
        let saved = write(
            &r,
            &[],
            &root,
            "linked.txt",
            "mine\n",
            opened.sha.as_deref(),
            false,
        )
        .unwrap();
        assert_eq!(saved.text.as_deref(), Some("mine\n"));
        assert_eq!(
            fs::read_to_string(d.join("project/linked.txt")).unwrap(),
            "mine\n"
        );
        assert_eq!(
            fs::read_to_string(d.join("outside/secret.txt")).unwrap(),
            "no",
            "the other name keeps what it had"
        );
        // A save that does not say what it started from is not made.
        let blind = write(&r, &[], &root, "README.md", "x\n", None, false).unwrap_err();
        assert_eq!(blind.status, 409);
        assert_eq!(
            fs::read_to_string(d.join("project/README.md")).unwrap(),
            "# Waybread\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // As runnable and as private as it was.
            let script = d.join("project/run.sh");
            fs::write(&script, "#!/bin/sh\n").unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o750)).unwrap();
            write(&r, &[], &root, "run.sh", "#!/bin/sh\nexit 0\n", None, true).unwrap();
            assert_eq!(
                fs::metadata(&script).unwrap().permissions().mode() & 0o777,
                0o750
            );
            // Through a link inside the folder, the file it leads to is the one replaced.
            std::os::unix::fs::symlink(d.join("project/README.md"), d.join("project/alias.md"))
                .unwrap();
            write(&r, &[], &root, "alias.md", "# Lembas\n", None, true).unwrap();
            assert!(fs::symlink_metadata(d.join("project/alias.md"))
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                fs::read_to_string(d.join("project/README.md")).unwrap(),
                "# Lembas\n"
            );
        }
        // Nothing it was written under is left beside it.
        assert!(!names(&d.join("project"))
            .iter()
            .any(|n| n.ends_with(".part")));
        // A file being written is new, is never somebody else's, and goes when it is let go.
        let dest = d.join("project/incoming.bin");
        let fresh = Fresh::beside(&dest).unwrap();
        let at = fresh.path().to_path_buf();
        assert!(at.is_file() && at.parent() == dest.parent());
        drop(fresh);
        assert!(!at.exists());
        fs::write(&dest, "taken").unwrap();
        let mut fresh = Fresh::beside(&dest).unwrap();
        fresh.file().write_all(b"new").unwrap();
        assert!(fresh.settle_new(&dest).is_err(), "never over something");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "taken");
        let mut fresh = Fresh::beside(&dest).unwrap();
        fresh.file().write_all(b"new").unwrap();
        fresh
            .settle_new(&d.join("project/incoming (2).bin"))
            .unwrap();
        assert_eq!(
            fs::read_to_string(d.join("project/incoming (2).bin")).unwrap(),
            "new"
        );
        assert!(!names(&d.join("project"))
            .iter()
            .any(|n| n.ends_with(".part")));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_copy_reads_only_ordinary_files_and_removes_only_what_it_made() {
        let d = scratch("copy");
        let r = roots(&d);
        let home = d.join("project");
        let root = home.to_string_lossy().into_owned();
        #[cfg(unix)]
        {
            // A pipe in the tree: opening it to read would wait for ever. It is left out, said.
            let pipe = std::ffi::CString::new(home.join("src/pipe").to_string_lossy().into_owned())
                .unwrap();
            assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
            let copied = transfer(&r, &[], &root, &all(&["src"]), "", true).unwrap();
            assert!(copied[0].ok, "{:?}", copied[0].error);
            assert_eq!(copied[0].to.as_deref(), Some("src (2)"));
            assert!(copied[0]
                .note
                .as_deref()
                .unwrap()
                .contains("not a file or a folder"));
            assert_eq!(names(&home.join("src (2)")), vec!["main.rs"]);
            assert!(open_regular(&home.join("src/pipe"), true).is_err());
            // By itself it is not copied at all, and nothing is said to be there.
            assert!(!transfer(&r, &[], &root, &all(&["src/pipe"]), "", true).unwrap()[0].ok);
            assert!(!home.join("pipe").exists());
            // A link is never read through by its last name.
            std::os::unix::fs::symlink(d.join("outside/secret.txt"), home.join("alias.txt"))
                .unwrap();
            assert!(open_regular(&home.join("alias.txt"), false).is_err());
            assert!(open_regular(&home.join("alias.txt"), true).is_ok());
            fs::remove_file(home.join("src/pipe")).unwrap();
        }
        assert!(open_regular(&home.join("src"), true).is_err());
        let (_, meta) = open_regular(&home.join("README.md"), false).unwrap();
        assert_eq!(meta.len(), 11);
        // The name was free when it was chosen and is not when the copy gets there: what took
        // it is somebody else's, and stays -- whole.
        let real = fs::canonicalize(home.join("src")).unwrap();
        let theirs = home.join("theirs");
        fs::create_dir_all(theirs.join("kept")).unwrap();
        fs::write(theirs.join("kept/word.txt"), "theirs").unwrap();
        assert!(copy_whole(&[], &home.join("src"), &real, &theirs, false).is_err());
        assert_eq!(
            fs::read_to_string(theirs.join("kept/word.txt")).unwrap(),
            "theirs"
        );
        let file = home.join("theirs.txt");
        fs::write(&file, "theirs").unwrap();
        let readme = fs::canonicalize(home.join("README.md")).unwrap();
        assert!(copy_whole(&[], &readme, &readme, &file, false).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
        // A copy that fails part-way takes back what it made, and only that.
        fs::create_dir_all(home.join("big/a")).unwrap();
        fs::write(home.join("big/a/one.txt"), "1").unwrap();
        fs::write(home.join("big/a/two.txt"), "2").unwrap();
        let big = fs::canonicalize(home.join("big")).unwrap();
        let mut copying = Copying {
            kept: &[],
            inside: &big,
            whole: false,
            left: 3,
            made: Vec::new(),
            out: LeftOut::default(),
        };
        let half = home.join("half");
        assert!(copying.copy(&big, &half).is_err(), "too many for this copy");
        assert!(half.join("a").is_dir());
        fs::write(half.join("stranger.txt"), "theirs").unwrap();
        copying.undo();
        assert_eq!(names(&half), vec!["stranger.txt"]);
        // What is copied is read from inside it only: a folder that is somewhere else by now.
        let elsewhere = fs::canonicalize(d.join("outside")).unwrap();
        assert!(copy_whole(&[], &big, &elsewhere, &home.join("big (2)"), false).is_err());
        assert!(!home.join("big (2)").exists());
        // A move to another disk is all of it or not made.
        fs::create_dir_all(home.join("big/.lembas")).unwrap();
        assert!(copy_whole(&[], &big, &big, &home.join("big (3)"), true).is_err());
        assert!(!home.join("big (3)").exists());
        let out = copy_whole(&[], &big, &big, &home.join("big (3)"), false).unwrap();
        assert_eq!(out, LeftOut { own: 1, special: 0 });
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_file_brought_in_is_whole_or_not_there_under_a_plain_name_inside_a_root() {
        let d = scratch("bring");
        let (r, p) = (roots(&d), d.join("project"));
        let root = r[0].clone();
        let none: Vec<PathBuf> = Vec::new();
        // Dropped in: under its own name, trimmed; a taken name gets a number, nothing is written over.
        assert_eq!(
            bring_in(&r, &none, &root, "", " notes.txt ", b"one", true).unwrap(),
            "notes.txt"
        );
        assert_eq!(fs::read(p.join("notes.txt")).unwrap(), b"one");
        assert_eq!(
            bring_in(&r, &none, &root, "", "README.md", b"two", true).unwrap(),
            "README (2).md"
        );
        assert_eq!(
            fs::read_to_string(p.join("README.md")).unwrap(),
            "# Waybread\n"
        );
        assert_eq!(
            bring_in(&r, &none, &root, "src", "lib.rs", b"", true).unwrap(),
            "src/lib.rs"
        );
        // A name that is a path, or no name: refused, and nothing is made anywhere.
        for bad in ["../outside/x.txt", "a/b.txt", "..", "", "a\\b", "a\nb"] {
            assert!(
                bring_in(&r, &none, &root, "", bad, b"x", true).is_err(),
                "{bad:?}"
            );
        }
        assert!(!d.join("outside/x.txt").exists());
        // A folder outside the roots, one that is not there, a file named as the folder: refused.
        assert!(bring_in(&r, &none, &root, "../outside", "x.txt", b"x", true).is_err());
        assert!(bring_in(&r, &none, &root, "nowhere", "x.txt", b"x", true).is_err());
        assert!(bring_in(&r, &none, &root, "README.md", "x.txt", b"x", true).is_err());
        let elsewhere = d.join("outside").to_string_lossy().into_owned();
        assert!(bring_in(&r, &none, &elsewhere, "", "x.txt", b"x", true).is_err());
        assert_eq!(names(&d.join("outside")), vec!["secret.txt"]);
        // Never among the CLI's own files.
        let own = vec![p.join("src")];
        assert!(bring_in(&r, &own, &root, "src", "x.txt", b"x", true).is_err());
        assert!(bring_in(&r, &none, &root, "", ".lembas", b"x", true).is_err());
        // Not numbered (`free` off): the name as it is, trimmed, and a taken one is the refusal.
        assert_eq!(
            bring_in(&r, &none, &root, "", " oven.py ", b"bake()\n", false).unwrap(),
            "oven.py"
        );
        let said = bring_in(&r, &none, &root, "", "oven.py", b"other", false).unwrap_err();
        assert!(said.contains("already something called oven.py"), "{said}");
        assert_eq!(fs::read_to_string(p.join("oven.py")).unwrap(), "bake()\n");
        // Nothing half-written is left under any name.
        assert!(
            names(&p).iter().all(|n| !n.ends_with(".part")),
            "{:?}",
            names(&p)
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn what_is_written_lands_in_the_folder_that_was_opened_whatever_becomes_of_its_path() {
        let d = scratch("swap");
        let p = fs::canonicalize(d.join("project")).unwrap();
        let out = fs::canonicalize(d.join("outside")).unwrap();
        fs::create_dir(p.join("in")).unwrap();
        let dest = p.join("in/loaf.bin");
        let mut fresh = Fresh::within(&dest).unwrap();
        fresh.file().write_all(b"whole").unwrap();
        // The folder is moved away and a link to somewhere else put under its name.
        fs::rename(p.join("in"), p.join("was-in")).unwrap();
        std::os::unix::fs::symlink(&out, p.join("in")).unwrap();
        fresh.settle_new(&dest).unwrap();
        assert_eq!(fs::read(p.join("was-in/loaf.bin")).unwrap(), b"whole");
        assert_eq!(
            names(&out),
            vec!["secret.txt"],
            "nothing was written where the link leads"
        );
        assert_eq!(
            names(&p.join("was-in")),
            vec!["loaf.bin"],
            "and nothing is left of the name it was written under"
        );
        // Let go before it is whole: its own name goes from the folder it was made in.
        let fresh = Fresh::within(&p.join("was-in/other.bin")).unwrap();
        drop(fresh);
        assert_eq!(names(&p.join("was-in")), vec!["loaf.bin"]);
        // A folder reached through a link is not the folder that was checked (where the system can say).
        if cfg!(target_os = "linux") {
            assert!(Fresh::within(&p.join("in/x.bin")).is_err());
            assert_eq!(names(&out), vec!["secret.txt"]);
        }
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_this_apps_own_half_written_files_are_swept() {
        let d = scratch("sweep");
        let p = d.join("project");
        let part = ".llembas-0123456789abcdef.part";
        fs::write(p.join(part), "half").unwrap();
        fs::write(p.join("src").join(".llembas-fedcba9876543210.part"), "half").unwrap();
        // What only looks like one stays: another length, other letters, a folder of that name, a file outside the roots.
        for keep in [
            ".llembas-0123.part",
            ".llembas-0123456789abcdeg.part",
            "x.llembas-0123456789abcdef.part",
            ".llembas-0123456789abcdef.part.txt",
        ] {
            fs::write(p.join(keep), "mine").unwrap();
            assert!(!is_part(keep), "{keep}");
        }
        fs::create_dir(p.join(".llembas-00000000000000aa.part")).unwrap();
        fs::write(d.join("outside").join(part), "theirs").unwrap();
        assert!(is_part(part));
        // One written to a moment ago is a transfer under way: left alone.
        let hour = std::time::Duration::from_secs(3600);
        assert_eq!(sweep_parts(&roots(&d), 10_000, hour), 0);
        assert!(p.join(part).exists());
        assert_eq!(
            sweep_parts(&roots(&d), 10_000, std::time::Duration::ZERO),
            2
        );
        assert!(!p.join(part).exists() && !p.join("src/.llembas-fedcba9876543210.part").exists());
        assert!(
            p.join(".llembas-0123.part").exists()
                && p.join(".llembas-00000000000000aa.part").is_dir()
        );
        assert!(d.join("outside").join(part).exists());
        assert_eq!(
            fs::read_to_string(p.join("README.md")).unwrap(),
            "# Waybread\n"
        );
        // Bounded: no more is looked at than asked.
        fs::write(p.join(part), "half").unwrap();
        assert_eq!(sweep_parts(&roots(&d), 0, std::time::Duration::ZERO), 0);
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
