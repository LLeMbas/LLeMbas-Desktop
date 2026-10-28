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
//! - **The agent is the CLI's**: `lembas login --json` links this computer, and
//!   `lembas service run` is the device (`agent.rs`). The app reads the CLI's state and runs its
//!   commands; it never writes the CLI's files.
//! - **A 2.0 server only.** Discovery is checked before anything else (`server::check`).

mod agent;
mod cli;
mod files;
mod remote;
mod sealed;
mod server;
mod settings;
mod watch;

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, RunEvent, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
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
    sealed: sealed::Pages,
    watch: watch::Watch,
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

/// Sign the app in to the server: a device login for the `app` scope, approved in the browser.
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
        let result = server::start_sign_in(&d, &host).and_then(|code| {
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
        let outcome = match result {
            Ok(account) => match server::save_account(&app.config_dir, &account) {
                Ok(()) => {
                    *app.account.lock().unwrap() = Some(account);
                    app.watch.reset();
                    SignIn::Done
                }
                Err(e) => SignIn::Failed {
                    message: format!("The sign-in could not be saved: {e}"),
                },
            },
            Err(message) => SignIn::Failed { message },
        };
        let _ = handle.emit("signin", outcome);
        announce(&handle);
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

/// Link this computer: `lembas login <server> --json`, the approval opened in the system's
/// browser (where the person is signed in to the server), then the agent started.
fn start_link(handle: &AppHandle) -> Result<(), String> {
    let app = handle.state::<App>();
    let Some(server) = app.settings().server else {
        return Err("Choose a server first.".into());
    };
    {
        let mut busy = app.linking.lock().unwrap();
        if *busy {
            return Err("Linking is already in progress.".into());
        }
        *busy = true;
    }
    let mut child = match Command::new(cli::binary())
        .arg("login")
        .arg(&server)
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            *app.linking.lock().unwrap() = false;
            return Err(format!("Could not start {}: {e}", cli::binary().display()));
        }
    };
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
                let _ = handle.emit("linking", Linking::Failed { message });
            }
        }
        announce(&handle);
    });
    Ok(())
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
        .build()
}

/// The window shows the app's own page, and the sealed frames inside it; nothing else, ever.
/// A link the page wants followed goes to the system's browser through `open_external`; a
/// navigation it did not ask for -- a link or a script in a sealed frame -- simply goes nowhere.
fn allowed(url: &Url) -> bool {
    let local_app = url.scheme() == "tauri"
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let sealed = url.scheme() == sealed::SCHEME
        || (url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|h| h == format!("{}.localhost", sealed::SCHEME)));
    local_app || sealed || url.as_str() == "about:blank"
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
            let _ = handle
                .notification()
                .builder()
                .title(title)
                .body(if d.agent { &words.agent } else { &words.reply })
                .show();
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
        .invoke_handler(tauri::generate_handler![
            get_status,
            recheck_server,
            set_server,
            sign_in,
            sign_in_cancel,
            sign_out,
            api,
            stream_open,
            stream_close,
            local_list,
            local_read,
            sealed_open,
            sealed_close,
            set_theme,
            set_notify,
            set_open_chat,
            set_words,
            open_external,
            set_agent,
            link_computer,
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
                update: Mutex::new(None),
                remote: Mutex::new(None),
                theme: Mutex::new(theme),
                server: Mutex::new(None),
                refused: Mutex::new(None),
                account: Mutex::new(None),
                signing_in: Mutex::new(None),
                streams: Mutex::new(HashMap::new()),
                next_stream: AtomicU64::new(0),
                sealed: sealed::Pages::default(),
                watch: watch::Watch::default(),
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
    fn the_window_shows_the_app_and_its_sealed_frames_only() {
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "llembas-sealed://localhost/p1",
            "http://llembas-sealed.localhost/p1",
            "about:blank",
        ] {
            assert!(allowed(&Url::parse(ok).unwrap()), "{ok}");
        }
        for no in [
            "https://ai.example/",
            "http://localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "file:///etc/passwd",
            "data:text/html,<p>x</p>",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(&Url::parse(no).unwrap()), "{no}");
        }
    }

    #[test]
    fn the_log_lives_in_the_apps_own_directory() {
        let f = log::file().unwrap();
        assert!(f.ends_with("eu.llembas.desktop/logs/desktop.log"));
    }
}
