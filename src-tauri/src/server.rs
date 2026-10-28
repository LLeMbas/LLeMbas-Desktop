//! The server this app is a front end to: whether it is one this app can talk to, the app's own
//! sign-in to it, and every request the app's pages make to it.
//!
//! - **Discovery** (`/.well-known/lembas.json`) decides first. LLeMbas Desktop 1.0 needs a
//!   LLeMbas 2.0 server: one that speaks link protocol 3 and has the app's door (`/api/v2`) in a
//!   version this app knows. An older server is refused with a sentence that says which side to
//!   update, before anything is signed in.
//! - **The app's sign-in** is the server's device login (RFC 8628), the same one `lembas login`
//!   uses, for one scope: `app`, "read and write your chats, as the web interface does". The
//!   approval page opens in the system's browser, where the person is signed in already. The
//!   token is kept in the app's config directory, readable by this user only.
//! - **The token stays in Rust.** The pages ask for `/api/v2/...` through a command and get the
//!   JSON back; they never hold the token, so no page -- and nothing a page shows -- can send it
//!   anywhere. A request can only reach the server's `/api/v2`: the path is checked here.
//!
//! The agent's own link is a different token, the CLI's (`lembas login`), which this app never
//! reads: a token that may accept work as a device is not one the chat window needs.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The link protocol a 2.0 server speaks (harness spec `acp.md`, *Versions*).
pub const NEEDS_PROTOCOL: i64 = 3;
/// The server's major version this app is written for.
pub const NEEDS_MAJOR: u64 = 2;
/// The `/api/v2` contract this app is written against: discovery's `app_api`. A higher number is
/// a change an existing client would misread, so this app says it is too old rather than guess.
pub const APP_API: i64 = 1;

/// What discovery said, once it has passed every check.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Discovery {
    pub base: String,
    pub name: String,
    pub version: String,
    /// The app's door: `https://host/api/v2`.
    #[serde(skip)]
    pub app: String,
    #[serde(skip)]
    pub device_code: String,
    #[serde(skip)]
    pub device_token: String,
}

fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(read)
        .timeout_write(Duration::from_secs(30))
        .user_agent(&format!("llembas-desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
}

/// An error a page can show and act on: the HTTP status (0: the server was not reached) and the
/// server's own sentence (`detail`), or ours.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub detail: String,
}

impl ApiError {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        ApiError {
            status,
            detail: detail.into(),
        }
    }
}

impl From<ureq::Error> for ApiError {
    fn from(e: ureq::Error) -> Self {
        match e {
            ureq::Error::Status(code, res) => {
                let text = res.into_string().unwrap_or_default();
                let detail = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.get("detail").cloned())
                    .map(|d| match d {
                        Value::String(s) => s,
                        other => other.to_string(),
                    })
                    .unwrap_or_else(|| format!("The server answered {code}."));
                ApiError::new(code, detail)
            }
            ureq::Error::Transport(t) => {
                ApiError::new(0, format!("Could not reach the server: {t}"))
            }
        }
    }
}

/// Ask `base` who it is, and refuse what this app cannot talk to.
pub fn discover(base: &str) -> Result<Discovery, String> {
    let url = format!("{base}/.well-known/lembas.json");
    let res = agent(Duration::from_secs(15))
        .get(&url)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => format!("{base} answers, but is not a LLeMbas server."),
            ureq::Error::Status(code, _) => format!("{base} answered {code}."),
            ureq::Error::Transport(t) => format!("Could not reach {base}: {t}"),
        })?;
    let body: Value = res
        .into_json()
        .map_err(|_| format!("{base} is not a LLeMbas server."))?;
    check(&body, base)
}

