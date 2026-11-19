//! The server this app is a front end to: whether it is one this app can talk to, the app's own
//! sign-in to it, and every request the app's pages make to it.
//!
//! - **Discovery** (`/.well-known/lembas.json`) decides first. LLeMbas Desktop 1.0 needs a
//!   LLeMbas 2.0 server: one that speaks link protocol 3 and has the app's door (`/api/v2`) in
//!   version 2. That is checked by `app_api`, not by the server's version number, which says 2
//!   only from its first 2.0 release on. An older server is refused with a sentence that says
//!   which side to update, before anything is signed in.
//! - **The app's sign-in** is the server's device login (RFC 8628), the same one `lembas login`
//!   uses, for `app models`: "read and write your chats, as the web interface does", and the
//!   speech routes. **One approval, two tokens**: where discovery says
//!   `login.device.agent_scope`, the same login asks for the agent's scopes too
//!   (`models memory link`), and the approval answers with a second token, the agent's, which is
//!   handed straight to the bundled CLI (`lembas login --token-stdin`) and never kept here. The
//!   approval page opens in the system's browser, where the person is signed in already. The
//!   app's token is kept in the app's config directory, readable by this user only.
//! - **The token stays in Rust.** The pages ask for `/api/v2/...` through a command and get the
//!   JSON back; they never hold the token, so no page -- and nothing a page shows -- can send it
//!   anywhere. A request can only reach the server's `/api/v2`: the path is checked here.
//!
//! The agent's own link is a different token, the CLI's, which this app never keeps or reads
//! back: a token that may accept work as a device is not one the chat window needs.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The link protocol a 2.0 server speaks (harness spec `acp.md`, *Versions*).
pub const NEEDS_PROTOCOL: i64 = 3;
/// The `/api/v2` contract this app is written against: discovery's `app_api`. A lower number is
/// a server before 2.0 (its chats carry what this app no longer reads, and it has no `show`
/// card); a higher one is a change an existing client would misread, so this app says it is too
/// old rather than guess.
pub const APP_API: i64 = 2;
/// The scopes the app's own token asks for: the chats, and the speech routes of `/v1`.
pub const APP_SCOPE: &str = "app models";
/// The scopes the agent's token asks for, in the same approval: what `lembas service` needs.
pub const AGENT_SCOPE: &str = "models memory link";

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
    /// The server gives the agent's token from the app's own approval
    /// (`login.device.agent_scope`): one approval, not two.
    pub one_approval: bool,
}

/// Every request is made by one of these. The token goes to the server it was given by and
/// nowhere else: on a redirect the `Authorization` header is never sent on, to the same host or
/// to another (said here rather than left to the library's default, which is the same).
fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirect_auth_headers(ureq::RedirectAuthHeaders::Never)
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

