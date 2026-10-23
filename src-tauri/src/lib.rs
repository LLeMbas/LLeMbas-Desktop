//! LLeMbas Desktop: the server's web UI in a window of its own, and the LLeMbas CLI's agent
//! running on this computer, so agent chats can work in its projects without a terminal.
//!
//! - **One window, `main`, drawn by the app**: no system decoration, the app's own title bar (a
//!   local page, `ui/titlebar.html`) on top and the content below it — before a server is chosen
//!   the first-run page (`ui/index.html`), after it the server itself. Two webviews in one window,
//!   so the server's pages never share a document with the app's controls. Closing hides the
//!   window; the tray, the title bar's menu or starting the app again bring it back.
//! - **The server's pages get no IPC.** They are remote content, and the one capability lists no
//!   remote URL. Links that leave the server open in the system browser.
//! - **The window follows the server's theme** (Moria or Shire, the account's choice, not the
//!   desktop's): a script in the content view reports the page's `data-theme` by trying to
//!   navigate to `llembas-theme:<name>`, which the navigation handler notes and refuses (see
//!   `THEME_SCRIPT`). The frame, the title bar and the first-run page are painted in it, and it
//!   is remembered for the next start. No IPC is granted for this: a navigation attempt is all
//!   the page can make, and the only thing it can say is one of two theme names.
//! - **The agent is the CLI's**: `lembas login --json` links this computer, and
//!   `lembas service run` is the device (see `agent.rs`).

mod agent;
mod cli;
mod remote;
mod settings;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{PermissionKind, PermissionResponse, WebviewBuilder};
use tauri::window::{Color, WindowBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, Url, Webview, WebviewUrl,
    Window, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use agent::{Agent, State as AgentState};
use remote::Remote;
use settings::Settings;

/// The colours the window paints itself, read out of `ui/tokens.css` by `build.rs`.
mod tokens {
    include!(concat!(env!("OUT_DIR"), "/tokens.rs"));
}

const MAIN: &str = "main";
const TITLEBAR: &str = "titlebar";
const CONTENT: &str = "content";
/// The title bar's height, in logical pixels: `--titlebar-h` in `ui/titlebar.css`.
const TITLE_H: f64 = 36.0;
/// The frame left around the webviews while the window is not maximized: the window's own
/// surface, where the pointer resizes it (a webview over the edge would take the events).
const FRAME: f64 = 4.0;
/// The scheme the content page's theme report is a navigation to: `llembas-theme:shire`.
const THEME_SCHEME: &str = "llembas-theme";
/// Run in the content view on every page: reports the page's theme (see the module's notes).
const THEME_SCRIPT: &str = include_str!("theme_report.js");

/// The two looks the server's tokens define, named as `tokens.css` selects them (`data-theme`).
/// A custom theme on the server reports its base, which is one of these.
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

    /// The frame's colour: the theme's `--border`, which the pages draw their edges in.
    fn frame(self) -> Color {
        let (r, g, b) = match self {
            Theme::Moria => tokens::MORIA_BORDER,
            Theme::Shire => tokens::SHIRE_BORDER,
        };
        Color(r, g, b, 0xFF)
    }

    /// A webview's own colour, `--bg`: what shows where a page has not painted yet, so a
    /// server page loading in the dark theme is not a white flash first.
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
    /// What the window is painted in: the server page's theme, as last reported.
    theme: Mutex<Theme>,
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
}

/// What the first-run page shows.
#[derive(Clone, Serialize)]
struct Status {
    version: &'static str,
    server: Option<String>,
    linked: bool,
    agent: AgentState,
    agent_wanted: bool,
    /// A newer release of the app, when the last check found one.
    update: Option<String>,
    /// Which folders the agent may open sessions in (None: not known yet).
    remote: Option<Remote>,
    /// The theme the app's own pages are painted in: `moria` or `shire`, the server page's.
    theme: &'static str,
}

fn status(app: &App) -> Status {
    let s = app.settings();
    Status {
        version: env!("CARGO_PKG_VERSION"),
        linked: s.server.as_deref().is_some_and(cli::linked_to),
        server: s.server,
        agent: app.agent.state(),
        agent_wanted: app.agent.wanted(),
        update: app.update.lock().unwrap().clone(),
        remote: app.remote.lock().unwrap().clone(),
        theme: app.theme().name(),
    }
}

#[tauri::command]
fn get_status(app: tauri::State<'_, App>) -> Status {
    status(&app)
}

