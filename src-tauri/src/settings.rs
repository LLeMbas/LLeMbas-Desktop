//! What the app remembers: which server it talks to, whether the agent should run, the theme and
//! whether to notify. One small JSON file in the app's config directory; nothing secret is in it
//! (the app's sign-in is `account.json`, readable by this user only; the device's key is the
//! LLeMbas CLI's, in its own config).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// The server's base address, `https://host[:port]`, with no trailing slash.
    pub server: Option<String>,
    /// Run the agent while the app runs (once this computer is linked to the server).
    pub agent: bool,
    /// The account's theme the last time the server said (`moria` or `shire`): what the window
    /// is painted in until it says again. None until it has.
    pub theme: Option<String>,
    /// Say with a notification when a reply or an agent's work finishes out of sight.
    pub notify: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server: None,
            agent: false,
            theme: None,
            notify: true,
        }
    }
}

pub fn file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> Settings {
    fs::read_to_string(file(config_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, s: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let tmp = config_dir.join("settings.json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(s)? + "\n")?;
    fs::rename(tmp, file(config_dir))
}

/// An address as typed (`ai.example`, `https://ai.example/`, `http://10.1.2.3:8080/chat`)
/// as a base: https unless it says http, scheme and host and port only. The same rule as
/// `lembas login`, so both name the instance alike.
pub fn normalise(address: &str) -> Result<String, String> {
    let a = address.trim();
    if a.is_empty() {
        return Err("Enter the address of your LLeMbas server.".into());
    }
    let with_scheme = if a.contains("://") {
        a.to_string()
    } else {
        format!("https://{a}")
    };
    let url = tauri::Url::parse(&with_scheme).map_err(|e| format!("Not an address: {e}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("The address must start with https:// or http://.".into());
    }
    let host = url.host_str().ok_or("The address has no host.")?;
    Ok(match url.port() {
        Some(p) => format!("{}://{}:{}", url.scheme(), host, p),
        None => format!("{}://{}", url.scheme(), host),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_becomes_a_base() {
        assert_eq!(normalise("ai.example").unwrap(), "https://ai.example");
        assert_eq!(
            normalise(" https://ai.example/ ").unwrap(),
            "https://ai.example"
        );
        assert_eq!(
            normalise("http://10.1.2.3:8080/chat?x=1").unwrap(),
            "http://10.1.2.3:8080"
        );
        assert!(normalise("").is_err());
        assert!(normalise("ftp://ai.example").is_err());
    }

    #[test]
    fn settings_round_trip_and_survive_a_missing_file() {
        let dir = std::env::temp_dir().join(format!("llembas-desktop-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), Settings::default());
        assert!(Settings::default().notify);
        // A file from before 1.0 has no `notify`: it is on.
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            file(&dir),
            r#"{"server":"https://ai.example","agent":true}"#,
        )
        .unwrap();
        assert!(load(&dir).notify);
        let s = Settings {
            server: Some("https://ai.example".into()),
            agent: true,
            theme: Some("shire".into()),
            notify: false,
        };
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
        fs::remove_dir_all(&dir).unwrap();
    }
}
