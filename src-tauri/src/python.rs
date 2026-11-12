//! The `python` tool's runner: Pyodide (CPython in WebAssembly) in a frame of its own.
//!
//! On the server a chat's `python` call runs in the page of that chat. The app's window is such
//! a page for the chat it shows: it says so to the server and takes the calls (`ui/js/python.js`,
//! through the app's door like every other request). What runs them is here:
//!
//! - **The files are the server's, fetched and checked by the app.** `GET /me` names the pinned
//!   Pyodide release -- its version and, for each file, its size and SHA-256 (`python`). The app
//!   reads that itself, downloads each file through its own door
//!   (`/api/v2/pyodide/{version}/{name}`) into its data directory, and keeps one only when its
//!   size and hash are the ones named; a file already there is checked the same way before it is
//!   used again. The webview never fetches them from the network.
//! - **They are served on a scheme of their own** (`llembas-python://`), with the three files of
//!   the runner itself (`src-tauri/python/`, compiled in). A hidden frame of the app's page loads
//!   `runner.html` from there. It is not the app's origin: the capability names only the app's
//!   own page, so nothing in the frame -- and no Python a model wrote -- can call the app.
//! - **Under a policy of its own** (`POLICY`): scripts, workers and requests from this scheme
//!   only, WebAssembly allowed to compile (`'wasm-unsafe-eval'`), nothing else from anywhere.
//!   Code run there has the files the call handed it and no network.
//!
//! The app's own page gains one thing in its policy (`tauri.conf.json`): this scheme under
//! `frame-src`, so it may hold the frame. It gains no `'wasm-unsafe-eval'` and no worker source.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

pub const SCHEME: &str = "llembas-python";

/// The policy every response of the scheme carries (a worker takes its own from its script's).
pub const POLICY: &str = "default-src 'none'; script-src 'self' llembas-python: http://llembas-python.localhost 'wasm-unsafe-eval'; worker-src 'self' llembas-python: http://llembas-python.localhost; connect-src 'self' llembas-python: http://llembas-python.localhost; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const RUNNER_HTML: &str = include_str!("../python/runner.html");
const RUNNER_JS: &str = include_str!("../python/runner.js");
const WORKER_JS: &str = include_str!("../python/worker.js");

/// The most one file of a release may be, and the most files: Pyodide's largest is under 10 MB
/// and there are five. A server that names more is not believed.
pub const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 16;

/// One file of the release, as the server's lock names it.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

/// A plain file name: letters, digits, `.`, `-` and `_`, not starting with a dot.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A release's version, as a directory name: the same letters, and no `..` in it.
pub fn version_ok(version: &str) -> bool {
    name_ok(version) && !version.contains("..")
}

/// What `GET /me` says of Python (`python`): the version and its files, `None` where it is not
/// switched on, an error where what it names cannot be a release.
pub fn specs(python: &Value) -> Result<Option<(String, Vec<Spec>)>, String> {
    if python.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let bad = || "The server's Python files could not be read.".to_string();
    let version = python
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !version_ok(&version) {
        return Err(bad());
    }
    let files = python
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(bad)?;
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(bad());
    }
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let name = file.get("name").and_then(Value::as_str).unwrap_or("");
        let sha256 = file
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let size = file.get("size").and_then(Value::as_u64).unwrap_or(0);
        let hash_ok = sha256.len() == 64 && sha256.chars().all(|c| c.is_ascii_hexdigit());
        if !name_ok(name) || !hash_ok || size == 0 || size > MAX_FILE {
            return Err(bad());
        }
        if out.iter().any(|s: &Spec| s.name == name) {
            return Err(bad());
        }
        out.push(Spec {
            name: name.to_string(),
            sha256,
            size,
        });
    }
    // The entry the worker imports: without it there is nothing to run.
    if !out.iter().any(|s| s.name == "pyodide.mjs") {
        return Err(bad());
    }
    Ok(Some((version, out)))
}

/// SHA-256 of `bytes`, as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(bytes) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Whether `bytes` are the file the lock names: its size and its hash.
pub fn matches(bytes: &[u8], spec: &Spec) -> bool {
    bytes.len() as u64 == spec.size && sha256_hex(bytes) == spec.sha256
}

