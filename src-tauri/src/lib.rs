//! LLeMbas Desktop: the server's web UI in a window of its own, and the LLeMbas CLI's agent
//! running on this computer, so agent chats can work in its projects without a terminal.
//!
//! - **One window, `main`.** Before a server is chosen it shows the app's own first-run page
//!   (`ui/`); after, the server itself. Closing it hides it; the tray brings it back.
//! - **The server's pages get no IPC.** They are remote content, and the one capability lists no
//!   remote URL. Links that leave the server open in the system browser.
//! - **The agent is the CLI's**: `lembas login --json` links this computer, and
//!   `lembas service run` is the device (see `agent.rs`).

mod agent;
mod cli;
mod settings;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use agent::{Agent, State as AgentState};
use settings::Settings;

const MAIN: &str = "main";

struct App {
    config_dir: PathBuf,
    settings: Mutex<Settings>,
    agent: Agent,
    tray: Mutex<Option<TrayItems>>,
    linking: Mutex<bool>,
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
}

/// What the first-run page shows.
#[derive(Clone, Serialize)]
struct Status {
    version: &'static str,
    server: Option<String>,
    linked: bool,
    agent: AgentState,
    agent_wanted: bool,
}

fn status(app: &App) -> Status {
    let s = app.settings();
    Status {
        version: env!("CARGO_PKG_VERSION"),
        linked: s.server.as_deref().is_some_and(cli::linked_to),
        server: s.server,
        agent: app.agent.state(),
        agent_wanted: app.agent.wanted(),
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
        (true, Some(server)) => app.agent.start(server),
        _ => app.agent.stop(),
    }
    Ok(())
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

/// Show the main window on `server`, or on the first-run page; made when it does not exist.
fn open_main(handle: &AppHandle, server: Option<&str>) -> Result<(), String> {
    let target = match server {
        Some(s) => Some(Url::parse(s).map_err(|e| format!("{s}: {e}"))?),
        None => None,
    };
    if let Some(w) = handle.get_webview_window(MAIN) {
        w.navigate(target.unwrap_or_else(local_page))
            .map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = match target {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("index.html".into()),
    };
    let nav = handle.clone();
    WebviewWindowBuilder::new(handle, MAIN, url)
        .title("LLeMbas")
        .inner_size(1280.0, 840.0)
        .min_inner_size(420.0, 560.0)
        .on_navigation(move |url| allowed(&nav, url))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The window may show the app's own pages and the server; anything else opens in the browser.
fn allowed(handle: &AppHandle, url: &Url) -> bool {
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
                            if let Some(w) = handle.get_webview_window(MAIN) {
                                let _ = w.navigate(url);
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
    if let Some(w) = handle.get_webview_window(MAIN) {
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
    let server = MenuItem::with_id(handle, "server", "Change server…", true, None::<&str>)?;
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
        .menu(&menu)
        .on_menu_event(|h, ev| match ev.id().as_ref() {
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
            "server" => {
                let _ = open_main(h, None);
            }
            "quit" => {
                h.state::<App>().agent.stop();
                h.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = handle.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(handle)?;
    Ok(TrayItems { status, toggle })
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
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_server,
            set_agent,
            link_computer
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let log = app.path().app_log_dir()?.join("agent.log");
            let notify_handle = handle.clone();
            let agent = Agent::new(log, move |s| {
                // The notifier runs on the agent's thread; the tray is touched on the main one.
                let h = notify_handle.clone();
                let s = s.clone();
                let _ = notify_handle.run_on_main_thread(move || on_agent_state(&h, &s));
            });
            let loaded = settings::load(&config_dir);
            app.manage(App {
                config_dir,
                settings: Mutex::new(loaded.clone()),
                agent,
                tray: Mutex::new(None),
                linking: Mutex::new(false),
            });
            let items = build_tray(&handle)?;
            *handle.state::<App>().tray.lock().unwrap() = Some(items);
            open_main(&handle, loaded.server.as_deref())?;
            if let (true, Some(server)) = (loaded.agent, loaded.server) {
                handle.state::<App>().agent.start(server);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app (and the agent) in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("LLeMbas Desktop could not start")
        .run(|handle, event| {
            if let RunEvent::Exit = event {
                handle.state::<App>().agent.stop();
            }
        });
}
