// The title bar. Moving and double-click maximising come from `data-tauri-drag-region`; the
// buttons call the window directly; the menu and the agent pill open the app's native menu (the
// tray's items), which can reach past this 36-pixel-high page.
"use strict"

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const win = window.__TAURI__.window.getCurrentWindow()

const $ = (id) => document.getElementById(id)

const WORDS = {
  off: "agent off",
  not_linked: "not linked",
  starting: "agent starting…",
  running: "agent running",
  elsewhere: "agent running (service)",
  failed: "agent stopped",
  no_folders: "agent: no folders",
}

function render(s) {
  let host = ""
  try {
    host = s.server ? new URL(s.server).host : ""
  } catch {}
  $("host").textContent = host
  $("host").title = s.server || ""
  // Connected but allowed into no folder: a green light would say it works when it cannot.
  const noFolders = s.remote && !(s.remote.enabled && s.remote.roots.length)
  const state = s.agent.state === "running" && noFolders ? "no_folders" : s.agent.state
  $("agent").dataset.state = state
  $("agent-text").textContent = WORDS[state] ?? state
  $("agent").title = state === "failed" ? `Agent stopped: ${s.agent.detail}` : "Agent"
  $("update").hidden = !s.update
  $("update").textContent = s.update ? `update ${s.update}` : "update"
  $("update").title = s.update ? `LLeMbas ${s.update} is available (this is ${s.version})` : ""
}

function maximized(on) {
  const b = $("maximize")
  b.toggleAttribute("data-maximized", on)
  b.setAttribute("aria-label", on ? "Restore" : "Maximise")
  b.title = on ? "Restore" : "Maximise"
}

$("minimize").addEventListener("click", () => win.minimize())
$("maximize").addEventListener("click", () => win.toggleMaximize())
$("close").addEventListener("click", () => win.close())
$("update").addEventListener("click", () => invoke("update_app"))
// The menu opens under the button that was clicked: its bottom-left corner, in page pixels.
function menuAt(button) {
  const r = button.getBoundingClientRect()
  return invoke("titlebar_menu", { x: r.left, y: r.bottom })
}
$("menu").addEventListener("click", (e) => menuAt(e.currentTarget))
$("agent").addEventListener("click", (e) => menuAt(e.currentTarget))

listen("status", (e) => render(e.payload))
listen("maximized", (e) => maximized(!!e.payload))
invoke("get_status").then(render)
win.isMaximized().then(maximized)
