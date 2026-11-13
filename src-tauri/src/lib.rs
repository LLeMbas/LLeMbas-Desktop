//! LLeMbas Desktop: the agent on this computer, and the chats on your LLeMbas server, in an app
//! of its own.
//!
//! - **One window, `main`, one page: the app's own** (`ui/`). It draws its own title bar, the
//!   chats, the two explorers and the viewer. No server page is ever loaded into it: the page
//!   talks to the server's `/api/v2` through the commands here (`server.rs`), and the token that
//!   takes stays in Rust.
//! - **Only that page gets the bridge.** The one capability names the `main` window and no remote
//!   URL; the window refuses every navigation away from the app's page, and HTML the viewer shows
//!   is a sealed frame on a scheme of its own with no IPC and no network (`sealed.rs`).
//! - **The agent is the CLI's**: the app's own sign-in also gives the agent's token, in the same
//!   approval, and `lembas login --token-stdin` takes it; *Link this computer* is a login for the
//!   agent's token alone, handed over the same way. `lembas service run` is the device
//!   (`agent.rs`). The app reads the CLI's state and runs its commands; it never writes the
//!   CLI's files.
//! - **A 2.0 server only.** Discovery is checked before anything else (`server::check`).

mod agent;
mod cli;
mod files;
mod python;
mod remote;
mod sealed;
mod server;
mod settings;
mod terminal;
mod watch;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::window::Color;
use tauri::{
    AppHandle, DragDropEvent, Emitter, LogicalPosition, Manager, RunEvent, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::{Action, ActionPerformed, ActionType, NotificationExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use agent::{Agent, State as AgentState};
use remote::Remote;
use server::{Account, ApiError, Discovery};
use settings::Settings;

/// The colours the window paints itself, read out of `ui/tokens.css` by `build.rs`.
mod tokens {
    include!(concat!(env!("OUT_DIR"), "/tokens.rs"));
}

const MAIN: &str = "main";

/// The two looks the server's tokens define, named as `tokens.css` selects them (`data-theme`).
/// The account's theme, as `/api/v2/me` says; a custom theme counts as Moria, the default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Theme {
    Moria,
    Shire,
}

impl Theme {
    fn parse(name: &str) -> Option<Theme> {
        match name {
            "moria" => Some(Theme::Moria),
            "shire" => Some(Theme::Shire),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Theme::Moria => "moria",
            Theme::Shire => "shire",
        }
    }

    /// The window's own colour, `--bg`: what shows before the page has painted, so a dark
    /// theme does not start with a white flash.
    fn background(self) -> Color {
        let (r, g, b) = match self {
            Theme::Moria => tokens::MORIA_BG,
            Theme::Shire => tokens::SHIRE_BG,
        };
        Color(r, g, b, 0xFF)
    }
}

struct App {
    config_dir: PathBuf,
    settings: Mutex<Settings>,
    agent: Agent,
    tray: Mutex<Option<TrayItems>>,
    linking: Mutex<bool>,
    /// Set to stop waiting for the approval of a link in progress.
    link_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// The newer release the last check found, if any.
    update: Mutex<Option<String>>,
    /// The agent's folders, as `lembas remote` last answered.
    remote: Mutex<Option<Remote>>,
    theme: Mutex<Theme>,
    /// The chosen server, once discovery has passed.
    server: Mutex<Option<Discovery>>,
    /// Why the chosen server was refused, or could not be reached, at the last look.
    refused: Mutex<Option<String>>,
    /// The app's own sign-in to that server.
    account: Mutex<Option<Account>>,
    /// Set to cancel the device login in progress.
    signing_in: Mutex<Option<Arc<AtomicBool>>>,
    streams: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next_stream: AtomicU64,
    /// The terminal panel's sockets (`terminal.rs`), by the page's id for each.
    terminals: terminal::Sessions,
    sealed: sealed::Pages,
    /// The Pyodide release the `python` tool's runner is served from, once verified (`python.rs`).
    python: python::Runtime,
    watch: watch::Watch,
    /// The files last dropped on the window: what `attach_dropped` may send, and nothing else.
    dropped: Mutex<Vec<PathBuf>>,
    /// Until when the page's own Dictate button may have the microphone (`voice_arm`): a request
    /// for it at any other moment is refused.
    mic_until: Mutex<Option<std::time::Instant>>,
}

struct TrayItems {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

impl App {
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn update(&self, f: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut s = self.settings.lock().unwrap();
        f(&mut s);
        settings::save(&self.config_dir, &s)
            .map_err(|e| format!("could not save the settings: {e}"))?;
        Ok(s.clone())
    }

    fn theme(&self) -> Theme {
        *self.theme.lock().unwrap()
    }

    /// The app door and the token, when the app is signed in to a server that passed.
    fn door(&self) -> Option<(String, String)> {
        let server = self.server.lock().unwrap().clone()?;
        let account = self.account.lock().unwrap().clone()?;
        Some((server.app, account.token))
    }

    /// The server's own address and the app's token: for the `/v1` routes (voice, pictures).
    fn door_v1(&self) -> Option<(String, String)> {
        let server = self.server.lock().unwrap().clone()?;
        let account = self.account.lock().unwrap().clone()?;
        Some((server.base, account.token))
    }

    /// The folders the agent may use: what the explorer and the viewer may read.
    fn roots(&self) -> Vec<String> {
        self.remote
            .lock()
            .unwrap()
            .as_ref()
            .filter(|r| r.usable())
            .map(|r| r.roots.clone())
            .unwrap_or_default()
    }
}

/// What the app's page draws from: everything but the token.
#[derive(Clone, Serialize)]
struct Status {
    version: &'static str,
    /// The chosen server's address.
    server: Option<String>,
    /// What discovery said about it, once it passed.
    discovery: Option<Discovery>,
    refused: Option<String>,
    /// Discovery has answered (or failed) for the chosen server.
    checked: bool,
    account: Option<Account>,
    signing_in: bool,
    linked: bool,
    agent: AgentState,
    agent_wanted: bool,
    /// A newer release of the app, when the last check found one.
    update: Option<String>,
    /// Which folders the agent may open sessions in (None: not known yet).
    remote: Option<Remote>,
    theme: &'static str,
    /// This computer's name: the device an agent chat on it runs on says this `host`.
    host: Option<String>,
    notify: bool,
}

fn status(app: &App) -> Status {
    let s = app.settings();
    let discovery = app.server.lock().unwrap().clone();
    let refused = app.refused.lock().unwrap().clone();
    Status {
        version: env!("CARGO_PKG_VERSION"),
        linked: s.server.as_deref().is_some_and(cli::linked_to),
        checked: s.server.is_none() || discovery.is_some() || refused.is_some(),
        server: s.server,
        discovery,
        refused,
        account: app.account.lock().unwrap().as_ref().map(Account::public),
        signing_in: app.signing_in.lock().unwrap().is_some(),
        agent: app.agent.state(),
        agent_wanted: app.agent.wanted(),
        update: app.update.lock().unwrap().clone(),
        remote: app.remote.lock().unwrap().clone(),
        theme: app.theme().name(),
        host: cli::hostname(),
        notify: s.notify,
    }
}

fn status_of(handle: &AppHandle) -> Status {
    status(&handle.state::<App>())
}

fn announce(handle: &AppHandle) {
    let _ = handle.emit("status", status_of(handle));
}

#[tauri::command]
fn get_status(app: tauri::State<'_, App>) -> Status {
    status(&app)
}

// --- The server ------------------------------------------------------------------------------

/// Look at the chosen server again (at start, and when the page asks): discovery, and the
/// sign-in kept for it.
fn check_server(handle: &AppHandle) {
    let app = handle.state::<App>();
    let Some(base) = app.settings().server else {
        return;
    };
    let found = server::discover(&base);
    match found {
        Ok(d) => {
            *app.account.lock().unwrap() = server::load_account(&app.config_dir, &d.base);
            *app.server.lock().unwrap() = Some(d);
            *app.refused.lock().unwrap() = None;
        }
        Err(why) => {
            *app.server.lock().unwrap() = None;
            *app.refused.lock().unwrap() = Some(why);
        }
    }
    announce(handle);
}

#[tauri::command]
async fn recheck_server(handle: AppHandle) -> Result<Status, String> {
    let h = handle.clone();
    tauri::async_runtime::spawn_blocking(move || check_server(&h))
        .await
        .map_err(|e| e.to_string())?;
    Ok(status_of(&handle))
}

/// Check that `address` is a LLeMbas 2.0 server and remember it. A refused one is not kept.
#[tauri::command]
async fn set_server(handle: AppHandle, address: String) -> Result<Status, String> {
    let base = settings::normalise(&address)?;
    let probe = base.clone();
    let d = tauri::async_runtime::spawn_blocking(move || server::discover(&probe))
        .await
        .map_err(|e| e.to_string())??;
    let app = handle.state::<App>();
    let before = app.settings().server;
    app.update(|s| s.server = Some(d.base.clone()))?;
    if before.as_deref() != Some(d.base.as_str()) {
        app.agent.stop();
        app.watch.reset();
        app.terminals.close_all();
        // Another server: its Pyodide is not the one made ready, and is not served any more.
        app.python.clear();
        app.sealed.clear_pages();
    }
    *app.account.lock().unwrap() = server::load_account(&app.config_dir, &d.base);
    *app.server.lock().unwrap() = Some(d);
    *app.refused.lock().unwrap() = None;
    announce(&handle);
    Ok(status_of(&handle))
}

/// What the page hears while signing in: the code, then the outcome.
#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum SignIn {
    Code { code: server::Code },
    Done,
    Failed { message: String },
}

/// Sign the app in to the server: a device login for the app's scopes, approved in the browser.
/// Where the server can (`one_approval`), the same approval asks for the agent's token too, unless
/// the agent's link works right now (the CLI says it is linked). Whether the CLI has a login for
/// this server on file is not asked: a login the server refuses is a file all the same, and
/// asking that left a computer with a refused link and no way to a new one from the sign-in.
/// After the approval the agent's token goes to the CLI -- whose `--token-stdin` login replaces
/// the one it had for this server -- or, when the link came up meanwhile, is given up.
#[tauri::command]
fn sign_in(handle: AppHandle) -> Result<(), String> {
    let app = handle.state::<App>();
    let Some(d) = app.server.lock().unwrap().clone() else {
        return Err("Choose a LLeMbas 2.0 server first.".into());
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut busy = app.signing_in.lock().unwrap();
        if let Some(old) = busy.take() {
            old.store(true, Ordering::SeqCst);
        }
        *busy = Some(cancel.clone());
    }
    announce(&handle);
    std::thread::spawn(move || {
        let host = cli::hostname().unwrap_or_default();
        let with_agent = d.one_approval && !link_works(&handle.state::<App>());
        let result = server::start_sign_in(&d, &host, with_agent).and_then(|code| {
            let _ = handle
                .opener()
                .open_url(&code.verification_uri_complete, None::<&str>);
            let _ = handle.emit("signin", SignIn::Code { code: code.clone() });
            server::await_sign_in(&d, &code, &cancel)
        });
        let app = handle.state::<App>();
        {
            let mut busy = app.signing_in.lock().unwrap();
            if busy.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
                *busy = None;
            }
        }
        let mut agent_token = None;
        let outcome = match result {
            Ok(granted) => match server::save_account(&app.config_dir, &granted.account) {
                Ok(()) => {
                    *app.account.lock().unwrap() = Some(granted.account);
                    app.watch.reset();
                    agent_token = granted.agent_token;
                    SignIn::Done
                }
                Err(e) => {
                    // Nobody holds either token now: give both up.
                    server::sign_out(&d.base, &granted.account.token);
                    if let Some(t) = granted.agent_token {
                        server::sign_out(&d.base, &t);
                    }
                    SignIn::Failed {
                        message: format!("The sign-in could not be saved: {e}"),
                    }
                }
            },
            Err(message) => SignIn::Failed { message },
        };
        let _ = handle.emit("signin", outcome);
        announce(&handle);
        if let Some(token) = agent_token {
            if link_works(&app) {
                // Linked meanwhile (a service started by hand, say): this token is nobody's.
                server::sign_out(&d.base, &token);
            } else if let Err(message) = hand_to_cli(&handle, &d.base, token) {
                let _ = handle.emit("linking", Linking::Failed { message });
                announce(&handle);
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn sign_in_cancel(handle: AppHandle) {
    if let Some(c) = handle.state::<App>().signing_in.lock().unwrap().take() {
        c.store(true, Ordering::SeqCst);
    }
    announce(&handle);
}

/// Sign the app out: the token is given up on the server and forgotten here. The agent's own
/// link (the CLI's) is not touched.
#[tauri::command]
fn sign_out(handle: AppHandle) {
    let app = handle.state::<App>();
    let account = app.account.lock().unwrap().take();
    server::forget_account(&app.config_dir);
    app.watch.reset();
    app.terminals.close_all();
    app.python.clear();
    app.sealed.clear_pages();
    if let Some(a) = account {
        std::thread::spawn(move || server::sign_out(&a.server, &a.token));
    }
    announce(&handle);
}

/// The token was refused: it was revoked, or expired. Forget it, so the page asks to sign in.
fn token_refused(handle: &AppHandle) {
    let app = handle.state::<App>();
    if app.account.lock().unwrap().take().is_some() {
        server::forget_account(&app.config_dir);
        app.terminals.close_all();
        app.python.clear();
        app.sealed.clear_pages();
        announce(handle);
    }
}

/// One request to the server's `/api/v2`, as the signed-in account: `path` from there on
/// (`/chats?kind=agent`). The answer's JSON, or the server's error.
#[tauri::command]
async fn api(
    handle: AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        server::request(&app_url, &token, &method, &path, body.as_ref())
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?;
    if matches!(&result, Err(e) if e.status == 401) {
        token_refused(&handle);
    }
    result
}

/// One request to `/api/v2` that answers plain text: the file a `show` card names.
#[tauri::command]
async fn api_text(handle: AppHandle, path: String) -> Result<String, ApiError> {
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || server::request_text(&app_url, &token, &path))
            .await
            .map_err(|e| ApiError::new(0, e.to_string()))?;
    if matches!(&result, Err(e) if e.status == 401) {
        token_refused(&handle);
    }
    result
}

/// A model's picture (`image` in `/api/v2/models`), as a `data:` URL: the page's policy allows
/// images from `data:` and reaches the server only through the bridge.
#[tauri::command]
async fn model_image(handle: AppHandle, path: String) -> Result<String, ApiError> {
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    tauri::async_runtime::spawn_blocking(move || server::request_image(&app_url, &token, &path))
        .await
        .map_err(|e| ApiError::new(0, e.to_string()))?
}

// --- Voice and pictures (`/v1`, the app's token holds the `models` scope) -----------------------

/// Run a `/v1` call off the page's thread, as the signed-in account; a 401 signs the app out.
async fn on_v1<T: Send + 'static>(
    handle: &AppHandle,
    f: impl FnOnce(&str, &str) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let Some((base, token)) = handle.state::<App>().door_v1() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let result = tauri::async_runtime::spawn_blocking(move || f(&base, &token))
        .await
        .map_err(|e| ApiError::new(0, e.to_string()))?;
    if matches!(&result, Err(e) if e.status == 401) {
        token_refused(handle);
    }
    result
}

/// The page is about to ask for the microphone, because the person pressed Dictate: for the
/// next few seconds a request for it is allowed (`permission`), and at no other time.
#[tauri::command]
fn voice_arm(app: tauri::State<'_, App>) {
    *app.mic_until.lock().unwrap() =
        Some(std::time::Instant::now() + std::time::Duration::from_secs(10));
}

/// A recording made in the composer, in words: its bytes as the raw body of the call, its media
/// type in `x-type`.
#[tauri::command]
async fn transcribe(
    handle: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, ApiError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(ApiError::new(400, "No recording."));
    };
    if bytes.len() as u64 > server::RECORDING_LIMIT {
        return Err(ApiError::new(413, "That recording is too long."));
    }
    let kind = request
        .headers()
        .get("x-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = bytes.clone();
    on_v1(&handle, move |base, token| {
        server::transcribe(base, token, &kind, &bytes)
    })
    .await
}

/// A reply read aloud, as a `data:` URL of its audio.
#[tauri::command]
async fn speak(handle: AppHandle, text: String) -> Result<String, ApiError> {
    on_v1(&handle, move |base, token| {
        server::speak(base, token, &text)
    })
    .await
}

/// Pictures drawn by the instance for `prompt`, as `data:` URLs.
#[tauri::command]
async fn draw(handle: AppHandle, prompt: String, size: String) -> Result<Vec<String>, ApiError> {
    on_v1(&handle, move |base, token| {
        server::draw(base, token, &prompt, &size)
    })
    .await
}

/// How the CLI is started in a terminal here (`lembas`, or the bundled one by its path): the
/// first word of "continue in a terminal" for an agent chat on this computer.
#[tauri::command]
fn terminal_word() -> String {
    cli::terminal_word()
}

/// A frame of a reply being written, as the page hears it.
#[derive(Clone, Serialize)]
struct Frame {
    id: u64,
    event: String,
    data: Value,
}

/// Follow a reply as it is written: the frames come as `stream` events with this id, and a last
/// one named `end` (its data the error, if it broke off).
#[tauri::command]
fn stream_open(handle: AppHandle, path: String) -> Result<u64, ApiError> {
    let app = handle.state::<App>();
    let Some((app_url, token)) = app.door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    server::checked_path(&path)?;
    let id = app.next_stream.fetch_add(1, Ordering::SeqCst) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    app.streams.lock().unwrap().insert(id, stop.clone());
    std::thread::spawn(move || {
        let emit = |event: &str, data: Value| {
            let _ = handle.emit(
                "stream",
                Frame {
                    id,
                    event: event.to_string(),
                    data,
                },
            );
        };
        let result = server::stream(&app_url, &token, &path, &stop, |event, data| {
            let value = serde_json::from_str(data).unwrap_or(Value::String(data.to_string()));
            emit(event, value);
            !stop.load(Ordering::SeqCst)
        });
        let end = match result {
            Ok(()) => Value::Null,
            Err(e) => {
                if e.status == 401 {
                    token_refused(&handle);
                }
                serde_json::to_value(e).unwrap_or(Value::Null)
            }
        };
        handle.state::<App>().streams.lock().unwrap().remove(&id);
        emit("end", end);
    });
    Ok(id)
}

#[tauri::command]
fn stream_close(app: tauri::State<'_, App>, id: u64) {
    if let Some(stop) = app.streams.lock().unwrap().remove(&id) {
        stop.store(true, Ordering::SeqCst);
    }
}

// --- The terminal panel ------------------------------------------------------------------------

/// Open a shell on a linked device, as the terminal panel asks: an agent chat's (`chat`), or the
/// one before the chat exists (`device` and `directory`). The socket is opened here, with the
/// app's token in its handshake; the page gets its frames as `terminal` events with this id --
/// `output` (base64), `control` (the server's JSON), and a last `end`.
#[tauri::command]
fn terminal_open(
    handle: AppHandle,
    chat: Option<String>,
    device: Option<String>,
    directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, ApiError> {
    let app = handle.state::<App>();
    let Some((app_url, token)) = app.door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let target = match (chat, device) {
        (Some(chat), None) => terminal::Target::Chat(chat),
        (None, Some(device)) => terminal::Target::Device {
            device,
            directory: directory.unwrap_or_default(),
        },
        _ => return Err(ApiError::new(400, "A chat or a device, not both.")),
    };
    let url = terminal::url(&app_url, &target, cols, rows)?;
    let h = handle.clone();
    let on_end = handle.clone();
    Ok(app.terminals.open(
        url,
        token,
        move |down| {
            let _ = h.emit("terminal", down);
        },
        move |id, end| {
            on_end.state::<App>().terminals.forget(id);
            if end.unauthorized() {
                token_refused(&on_end);
            }
        },
    ))
}

/// Keys typed (or pasted) into a terminal, as text: sent to the shell as its bytes.
#[tauri::command]
fn terminal_input(app: tauri::State<'_, App>, id: u64, data: String) -> bool {
    app.terminals
        .send(id, terminal::Up::Keys(data.into_bytes()))
}

/// The terminal's size changed.
#[tauri::command]
fn terminal_resize(app: tauri::State<'_, App>, id: u64, cols: u16, rows: u16) -> bool {
    app.terminals.send(id, terminal::Up::Resize(cols, rows))
}

/// The page let go of a terminal: its socket is closed (the shell on the device lives on, as
/// the server keeps it).
#[tauri::command]
fn terminal_close(app: tauri::State<'_, App>, id: u64) {
    app.terminals.close(id);
}

// --- Attachments ----------------------------------------------------------------------------------

/// What became of one file sent as an attachment: the server's attachment, or why not. `reason`
/// names the refusals made here, so the page can say them in its language; the server's own
/// refusals come in the account's language already.
#[derive(Clone, Serialize)]
struct Uploaded {
    name: String,
    size: u64,
    attachment: Option<Value>,
    error: Option<String>,
    reason: Option<&'static str>,
}

fn read_for_upload(path: &std::path::Path) -> Result<Vec<u8>, (&'static str, String)> {
    let meta = std::fs::metadata(path).map_err(|e| ("unreadable", e.to_string()))?;
    if meta.is_dir() {
        return Err(("folder", "This is a folder.".into()));
    }
    if meta.len() > server::UPLOAD_LIMIT {
        return Err(("too_large", "This file is too large to send.".into()));
    }
    std::fs::read(path).map_err(|e| ("unreadable", e.to_string()))
}

/// Send these files, one by one, as attachments for `chat` ("" for a chat not made yet). Only
/// ever called with paths the person chose: in the file dialog, or by dropping them on the window.
fn upload_paths(
    handle: &AppHandle,
    paths: Vec<PathBuf>,
    chat: &str,
) -> Result<Vec<Uploaded>, ApiError> {
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let mut out = Vec::new();
    for path in paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let sent = match read_for_upload(&path) {
            Ok(bytes) => server::upload(&app_url, &token, chat, &name, &bytes).map_err(|e| {
                if e.status == 401 {
                    token_refused(handle);
                }
                (None, e.detail)
            }),
            Err((reason, message)) => Err((Some(reason), message)),
        };
        out.push(match sent {
            Ok(a) => Uploaded {
                name,
                size,
                attachment: Some(a),
                error: None,
                reason: None,
            },
            Err((reason, message)) => Uploaded {
                name,
                size,
                attachment: None,
                error: Some(message),
                reason,
            },
        });
    }
    Ok(out)
}

/// Choose files with the system's dialog and send them as attachments for `chat`.
#[tauri::command]
async fn attach_pick(
    handle: AppHandle,
    chat: Option<String>,
    title: String,
) -> Result<Vec<Uploaded>, ApiError> {
    let h = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let picked = h.dialog().file().set_title(title).blocking_pick_files();
        let paths: Vec<PathBuf> = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect();
        upload_paths(&h, paths, chat.as_deref().unwrap_or(""))
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?
}

/// Send the files just dropped on the window as attachments for `chat`. Each drop can be sent
/// once.
#[tauri::command]
async fn attach_dropped(
    handle: AppHandle,
    chat: Option<String>,
) -> Result<Vec<Uploaded>, ApiError> {
    let paths = std::mem::take(&mut *handle.state::<App>().dropped.lock().unwrap());
    let h = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        upload_paths(&h, paths, chat.as_deref().unwrap_or(""))
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?
}

/// What an upload into the library came to: the directory's listing after the last file the
/// server took, and the files it did not take, each with the reason.
#[derive(Clone, Serialize)]
struct LibraryUpload {
    listing: Option<Value>,
    sent: usize,
    failed: Vec<Uploaded>,
}

/// Choose files with the system's dialog and send them into the person's library, into the
/// directory `dir`. Nothing is sent when the dialog is cancelled.
#[tauri::command]
async fn library_upload(
    handle: AppHandle,
    dir: String,
    title: String,
) -> Result<LibraryUpload, ApiError> {
    let h = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let picked = h.dialog().file().set_title(title).blocking_pick_files();
        let paths: Vec<PathBuf> = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect();
        let Some((app_url, token)) = h.state::<App>().door() else {
            return Err(ApiError::new(401, "Not signed in."));
        };
        let mut out = LibraryUpload {
            listing: None,
            sent: 0,
            failed: Vec::new(),
        };
        for path in paths {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let sent = match read_for_upload(&path) {
                Ok(bytes) => server::upload_to_library(&app_url, &token, &dir, &name, &bytes)
                    .map_err(|e| {
                        if e.status == 401 {
                            token_refused(&h);
                        }
                        (None, e.detail)
                    }),
                Err((reason, message)) => Err((Some(reason), message)),
            };
            match sent {
                Ok(listing) => {
                    out.listing = Some(listing);
                    out.sent += 1;
                }
                Err((reason, message)) => out.failed.push(Uploaded {
                    name,
                    size,
                    attachment: None,
                    error: Some(message),
                    reason,
                }),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?
}

/// `%XX` escapes undone (the page sends a file's name as `encodeURIComponent` gives it).
fn percent_decode(text: &str) -> String {
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

/// A file pasted into the composer (an image from the clipboard): its bytes as the raw body of
/// the call, its name in `x-name` and the chat in `x-chat`. The page has these bytes only because
/// the person pasted them.
#[tauri::command]
async fn attach_bytes(
    handle: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, ApiError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(ApiError::new(400, "No file."));
    };
    if bytes.len() as u64 > server::UPLOAD_LIMIT {
        return Err(ApiError::new(413, "This file is too large to send."));
    }
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let name = percent_decode(&header("x-name"));
    let chat = header("x-chat");
    let bytes = bytes.clone();
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        server::upload(&app_url, &token, &chat, &name, &bytes)
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?;
    if matches!(&result, Err(e) if e.status == 401) {
        token_refused(&handle);
    }
    result
}

// --- This computer's files ----------------------------------------------------------------------

/// A folder of the agent's, for the explorer: `root` one of the agent's folders (or a folder
/// inside one), `path` inside it.
#[tauri::command]
async fn local_list(
    handle: AppHandle,
    root: String,
    path: String,
) -> Result<files::Listing, String> {
    let roots = handle.state::<App>().roots();
    tauri::async_runtime::spawn_blocking(move || files::list(&roots, &root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// A file of the agent's, for the viewer: as text, or why not.
#[tauri::command]
async fn local_read(
    handle: AppHandle,
    root: String,
    path: String,
) -> Result<files::Opened, String> {
    let roots = handle.state::<App>().roots();
    tauri::async_runtime::spawn_blocking(move || files::read(&roots, &root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// What the page needs to run the `python` tool for the chat it shows: whether the server has
/// Python switched on, and where the runner's frame is.
#[derive(Clone, Serialize)]
struct PythonRunner {
    enabled: bool,
    version: String,
    url: String,
}

/// Make the `python` tool's runner ready: read what the server says of Python (`GET /me`), fetch
/// the files of its pinned Pyodide release that are not already here and intact, check each one's
/// size and SHA-256 against the server's list, and serve them on the runner's own scheme. The
/// page then loads the frame at `url`. Off on the server: nothing is fetched, and none is served.
#[tauri::command]
async fn python_prepare(handle: AppHandle) -> Result<PythonRunner, ApiError> {
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    let root = handle
        .path()
        .app_data_dir()
        .map_err(|e| ApiError::new(0, e.to_string()))?
        .join("pyodide");
    let h = handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<PythonRunner, ApiError> {
        let me = server::request(&app_url, &token, "GET", "/me", None)?;
        let app = h.state::<App>();
        let said = python::specs(me.get("python").unwrap_or(&Value::Null))
            .map_err(|e| ApiError::new(0, e))?;
        let Some((version, specs)) = said else {
            app.python.clear();
            return Ok(PythonRunner {
                enabled: false,
                version: String::new(),
                url: String::new(),
            });
        };
        let fetch = |name: &str| {
            let path = format!("/pyodide/{version}/{name}");
            server::request_bytes(&app_url, &token, &path, python::MAX_FILE).map_err(|e| e.detail)
        };
        let dir =
            python::prepare(&root, &version, &specs, &fetch).map_err(|e| ApiError::new(0, e))?;
        let names = specs.into_iter().map(|s| s.name).collect();
        app.python.set(&version, dir, names);
        Ok(PythonRunner {
            enabled: true,
            url: python::url(&version),
            version,
        })
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?;
    if matches!(&result, Err(e) if e.status == 401) {
        token_refused(&handle);
    }
    result
}

/// Hold HTML for the viewer's sealed frame; the address the frame loads.
#[tauri::command]
fn sealed_open(app: tauri::State<'_, App>, html: String) -> String {
    sealed::url(&app.sealed.hold(html))
}

#[tauri::command]
fn sealed_close(app: tauri::State<'_, App>, url: String) {
    let path = Url::parse(&url)
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    app.sealed.forget(sealed::id_of(&path));
}

/// What the page is told of a page of an answer: where its frame loads it, and its title.
#[derive(Serialize)]
struct AnswerPage {
    url: String,
    title: String,
}

/// A page's digest as the server makes one: 32 lower-case hex digits, nothing else.
fn page_digest(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// A name in a page's address: a message's or a report's id.
fn page_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 96
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A colour as the page's address takes one: `#rgb`, `#rrggbb` or `#rrggbbaa`, nothing else.
fn page_colour(s: &str) -> bool {
    let hex = s.strip_prefix('#').unwrap_or("");
    s.starts_with('#')
        && matches!(hex.len(), 3 | 6 | 8)
        && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// The path of a page of an answer on the server (`/pages/m/{message}/{digest}` or
/// `/pages/r/{report}/{digest}`) with the theme's colours -- also what it is held under; `None`
/// where a part is not what it must be.
fn page_path(
    kind: &str,
    owner: &str,
    digest: &str,
    colours: &[(String, String)],
) -> Option<String> {
    if !matches!(kind, "m" | "r") || !page_name(owner) || !page_digest(digest) {
        return None;
    }
    let mut query = String::new();
    for name in ["bg", "ink", "muted", "accent", "line"] {
        if let Some((_, value)) = colours.iter().find(|(k, v)| k == name && page_colour(v)) {
            query.push(if query.is_empty() { '?' } else { '&' });
            query.push_str(&format!("{name}=%23{}", &value[1..]));
        }
    }
    Some(format!("/pages/{kind}/{owner}/{digest}{query}"))
}

/// A page a model wrote into an answer or a report, made ready for its sealed frame. The server
/// rebuilds the page as a static document (it is the one sanitiser: the app never cleans a
/// model's markup); this fetches that document through the app's own door, holds it, and says
/// where the frame loads it. The page's script never sees the document.
#[tauri::command]
async fn page_open(
    handle: AppHandle,
    kind: String,
    owner: String,
    digest: String,
    colours: Option<std::collections::BTreeMap<String, String>>,
) -> Result<AnswerPage, ApiError> {
    let colours: Vec<(String, String)> = colours.unwrap_or_default().into_iter().collect();
    let Some(path) = page_path(&kind, &owner, &digest, &colours) else {
        return Err(ApiError::new(400, "Not a page's address."));
    };
    let Some((app_url, token)) = handle.state::<App>().door() else {
        return Err(ApiError::new(401, "Not signed in."));
    };
    if let Some(id) = handle.state::<App>().sealed.page(&path) {
        return Ok(AnswerPage {
            url: sealed::url(&id),
            title: String::new(),
        });
    }
    let door = (app_url.clone(), token.clone());
    let asked = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        server::request(&app_url, &token, "GET", &asked, None)
    })
    .await
    .map_err(|e| ApiError::new(0, e.to_string()))?;
    if matches!(&result, Err(e) if e.status == 401) {
        token_refused(&handle);
    }
    let said = result?;
    let Some(html) = said.get("html").and_then(Value::as_str) else {
        return Err(ApiError::new(0, "The server sent no page."));
    };
    // Signed out, or another server, while it was fetched: the page is not this account's to hold.
    if handle.state::<App>().door().as_ref() != Some(&door) {
        return Err(ApiError::new(401, "Not signed in."));
    }
    if html.len() > sealed::PAGE_MAX {
        return Err(ApiError::new(413, "The page is too large to show."));
    }
    // The server rebuilds the page; the app still looks for itself that nothing in what it is
    // about to show could run or reach anywhere (`sealed::page_safe`), and shows nothing if so.
    if let Err(why) = sealed::page_safe(html) {
        log::write(&format!("a page of an answer was not shown: {why}"));
        return Err(ApiError::new(422, "This page could not be shown safely."));
    }
    let title = said
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let id = handle
        .state::<App>()
        .sealed
        .hold_page(&path, html.to_string());
    Ok(AnswerPage {
        url: sealed::url(&id),
        title,
    })
}

/// The pages of answers held are let go: the chat or the report shown is read again, so what
/// is drawn next is asked of the server afresh (a page of a message deleted since is not shown
/// from what was held).
#[tauri::command]
fn pages_clear(app: tauri::State<'_, App>) {
    app.sealed.clear_pages();
}

// --- The page's own settings ---------------------------------------------------------------------

/// The account's theme, as the page read it from the server: the window is painted in it, and
/// it is remembered for the next start.
#[tauri::command]
fn set_theme(handle: AppHandle, name: String) {
    let Some(theme) = Theme::parse(&name) else {
        return;
    };
    let app = handle.state::<App>();
    {
        let mut current = app.theme.lock().unwrap();
        if *current == theme {
            return;
        }
        *current = theme;
    }
    let _ = app.update(|s| s.theme = Some(theme.name().into()));
    if let Some(w) = handle.get_webview_window(MAIN) {
        let _ = w.set_background_color(Some(theme.background()));
    }
    announce(&handle);
}

#[tauri::command]
fn set_notify(handle: AppHandle, on: bool) -> Result<(), String> {
    handle.state::<App>().update(|s| s.notify = on)?;
    announce(&handle);
    Ok(())
}

/// Which chat the page shows (none: `null`), and what notifications say in its language.
#[tauri::command]
fn set_open_chat(app: tauri::State<'_, App>, chat: Option<String>) {
    *app.watch.open.lock().unwrap() = chat;
}

/// Which report the page shows (none: `null`): one being read is not announced.
#[tauri::command]
fn set_open_report(app: tauri::State<'_, App>, report: Option<String>) {
    *app.watch.open_report.lock().unwrap() = report;
}

#[tauri::command]
fn set_words(app: tauri::State<'_, App>, words: watch::Words) {
    *app.watch.words.lock().unwrap() = words;
}

/// A link the page was asked to follow: in the system's browser, and only a web or mail link.
#[tauri::command]
fn open_external(handle: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| format!("Not a link: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!("Not a web link: {url}"));
    }
    handle
        .opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

// --- The agent ----------------------------------------------------------------------------------

#[tauri::command]
fn set_agent(handle: AppHandle, on: bool) -> Result<(), String> {
    set_agent_wanted(&handle, on)
}

#[tauri::command]
fn link_computer(handle: AppHandle) -> Result<(), String> {
    start_link(&handle)
}

/// Stop waiting for the approval of a link in progress.
#[tauri::command]
fn link_cancel(handle: AppHandle) {
    if let Some(c) = handle.state::<App>().link_cancel.lock().unwrap().take() {
        c.store(true, Ordering::SeqCst);
    }
}

/// Whether the agent's link works right now: the CLI says it is linked -- the app's own service,
/// or one started by hand. A login on file is not a link that works.
fn link_works(app: &App) -> bool {
    match app.agent.state() {
        AgentState::Running => true,
        AgentState::Elsewhere(e) => e.linked,
        _ => false,
    }
}

fn set_agent_wanted(handle: &AppHandle, on: bool) -> Result<(), String> {
    let app = handle.state::<App>();
    let s = app.update(|s| s.agent = on)?;
    match (on, s.server) {
        (true, Some(server)) => {
            app.agent.start(server);
            let h = handle.clone();
            std::thread::spawn(move || {
                refresh_remote(&h);
            });
        }
        _ => app.agent.stop(),
    }
    Ok(())
}

/// Ask the CLI which folders the agent may use; remember and announce it.
fn refresh_remote(handle: &AppHandle) -> Option<Remote> {
    let r = remote::run(&["list"]).ok();
    *handle.state::<App>().remote.lock().unwrap() = r.clone();
    announce(handle);
    r
}

/// After a change: remember the new state, and start the app's own agent again when the CLI
/// says the running service cannot take the change live.
fn remote_changed(handle: &AppHandle, r: Remote) {
    let app = handle.state::<App>();
    *app.remote.lock().unwrap() = Some(r.clone());
    if r.restart_needed && app.agent.wanted() {
        if let Some(server) = app.settings().server {
            app.agent.start(server);
        }
    }
    announce(handle);
}

/// Run a `lembas remote` change off the main thread; the page hears the outcome as `status`,
/// or as `remote-error`.
fn change_remote(handle: &AppHandle, args: Vec<String>) {
    let h = handle.clone();
    std::thread::spawn(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match remote::run(&refs) {
            Ok(r) => remote_changed(&h, r),
            Err(e) => {
                let _ = h.emit("remote-error", e);
            }
        }
    });
}

#[tauri::command]
fn remote_refresh(handle: AppHandle) {
    std::thread::spawn(move || {
        refresh_remote(&handle);
    });
}

/// Choose a folder with the system's dialog and let the agent work in it (this turns remote
/// control on, if it was off).
#[tauri::command]
fn remote_add(handle: AppHandle) {
    let h = handle.clone();
    handle
        .dialog()
        .file()
        .set_title("A folder the agent may work in")
        .pick_folder(move |picked| {
            if let Some(path) = picked.and_then(|p| p.into_path().ok()) {
                change_remote(&h, vec!["add".into(), path.to_string_lossy().into_owned()]);
            }
        });
}

#[tauri::command]
fn remote_remove(handle: AppHandle, dir: String) {
    change_remote(&handle, vec!["remove".into(), dir]);
}

#[tauri::command]
fn remote_mode(handle: AppHandle, mode: String) -> Result<(), String> {
    if !["manual", "edit", "auto", "plan"].contains(&mode.as_str()) {
        return Err(format!("no such mode: {mode}"));
    }
    change_remote(&handle, vec!["mode".into(), mode]);
    Ok(())
}

#[tauri::command]
fn remote_terminal(handle: AppHandle, on: bool) {
    change_remote(
        &handle,
        vec!["terminal".into(), if on { "on" } else { "off" }.into()],
    );
}

/// What the page hears while the computer is linked: the code, then the outcome.
#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Linking {
    Code { user_code: String, uri: String },
    Done,
    Failed { message: String },
}

/// Link this computer (again): a device login for the agent's scopes alone, the approval opened
/// in the system's browser (where the person is signed in to the server), the token handed to
/// the CLI (`lembas login --token-stdin`, which replaces a login it had for this server), then the
/// agent started. Not `lembas login <server>`: for a server the CLI is logged in to already, that
/// only refreshes the login it has, so a token the server refused would stay refused.
fn start_link(handle: &AppHandle) -> Result<(), String> {
    let app = handle.state::<App>();
    let Some(d) = app.server.lock().unwrap().clone() else {
        return Err("Choose a LLeMbas 2.0 server first.".into());
    };
    claim_linking(&app)?;
    let cancel = Arc::new(AtomicBool::new(false));
    *app.link_cancel.lock().unwrap() = Some(cancel.clone());
    let handle = handle.clone();
    std::thread::spawn(move || {
        let host = cli::hostname().unwrap_or_default();
        let result = server::start_link(&d, &host).and_then(|code| {
            let _ = handle
                .opener()
                .open_url(&code.verification_uri_complete, None::<&str>);
            let _ = handle.emit(
                "linking",
                Linking::Code {
                    user_code: code.user_code.clone(),
                    uri: code.verification_uri_complete.clone(),
                },
            );
            server::await_sign_in(&d, &code, &cancel)
        });
        let app = handle.state::<App>();
        app.link_cancel.lock().unwrap().take();
        let given = match result {
            Ok(granted) => give_to_cli(&handle, &d.base, granted.account.token),
            Err(message) => {
                *app.linking.lock().unwrap() = false;
                Err(message)
            }
        };
        if let Err(message) = given {
            let _ = handle.emit("linking", Linking::Failed { message });
        }
        announce(&handle);
    });
    Ok(())
}

/// Hand the agent's token from the app's own approval to the bundled CLI:
/// `lembas login --token-stdin --server <url> --json`. The token goes on the CLI's standard
/// input and nowhere else -- not an argument, not the environment, not a file of the app's --
/// and the CLI writes its own files, as `lembas login` does. If the CLI does not take it, the
/// token is given up on the server, so no live token is left that nobody holds.
fn hand_to_cli(handle: &AppHandle, base: &str, token: String) -> Result<(), String> {
    let app = handle.state::<App>();
    if let Err(e) = claim_linking(&app) {
        server::sign_out(base, &token);
        return Err(e);
    }
    give_to_cli(handle, base, token)
}

/// `hand_to_cli` once linking is claimed: the CLI takes the token, or it is given up.
fn give_to_cli(handle: &AppHandle, base: &str, token: String) -> Result<(), String> {
    let app = handle.state::<App>();
    let spawned = Command::new(cli::binary())
        .args(["login", "--token-stdin", "--server", base, "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            *app.linking.lock().unwrap() = false;
            server::sign_out(base, &token);
            return Err(format!("Could not start {}: {e}", cli::binary().display()));
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        // Dropped at the end of this block: the CLI reads to the end of its input.
        let _ = stdin.write_all(format!("{token}\n").as_bytes());
    }
    follow_login(handle, child, Some((base.to_string(), token)));
    Ok(())
}

fn claim_linking(app: &App) -> Result<(), String> {
    let mut busy = app.linking.lock().unwrap();
    if *busy {
        return Err("Linking is already in progress.".into());
    }
    *busy = true;
    Ok(())
}

/// Read a `lembas login --json` to its end: a code to approve (opened in the browser), then
/// `done` or `error`; the agent started on success. `revoke`: the server and the token to give
/// up if the login fails (the agent's token from the app's approval).
fn follow_login(
    handle: &AppHandle,
    mut child: std::process::Child,
    mut revoke: Option<(String, String)>,
) {
    let handle = handle.clone();
    std::thread::spawn(move || {
        let mut failure: Option<String> = None;
        let mut done = false;
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(ev) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match ev.get("event").and_then(Value::as_str) {
                    Some("code") => {
                        // A CLI asking for an approval did not take the token it was handed
                        // (one too old for `--token-stdin`): give that token up now, and let
                        // this login go on as the two-step one.
                        if let Some((base, token)) = revoke.take() {
                            server::sign_out(&base, &token);
                        }
                        let field =
                            |k: &str| ev.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                        let uri = field("verification_uri_complete");
                        if Url::parse(&uri).is_ok() {
                            let _ = handle.opener().open_url(&uri, None::<&str>);
                        }
                        let _ = handle.emit(
                            "linking",
                            Linking::Code {
                                user_code: field("user_code"),
                                uri,
                            },
                        );
                    }
                    Some("done") => done = true,
                    Some("error") => {
                        failure = ev.get("message").and_then(Value::as_str).map(String::from)
                    }
                    _ => {}
                }
            }
        }
        let status = child.wait();
        if !done && failure.is_none() {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut e, &mut err);
            }
            failure = Some(match status {
                Ok(s) if !err.trim().is_empty() => format!("{} ({s})", err.trim()),
                Ok(s) => format!("lembas login ended without linking ({s})"),
                Err(e) => e.to_string(),
            });
        }
        *handle.state::<App>().linking.lock().unwrap() = false;
        match failure {
            None => {
                let _ = handle.emit("linking", Linking::Done);
                let _ = set_agent_wanted(&handle, true);
            }
            Some(message) => {
                if let Some((base, token)) = revoke {
                    server::sign_out(&base, &token);
                }
                let _ = handle.emit("linking", Linking::Failed { message });
            }
        }
        announce(&handle);
    });
}

// --- The window, the tray and the menu ------------------------------------------------------------

fn main_window(handle: &AppHandle) -> Option<WebviewWindow> {
    handle.get_webview_window(MAIN)
}

/// Bring the window to the front, made if it is not there.
fn show(handle: &AppHandle) {
    if let Some(w) = main_window(handle) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else if let Err(e) = build_main(handle) {
        log::write(&format!("could not open the window: {e}"));
    }
}

fn build_main(handle: &AppHandle) -> tauri::Result<WebviewWindow> {
    let theme = handle.state::<App>().theme();
    WebviewWindowBuilder::new(handle, MAIN, WebviewUrl::App("index.html".into()))
        .title("LLeMbas")
        .inner_size(1280.0, 840.0)
        .min_inner_size(360.0, 480.0)
        // The app draws its own title bar; Tauri makes the edges resize an undecorated window.
        .decorations(false)
        .background_color(theme.background())
        .on_navigation(allowed)
        .on_permission_request(permission)
        .build()
        .inspect(media_stream)
}

/// WebKitGTK answers no permission request its app does not, and has no prompt of its own. The
/// microphone is allowed when the page's own Dictate button has just asked for it (`voice_arm`,
/// which only the app's page can call: sealed frames have no bridge), once; nothing else is.
fn permission(view: tauri::Webview, kind: PermissionKind) -> PermissionResponse {
    if kind != PermissionKind::Microphone {
        return PermissionResponse::Default;
    }
    let app = view.app_handle().state::<App>();
    let armed = app.mic_until.lock().unwrap().take();
    if armed.is_some_and(|until| std::time::Instant::now() <= until) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

/// `getUserMedia` is off in WebKitGTK unless the app turns it on (it is on in other webviews).
/// The settings are read with their own getter: the `settings` property is write-only.
fn media_stream(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|pv| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = pv.inner().settings() {
            settings.set_enable_media_stream(true);
            // No name is looked up ahead of a request: a link hint in a page a model wrote
            // would otherwise have the webview resolve a name of the page's choosing.
            settings.set_enable_dns_prefetching(false);
        }
    });
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// The window shows the app's own page, and the frames it holds on schemes of their own -- the
/// viewer's sealed pages, the pages of answers and the `python` tool's runner; nothing else, ever.
/// A link the page wants followed goes to the system's browser through `open_external`; a
/// navigation it did not ask for -- a link in a sealed frame -- simply goes nowhere.
///
/// The hook is told an address, not which frame goes there, so it cannot hold a frame to its
/// own document: a frame could be taken to another address on the app's own schemes. What is
/// there stays what it is -- a page of an answer keeps its empty sandbox wherever its frame
/// goes, and every held document is served under its own policy.
fn allowed(url: &Url) -> bool {
    let local_app = url.scheme() == "tauri"
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let sealed = url.scheme() == sealed::SCHEME
        || (url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|h| h == format!("{}.localhost", sealed::SCHEME)));
    // The `python` tool's runner: a frame on its own scheme too, with no bridge (`python.rs`).
    // This says the address may be gone to; it cannot tell a frame from the window itself, so
    // that the window never shows the runner as its own page is held where it is served
    // (`python::respond` refuses a request for a document that is not a frame's) and by the
    // runner, which does nothing when it is not a frame.
    let runner = url.scheme() == python::SCHEME
        || (url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|h| h == format!("{}.localhost", python::SCHEME)));
    local_app || sealed || runner || url.as_str() == "about:blank"
}

fn build_tray(handle: &AppHandle) -> tauri::Result<TrayItems> {
    let open = MenuItem::with_id(handle, "open", "Open LLeMbas", true, None::<&str>)?;
    let status = MenuItem::with_id(
        handle,
        "status",
        AgentState::Off.label(),
        false,
        None::<&str>,
    )?;
    let toggle = MenuItem::with_id(handle, "toggle", "Start the agent", true, None::<&str>)?;
    let link = MenuItem::with_id(handle, "link", "Link this computer…", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, "quit", "Quit LLeMbas", true, None::<&str>)?;
    let menu = Menu::with_items(
        handle,
        &[
            &open,
            &PredefinedMenuItem::separator(handle)?,
            &status,
            &toggle,
            &link,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &quit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip("LLeMbas")
        .menu(&menu);
    if let Some(icon) = handle.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(handle)?;
    Ok(TrayItems { status, toggle })
}

/// How often a running app looks for a new release (and once shortly after it starts).
const UPDATE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// Ask the update manifest whether a newer release exists; remember and announce the answer.
/// The manifest and each package are signed with the updater key, which the app checks before
/// installing anything.
async fn check_update(handle: &AppHandle) -> Result<Option<String>, String> {
    let found = handle
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.version);
    *handle.state::<App>().update.lock().unwrap() = found.clone();
    announce(handle);
    Ok(found)
}

fn watch_updates(handle: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(20));
        loop {
            let _ = tauri::async_runtime::block_on(check_update(&handle));
            std::thread::sleep(UPDATE_EVERY);
        }
    });
}

/// Download and install the newer release, then start again on it. A .deb is installed with
/// the system's password prompt (pkexec); an AppImage replaces itself.
async fn install_update(handle: AppHandle) -> Result<(), String> {
    let update = handle
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("LLeMbas is up to date.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("The update could not be installed: {e}"))?;
    handle.state::<App>().agent.stop();
    handle.restart()
}

fn offer_update(h: &AppHandle) {
    let h = h.clone();
    tauri::async_runtime::spawn(async move {
        let version = match check_update(&h).await {
            Ok(Some(v)) => v,
            Ok(None) => {
                h.dialog()
                    .message(format!(
                        "LLeMbas {} is the newest release.",
                        env!("CARGO_PKG_VERSION")
                    ))
                    .title("LLeMbas is up to date")
                    .show(|_| {});
                return;
            }
            Err(e) => {
                h.dialog()
                    .message(format!("Could not look for updates: {e}"))
                    .title("LLeMbas")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
                return;
            }
        };
        let again = h.clone();
        h.dialog()
            .message(format!(
                "LLeMbas {version} is available (this is {}). Install it now? LLeMbas starts again afterwards; the agent stops for a moment.",
                env!("CARGO_PKG_VERSION")
            ))
            .title("Update LLeMbas")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "Install".into(),
                "Later".into(),
            ))
            .show(move |yes| {
                if yes {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = install_update(again.clone()).await {
                            again
                                .dialog()
                                .message(e)
                                .title("LLeMbas")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                    });
                }
            });
    });
}

#[tauri::command]
fn update_app(handle: AppHandle) {
    offer_update(&handle);
}

/// A menu item chosen, from the tray or from the title bar's menu: the same ids in both.
fn on_menu(h: &AppHandle, id: &str) {
    match id {
        "open" => show(h),
        "toggle" => {
            let on = !h.state::<App>().agent.wanted();
            if let Err(e) = set_agent_wanted(h, on) {
                h.dialog()
                    .message(e)
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
        "link" => {
            show(h);
            if let Err(e) = start_link(h) {
                h.dialog()
                    .message(e)
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
        }
        "update" => offer_update(h),
        "reload" => {
            if let Some(w) = main_window(h) {
                let _ = w.reload();
            }
        }
        "settings" => {
            show(h);
            let _ = h.emit("open-settings", ());
        }
        "quit" => {
            h.state::<App>().agent.stop();
            h.exit(0);
        }
        _ => {}
    }
}

/// The title bar's menu: the tray's items, where the window is (a desktop without a tray --
/// GNOME without the AppIndicator extension -- has no other way to reach them). Opened under the
/// button that asked for it: `x`, `y` are its bottom-left corner in the page. (A plain popup
/// opens at the pointer, which a Wayland compositor does not tell the app.)
#[tauri::command]
fn titlebar_menu(window: Window, x: f64, y: f64) -> Result<(), String> {
    let h = window.app_handle();
    let app = h.state::<App>();
    let m = |id: &str, text: &str, on: bool| MenuItem::with_id(h, id, text, on, None::<&str>);
    let build = || -> tauri::Result<Menu<Wry>> {
        let status = m("status", &app.agent.state().label(), false)?;
        let toggle = m(
            "toggle",
            if app.agent.wanted() {
                "Stop the agent"
            } else {
                "Start the agent"
            },
            true,
        )?;
        let link = m("link", "Link this computer…", true)?;
        let update = match app.update.lock().unwrap().clone() {
            Some(v) => m("update", &format!("Install LLeMbas {v}…"), true)?,
            None => m("update", "Check for updates…", true)?,
        };
        let reload = m("reload", "Reload", true)?;
        let settings = m("settings", "Settings…", true)?;
        let quit = m("quit", "Quit LLeMbas", true)?;
        Menu::with_items(
            h,
            &[
                &status,
                &toggle,
                &link,
                &PredefinedMenuItem::separator(h)?,
                &reload,
                &update,
                &settings,
                &PredefinedMenuItem::separator(h)?,
                &quit,
            ],
        )
    };
    let menu = build().map_err(|e| e.to_string())?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

fn on_agent_state(handle: &AppHandle, state: &AgentState) {
    let app = handle.state::<App>();
    if let Some(t) = app.tray.lock().unwrap().as_ref() {
        let _ = t.status.set_text(state.label());
        let _ = t.toggle.set_text(if app.agent.wanted() {
            "Stop the agent"
        } else {
            "Start the agent"
        });
    }
    announce(handle);
}

/// Look at the chat list every so often, and say when a reply finished out of sight.
fn watch_chats(handle: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(watch::EVERY);
        let app = handle.state::<App>();
        let Some((app_url, token)) = app.door() else {
            continue;
        };
        let list = match server::request(&app_url, &token, "GET", "/chats?limit=50", None) {
            Ok(v) => v,
            Err(e) => {
                if e.status == 401 {
                    token_refused(&handle);
                }
                continue;
            }
        };
        let done = app.watch.look(&list);
        if done.is_empty() || !app.settings().notify {
            continue;
        }
        let in_front = main_window(&handle)
            .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
        let open = app.watch.open.lock().unwrap().clone();
        let words = app.watch.words.lock().unwrap().clone();
        for d in done {
            if in_front && open.as_deref() == Some(d.id.as_str()) {
                continue;
            }
            let title = if d.title.is_empty() {
                "LLeMbas".to_string()
            } else {
                d.title.clone()
            };
            let id = app.watch.notes.add(watch::Note::Chat(d.id.clone()));
            let _ = handle
                .notification()
                .builder()
                .id(id)
                .title(title)
                .body(if d.agent { &words.agent } else { &words.reply })
                .show();
        }
    });
}

/// A click on one of the app's notifications, or on one of its actions: a chat's opens that chat;
/// a scheduled run's opens its task (`open`, or the notification itself), runs it again now
/// (`run_again`) or pauses it (`pause`) -- the last two without opening the window.
fn notification_action(handle: &AppHandle, done: &ActionPerformed) {
    let Some(id) = done.notification().map(|n| n.id()) else {
        return;
    };
    let Some(note) = handle.state::<App>().watch.notes.get(id) else {
        return;
    };
    match (note, done.action_id()) {
        (watch::Note::Chat(chat), "tap") => {
            show(handle);
            let _ = handle.emit("open-chat", chat);
        }
        (watch::Note::Report(report), "tap" | "open") => {
            show(handle);
            let _ = handle.emit("open-report", report);
        }
        (watch::Note::Run { schedule, run }, "tap" | "open") => {
            show(handle);
            let _ = handle.emit(
                "open-schedule",
                serde_json::json!({ "schedule": schedule, "run": run }),
            );
        }
        (watch::Note::Run { schedule, .. }, which @ ("run_again" | "pause")) => {
            let path = format!(
                "/schedules/{}/{}",
                terminal::encode(&schedule),
                if which == "pause" { "pause" } else { "run" }
            );
            let h = handle.clone();
            std::thread::spawn(move || {
                let Some((app_url, token)) = h.state::<App>().door() else {
                    return;
                };
                match server::request(
                    &app_url,
                    &token,
                    "POST",
                    &path,
                    Some(&serde_json::json!({})),
                ) {
                    Err(e) if e.status == 401 => token_refused(&h),
                    Err(e) => log::write(&format!("a notification's action failed: {}", e.detail)),
                    Ok(_) => {}
                }
            });
        }
        _ => {}
    }
}

/// How long to wait before following the event stream again: after it closed or broke off, and
/// (longer) on a server that has none.
const EVENTS_AGAIN: std::time::Duration = std::time::Duration::from_secs(5);
const EVENTS_NONE: std::time::Duration = std::time::Duration::from_secs(300);

/// Follow the server's event stream for the signed-in person (`GET /events`): each `schedules`
/// frame goes to the page as it is (the Scheduled page redraws from it), and a scheduled task's
/// newly finished run is told by its notify decision (`watch::decide`). Said even with the window
/// in front: it ran on its own. Signing out or another server ends the stream (`Watch::reset`).
/// The account the reports' mark is kept for: `server|email`.
fn reports_key(app: &App) -> Option<String> {
    let account = app.account.lock().unwrap().clone()?;
    Some(format!("{}|{}", account.server, account.email))
}

/// The stream's `reports` frame: handed to the page (its Reports row counts the unread), and
/// what is news in it is told (`watch::look_reports`): a report filed while the app listened by
/// its own title and summary -- unless the window in front already shows it -- and what was
/// filed while it did not in one notification: that report where it is the only one, else how
/// many there are. The mark is kept for the account whenever it moves.
fn report_filed(handle: &AppHandle, data: &str, door: &(String, String)) {
    let Ok(frame) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let app = handle.state::<App>();
    let before = app.watch.mark();
    let news = app.watch.look_reports(&frame);
    let _ = handle.emit("reports", &frame);
    let mark = app.watch.mark();
    if mark != before {
        if let (Some(key), Some(mark)) = (reports_key(&app), mark) {
            let _ = app.update(|s| {
                s.reports_seen.insert(key, mark);
            });
        }
    }
    let (report, n) = match news {
        watch::News::None => return,
        watch::News::One(report) => (report, 1),
        watch::News::Since { mark, newest } => {
            // How many were filed meanwhile: the unread ones later than the mark as it was.
            let n = server::request(&door.0, &door.1, "GET", "/reports?unread=1", None)
                .map(|list| watch::since(&list, &mark))
                .unwrap_or(1)
                .max(1);
            (newest, n)
        }
    };
    if !app.settings().notify {
        return;
    }
    let words = app.watch.words.lock().unwrap().clone();
    if n > 1 {
        // One notification for all of them; a click opens the list.
        let id = app.watch.notes.add(watch::Note::Report(String::new()));
        let _ = handle
            .notification()
            .builder()
            .id(id)
            .title("LLeMbas")
            .body(words.reports_new.replace("%(n)s", &n.to_string()))
            .show();
        return;
    }
    let in_front = main_window(handle)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if in_front && app.watch.open_report.lock().unwrap().as_deref() == Some(report.id.as_str()) {
        return;
    }
    let id = app.watch.notes.add(watch::Note::Report(report.id));
    let _ = handle
        .notification()
        .builder()
        .id(id)
        .title(if report.title.is_empty() {
            "LLeMbas".to_string()
        } else {
            report.title
        })
        .body(if report.summary.is_empty() {
            words.scheduled.clone()
        } else {
            report.summary
        })
        .show();
}

fn watch_events(handle: AppHandle) {
    std::thread::spawn(move || loop {
        let app = handle.state::<App>();
        let Some((app_url, token)) = app.door() else {
            std::thread::sleep(EVENTS_AGAIN);
            continue;
        };
        let stop = app.watch.stop_flag();
        // The mark kept for this account: a report later than it is news.
        let kept = reports_key(&app).and_then(|k| app.settings().reports_seen.get(&k).cloned());
        app.watch.begin(kept);
        let door = (app_url.clone(), token.clone());
        let result = server::stream(&app_url, &token, "/events", &stop, |event, data| {
            if event == "reports" {
                report_filed(&handle, data, &door);
                return true;
            }
            if event != "schedules" {
                return true;
            }
            let Ok(list) = serde_json::from_str::<Value>(data) else {
                return true;
            };
            let app = handle.state::<App>();
            let ran = app.watch.look_schedules(&list);
            let _ = handle.emit("schedules", &list);
            if ran.is_empty() || !app.settings().notify {
                return true;
            }
            let words = app.watch.words.lock().unwrap().clone();
            for r in ran {
                let title = if r.title.is_empty() {
                    "LLeMbas".to_string()
                } else {
                    r.title
                };
                let body = r.body.clone().unwrap_or_else(|| {
                    match r.told {
                        watch::Told::Result => &words.scheduled,
                        watch::Told::Failed => &words.scheduled_failed,
                        watch::Told::Pause => &words.scheduled_pause,
                    }
                    .clone()
                });
                let id = app.watch.notes.add(watch::Note::Run {
                    schedule: r.schedule.clone(),
                    run: r.run.clone(),
                });
                let mut note = handle
                    .notification()
                    .builder()
                    .id(id)
                    .title(title)
                    .body(body);
                if !r.actions.is_empty() {
                    // One action type per set of actions; registered again, it takes the labels
                    // this run came with (the person's language may have changed).
                    let kind = format!(
                        "schedule-{}",
                        r.actions
                            .iter()
                            .map(|(a, _)| a.as_str())
                            .collect::<Vec<_>>()
                            .join("-")
                    );
                    let actions = r
                        .actions
                        .iter()
                        .map(|(a, label)| Action::builder(a, label).build())
                        .collect();
                    let _ = handle
                        .notification()
                        .register_action_types(vec![ActionType::builder(&kind)
                            .actions(actions)
                            .build()]);
                    note = note.action_type_id(kind);
                }
                let _ = note.show();
            }
            true
        });
        match result {
            Err(e) if e.status == 401 => {
                token_refused(&handle);
                std::thread::sleep(EVENTS_AGAIN);
            }
            // A server without the stream: look again now and then (it may be updated).
            Err(e) if e.status == 404 || e.status == 405 => std::thread::sleep(EVENTS_NONE),
            _ => std::thread::sleep(EVENTS_AGAIN),
        }
    });
}

/// Where the app writes what it could not show: a start that fails before the window is up
/// leaves its reason here, not only on a terminal nobody sees.
mod log {
    use std::io::Write;
    use std::path::PathBuf;

    /// The app's log directory as Tauri names it on Linux (`$XDG_DATA_HOME/<identifier>/logs`),
    /// worked out without the app, which may not exist yet.
    pub fn file() -> Option<PathBuf> {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
        Some(data.join("eu.llembas.desktop/logs/desktop.log"))
    }

    pub fn write(line: &str) {
        eprintln!("llembas-desktop: {line}");
        let Some(path) = file() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{secs}] {line}");
        }
    }

    /// A panic -- the release build aborts on one -- is written down before it ends the app.
    pub fn on_panic() {
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            write(&format!("stopped: {info}"));
            before(info);
        }));
    }
}