/// Check that `address` is a LLeMbas server, remember it, and open it.
#[tauri::command]
async fn set_server(handle: AppHandle, address: String) -> Result<String, String> {
    let base = settings::normalise(&address)?;
    let probe = base.clone();
    let name = tauri::async_runtime::spawn_blocking(move || discover(&probe))
        .await
        .map_err(|e| e.to_string())??;
    let app = handle.state::<App>();
    let before = app.settings().server;
    app.update(|s| s.server = Some(base.clone()))?;
    if before.as_deref() != Some(base.as_str()) {
        app.agent.stop();
    }
    open_main(&handle, Some(&base))?;
    Ok(name)
}

/// `/.well-known/lembas.json`: the same check `lembas login` makes first.
fn discover(base: &str) -> Result<String, String> {
    let url = format!("{base}/.well-known/lembas.json");
    let res = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => format!("{base} answers, but is not a LLeMbas server."),
            ureq::Error::Status(code, _) => format!("{base} answered {code}."),
            ureq::Error::Transport(t) => format!("Could not reach {base}: {t}"),
        })?;
    let body: serde_json::Value = res
        .into_json()
        .map_err(|_| format!("{base} is not a LLeMbas server."))?;
    if body.get("service").and_then(|s| s.as_str()) != Some("lembas") {
        return Err(format!("{base} is not a LLeMbas server."));
    }
    Ok(body
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("LLeMbas")
        .to_string())
}

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
                // Connected but allowed into no folder is the state a new computer starts in:
                // say so where the folders are chosen, rather than showing a green light.
                if let Some(r) = refresh_remote(&h) {
                    if !r.usable() {
                        let _ = h.run_on_main_thread({
                            let h = h.clone();
                            move || {
                                let _ = open_main(&h, None);
                            }
                        });
                    }
                }
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
    let _ = handle.emit("status", status_of(handle));
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
    let _ = handle.emit("status", status_of(handle));
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

/// The server's pages are told they are in LLeMbas Desktop, and on which computer: it shows
/// the device that is this computer as "Local". A label only — it grants nothing.
fn user_agent() -> String {
    let platform = if cfg!(target_os = "linux") {
        "X11; Linux x86_64"
    } else if cfg!(target_os = "macos") {
        "Macintosh; Intel Mac OS X 10_15_7"
    } else {
        "Windows NT 10.0; Win64; x64"
    };
    let host = cli::hostname()
        .filter(|h| {
            h.len() <= 253
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
        })
        .map(|h| format!(" (host={h})"))
        .unwrap_or_default();
    format!(
        "Mozilla/5.0 ({platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 LLeMbasDesktop/{}{host}",
        env!("CARGO_PKG_VERSION")
    )
}

/// The app's own first-run page, as the webview addresses it on this platform.
fn local_page() -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    Url::parse(base).expect("a fixed URL")
}

fn content(handle: &AppHandle) -> Option<Webview> {
    handle.get_webview(CONTENT)
}

fn main_window(handle: &AppHandle) -> Option<Window> {
    handle.get_window(MAIN)
}