/// The leading number of a version: `2` of `2.0.0-beta.1`, `1` of `1.7.3`.
fn major(version: &str) -> Option<u64> {
    let digits: String = version
        .trim_start_matches('v')
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// The checks, on discovery's answer: a LLeMbas server, a 2.0 one (protocol 3, version 2 or
/// later), with an app door whose version this app knows.
pub fn check(body: &Value, base: &str) -> Result<Discovery, String> {
    if body.get("service").and_then(Value::as_str) != Some("lembas") {
        return Err(format!("{base} is not a LLeMbas server."));
    }
    let version = body
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // `protocols` is a 2.0 server's list; a 1.x one has only `protocol`, frozen at 1.
    let protocols: Vec<i64> = match body.get("protocols").and_then(Value::as_array) {
        Some(list) => list.iter().filter_map(Value::as_i64).collect(),
        None => body
            .get("protocol")
            .and_then(Value::as_i64)
            .into_iter()
            .collect(),
    };
    let new_enough =
        protocols.contains(&NEEDS_PROTOCOL) && major(&version).is_some_and(|m| m >= NEEDS_MAJOR);
    if !new_enough {
        let runs = if version.is_empty() {
            "an older LLeMbas".to_string()
        } else {
            format!("LLeMbas {version}")
        };
        return Err(format!(
            "{base} runs {runs}. LLeMbas Desktop {} needs a LLeMbas 2.0 server or later: update the server, or keep using LLeMbas Desktop 0.7 with this one.",
            env!("CARGO_PKG_VERSION")
        ));
    }
    let app_api = body.get("app_api").and_then(Value::as_i64).unwrap_or(0);
    if app_api < 1 {
        return Err(format!(
            "{base} has no app interface (/api/v2). Update the server to LLeMbas 2.0 or later."
        ));
    }
    if app_api > APP_API {
        return Err(format!(
            "{base} speaks a newer app interface (version {app_api}) than LLeMbas Desktop {} knows (version {APP_API}). Update LLeMbas Desktop.",
            env!("CARGO_PKG_VERSION")
        ));
    }
    let api = body.get("api");
    let app = api
        .and_then(|a| a.get("app"))
        .and_then(Value::as_str)
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| format!("{base}/api/v2"));
    let device = body.get("login").and_then(|l| l.get("device"));
    let endpoint = |key: &str| {
        device
            .and_then(|d| d.get(key))
            .and_then(Value::as_str)
            .map(String::from)
    };
    let (Some(device_code), Some(device_token)) = (endpoint("code"), endpoint("token")) else {
        return Err(format!("{base} offers no device sign-in."));
    };
    Ok(Discovery {
        base: base.to_string(),
        name: body
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("LLeMbas")
            .to_string(),
        version,
        app,
        device_code,
        device_token,
    })
}

// --- The app's sign-in ----------------------------------------------------------------------

/// What the app keeps of its sign-in: which server, the token, and whose it is.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Account {
    pub server: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub token: String,
    pub email: String,
    pub name: String,
}

impl Account {
    /// The same account without its token: what a page may see.
    pub fn public(&self) -> Account {
        Account {
            token: String::new(),
            ..self.clone()
        }
    }
}

fn account_file(config_dir: &Path) -> PathBuf {
    config_dir.join("account.json")
}

/// The sign-in for `server`, if there is one (a sign-in to another server is not this one's).
pub fn load_account(config_dir: &Path, server: &str) -> Option<Account> {
    let text = fs::read_to_string(account_file(config_dir)).ok()?;
    let a: Account = serde_json::from_str(&text).ok()?;
    (a.server == server && !a.token.is_empty()).then_some(a)
}

/// Written to a new file readable by this user only, then moved over the old one.
pub fn save_account(config_dir: &Path, a: &Account) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let tmp = config_dir.join("account.json.tmp");
    let _ = fs::remove_file(&tmp);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&tmp)?;
    f.write_all((serde_json::to_string_pretty(a)? + "\n").as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(tmp, account_file(config_dir))
}

pub fn forget_account(config_dir: &Path) {
    let _ = fs::remove_file(account_file(config_dir));
}