/// The checks, on discovery's answer: a LLeMbas server, a 2.0 one (protocol 3, and the app
/// door in version 2), with an app door whose version this app knows. The server's version
/// number is not checked: a 2.0 server in the making still says 1.7 until its first beta.
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
    let app_api = body.get("app_api").and_then(Value::as_i64).unwrap_or(0);
    let new_enough = protocols.contains(&NEEDS_PROTOCOL) && app_api >= APP_API;
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
        one_approval: device
            .and_then(|d| d.get("agent_scope"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
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

/// What a device login asks the server for, as the form it posts.
fn code_request(host: &str, with_agent: bool) -> Value {
    code_request_for(host, Ask::App { with_agent })
}

/// Which login: the app's own (and the agent's beside it, in the same approval), or the agent's
/// alone -- linking this computer again, which needs no second token for the app.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ask {
    App { with_agent: bool },
    Agent,
}

fn code_request_for(host: &str, ask: Ask) -> Value {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let device_name = if host.is_empty() {
        "LLeMbas Desktop".to_string()
    } else {
        format!("LLeMbas Desktop on {host}")
    };
    let mut body = serde_json::json!({
        "client_id": format!("llembas-desktop {}", env!("CARGO_PKG_VERSION")),
        "device_name": device_name,
        "device_platform": platform,
        "scope": APP_SCOPE,
    });
    if ask == Ask::Agent {
        // The agent's token alone: the device an agent chat runs on, named by its host.
        body["scope"] = Value::String(AGENT_SCOPE.to_string());
        body["device_host"] = Value::String(host.to_string());
        return body;
    }
    if matches!(ask, Ask::App { with_agent: true }) {
        // The agent's token is the device an agent chat runs on: it carries this computer's
        // host, as `lembas login` sends it, so the app knows which device is this one. The
        // app's own token alone names no host: it is not a device.
        body["device_host"] = Value::String(host.to_string());
        body["agent_scope"] = Value::String(AGENT_SCOPE.to_string());
    }
    body
}

/// Open a device login for the app's scopes, and the agent's too when `with_agent` (only where
/// discovery offered it).
pub fn start_sign_in(d: &Discovery, host: &str, with_agent: bool) -> Result<Code, String> {
    start_code(d, code_request(host, with_agent && d.one_approval))
}

/// Open a device login for the agent's scopes alone: linking this computer (again), with the
/// token handed to the CLI as the app's own approval hands it. A login the CLI made itself
/// (`lembas login <server>`) would not do here: for a server it is logged in to already, that
/// only refreshes the login it has -- a token the server refuses stays refused.
pub fn start_link(d: &Discovery, host: &str) -> Result<Code, String> {
    start_code(d, code_request_for(host, Ask::Agent))
}

fn start_code(d: &Discovery, form: Value) -> Result<Code, String> {
    let res = agent(Duration::from_secs(15))
        .post(&d.device_code)
        .set("accept", "application/json")
        .send_json(form)
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

/// What an approval gave: the app's sign-in, and the agent's token when the login asked for one.
/// The agent's token is not kept: it goes to the CLI and is dropped.
pub struct Granted {
    pub account: Account,
    pub agent_token: Option<String>,
}

/// The token endpoint's answer, once it carries a token.
fn granted(v: &Value, server: &str) -> Option<Granted> {
    let token = v.get("access_token").and_then(Value::as_str)?;
    let account = v.get("account");
    let field = |k: &str| {
        account
            .and_then(|a| a.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Some(Granted {
        account: Account {
            server: server.to_string(),
            token: token.to_string(),
            email: field("email"),
            name: field("name"),
        },
        agent_token: v
            .get("agent_token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(String::from),
    })
}

/// Wait for the person to approve the code (or not), checking `cancelled` while waiting.
pub fn await_sign_in(
    d: &Discovery,
    code: &Code,
    cancelled: &AtomicBool,
) -> Result<Granted, String> {
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
        if let Some(g) = granted(&v, &d.base) {
            return Ok(g);
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

/// Give a token up on the server (the app's: gone from the account's apps then; the agent's:
/// one the CLI did not take). Best effort: the app forgets it either way.
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

/// The most a plain-text answer may be: the server's own limit for a shown file (1 MB), and a
/// little room. Anything longer is not read to the end.
pub const TEXT_LIMIT: u64 = 1024 * 1024 + 4096;

/// One `GET` on `/api/v2` that answers plain text, not JSON: the file a `show` card names
/// (`/chats/{chat}/show?…`). An error is still the server's JSON `detail` -- 404 when the file
/// is no longer the chat's to show, 413 when it is too large, 415 when it is not text.
pub fn request_text(app: &str, token: &str, path: &str) -> Result<String, ApiError> {
    let path = checked_path(path)?;
    let res = agent(Duration::from_secs(60))
        .get(&format!("{app}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .set("accept", "text/plain")
        .call()?;
    let mut text = String::new();
    res.into_reader()
        .take(TEXT_LIMIT)
        .read_to_string(&mut text)
        .map_err(|e| ApiError::new(0, format!("The server's answer could not be read: {e}")))?;
    Ok(text)
}

/// One `GET` on `/api/v2` that answers a file's bytes: a file of the pinned Pyodide release
/// (`/pyodide/{version}/{name}`), which `python.rs` checks against the server's list before it
/// keeps it. Not read past `limit`: an answer longer than that is refused, not cut.
pub fn request_bytes(app: &str, token: &str, path: &str, limit: u64) -> Result<Vec<u8>, ApiError> {
    let path = checked_path(path)?;
    let res = agent(Duration::from_secs(120))
        .get(&format!("{app}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .call()?;
    let mut bytes = Vec::new();
    res.into_reader()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| ApiError::new(0, format!("The server's answer could not be read: {e}")))?;
    if bytes.len() as u64 > limit {
        return Err(ApiError::new(413, "The file is too large."));
    }
    Ok(bytes)
}

/// The most a model's picture may be: the server's own limit for one (2 MB), and a little room.
pub const IMAGE_LIMIT: u64 = 2 * 1024 * 1024 + 4096;
/// The most an attached picture shown as a thumbnail may be: a screenshot fits; a larger one
/// shows as a file.
pub const ATTACHMENT_IMAGE_LIMIT: u64 = 8 * 1024 * 1024;

/// The pictures a model may have, by the type the server serves them as: the four it accepts on
/// upload. Nothing else is shown, whatever the server says it is.
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// A picture's path on the app's door, or None for anything else: a model's picture as
/// `/api/v2/models` names it (`/models/images/<file>`), or a message's attached file
/// (`/attachments/<id>`, shown as a thumbnail when the server serves it as a picture). One plain
/// name after the prefix, no more.
pub fn image_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/v2").unwrap_or(path);
    let plain = |name: &str| {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            && !name.starts_with('.')
    };
    if let Some(name) = rest.strip_prefix("/models/images/") {
        return plain(name).then(|| format!("/models/images/{name}"));
    }
    let id = rest.strip_prefix("/attachments/")?;
    (plain(id) && !id.contains('.')).then(|| format!("/attachments/{id}"))
}

/// A model's picture, as a `data:` URL the page can show without a request of its own (its
/// policy allows images from `data:` and nowhere else on the network). Read with the app's
/// token, as the page reads nothing itself.
pub fn request_image(app: &str, token: &str, path: &str) -> Result<String, ApiError> {
    let Some(path) = image_path(path) else {
        return Err(ApiError::new(400, format!("Not a picture's path: {path}")));
    };
    let res = agent(Duration::from_secs(30))
        .get(&format!("{app}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .call()?;
    let kind = res
        .content_type()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !IMAGE_TYPES.contains(&kind.as_str()) {
        return Err(ApiError::new(415, format!("Not a picture: {kind}")));
    }
    let limit = if path.starts_with("/attachments/") {
        ATTACHMENT_IMAGE_LIMIT
    } else {
        IMAGE_LIMIT
    };
    let mut bytes = Vec::new();
    res.into_reader()
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| ApiError::new(0, format!("The server's answer could not be read: {e}")))?;
    if bytes.len() as u64 >= limit {
        return Err(ApiError::new(413, "The picture is too large."));
    }
    Ok(format!("data:{kind};base64,{}", base64(&bytes)))
}

/// Standard base64 with padding (RFC 4648 §4): a picture's bytes in a `data:` URL.
pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ABC[((n >> 18) & 63) as usize] as char);
        out.push(ABC[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ABC[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ABC[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The most a file sent as an attachment may be here. The server has its own limit (20 MB by
/// default, an administrator may change it) and says so in its words; this one only keeps a
/// file far beyond any server's limit from being read into memory at all.
pub const UPLOAD_LIMIT: u64 = 64 * 1024 * 1024;

/// A file's name as it may stand in a multipart header: no quotes, backslashes or line breaks.
fn header_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| match c {
            '"' | '\\' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    if clean.trim().is_empty() {
        "file".into()
    } else {
        clean
    }
}

/// The body of a `multipart/form-data` request with one file in the field `field`.
fn multipart(boundary: &str, field: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    multipart_typed(boundary, field, name, "application/octet-stream", bytes)
}

/// The same, with the file's own media type (a recording says what it is: `audio/webm`).
fn multipart_typed(boundary: &str, field: &str, name: &str, kind: &str, bytes: &[u8]) -> Vec<u8> {
    multipart_with(boundary, &[], field, name, kind, bytes)
}

/// The same, after plain fields of text (`name`, `value`): a value's line breaks and other
/// control characters go, so it stays one field.
fn multipart_with(
    boundary: &str,
    fields: &[(&str, &str)],
    field: &str,
    name: &str,
    kind: &str,
    bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 512);
    for (key, value) in fields {
        let value: String = value.chars().filter(|c| !c.is_control()).collect();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{}\"\r\nContent-Type: {kind}\r\n\r\n",
            header_name(name)
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Send one file to `/api/v2/attachments` (for the chat `chat`, or a chat not made yet): stored
/// now, bound to the message that names it when that is sent. The server's attachment, as JSON.
pub fn upload(
    app: &str,
    token: &str,
    chat: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Value, ApiError> {
    if !chat
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::new(400, format!("Not a chat: {chat}")));
    }
    let path = if chat.is_empty() {
        "/attachments".to_string()
    } else {
        format!("/attachments?chat={chat}")
    };
    let v = send_file(app, token, &path, "file", name, bytes)?;
    v.get("attachment")
        .cloned()
        .ok_or_else(|| ApiError::new(0, "The server's answer was not understood.".to_string()))
}

/// Send one file into the person's library, into the directory `dir` (`/files/upload`, the
/// explorer's upload): the server's listing of that directory afterwards, as JSON.
pub fn upload_to_library(
    app: &str,
    token: &str,
    dir: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Value, ApiError> {
    if !dir.starts_with('/') || dir.chars().any(|c| c.is_control()) {
        return Err(ApiError::new(400, format!("Not a folder: {dir}")));
    }
    let path = format!("/files/upload?path={}", crate::terminal::encode(dir));
    send_file(app, token, &path, "files", name, bytes)
}

// --- The person's files, as bytes --------------------------------------------------------------
//
// A download is written to disk as it arrives and never held whole: not in this process, and
// not in the page, which is only told where it went. What a viewer plays or draws is asked for a
// piece at a time (`raw_part`), with the app's token, by the media scheme (`media.rs`).

/// `/files/raw?path=…` for a file in the server's tree: all of it, or one version, as a download
/// or -- `inline` -- under its own type where the server allows that (a picture, sound, video).
pub fn raw_path(path: &str, version: Option<&str>, inline: bool) -> Result<String, ApiError> {
    if !path.starts_with('/') || path.chars().any(|c| c.is_control()) {
        return Err(ApiError::new(400, format!("Not a file: {path}")));
    }
    let mut out = format!("/files/raw?path={}", crate::terminal::encode(path));
    if let Some(version) = version {
        let plain = !version.is_empty()
            && version.len() <= 128
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !plain {
            return Err(ApiError::new(400, format!("Not a version: {version}")));
        }
        out.push_str(&format!("&version={version}"));
    }
    if inline {
        out.push_str("&inline=1");
    }
    Ok(out)
}

/// `/files/raw?node=…` for a file by its id (a generated file's `node_id`): the address keeps
/// working after the file is renamed or moved. `inline` as in `raw_path`.
pub fn raw_node(node: &str, inline: bool) -> Result<String, ApiError> {
    if !plain_id(node) {
        return Err(ApiError::new(400, format!("Not a file's id: {node}")));
    }
    Ok(format!(
        "/files/raw?node={node}{}",
        if inline { "&inline=1" } else { "" }
    ))
}

/// `/attachments/<id>` for a file a message carries (sound or video the person attached).
pub fn attachment_path(id: &str) -> Result<String, ApiError> {
    if !plain_id(id) {
        return Err(ApiError::new(400, format!("Not an attachment's id: {id}")));
    }
    Ok(format!("/attachments/{id}"))
}

/// An id the server made: letters, digits, `-` and `_`, nothing that could change the address.
fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The most a download to disk may be. An answer that says it is longer is refused before a
/// byte is written, and one that does not say is stopped here.
pub const DOWNLOAD_LIMIT: u64 = 16 * 1024 * 1024 * 1024;

/// Where a download goes, and how it takes its name once it is whole.
pub struct Dest<'a> {
    pub at: &'a Path,
    /// The name must still be free: nothing is replaced (a folder of the agent's). Otherwise the
    /// person chose the name in the system's dialog, and what is called that is replaced.
    pub new: bool,
    /// What the file it is written to meanwhile must pass, as `at` already did: the rule that
    /// keeps the CLI's files (`files::may_write`).
    pub check: Option<&'a dyn Fn(&Path) -> Result<(), String>>,
}

impl<'a> Dest<'a> {
    /// A place the person chose in the system's save dialog.
    pub fn chosen(at: &'a Path) -> Self {
        Dest {
            at,
            new: false,
            check: None,
        }
    }
}

fn too_large() -> ApiError {
    ApiError::new(
        413,
        format!(
            "This file is larger than the app downloads ({} GB).",
            DOWNLOAD_LIMIT / (1024 * 1024 * 1024)
        ),
    )
}

/// Write `body` to `dest` as it arrives; how many bytes. `length` is what the answer said its
/// length is, where it said: more than `limit`, or more than the disk has room for, and nothing
/// is written. It is written to a file made new beside `dest` under a random name
/// (`files::Fresh`: never through a link, never over anything) and takes its name only once
/// whole, so a download that breaks off, or runs past `limit`, leaves nothing behind -- and
/// nothing that was there before is touched.
fn save_stream(
    body: impl Read,
    length: Option<u64>,
    dest: &Dest,
    limit: u64,
) -> Result<u64, ApiError> {
    let failed = |e: std::io::Error| ApiError::new(0, format!("The file could not be saved: {e}"));
    if length.is_some_and(|n| n > limit) {
        return Err(too_large());
    }
    if let (Some(n), Some(room)) = (length, crate::files::room_for(dest.at)) {
        if n > room {
            return Err(ApiError::new(
                507,
                "There is not enough room on the disk for this file.",
            ));
        }
    }
    let mut fresh = crate::files::Fresh::beside(dest.at).map_err(failed)?;
    if let Some(check) = dest.check {
        check(fresh.path()).map_err(|e| ApiError::new(400, e))?;
    }
    let n = std::io::copy(&mut body.take(limit.saturating_add(1)), fresh.file()).map_err(failed)?;
    if n > limit {
        return Err(too_large());
    }
    fresh.file().flush().map_err(failed)?;
    let settled = if dest.new {
        fresh.settle_new(dest.at)
    } else {
        fresh.replace(dest.at)
    };
    settled.map_err(failed)?;
    Ok(n)
}

/// An answer's body, written to `dest` (`save_stream`).
fn save_body(res: ureq::Response, dest: &Dest) -> Result<u64, ApiError> {
    let length = res
        .header("content-length")
        .and_then(|v| v.trim().parse::<u64>().ok());
    save_stream(res.into_reader(), length, dest, DOWNLOAD_LIMIT)
}

/// A file of the server's tree (or one version of it), written to `dest`.
pub fn download(
    app: &str,
    token: &str,
    path: &str,
    version: Option<&str>,
    dest: &Dest,
) -> Result<u64, ApiError> {
    download_raw(app, token, &raw_path(path, version, false)?, dest)
}

/// `raw` (from `raw_path` or `raw_node`), written to `dest` as it arrives.
pub fn download_raw(app: &str, token: &str, raw: &str, dest: &Dest) -> Result<u64, ApiError> {
    let res = agent(Duration::from_secs(120))
        .get(&format!("{app}{}", checked_path(raw)?))
        .set("authorization", &format!("Bearer {token}"))
        .call()?;
    save_body(res, dest)
}

/// The chosen files and folders as one zip (`POST /files/zip`), written to `dest`. More than
/// the instance allows is its 413, in its words.
pub fn download_zip(
    app: &str,
    token: &str,
    paths: &[String],
    dest: &Dest,
) -> Result<u64, ApiError> {
    let res = agent(Duration::from_secs(300))
        .post(&format!("{app}/files/zip"))
        .set("authorization", &format!("Bearer {token}"))
        .send_json(serde_json::json!({ "paths": paths }))?;
    save_body(res, dest)
}

/// A piece of a file as the server answered it: 200 (all of it) or 206 (the range asked for).
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub status: u16,
    /// The media type, lower case, without parameters.
    pub kind: String,
    /// `Content-Range`, on a 206.
    pub range: Option<String>,
    pub bytes: Vec<u8>,
}

/// `raw` (from `raw_path`), or the `range` of it. Not read past `limit`: a longer answer is
/// refused, not cut. A range past the end is the server's 416.
pub fn raw_part(
    app: &str,
    token: &str,
    raw: &str,
    range: Option<&str>,
    limit: u64,
) -> Result<Part, ApiError> {
    let mut req = agent(Duration::from_secs(60))
        .get(&format!("{app}{}", checked_path(raw)?))
        .set("authorization", &format!("Bearer {token}"));
    if let Some(range) = range {
        req = req.set("range", range);
    }
    let res = req.call()?;
    let status = res.status();
    let kind = res
        .content_type()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let range = res.header("content-range").map(str::to_string);
    let mut bytes = Vec::new();
    res.into_reader()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| ApiError::new(0, format!("The server's answer could not be read: {e}")))?;
    if bytes.len() as u64 > limit {
        return Err(ApiError::new(413, "The file is too large to show here."));
    }
    Ok(Part {
        status,
        kind,
        range,
        bytes,
    })
}

// --- Voice and pictures: the OpenAI-compatible routes of `/v1`, under the `models` scope ------------

/// The most a recording may be here: the server's own limit is 25 MB.
pub const RECORDING_LIMIT: u64 = 25 * 1024 * 1024;
/// The most a reply read aloud may be, as audio.
pub const SPEECH_LIMIT: u64 = 32 * 1024 * 1024;
/// The most a generated picture may be.
pub const DRAWN_LIMIT: u64 = 24 * 1024 * 1024;
/// The media types a recording may say it is; anything else goes as `audio/webm`.
const RECORDING_TYPES: [&str; 5] = [
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/mpeg",
    "audio/mp4",
];

/// A recording's media type as it may be sent: one of ours, its parameters (`;codecs=opus`) off.
pub fn recording_type(kind: &str) -> &'static str {
    let bare = kind
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    RECORDING_TYPES
        .iter()
        .find(|t| **t == bare)
        .copied()
        .unwrap_or("audio/webm")
}

/// Which chat a recording, a reply read aloud is for: the server then answers with the speech
/// model of that chat's connection where it has one, else with the instance's default. `chat`
/// is an open chat's id; `model` the model (`provider/model`) of a chat not made yet. Either may
/// be empty, and a chat goes before a model. A server that does not know the two fields reads
/// neither: it answers with its default, as it always did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MediaFor {
    pub chat: String,
    pub model: String,
}

/// The most a model's name may be here.
const MODEL_REF_LIMIT: usize = 300;

impl MediaFor {
    /// As the page named them: a chat's id is letters, digits, `-` and `_`; a model's name is
    /// one line of no great length. Anything else is refused, not sent.
    pub fn new(chat: &str, model: &str) -> Result<Self, ApiError> {
        let (chat, model) = (chat.trim(), model.trim());
        if chat.len() > 128
            || !chat
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(ApiError::new(400, "Not a chat."));
        }
        if model.len() > MODEL_REF_LIMIT || model.chars().any(char::is_control) {
            return Err(ApiError::new(400, "Not a model."));
        }
        Ok(MediaFor {
            chat: chat.to_string(),
            model: if chat.is_empty() {
                model.to_string()
            } else {
                String::new()
            },
        })
    }

    /// The one field that says it, as the server names it; none where there is nothing to say.
    fn field(&self) -> Option<(&'static str, &str)> {
        if !self.chat.is_empty() {
            Some(("chat_id", &self.chat))
        } else if !self.model.is_empty() {
            Some(("chat_model", &self.model))
        } else {
            None
        }
    }
}

/// What answered a recording or a reply read aloud, as the server's headers say it:
/// `X-Lembas-Source` (percent-encoded: a header is Latin-1) and `X-Lembas-Fallback` (the chat's
/// own did not answer, and the instance's default did). A server that sends neither: nothing.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Answered {
    pub source: String,
    pub fallback: bool,
}

/// The most of a source's name that is shown.
const SOURCE_LIMIT: usize = 200;

/// `Answered` from the two headers' values.
pub fn answered(source: Option<&str>, fallback: Option<&str>) -> Answered {
    let name: String = percent_decoded(source.unwrap_or("").trim())
        .chars()
        .filter(|c| !c.is_control())
        .take(SOURCE_LIMIT)
        .collect();
    let said = fallback.unwrap_or("").trim();
    Answered {
        fallback: !name.is_empty() && !said.is_empty() && said != "0",
        source: name,
    }
}

fn answered_by(res: &ureq::Response) -> Answered {
    answered(
        res.header("x-lembas-source"),
        res.header("x-lembas-fallback"),
    )
}

/// `%XX` escapes undone; an escape that is not one stays as it came.
pub fn percent_decoded(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A recording in words, and what wrote it down.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Heard {
    pub text: String,
    #[serde(flatten)]
    pub by: Answered,
}

/// A reply as audio (a `data:` URL), and what read it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Spoken {
    pub url: String,
    #[serde(flatten)]
    pub by: Answered,
}

/// A recording, in words: `POST /v1/audio/transcriptions` (the speech model of the chat it is
/// `for_`, else the instance's own; the account's language). The text the server heard.
pub fn transcribe(
    base: &str,
    token: &str,
    kind: &str,
    bytes: &[u8],
    for_: &MediaFor,
) -> Result<Heard, ApiError> {
    if bytes.is_empty() {
        return Err(ApiError::new(400, "The recording was empty."));
    }
    let kind = recording_type(kind);
    let ext = kind
        .rsplit('/')
        .next()
        .unwrap_or("webm")
        .replace("mpeg", "mp3");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let boundary = format!("llembas-desktop-{nanos:x}");
    let fields: Vec<(&str, &str)> = for_.field().into_iter().collect();
    let res = agent(Duration::from_secs(300))
        .post(&format!("{base}/v1/audio/transcriptions"))
        .set("authorization", &format!("Bearer {token}"))
        .set("accept", "application/json")
        .set(
            "content-type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&multipart_with(
            &boundary,
            &fields,
            "file",
            &format!("speech.{ext}"),
            kind,
            bytes,
        ))?;
    let by = answered_by(&res);
    let v: Value = res
        .into_json()
        .map_err(|_| ApiError::new(0, "The server's answer was not JSON.".to_string()))?;
    Ok(Heard {
        text: v
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        by,
    })
}

/// `bytes` of a media type of `kinds` (by its prefix), as a `data:` URL; at most `limit`.
fn as_data_url(res: ureq::Response, prefix: &str, limit: u64) -> Result<String, ApiError> {
    let kind = res
        .content_type()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let fits = if prefix == "image/" {
        IMAGE_TYPES.contains(&kind.as_str())
    } else {
        kind.starts_with(prefix)
            && kind
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "/-+.".contains(c))
    };
    if !fits {
        return Err(ApiError::new(
            415,
            format!("Not what was asked for: {kind}"),
        ));
    }
    let mut bytes = Vec::new();
    res.into_reader()
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| ApiError::new(0, format!("The server's answer could not be read: {e}")))?;
    if bytes.len() as u64 >= limit {
        return Err(ApiError::new(413, "The server's answer is too large."));
    }
    Ok(format!("data:{kind};base64,{}", base64(&bytes)))
}

/// What `/v1/audio/speech` is sent: the words, and the chat they are read for where one is said.
fn speech_body(text: &str, for_: &MediaFor) -> Value {
    let mut body = serde_json::json!({ "input": text, "response_format": "mp3" });
    if let Some((key, value)) = for_.field() {
        body[key] = Value::String(value.to_string());
    }
    body
}

/// A reply read aloud: `POST /v1/audio/speech` in the account's own voice and speed, by the
/// speech model of the chat it is `for_`, else the instance's own. The audio, as a `data:` URL
/// the page plays.
pub fn speak(base: &str, token: &str, text: &str, for_: &MediaFor) -> Result<Spoken, ApiError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ApiError::new(400, "There is nothing to read aloud."));
    }
    let res = agent(Duration::from_secs(300))
        .post(&format!("{base}/v1/audio/speech"))
        .set("authorization", &format!("Bearer {token}"))
        .send_json(speech_body(text, for_))?;
    let by = answered_by(&res);
    Ok(Spoken {
        url: as_data_url(res, "audio/", SPEECH_LIMIT)?,
        by,
    })
}

/// The id of one of the person's own files in a URL `/v1/images/generations` answered with:
/// `…/v1/files/<id>/content`, and nothing else. The picture is then fetched from this app's own
/// server by that id -- never from the address the answer named.
pub fn own_file_id(url: &str) -> Option<String> {
    let rest = url.split(['?', '#']).next()?;
    let tail = rest.strip_suffix("/content")?;
    let (head, id) = tail.rsplit_once('/')?;
    let ok = head.ends_with("/v1/files")
        && !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| id.to_string())
}

/// Sizes a picture may be asked for: the instance rounds to what its workflow takes.
const SIZES: [&str; 3] = ["1024x1024", "1344x768", "768x1344"];

/// Pictures drawn by the instance: `POST /v1/images/generations` (its own workflow and default
/// checkpoint), each then read from the person's own files on this server. `data:` URLs.
pub fn draw(base: &str, token: &str, prompt: &str, size: &str) -> Result<Vec<String>, ApiError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(ApiError::new(400, "Say what to draw."));
    }
    let mut body = serde_json::json!({ "prompt": prompt, "n": 1, "response_format": "url" });
    if SIZES.contains(&size) {
        body["size"] = Value::String(size.to_string());
    }
    let res = agent(Duration::from_secs(900))
        .post(&format!("{base}/v1/images/generations"))
        .set("authorization", &format!("Bearer {token}"))
        .set("accept", "application/json")
        .send_json(body)?;
    let v: Value = res
        .into_json()
        .map_err(|_| ApiError::new(0, "The server's answer was not JSON.".to_string()))?;
    let ids: Vec<String> = v
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str).and_then(own_file_id))
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(ApiError::new(
            0,
            "The server's answer had no picture of yours in it.",
        ));
    }
    ids.iter()
        .map(|id| {
            let res = agent(Duration::from_secs(60))
                .get(&format!("{base}/v1/files/{id}/content"))
                .set("authorization", &format!("Bearer {token}"))
                .call()?;
            as_data_url(res, "image/", DRAWN_LIMIT)
        })
        .collect()
}