/// Show the main window on `server`, or on the first-run page; made when it does not exist.
fn open_main(handle: &AppHandle, server: Option<&str>) -> Result<(), String> {
    let target = match server {
        Some(s) => Some(Url::parse(s).map_err(|e| format!("{s}: {e}"))?),
        None => None,
    };
    if let (Some(w), Some(c)) = (main_window(handle), content(handle)) {
        c.navigate(target.unwrap_or_else(local_page))
            .map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    build_main(handle, target).map_err(|e| e.to_string())
}

fn build_main(handle: &AppHandle, target: Option<Url>) -> tauri::Result<()> {
    let theme = handle.state::<App>().theme();
    let window = WindowBuilder::new(handle, MAIN)
        .title("LLeMbas")
        .inner_size(1280.0, 840.0)
        .min_inner_size(420.0, 560.0)
        .decorations(false)
        // The frame's colour: the theme's border, as the pages draw theirs.
        .background_color(theme.frame())
        .build()?;
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    window.add_child(
        WebviewBuilder::new(TITLEBAR, WebviewUrl::App("titlebar.html".into()))
            .background_color(theme.background()),
        LogicalPosition::new(FRAME, FRAME),
        LogicalSize::new(size.width - 2.0 * FRAME, TITLE_H),
    )?;
    let url = match target {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("index.html".into()),
    };
    #[cfg(target_os = "linux")]
    if let Some(bar) = handle.get_webview(TITLEBAR) {
        pin_titlebar(&bar);
    }
    let nav = handle.clone();
    let perm = handle.clone();
    window.add_child(
        WebviewBuilder::new(CONTENT, url)
            .user_agent(&user_agent())
            .background_color(theme.background())
            .initialization_script(THEME_SCRIPT)
            .on_navigation(move |url| allowed(&nav, url))
            .on_permission_request(move |view, kind| permission(&perm, &view, kind)),
        LogicalPosition::new(FRAME, FRAME + TITLE_H),
        LogicalSize::new(
            size.width - 2.0 * FRAME,
            (size.height - TITLE_H - 2.0 * FRAME).max(0.0),
        ),
    )?;
    layout(&window);
    Ok(())
}

/// The server's dictation asks for the microphone, and a webview answers a permission request
/// only if its app does: WebKitGTK refuses anything it is not answered on, and has no prompt of
/// its own -- so the microphone simply said "Permission may be blocked" with no way to allow it.
/// Granted for the microphone, in the content view, once a server is chosen, and for nothing
/// else (a camera or a screen gets the platform's default, which on Linux is no). The content view
/// never shows another origin: `allowed` sends every other site to the system browser.
fn permission(handle: &AppHandle, view: &Webview, kind: PermissionKind) -> PermissionResponse {
    if kind != PermissionKind::Microphone || view.label() != CONTENT {
        return PermissionResponse::Default;
    }
    if handle.state::<App>().settings().server.is_some() {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

/// On Linux, Tauri packs every webview of a window into the window's GTK box, each with an equal
/// share of the height, and positions and sizes set on a webview are not applied there. So the
/// title bar is told directly: a fixed height, no share of what is left (the content takes it).
#[cfg(target_os = "linux")]
fn pin_titlebar(bar: &Webview) {
    let _ = bar.with_webview(|pv| {
        use gtk::prelude::*;
        let view = pv.inner();
        view.set_size_request(-1, TITLE_H as i32);
        if let Some(parent) = view.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
            parent.set_child_packing(&view, false, false, 0, gtk::PackType::Start);
        }
    });
}

/// Lay the two webviews out in the window: the title bar on top, the content under it, and the
/// frame around both unless the window is maximized (then there is nothing to resize).
fn layout(window: &Window) {
    let framed =
        !(window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false));
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        // The box's border is the frame: the window's own surface, which GTK resizes by.
        if let Ok(vbox) = window.default_vbox() {
            vbox.set_border_width(if framed { FRAME as u32 } else { 0 });
        }
    }
    #[cfg(not(target_os = "linux"))]
    place(window, framed);
}

#[cfg(not(target_os = "linux"))]
fn place(window: &Window, framed: bool) {
    use tauri::{PhysicalPosition, PhysicalSize};
    let handle = window.app_handle();
    let (Some(bar), Some(body)) = (handle.get_webview(TITLEBAR), handle.get_webview(CONTENT))
    else {
        return;
    };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return;
    };
    let frame = if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false)
    {
        0
    } else {
        (FRAME * scale).round() as u32
    };
    let title = (TITLE_H * scale).round() as u32;
    let width = size.width.saturating_sub(2 * frame);
    let _ = bar.set_position(PhysicalPosition::new(frame, frame));
    let _ = bar.set_size(PhysicalSize::new(width, title));
    let _ = body.set_position(PhysicalPosition::new(frame, frame + title));
    let _ = body.set_size(PhysicalSize::new(
        width,
        size.height.saturating_sub(title + 2 * frame),
    ));
}

/// The window may show the app's own pages and the server; anything else opens in the browser.
/// A `llembas-theme:` "navigation" is the content page reporting its theme: noted, never loaded.
fn allowed(handle: &AppHandle, url: &Url) -> bool {
    if url.scheme() == THEME_SCHEME {
        if let Some(theme) = Theme::parse(url.path()) {
            set_theme(handle, theme);
        }
        return false;
    }
    let local = matches!(url.scheme(), "tauri" | "asset")
        || url.host_str() == Some("tauri.localhost")
        || url.scheme() == "about"
        || url.scheme() == "data";
    if local {
        return true;
    }
    let server = handle.state::<App>().settings().server;
    let same = server
        .as_deref()
        .and_then(|s| Url::parse(s).ok())
        .is_some_and(|s| s.origin() == url.origin());
    if !same && matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
    }
    same
}

/// The server page shows `theme`: paint the frame and the webviews in it, remember it for the
/// next start, and tell the app's own pages (they hear it as `status`).
fn set_theme(handle: &AppHandle, theme: Theme) {
    let app = handle.state::<App>();
    {
        let mut current = app.theme.lock().unwrap();
        if *current == theme {
            return;
        }
        *current = theme;
    }
    let _ = app.update(|s| s.theme = Some(theme.name().into()));
    if let Some(w) = main_window(handle) {
        let _ = w.set_background_color(Some(theme.frame()));
    }
    for label in [TITLEBAR, CONTENT] {
        if let Some(v) = handle.get_webview(label) {
            let _ = v.set_background_color(Some(theme.background()));
        }
    }
    let _ = handle.emit("status", status_of(handle));
}