/// A device login in progress: the code to approve and where.
#[derive(Clone, Debug, Serialize)]
pub struct Code {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    #[serde(skip)]
    pub interval: u64,
    #[serde(skip)]
    pub device_code: String,
}

/// Open a device login for the `app` scope.
pub fn start_sign_in(d: &Discovery, host: &str) -> Result<Code, String> {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let device_name = if host.is_empty() {
        "LLeMbas Desktop".to_string()
    } else {
        format!("LLeMbas Desktop on {host}")
    };
    let res = agent(Duration::from_secs(15))
        .post(&d.device_code)
        .set("accept", "application/json")
        .send_json(serde_json::json!({
            "client_id": format!("llembas-desktop {}", env!("CARGO_PKG_VERSION")),
            "device_name": device_name,
            // No host on purpose: the host names the device an agent chat runs on, and that is
            // the CLI's link, not this sign-in.
            "device_platform": platform,
            "scope": "app",
        }))
        .map_err(|e| oauth_error(e, "The server refused to start a sign-in"))?;
    let v: Value = res
        .into_json()
        .map_err(|e| format!("The server's answer was not understood: {e}"))?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str, or: u64| v.get(k).and_then(Value::as_u64).unwrap_or(or);
    let code = Code {
        user_code: s("user_code"),
        verification_uri: s("verification_uri"),
        verification_uri_complete: match s("verification_uri_complete") {
            c if c.is_empty() => s("verification_uri"),
            c => c,
        },
        expires_in: n("expires_in", 600),
        interval: n("interval", 5).max(1),
        device_code: s("device_code"),
    };
    if code.device_code.is_empty() || code.verification_uri.is_empty() {
        return Err("The server's answer was not understood: no code.".into());
    }
    Ok(code)
}

/// RFC 8628's error, in words.
fn oauth_error(e: ureq::Error, what: &str) -> String {
    match e {
        ureq::Error::Status(code, res) => {
            let v: Value = res.into_json().unwrap_or(Value::Null);
            let said = v
                .get("error_description")
                .or_else(|| v.get("error"))
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("{code}"));
            format!("{what}: {said}")
        }
        ureq::Error::Transport(t) => format!("Could not reach the server: {t}"),
    }
}