/// One `multipart/form-data` POST of one file to `path` on the app's door; the JSON answer.
fn send_file(
    app: &str,
    token: &str,
    path: &str,
    field: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Value, ApiError> {
    let path = checked_path(path)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let boundary = format!("llembas-desktop-{nanos:x}");
    let res = agent(Duration::from_secs(300))
        .post(&format!("{app}{path}"))
        .set("authorization", &format!("Bearer {token}"))
        .set("accept", "application/json")
        .set(
            "content-type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&multipart(&boundary, field, name, bytes))?;
    res.into_json()
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

    #[test]
    fn a_files_bytes_are_asked_for_by_an_encoded_path() {
        assert_eq!(
            raw_path("/home/frodo/a b&c.png", None, true).unwrap(),
            "/files/raw?path=%2Fhome%2Ffrodo%2Fa%20b%26c.png&inline=1"
        );
        assert_eq!(
            raw_path("/home/frodo/lembas.md", Some("ver2"), false).unwrap(),
            "/files/raw?path=%2Fhome%2Ffrodo%2Flembas.md&version=ver2"
        );
        // What is built is a path the app's door takes, whatever the file is called.
        for name in ["/a/../b", "/a?x=1#y", "/a\\b", "/x y"] {
            assert!(
                checked_path(&raw_path(name, None, false).unwrap()).is_ok(),
                "{name}"
            );
        }
        assert!(raw_path("relative.md", None, false).is_err());
        assert!(raw_path("/a\nb", None, false).is_err());
        assert!(raw_path("/a", Some("v&inline=1"), false).is_err());
        assert!(raw_path("/a", Some(""), false).is_err());
        // By its id: a generated file, wherever it is now.
        assert_eq!(
            raw_node("node7", true).unwrap(),
            "/files/raw?node=node7&inline=1"
        );
        assert_eq!(raw_node("a-b_9", false).unwrap(), "/files/raw?node=a-b_9");
        assert_eq!(attachment_path("att1").unwrap(), "/attachments/att1");
        for bad in ["", "a&path=/x", "a/b", "a b", "a?x", "..", "a#b"] {
            assert!(raw_node(bad, true).is_err(), "{bad}");
            assert!(attachment_path(bad).is_err(), "{bad}");
        }
        assert_eq!(
            part_of(Path::new("/tmp/waybread.zip")),
            Path::new("/tmp/waybread.zip.part")
        );
    }

    fn two_oh() -> Value {
        json!({
            "service": "lembas",
            "version": "2.0.0-beta.1",
            "name": "Example",
            "protocol": 3,
            "protocols": [3],
            "app_api": 2,
            "api": {"app": "https://ai.example/api/v2"},
            "login": {"device": {
                "code": "https://ai.example/api/device/code",
                "token": "https://ai.example/api/device/token",
                "agent_scope": true
            }}
        })
    }

    #[test]
    fn a_2_0_server_passes() {
        let d = check(&two_oh(), "https://ai.example").unwrap();
        assert_eq!(d.app, "https://ai.example/api/v2");
        assert_eq!(d.name, "Example");
        assert_eq!(d.device_token, "https://ai.example/api/device/token");
        assert!(d.one_approval);
        // A server in the making still says 1.7 until its first 2.0 beta: `app_api` decides.
        let mut dev = two_oh();
        dev["version"] = json!("1.7.2");
        assert!(check(&dev, "https://ai.example").is_ok());
    }

    #[test]
    fn without_agent_scope_in_discovery_there_are_two_approvals() {
        let mut older = two_oh();
        older["login"]["device"]
            .as_object_mut()
            .unwrap()
            .remove("agent_scope");
        assert!(!check(&older, "https://ai.example").unwrap().one_approval);
    }

    #[test]
    fn one_approval_asks_for_both_tokens_and_only_then_names_the_host() {
        let both = code_request("workbench", true);
        assert_eq!(both["scope"], "app models");
        assert_eq!(both["agent_scope"], "models memory link");
        assert_eq!(both["device_host"], "workbench");
        assert_eq!(both["device_name"], "LLeMbas Desktop on workbench");
        let app_only = code_request("workbench", false);
        assert_eq!(app_only["scope"], "app models");
        assert!(app_only.get("agent_scope").is_none());
        assert!(app_only.get("device_host").is_none());
    }

    #[test]
    fn linking_again_asks_for_the_agents_token_alone_and_names_the_host() {
        let link = code_request_for("box", Ask::Agent);
        assert_eq!(link["scope"], "models memory link");
        assert_eq!(link["device_host"], "box");
        assert!(link.get("agent_scope").is_none());
    }

    #[test]
    fn an_approval_gives_the_app_its_token_and_the_agent_its_own() {
        let v = json!({
            "access_token": "lmb_app", "token_type": "Bearer", "scope": "app models",
            "account": {"email": "a@example.org", "name": "A"},
            "base_url": "https://ai.example",
            "agent_token": "lmb_agent", "agent_scope": "models memory link"
        });
        let g = granted(&v, "https://ai.example").unwrap();
        assert_eq!(g.account.token, "lmb_app");
        assert_eq!(g.account.email, "a@example.org");
        assert_eq!(g.agent_token.as_deref(), Some("lmb_agent"));
        let one = json!({"access_token": "lmb_app", "account": {}});
        assert_eq!(
            granted(&one, "https://ai.example").unwrap().agent_token,
            None
        );
        assert!(granted(&json!({"error": "authorization_pending"}), "x").is_none());
    }

    #[test]
    fn an_older_server_is_refused_and_told_which_side_to_update() {
        // 1.x: protocol frozen at 1, no `protocols`, no app door.
        let old = json!({"service": "lembas", "version": "1.7.3", "protocol": 1});
        let why = check(&old, "https://ai.example").unwrap_err();
        assert!(why.contains("LLeMbas 1.7.3"), "{why}");
        assert!(why.contains("needs a LLeMbas 2.0 server"), "{why}");
        // Protocol 3 alone is not enough: the app door must be version 2 (1.7 serves 1).
        let mut early = two_oh();
        early["version"] = json!("1.7.3");
        early["app_api"] = json!(1);
        let why = check(&early, "https://ai.example").unwrap_err();
        assert!(why.contains("needs a LLeMbas 2.0 server"), "{why}");
        // The app door without protocol 3 is not one either.
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

    /// A body that breaks off after its first bytes.
    struct Broken(bool);

    impl Read for Broken {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("the line dropped"));
            }
            self.0 = true;
            buf[0] = b'x';
            Ok(1)
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_download_is_written_under_a_name_of_its_own_and_never_through_what_lies_beside_it() {
        let d = std::env::temp_dir().join(format!("llembas-download-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("project")).unwrap();
        fs::create_dir_all(d.join("outside")).unwrap();
        fs::write(d.join("outside/secret.txt"), "no").unwrap();
        let dest = d.join("project/report.pdf");
        // What the old way wrote to: `report.pdf.part`, here a link out of the folder, and
        // somebody's own file that happens to be called so.
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            d.join("outside/secret.txt"),
            d.join("project/report.pdf.part"),
        )
        .unwrap();
        fs::write(d.join("project/notes.part"), "mine").unwrap();
        let body = b"%PDF-1.7 a report";
        let n = save_stream(
            &body[..],
            Some(body.len() as u64),
            &Dest::chosen(&dest),
            DOWNLOAD_LIMIT,
        )
        .unwrap();
        assert_eq!(n, body.len() as u64);
        assert_eq!(fs::read(&dest).unwrap(), body);
        assert_eq!(
            fs::read_to_string(d.join("outside/secret.txt")).unwrap(),
            "no"
        );
        #[cfg(unix)]
        assert!(fs::symlink_metadata(d.join("project/report.pdf.part"))
            .unwrap()
            .file_type()
            .is_symlink());
        // One that breaks off leaves nothing, and takes nothing that was there with it.
        let notes = d.join("project/notes");
        assert!(save_stream(Broken(false), None, &Dest::chosen(&notes), DOWNLOAD_LIMIT).is_err());
        assert!(!notes.exists());
        assert_eq!(
            fs::read_to_string(d.join("project/notes.part")).unwrap(),
            "mine"
        );
        // Longer than is downloaded: refused by what it says of itself before a byte is
        // written, and stopped where it says nothing.
        let said = save_stream(&body[..], Some(10), &Dest::chosen(&notes), 4).unwrap_err();
        assert_eq!(said.status, 413);
        let unsaid = save_stream(&body[..], None, &Dest::chosen(&notes), 4).unwrap_err();
        assert_eq!(unsaid.status, 413);
        assert!(!notes.exists());
        assert_eq!(
            save_stream(&body[..4], None, &Dest::chosen(&notes), 4).unwrap(),
            4
        );
        // Into a folder of the agent's: never over what is there, and the file it is written
        // to meanwhile passes the same rule as the place it is going.
        let allow: &dyn Fn(&Path) -> Result<(), String> = &|_| Ok(());
        let refuse: &dyn Fn(&Path) -> Result<(), String> = &|_| Err("not there".into());
        let taken = Dest {
            at: &dest,
            new: true,
            check: Some(allow),
        };
        let over = save_stream(&b"other"[..], None, &taken, DOWNLOAD_LIMIT).unwrap_err();
        assert_eq!(over.status, 0);
        assert_eq!(fs::read(&dest).unwrap(), body);
        let free = d.join("project/report (2).pdf");
        let fresh = Dest {
            at: &free,
            new: true,
            check: Some(allow),
        };
        assert_eq!(
            save_stream(&b"other"[..], None, &fresh, DOWNLOAD_LIMIT).unwrap(),
            5
        );
        let kept = d.join("project/kept.pdf");
        let guarded = Dest {
            at: &kept,
            new: true,
            check: Some(refuse),
        };
        let refused = save_stream(&b"other"[..], None, &guarded, DOWNLOAD_LIMIT).unwrap_err();
        assert_eq!(
            (refused.status, refused.detail.as_str()),
            (400, "not there")
        );
        assert!(!kept.exists());
        // A place there is no folder for.
        assert!(save_stream(
            &body[..],
            None,
            &Dest::chosen(&d.join("nowhere/x.pdf")),
            DOWNLOAD_LIMIT
        )
        .is_err());
        // Nothing written meanwhile is left behind.
        let mut expected = vec![
            "notes".to_string(),
            "notes.part".to_string(),
            "report (2).pdf".to_string(),
            "report.pdf".to_string(),
        ];
        if cfg!(unix) {
            expected.push("report.pdf.part".to_string());
        }
        expected.sort();
        assert_eq!(names(&d.join("project")), expected);
        fs::remove_dir_all(&d).unwrap();
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
    fn a_models_picture_is_one_file_on_the_app_door() {
        assert_eq!(
            image_path("/api/v2/models/images/0a1b2c3d4e5f.png").as_deref(),
            Some("/models/images/0a1b2c3d4e5f.png")
        );
        assert_eq!(
            image_path("/models/images/a-b_c.webp").as_deref(),
            Some("/models/images/a-b_c.webp")
        );
        assert_eq!(
            image_path("/api/v2/attachments/att_01x").as_deref(),
            Some("/attachments/att_01x")
        );
        for bad in [
            "/api/v2/models/images/",
            "/api/v2/models/images/../me",
            "/api/v2/models/images/a/b.png",
            "/api/v2/models/images/.hidden",
            "/api/v2/chats/x",
            "/api/v2/attachments/",
            "/api/v2/attachments/a/b",
            "/api/v2/attachments/..",
            "/uploads/models/a.png",
            "https://elsewhere/models/images/a.png",
        ] {
            assert!(image_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn base64_is_the_standard_alphabet_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn a_drawn_picture_is_read_only_as_one_of_the_persons_own_files() {
        assert_eq!(
            own_file_id("https://ai.example/v1/files/abc_12-3/content").as_deref(),
            Some("abc_12-3")
        );
        assert_eq!(
            own_file_id("http://other/v1/files/x/content?t=1").as_deref(),
            Some("x")
        );
        assert_eq!(own_file_id("https://ai.example/v1/files/../content"), None);
        assert_eq!(own_file_id("https://ai.example/v1/files//content"), None);
        assert_eq!(own_file_id("https://ai.example/uploads/x/content"), None);
        assert_eq!(
            own_file_id("https://ai.example/v1/files/a%2Fb/content"),
            None
        );
        assert_eq!(own_file_id("javascript:alert(1)"), None);
    }

    #[test]
    fn a_recording_says_one_of_the_known_types() {
        assert_eq!(recording_type("audio/webm;codecs=opus"), "audio/webm");
        assert_eq!(recording_type("Audio/OGG"), "audio/ogg");
        assert_eq!(recording_type("text/html"), "audio/webm");
        let body = String::from_utf8(multipart_typed(
            "B",
            "file",
            "speech.webm",
            "audio/webm",
            b"x",
        ))
        .unwrap();
        assert!(body.contains("filename=\"speech.webm\"\r\nContent-Type: audio/webm\r\n"));
    }

    #[test]
    fn a_recording_says_which_chat_it_is_for() {
        let open = MediaFor::new("chat-1_a", "local/qwen").unwrap();
        assert_eq!(open.field(), Some(("chat_id", "chat-1_a")));
        let draft = MediaFor::new("", " local/qwen ").unwrap();
        assert_eq!(draft.field(), Some(("chat_model", "local/qwen")));
        assert_eq!(MediaFor::new("", "").unwrap().field(), None);
        assert!(MediaFor::new("a/b", "").is_err());
        assert!(MediaFor::new("", "a\r\nb").is_err());
        assert!(MediaFor::new("", &"m".repeat(301)).is_err());

        let fields: Vec<(&str, &str)> = draft.field().into_iter().collect();
        let body = String::from_utf8(multipart_with(
            "B",
            &fields,
            "file",
            "speech.webm",
            "audio/webm",
            b"x",
        ))
        .unwrap();
        assert!(body.starts_with(
            "--B\r\nContent-Disposition: form-data; name=\"chat_model\"\r\n\r\nlocal/qwen\r\n--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.webm\"\r\n"
        ));
        assert!(body.ends_with("\r\nx\r\n--B--\r\n"));
        // A value cannot open a field of its own.
        let broken = String::from_utf8(multipart_with(
            "B",
            &[("chat_model", "a\r\n--B\r\nb")],
            "file",
            "f",
            "audio/webm",
            b"x",
        ))
        .unwrap();
        assert_eq!(broken.matches("\r\n--B").count(), 2);

        assert_eq!(
            speech_body("Hello", &open),
            serde_json::json!({ "input": "Hello", "response_format": "mp3", "chat_id": "chat-1_a" })
        );
        assert_eq!(
            speech_body("Hello", &MediaFor::default()),
            serde_json::json!({ "input": "Hello", "response_format": "mp3" })
        );
    }

    #[test]
    fn what_answered_is_read_from_the_two_headers() {
        assert_eq!(answered(None, None), Answered::default());
        assert_eq!(
            answered(Some("stt%2Fwhisper%20%C5%BE"), None),
            Answered {
                source: "stt/whisper ž".into(),
                fallback: false
            }
        );
        assert!(answered(Some("stt/whisper"), Some("1")).fallback);
        assert!(!answered(Some("stt/whisper"), Some("0")).fallback);
        // Fallen back to nothing that has a name is not said.
        assert!(!answered(None, Some("1")).fallback);
        assert_eq!(answered(Some("a%0D%0Ab"), Some("1")).source, "ab");
        assert_eq!(
            serde_json::to_value(Heard {
                text: "hi".into(),
                by: answered(Some("x"), Some("1"))
            })
            .unwrap(),
            serde_json::json!({ "text": "hi", "source": "x", "fallback": true })
        );
    }

    #[test]
    fn a_file_goes_as_one_multipart_field() {
        let body = multipart("XYZ", "file", "a\"b\r\n.txt", b"hello");
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with(
            "--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a_b__.txt\"\r\n"
        ));
        assert!(text.contains("\r\n\r\nhello\r\n--XYZ--\r\n"));
        assert_eq!(header_name("  "), "file");
        assert_eq!(header_name("Schöne Grüße.pdf"), "Schöne Grüße.pdf");
        let library = String::from_utf8(multipart("XYZ", "files", "b.md", b"x")).unwrap();
        assert!(library.contains("name=\"files\"; filename=\"b.md\""));
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