/// Settings for WebKitGTK that must be in place before it starts. A blank or crashing window
/// with NVIDIA's own driver (on Wayland most of all) is WebKitGTK's DMA-BUF renderer; without it,
/// the window draws. Only when that driver is loaded and the person has not chosen otherwise.
#[cfg(target_os = "linux")]
fn webkit_environment() {
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if nvidia && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

pub fn run() {
    log::on_panic();
    #[cfg(target_os = "linux")]
    webkit_environment();
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|h, _argv, _cwd| show(h)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol(sealed::SCHEME, |ctx, request| {
            sealed::respond(
                &ctx.app_handle().state::<App>().sealed,
                request.uri().path(),
            )
        })
        .register_uri_scheme_protocol(python::SCHEME, |ctx, request| {
            python::respond(
                &ctx.app_handle().state::<App>().python,
                request.uri().path(),
                request
                    .headers()
                    .get("sec-fetch-dest")
                    .and_then(|v| v.to_str().ok()),
            )
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            recheck_server,
            set_server,
            sign_in,
            sign_in_cancel,
            sign_out,
            api,
            api_text,
            model_image,
            terminal_word,
            stream_open,
            stream_close,
            terminal_open,
            terminal_input,
            terminal_resize,
            terminal_close,
            local_list,
            local_read,
            sealed_open,
            sealed_close,
            page_open,
            pages_clear,
            set_open_report,
            python_prepare,
            attach_pick,
            library_upload,
            voice_arm,
            transcribe,
            speak,
            draw,
            attach_dropped,
            attach_bytes,
            set_theme,
            set_notify,
            set_open_chat,
            set_words,
            open_external,
            set_agent,
            link_computer,
            link_cancel,
            titlebar_menu,
            update_app,
            remote_refresh,
            remote_add,
            remote_remove,
            remote_mode,
            remote_terminal
        ])
        .on_menu_event(|h, ev| on_menu(h, ev.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            if let Ok(dir) = app.path().resource_dir() {
                cli::set_bundled(&dir);
            }
            let agent_log = app.path().app_log_dir()?.join("agent.log");
            let notify_handle = handle.clone();
            let agent = Agent::new(agent_log, move |s| {
                // The notifier runs on the agent's thread; the tray is touched on the main one.
                let h = notify_handle.clone();
                let s = s.clone();
                let _ = notify_handle.run_on_main_thread(move || on_agent_state(&h, &s));
            });
            let loaded = settings::load(&config_dir);
            // Until the account has said, the server's own default: Moria.
            let theme = loaded
                .theme
                .as_deref()
                .and_then(Theme::parse)
                .unwrap_or(Theme::Moria);
            app.manage(App {
                config_dir,
                settings: Mutex::new(loaded.clone()),
                agent,
                tray: Mutex::new(None),
                linking: Mutex::new(false),
                link_cancel: Mutex::new(None),
                update: Mutex::new(None),
                remote: Mutex::new(None),
                theme: Mutex::new(theme),
                server: Mutex::new(None),
                refused: Mutex::new(None),
                account: Mutex::new(None),
                signing_in: Mutex::new(None),
                streams: Mutex::new(HashMap::new()),
                next_stream: AtomicU64::new(0),
                terminals: terminal::Sessions::default(),
                sealed: sealed::Pages::default(),
                python: python::Runtime::default(),
                watch: watch::Watch::default(),
                dropped: Mutex::new(Vec::new()),
                mic_until: Mutex::new(None),
            });
            // Without a tray (no AppIndicator library, no StatusNotifier host) the app still
            // starts: the title bar's menu has every item the tray has.
            match build_tray(&handle) {
                Ok(items) => *handle.state::<App>().tray.lock().unwrap() = Some(items),
                Err(e) => log::write(&format!("no tray icon: {e}")),
            }
            build_main(&handle)?;
            watch_updates(handle.clone());
            watch_chats(handle.clone());
            watch_events(handle.clone());
            {
                let h = handle.clone();
                let _ = handle
                    .notification()
                    .on_action(move |done| notification_action(&h, done));
            }
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    check_server(&h);
                    refresh_remote(&h);
                });
            }
            if let (true, Some(server)) = (loaded.agent, loaded.server) {
                handle.state::<App>().agent.start(server);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the window keeps the app (and the agent) in the tray.
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
                let _ = window.hide();
                api.prevent_close();
            }
            WindowEvent::Resized(_) if window.label() == MAIN => {
                let _ = window.emit("maximized", window.is_maximized().unwrap_or(false));
            }
            // Files dragged onto the window: the page shows where they go, and a drop is held
            // here for `attach_dropped` -- the page itself never names a path to send.
            WindowEvent::DragDrop(ev) if window.label() == MAIN => match ev {
                DragDropEvent::Enter { .. } => {
                    let _ = window.emit("drag", true);
                }
                DragDropEvent::Leave => {
                    let _ = window.emit("drag", false);
                }
                DragDropEvent::Drop { paths, .. } => {
                    let names: Vec<String> = paths
                        .iter()
                        .map(|p| {
                            p.file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                                .unwrap_or_default()
                        })
                        .collect();
                    *window.state::<App>().dropped.lock().unwrap() = paths.clone();
                    let _ = window.emit("drag", false);
                    let _ = window.emit("drop", names);
                }
                _ => {}
            },
            _ => {}
        })
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(e) => {
            log::write(&format!("could not start: {e}"));
            std::process::exit(1);
        }
    };
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<App>().agent.stop();
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_page_of_an_answer_is_asked_for_by_names_and_colours_only() {
        const D: &str = "526b3a6b58f09769d9f81f628942cc7f";
        let c = |k: &str, v: &str| (k.to_string(), v.to_string());
        let colours = [
            c("ink", "#E2E8EC"),
            c("bg", "#101418"),
            c("line", "red"),
            c("x", "#fff"),
        ];
        assert_eq!(
            super::page_path("m", "msg-1", D, &colours).as_deref(),
            Some("/pages/m/msg-1/526b3a6b58f09769d9f81f628942cc7f?bg=%23101418&ink=%23E2E8EC")
        );
        assert_eq!(
            super::page_path("r", "rep1", D, &[]).as_deref(),
            Some("/pages/r/rep1/526b3a6b58f09769d9f81f628942cc7f")
        );
        // A digest is 32 lower-case hex digits and nothing else.
        for digest in [
            "d",
            "526B3A6B58F09769D9F81F628942CC7F",
            "526b3a6b58f09769d9f81f628942cc7",
            "526b3a6b58f09769d9f81f628942cc7f0",
            "526b3a6b58f09769d9f81f628942cc7g",
            "../6b3a6b58f09769d9f81f628942cc7f",
        ] {
            assert_eq!(super::page_path("m", "msg1", digest, &[]), None, "{digest}");
        }
        for (kind, owner) in [
            ("x", "a"),
            ("m", "../a"),
            ("m", "a?c=d"),
            ("m", ""),
            ("m", "a/b"),
            ("r", "a#c"),
        ] {
            assert_eq!(
                super::page_path(kind, owner, D, &[]),
                None,
                "{kind} {owner}"
            );
        }
        assert!(
            !super::page_colour("#12")
                && !super::page_colour("rgb(1,2,3)")
                && super::page_colour("#abc")
        );
    }

    use super::*;

    #[test]
    fn a_theme_is_one_of_two_names() {
        assert_eq!(Theme::parse("moria"), Some(Theme::Moria));
        assert_eq!(Theme::parse("shire"), Some(Theme::Shire));
        assert_eq!(Theme::parse("Shire"), None);
        assert_eq!(Theme::parse(""), None);
        for t in [Theme::Moria, Theme::Shire] {
            assert_eq!(Theme::parse(t.name()), Some(t));
        }
    }

    #[test]
    fn the_themes_come_out_of_tokens_css_as_two_different_looks() {
        // build.rs read these out of ui/tokens.css: a light and a dark theme cannot share a page
        // colour.
        assert_ne!(Theme::Moria.background(), Theme::Shire.background());
    }

    #[test]
    fn the_window_shows_the_app_and_its_own_frames_only() {
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "about:blank",
        ] {
            assert!(allowed(&Url::parse(ok).unwrap()), "{ok}");
        }
        // The app's own frames: the viewer's sealed page, a page of an answer, the runner.
        for framed in [
            "llembas-sealed://localhost/p1",
            "http://llembas-sealed.localhost/p1",
            "llembas-sealed://localhost/s7#totals",
            "llembas-python://localhost/runner.html?v=314.0.7",
            "http://llembas-python.localhost/runner.html?v=314.0.7",
        ] {
            assert!(allowed(&Url::parse(framed).unwrap()), "{framed}");
        }
        for no in [
            "https://ai.example/",
            "http://localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "http://llembas-python.localhost.evil.example/runner.html",
            "https://llembas-python.localhost/runner.html",
            "file:///etc/passwd",
            "data:text/html,<p>x</p>",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(&Url::parse(no).unwrap()), "{no}");
        }
    }

    #[test]
    fn a_pasted_files_name_comes_back_whole() {
        assert_eq!(percent_decode("Sch%C3%B6n%20bild.png"), "Schön bild.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb%4"), "a%zzb%4");
        assert_eq!(percent_decode("ž%41"), "žA");
    }

    #[test]
    fn the_log_lives_in_the_apps_own_directory() {
        let f = log::file().unwrap();
        assert!(f.ends_with("eu.llembas.desktop/logs/desktop.log"));
    }
}