/// Whether the file on disk is the one the lock names.
fn kept(path: &Path, spec: &Spec) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.len() == spec.size => {
            fs::read(path).is_ok_and(|bytes| matches(&bytes, spec))
        }
        _ => false,
    }
}

/// Make `root/<version>/` hold every file of the release, verified: one already there and
/// intact is kept; any other is fetched with `fetch(name)`, checked, and only then put in place
/// (written beside it first, so a refused or half-written file is never what is served). Other
/// versions' directories go once this one is whole. The directory, or why not.
pub fn prepare(
    root: &Path,
    version: &str,
    specs: &[Spec],
    fetch: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<PathBuf, String> {
    if !version_ok(version) || specs.iter().any(|s| !name_ok(&s.name)) {
        return Err("The server's Python files could not be read.".to_string());
    }
    let dir = root.join(version);
    let io = |e: std::io::Error| format!("Python's files could not be kept: {e}");
    fs::create_dir_all(&dir).map_err(io)?;
    for spec in specs {
        let path = dir.join(&spec.name);
        if kept(&path, spec) {
            continue;
        }
        let bytes = fetch(&spec.name)?;
        if !matches(&bytes, spec) {
            return Err(format!(
                "{} is not the file the server's list names: it was not kept.",
                spec.name
            ));
        }
        let part = dir.join(format!(".{}.part", spec.name));
        fs::write(&part, &bytes).map_err(io)?;
        fs::rename(&part, &path).map_err(io)?;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path() != dir && entry.path().is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(dir)
}

/// The release the scheme serves: set once `prepare` has verified it, and nothing before.
#[derive(Default)]
pub struct Runtime {
    ready: Mutex<Option<(String, PathBuf, Vec<String>)>>,
}

impl Runtime {
    pub fn set(&self, version: &str, dir: PathBuf, names: Vec<String>) {
        *self.ready.lock().unwrap() = Some((version.to_string(), dir, names));
    }

    pub fn clear(&self) {
        *self.ready.lock().unwrap() = None;
    }

    /// One file of the verified release: that version, a name its list has, and nothing else.
    pub fn file(&self, version: &str, name: &str) -> Option<Vec<u8>> {
        let ready = self.ready.lock().unwrap();
        let (v, dir, names) = ready.as_ref()?;
        if v != version || !names.iter().any(|n| n == name) {
            return None;
        }
        fs::read(dir.join(name)).ok()
    }
}

/// Where the runner's page is: the address form differs by platform, as Tauri's own does.
pub fn url(version: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/runner.html?v={version}")
    } else {
        format!("{SCHEME}://localhost/runner.html?v={version}")
    }
}

/// What a file is, said explicitly: a module must be JavaScript for the webview to import it,
/// and WebAssembly `application/wasm` to be compiled as it streams.
fn media_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// The response for a request to the scheme: the runner's own three files, or
/// `/pyodide/<version>/<name>` from the verified release. Anything else is not there.
pub fn respond(runtime: &Runtime, path: &str) -> tauri::http::Response<Vec<u8>> {
    let path = path.trim_start_matches('/');
    let found: Option<(&str, Vec<u8>)> = match path {
        "runner.html" => Some((path, RUNNER_HTML.as_bytes().to_vec())),
        "runner.js" => Some((path, RUNNER_JS.as_bytes().to_vec())),
        "worker.js" => Some((path, WORKER_JS.as_bytes().to_vec())),
        other => other
            .strip_prefix("pyodide/")
            .and_then(|rest| rest.split_once('/'))
            .filter(|(version, name)| version_ok(version) && name_ok(name))
            .and_then(|(version, name)| runtime.file(version, name).map(|bytes| (name, bytes))),
    };
    let builder = tauri::http::Response::builder()
        .header("Content-Security-Policy", POLICY)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "no-store");
    let built = match found {
        Some((name, bytes)) => builder
            .status(200)
            .header("Content-Type", media_type(name))
            .body(bytes),
        None => builder
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(Vec::new()),
    };
    built.unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    // SHA-256 of "abc" and of the empty string (FIPS 180-2's own examples).
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn spec(name: &str, bytes: &[u8]) -> Spec {
        Spec {
            name: name.to_string(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
        }
    }

    /// A directory of this test's own under the system's temporary one, empty.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "llembas-desktop-python-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_hash_is_sha_256_in_lowercase_hex() {
        assert_eq!(sha256_hex(b"abc"), ABC);
        assert_eq!(sha256_hex(b""), EMPTY);
        let s = spec("a.txt", b"abc");
        assert!(matches(b"abc", &s));
        assert!(!matches(b"abd", &s), "another file of the same size");
        assert!(!matches(b"abcd", &s), "another size");
    }

    #[test]
    fn what_the_server_names_must_be_a_release() {
        let file = |name: &str| json!({ "name": name, "sha256": ABC, "size": 3 });
        let said = |files: Value| json!({ "enabled": true, "version": "314.0.7", "files": files });
        // Off, or silent: nothing to fetch.
        assert_eq!(specs(&json!({ "enabled": false })), Ok(None));
        assert_eq!(specs(&Value::Null), Ok(None));
        let ok = specs(&said(json!([
            file("pyodide.mjs"),
            file("pyodide.asm.wasm")
        ])))
        .unwrap()
        .unwrap();
        assert_eq!(ok.0, "314.0.7");
        assert_eq!(ok.1.len(), 2);
        assert_eq!(ok.1[1].name, "pyodide.asm.wasm");
        assert_eq!(ok.1[1].size, 3);
        // A hash in capitals is the same hash.
        let upper = json!([{ "name": "pyodide.mjs", "sha256": ABC.to_uppercase(), "size": 3 }]);
        assert_eq!(specs(&said(upper)).unwrap().unwrap().1[0].sha256, ABC);
        // Not a release: a name that is a path, no entry, a hash that is not one, no size, the
        // same name twice, too many files, a version that is a path.
        for bad in [
            json!([file("../pyodide.mjs")]),
            json!([file("a/b.mjs"), file("pyodide.mjs")]),
            json!([file(".hidden"), file("pyodide.mjs")]),
            json!([file("pyodide.asm.wasm")]),
            json!([{ "name": "pyodide.mjs", "sha256": "abc", "size": 3 }]),
            json!([{ "name": "pyodide.mjs", "sha256": ABC, "size": 0 }]),
            json!([{ "name": "pyodide.mjs", "sha256": ABC, "size": MAX_FILE + 1 }]),
            json!([file("pyodide.mjs"), file("pyodide.mjs")]),
            json!([]),
            json!((0..17)
                .map(|i| file(&format!("f{i}.mjs")))
                .collect::<Vec<_>>()),
        ] {
            assert!(specs(&said(bad.clone())).is_err(), "{bad}");
        }
        for version in ["", "..", "../x", "a/b", ".1", "1 2"] {
            let v = json!({ "enabled": true, "version": version, "files": [file("pyodide.mjs")] });
            assert!(specs(&v).is_err(), "{version:?}");
        }
    }

    #[test]
    fn only_a_file_that_verifies_is_kept_and_one_kept_is_not_fetched_again() {
        let root = scratch("prepare");
        let specs = vec![spec("pyodide.mjs", b"export {}"), spec("lib.zip", b"PK")];
        let asked: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let good = |name: &str| -> Result<Vec<u8>, String> {
            asked.borrow_mut().push(name.to_string());
            Ok(match name {
                "pyodide.mjs" => b"export {}".to_vec(),
                _ => b"PK".to_vec(),
            })
        };
        let dir = prepare(&root, "1.0.0", &specs, &good).unwrap();
        assert_eq!(dir, root.join("1.0.0"));
        assert_eq!(fs::read(dir.join("lib.zip")).unwrap(), b"PK");
        assert_eq!(*asked.borrow(), ["pyodide.mjs", "lib.zip"]);
        // Again: both are there and intact, nothing is asked for.
        prepare(&root, "1.0.0", &specs, &good).unwrap();
        assert_eq!(asked.borrow().len(), 2);
        // One was changed on disk: that one alone is fetched again, and put right.
        fs::write(dir.join("lib.zip"), b"XX").unwrap();
        prepare(&root, "1.0.0", &specs, &good).unwrap();
        assert_eq!(asked.borrow().len(), 3);
        assert_eq!(fs::read(dir.join("lib.zip")).unwrap(), b"PK");
        // What comes back is not the file named: refused, and nothing of it is left behind.
        fs::remove_file(dir.join("lib.zip")).unwrap();
        let wrong = |_: &str| -> Result<Vec<u8>, String> { Ok(b"EVIL".to_vec()) };
        let refused = prepare(&root, "1.0.0", &specs, &wrong).unwrap_err();
        assert!(refused.contains("lib.zip"), "{refused}");
        assert!(!dir.join("lib.zip").exists());
        assert!(!dir.join(".lib.zip.part").exists());
        // The server could not be reached: its words.
        let down = |_: &str| -> Result<Vec<u8>, String> { Err("Could not reach".to_string()) };
        assert_eq!(
            prepare(&root, "1.0.0", &specs, &down).unwrap_err(),
            "Could not reach"
        );
        // A newer release whole: the older one's directory goes.
        prepare(&root, "2.0.0", &specs, &good).unwrap();
        assert!(root.join("2.0.0").join("pyodide.mjs").exists());
        assert!(!root.join("1.0.0").exists());
        // A version or a name that is a path never reaches the disk.
        assert!(prepare(&root, "../up", &specs, &good).is_err());
        let sly = vec![spec("../x", b"PK")];
        assert!(prepare(&root, "3.0.0", &sly, &good).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_scheme_serves_the_runner_and_the_verified_release_only_under_its_policy() {
        let root = scratch("serve");
        let specs = vec![spec("pyodide.mjs", b"export {}"), spec("a.wasm", b"\0asm")];
        let fetch = |name: &str| -> Result<Vec<u8>, String> {
            Ok(if name == "a.wasm" {
                b"\0asm".to_vec()
            } else {
                b"export {}".to_vec()
            })
        };
        let rt = Runtime::default();
        // Before anything is verified only the runner's own files are there.
        assert_eq!(respond(&rt, "/pyodide/1.0.0/pyodide.mjs").status(), 404);
        let page = respond(&rt, "/runner.html");
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()["Content-Type"], "text/html; charset=utf-8");
        let csp = page.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.starts_with("default-src 'none'"));
        assert!(csp.contains("'wasm-unsafe-eval'"));
        assert!(!csp.contains("'unsafe-eval'") && !csp.contains("'unsafe-inline'"));
        assert!(!csp.contains("http:") || csp.contains("http://llembas-python.localhost"));
        assert!(!csp.contains("https:") && !csp.contains('*'));
        for js in ["/runner.js", "/worker.js"] {
            let res = respond(&rt, js);
            assert_eq!(res.status(), 200, "{js}");
            assert_eq!(
                res.headers()["Content-Type"],
                "text/javascript; charset=utf-8"
            );
            assert_eq!(res.headers()["Content-Security-Policy"], POLICY, "{js}");
            assert!(!res.body().is_empty());
        }
        let dir = prepare(&root, "1.0.0", &specs, &fetch).unwrap();
        rt.set(
            "1.0.0",
            dir.clone(),
            vec!["pyodide.mjs".into(), "a.wasm".into()],
        );
        let wasm = respond(&rt, "/pyodide/1.0.0/a.wasm");
        assert_eq!(wasm.status(), 200);
        assert_eq!(wasm.headers()["Content-Type"], "application/wasm");
        assert_eq!(wasm.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(wasm.body().as_slice(), b"\0asm");
        // Another version, a name the list lacks (though the file is in the directory), a path.
        fs::write(dir.join("extra.js"), b"x").unwrap();
        for no in [
            "/pyodide/2.0.0/a.wasm",
            "/pyodide/1.0.0/extra.js",
            "/pyodide/1.0.0/../1.0.0/a.wasm",
            "/pyodide/1.0.0/",
            "/pyodide/a.wasm",
            "/index.html",
            "/",
        ] {
            assert_eq!(respond(&rt, no).status(), 404, "{no}");
        }
        rt.clear();
        assert_eq!(respond(&rt, "/pyodide/1.0.0/a.wasm").status(), 404);
        assert!(url("1.0.0").ends_with("/runner.html?v=1.0.0"));
        let _ = fs::remove_dir_all(&root);
    }
}
