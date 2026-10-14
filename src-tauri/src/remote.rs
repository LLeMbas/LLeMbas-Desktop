//! Which folders the agent may work in: the CLI's `remote` settings, read and changed through
//! `lembas remote … --json` so the app never edits the CLI's files itself. A freshly linked
//! computer allows no folder at all (remote control is off and `roots` is empty), so the agent
//! is connected but every agent chat on it is refused until at least one folder is added.

use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::cli;

/// `lembas remote list --json`, and what every changing command answers with.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Remote {
    pub enabled: bool,
    pub roots: Vec<String>,
    pub max_mode: String,
    pub terminal: bool,
    /// The running service must start again for the change to apply.
    pub restart_needed: bool,
}

impl Remote {
    /// Agent chats can be opened here at all.
    pub fn usable(&self) -> bool {
        self.enabled && !self.roots.is_empty()
    }
}

/// Run `lembas remote <args…> --json`: the new state, or what the CLI said went wrong.
pub fn run(args: &[&str]) -> Result<Remote, String> {
    let out = Command::new(cli::binary())
        .arg("remote")
        .args(args)
        .arg("--json")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not start {}: {e}", cli::binary().display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("lembas remote {} failed ({})", args.join(" "), out.status)
        } else {
            err.trim_start_matches("lembas: ").to_string()
        });
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// The last JSON object the CLI printed (it may say a word before it).
fn parse(stdout: &str) -> Result<Remote, String> {
    stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Remote>(l.trim()).ok())
        .ok_or_else(|| "lembas remote gave no answer this version of the app understands — is the bundled LLeMbas CLI too old?".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_state_and_defaults_what_is_missing() {
        let r = parse(
            "added /home/a/project\n{\"enabled\":true,\"roots\":[\"/home/a/project\"],\"max_mode\":\"edit\",\"terminal\":false}\n",
        )
        .unwrap();
        assert!(r.usable());
        assert_eq!(r.roots, vec!["/home/a/project"]);
        assert!(!r.restart_needed);
        let off = parse("{\"enabled\":false,\"roots\":[]}").unwrap();
        assert!(!off.usable());
        assert!(parse("lembas: unknown command remote").is_err());
    }
}
