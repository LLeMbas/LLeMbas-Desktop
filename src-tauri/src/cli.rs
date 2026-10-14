//! The LLeMbas CLI this app carries, and what it keeps on disk. The app never writes the CLI's
//! files: it runs `lembas login --json` and `lembas service run`, and reads two files to know
//! where things stand — the logins (`lembas.json`) and the service's lock (`service.lock`).
//!
//! The directories are the CLI's own (XDG, `lembas` inside each), so the app and a `lembas`
//! installed by hand on the same computer are one device to the server, not two.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static BUNDLED: OnceLock<PathBuf> = OnceLock::new();

/// Where the bundle put the CLI: the app's resource directory (`/usr/lib/llembas-desktop/` from
/// the .deb, inside the AppImage otherwise) — the app's own copy, never on PATH, so it neither
/// shadows nor is shadowed by a `lembas` installed by hand. Set once at start.
pub fn set_bundled(resource_dir: &Path) {
    let _ = BUNDLED.set(resource_dir.join(exe_name()));
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "lembas.exe"
    } else {
        "lembas"
    }
}

/// The CLI to run: `LLEMBAS_DESKTOP_CLI` (development), else the bundled one, else one beside
/// the app's executable (`cargo tauri dev`).
pub fn binary() -> PathBuf {
    if let Some(p) = std::env::var_os("LLEMBAS_DESKTOP_CLI") {
        return PathBuf::from(p);
    }
    if let Some(p) = BUNDLED.get().filter(|p| p.exists()) {
        return p.clone();
    }
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(exe_name())))
        .unwrap_or_else(|| PathBuf::from(exe_name()))
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// `$XDG_X_HOME/lembas`, or `~/<fallback>/lembas`: the CLI's `paths` (a relative XDG value
/// is ignored, as the spec says). `LEMBAS_HOME` roots all three, as it does for the CLI.
fn dir(var: &str, fallback: &str) -> PathBuf {
    if let Some(root) = std::env::var_os("LEMBAS_HOME") {
        let last = fallback.rsplit('/').next().unwrap_or(fallback);
        return PathBuf::from(root).join(last).join("lembas");
    }
    match std::env::var_os(var).map(PathBuf::from) {
        Some(p) if p.is_absolute() => p.join("lembas"),
        _ => home().join(fallback).join("lembas"),
    }
}

pub fn config_dir() -> PathBuf {
    dir("XDG_CONFIG_HOME", ".config")
}

pub fn state_dir() -> PathBuf {
    dir("XDG_STATE_HOME", ".local/state")
}

/// Whether this computer is signed in to `server` (a base from `settings::normalise`).
pub fn linked_to(server: &str) -> bool {
    linked_in(&config_dir(), server)
}

fn linked_in(config: &Path, server: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(config.join("lembas.json")) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let want = server.trim_end_matches('/');
    v.get("instances")
        .and_then(|i| i.as_object())
        .map(|all| {
            all.values().any(|i| {
                i.get("base_url")
                    .and_then(|b| b.as_str())
                    .is_some_and(|b| b.trim_end_matches('/') == want)
            })
        })
        .unwrap_or(false)
}

/// The pid of a `lembas service run` already going on this computer (installed as a service,
/// or started by hand), if any: then the app does not start another — one link per device.
pub fn running_service() -> Option<u32> {
    running_in(&state_dir())
}

fn running_in(state: &Path) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(state.join("service.lock"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    (pid != 0 && alive(pid)).then_some(pid)
}

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    // Signal 0 checks without sending; EPERM means it exists but is someone else's.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llembas-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn linked_reads_the_logins_the_cli_wrote() {
        let d = scratch("linked");
        assert!(!linked_in(&d, "https://ai.example"));
        fs::write(
            d.join("lembas.json"),
            r#"{"instances":{"example":{"base_url":"https://ai.example","connection":"example"}}}"#,
        )
        .unwrap();
        assert!(linked_in(&d, "https://ai.example"));
        assert!(linked_in(&d, "https://ai.example/"));
        assert!(!linked_in(&d, "https://other.example"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_counts_only_while_its_process_lives() {
        let d = scratch("lock");
        assert_eq!(running_in(&d), None);
        fs::write(d.join("service.lock"), std::process::id().to_string()).unwrap();
        assert_eq!(running_in(&d), Some(std::process::id()));
        // A pid far above any pid_max: no such process.
        fs::write(d.join("service.lock"), "2147483000").unwrap();
        assert_eq!(running_in(&d), None);
        fs::remove_dir_all(&d).unwrap();
    }
}