/// Wait for the person to approve the code (or not), checking `cancelled` while waiting.
pub fn await_sign_in(
    d: &Discovery,
    code: &Code,
    cancelled: &AtomicBool,
) -> Result<Account, String> {
    let deadline = Instant::now() + Duration::from_secs(code.expires_in.max(1));
    let mut interval = Duration::from_secs(code.interval);
    let http = agent(Duration::from_secs(15));
    while Instant::now() < deadline {
        let until = Instant::now() + interval;
        while Instant::now() < until {
            if cancelled.load(Ordering::SeqCst) {
                return Err("The sign-in was cancelled.".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let res = http
            .post(&d.device_token)
            .set("accept", "application/json")
            .send_json(serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": code.device_code,
            }));
        let v: Value = match res {
            Ok(r) => r.into_json().unwrap_or(Value::Null),
            Err(ureq::Error::Status(_, r)) => r.into_json().unwrap_or(Value::Null),
            Err(ureq::Error::Transport(t)) => {
                return Err(format!("Could not reach the server: {t}"))
            }
        };
        if let Some(token) = v.get("access_token").and_then(Value::as_str) {
            let account = v.get("account");
            let field = |k: &str| {
                account
                    .and_then(|a| a.get(k))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            return Ok(Account {
                server: d.base.clone(),
                token: token.to_string(),
                email: field("email"),
                name: field("name"),
            });
        }
        match v.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += Duration::from_secs(5),
            Some("access_denied") => return Err("The sign-in was denied on the server.".into()),
            Some("expired_token") => {
                return Err("The code expired before it was approved. Sign in again.".into())
            }
            Some(other) => return Err(format!("The server refused the sign-in: {other}")),
            None => return Err("The server's answer was not understood.".into()),
        }
    }
    Err("The code expired before it was approved. Sign in again.".into())
}

/// Give the token up on the server (it is gone from the server's device list then). Best effort:
/// the app forgets it either way.
pub fn sign_out(base: &str, token: &str) {
    let _ = agent(Duration::from_secs(10))
        .delete(&format!("{base}/api/v1/token"))
        .set("authorization", &format!("Bearer {token}"))
        .call();
}

// --- The app's door -------------------------------------------------------------------------

/// A path a page may ask for: on the app's door, and nothing that could leave it.
pub fn checked_path(path: &str) -> Result<&str, ApiError> {
    let ok = path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("://")
        && !path.contains('#')
        && !path.contains('\\')
        && !path.split(['/', '?']).any(|part| part == "..")
        && path.chars().all(|c| !c.is_control() && c != ' ');
    if ok {
        Ok(path)
    } else {
        Err(ApiError::new(
            400,
            format!("Not a path on the server: {path}"),
        ))
    }
}

/// One request to `/api/v2`, as the signed-in account. The JSON answer, or `null` for none.
pub fn request(
    app: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let path = checked_path(path)?;
    let method = method.to_ascii_uppercase();
    if !["GET", "POST", "PATCH", "PUT", "DELETE"].contains(&method.as_str()) {
        return Err(ApiError::new(400, format!("No such method: {method}")));
    }
    let req = agent(Duration::from_secs(60))
        .request(&method, &format!("{app}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .set("accept", "application/json");
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    }?;
    if res.status() == 204 {
        return Ok(Value::Null);
    }
    let text = res
        .into_string()
        .map_err(|e| ApiError::new(0, format!("The server's answer could not be read: {e}")))?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text)
        .map_err(|_| ApiError::new(0, "The server's answer was not JSON.".to_string()))
}

/// Server-sent events, a line at a time: what `stream` hands on, one `(event, data)` per frame.
#[derive(Default)]
pub struct Sse {
    event: String,
    data: Vec<String>,
}

impl Sse {
    /// Feed one line (without its newline); a blank line ends a frame and returns it.
    pub fn line(&mut self, line: &str) -> Option<(String, String)> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if self.data.is_empty() && self.event.is_empty() {
                return None;
            }
            let event = std::mem::take(&mut self.event);
            let data = std::mem::take(&mut self.data).join("\n");
            return Some((
                if event.is_empty() {
                    "message".into()
                } else {
                    event
                },
                data,
            ));
        }
        if line.starts_with(':') {
            return None; // a keepalive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }
}

/// Follow a reply as it is written (`GET …/stream`), handing each frame to `frame` until the
/// server closes it, `frame` says stop (false), or `stop` is set. Keepalives arrive often enough
/// that `stop` is noticed within seconds.
pub fn stream(
    app: &str,
    token: &str,
    path: &str,
    stop: &AtomicBool,
    mut frame: impl FnMut(&str, &str) -> bool,
) -> Result<(), ApiError> {
    let path = checked_path(path)?;
    let res = agent(Duration::from_secs(90))
        .get(&format!("{app}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .set("accept", "text/event-stream")
        .call()?;
    let mut sse = Sse::default();
    for line in BufReader::new(res.into_reader()).lines() {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let line = line.map_err(|e| ApiError::new(0, format!("The stream broke off: {e}")))?;
        if let Some((event, data)) = sse.line(&line) {
            if !frame(&event, &data) || event == "close" {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn two_oh() -> Value {
        json!({
            "service": "lembas",
            "version": "2.0.0-beta.1",
            "name": "Example",
            "protocol": 3,
            "protocols": [3],
            "app_api": 1,
            "api": {"app": "https://ai.example/api/v2"},
            "login": {"device": {
                "code": "https://ai.example/api/device/code",
                "token": "https://ai.example/api/device/token"
            }}
        })
    }

    #[test]
    fn a_2_0_server_passes() {
        let d = check(&two_oh(), "https://ai.example").unwrap();
        assert_eq!(d.app, "https://ai.example/api/v2");
        assert_eq!(d.name, "Example");
        assert_eq!(d.device_token, "https://ai.example/api/device/token");
    }

    #[test]
    fn an_older_server_is_refused_and_told_which_side_to_update() {
        // 1.x: protocol frozen at 1, no `protocols`, no app door.
        let old = json!({"service": "lembas", "version": "1.7.3", "protocol": 1});
        let why = check(&old, "https://ai.example").unwrap_err();
        assert!(why.contains("LLeMbas 1.7.3"), "{why}");
        assert!(why.contains("needs a LLeMbas 2.0 server"), "{why}");
        // Protocol 3 alone is not enough: the version must say 2.
        let mut early = two_oh();
        early["version"] = json!("1.7.2");
        assert!(check(&early, "https://ai.example").is_err());
        // Version 2 without protocol 3 is not one either.
        let mut odd = two_oh();
        odd["protocols"] = json!([1, 2]);
        assert!(check(&odd, "https://ai.example").is_err());
    }

    #[test]
    fn an_app_interface_this_app_does_not_know_is_refused() {
        let mut newer = two_oh();
        newer["app_api"] = json!(APP_API + 1);
        assert!(check(&newer, "https://ai.example")
            .unwrap_err()
            .contains("Update LLeMbas Desktop"));
        let mut none = two_oh();
        none.as_object_mut().unwrap().remove("app_api");
        assert!(check(&none, "https://ai.example").is_err());
        let not_ours = json!({"service": "other"});
        assert!(check(&not_ours, "https://ai.example").is_err());
    }

    #[test]
    fn versions_read_their_major() {
        assert_eq!(major("2.0.0-beta.1"), Some(2));
        assert_eq!(major("v10.1.0"), Some(10));
        assert_eq!(major("1.7.3"), Some(1));
        assert_eq!(major(""), None);
    }

    #[test]
    fn a_page_reaches_only_the_app_door() {
        assert!(checked_path("/chats?kind=agent&limit=50").is_ok());
        assert!(checked_path("/chats/abc/messages/def/stream").is_ok());
        for bad in [
            "chats",
            "//evil.example/x",
            "/x://y",
            "/../v1/admin",
            "/chats/../../v1",
            "/a#b",
            "/a b",
            "/a\\b",
        ] {
            assert!(checked_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn server_sent_events_come_out_whole() {
        let mut sse = Sse::default();
        let mut got = vec![];
        for line in [
            ": keepalive",
            "",
            "event: tail",
            "data: {\"text\":\"a\"}",
            "",
            "event: steps",
            "data: one",
            "data: two",
            "\r",
            "data: plain",
            "",
        ] {
            if let Some(f) = sse.line(line) {
                got.push(f);
            }
        }
        assert_eq!(
            got,
            vec![
                ("tail".to_string(), "{\"text\":\"a\"}".to_string()),
                ("steps".to_string(), "one\ntwo".to_string()),
                ("message".to_string(), "plain".to_string()),
            ]
        );
    }

    #[test]
    fn the_account_file_keeps_its_server_and_hides_its_token() {
        let dir = std::env::temp_dir().join(format!("llembas-account-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let a = Account {
            server: "https://ai.example".into(),
            token: "secret".into(),
            email: "a@example.org".into(),
            name: "A".into(),
        };
        save_account(&dir, &a).unwrap();
        assert_eq!(load_account(&dir, "https://ai.example"), Some(a.clone()));
        assert_eq!(load_account(&dir, "https://other.example"), None);
        assert!(!serde_json::to_string(&a.public())
            .unwrap()
            .contains("secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(account_file(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        forget_account(&dir);
        assert_eq!(load_account(&dir, "https://ai.example"), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