/// Link this computer: `lembas login <server> --json`, with the approval shown in the window
/// (where the user is already signed in to the server), then the agent started.
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
                let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match ev.get("event").and_then(|e| e.as_str()) {
                    Some("code") => {
                        let link = ev
                            .get("verification_uri_complete")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if let Ok(url) = Url::parse(link) {
                            if let Some(c) = content(&handle) {
                                let _ = c.navigate(url);
                            }
                            if let Some(w) = main_window(&handle) {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                    Some("done") => done = true,
                    Some("error") => {
                        failure = ev.get("message").and_then(|m| m.as_str()).map(String::from)
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
        let app = handle.state::<App>();
        *app.linking.lock().unwrap() = false;
        match failure {
            None => {
                let _ = open_main(&handle, Some(&server));
                let _ = set_agent_wanted(&handle, true);
            }
            Some(why) => {
                handle
                    .dialog()
                    .message(why)
                    .title("LLeMbas: linking failed")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
        let _ = handle.emit("status", status_of(&handle));
    });
    Ok(())
}

fn status_of(handle: &AppHandle) -> Status {
    status(&handle.state::<App>())
}

fn show(handle: &AppHandle) {
    let server = handle.state::<App>().settings().server;
    if let Some(w) = main_window(handle) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        let _ = open_main(handle, server.as_deref());
    }
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
    let server = MenuItem::with_id(handle, "server", "Settings…", true, None::<&str>)?;
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
            &server,
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
    let _ = handle.emit("status", status_of(handle));
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
            if let Err(e) = start_link(h) {
                h.dialog()
                    .message(e)
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
        }
        "update" => offer_update(h),
        "reload" => {
            if let Some(c) = content(h) {
                if let Ok(url) = c.url() {
                    let _ = c.navigate(url);
                }
            }
        }
        "server" => {
            let _ = open_main(h, None);
        }
        "quit" => {
            h.state::<App>().agent.stop();
            h.exit(0);
        }
        _ => {}
    }
}

/// The title bar's menu: the tray's items, where the window is (a desktop without a tray —
/// GNOME without the AppIndicator extension — has no other way to reach them).
/// The title bar's menu, opened under the button that asked for it: `x`, `y` are the button's
/// bottom-left corner in the title bar page. (A plain popup opens at the pointer, which a Wayland
/// compositor does not tell the app — it landed in the middle of the window.)
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
        let server = m("server", "Settings…", true)?;
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
                &server,
                &PredefinedMenuItem::separator(h)?,
                &quit,
            ],
        )
    };
    let menu = build().map_err(|e| e.to_string())?;
    // The title bar sits inside the frame while the window is not maximized.
    let framed =
        !(window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false));
    let inset = if framed { FRAME } else { 0.0 };
    window
        .popup_menu_at(&menu, LogicalPosition::new(x + inset, y + inset))
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
    let _ = handle.emit("status", status_of(handle));
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|h, _argv, _cwd| show(h)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_server,
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
            let log = app.path().app_log_dir()?.join("agent.log");
            let notify_handle = handle.clone();
            let agent = Agent::new(log, move |s| {
                // The notifier runs on the agent's thread; the tray is touched on the main one.
                let h = notify_handle.clone();
                let s = s.clone();
                let _ = notify_handle.run_on_main_thread(move || on_agent_state(&h, &s));
            });
            let loaded = settings::load(&config_dir);
            // Until a server page has said, the server's own default: Moria.
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
            });
            let items = build_tray(&handle)?;
            *handle.state::<App>().tray.lock().unwrap() = Some(items);
            open_main(&handle, loaded.server.as_deref())?;
            watch_updates(handle.clone());
            {
                let h = handle.clone();
                std::thread::spawn(move || {
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
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
                if window.label() == MAIN =>
            {
                layout(window);
                let _ = window.emit_to(
                    TITLEBAR,
                    "maximized",
                    window.is_maximized().unwrap_or(false),
                );
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("LLeMbas Desktop could not start")
        .run(|handle, event| {
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
        // build.rs read these out of ui/tokens.css: a light and a dark theme cannot share
        // either colour, and the frame is not the page.
        assert_ne!(Theme::Moria.frame(), Theme::Shire.frame());
        assert_ne!(Theme::Moria.background(), Theme::Shire.background());
        assert_ne!(Theme::Moria.frame(), Theme::Moria.background());
        assert_ne!(Theme::Shire.frame(), Theme::Shire.background());
    }

    #[test]
    fn the_theme_report_is_a_navigation_the_handler_can_read() {
        let url = Url::parse("llembas-theme:shire").unwrap();
        assert_eq!(url.scheme(), THEME_SCHEME);
        assert_eq!(Theme::parse(url.path()), Some(Theme::Shire));
        assert!(THEME_SCRIPT.contains(THEME_SCHEME));
    }
}
