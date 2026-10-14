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
}

function render(s) {
  let host = ""
  try {
    host = s.server ? new URL(s.server).host : ""
  } catch {}
  $("host").textContent = host
  $("host").title = s.server || ""
  const state = s.agent.state
  $("agent").dataset.state = state
  $("agent-text").textContent = WORDS[state] ?? state
  $("agent").title = state === "failed" ? `Agent stopped: ${s.agent.detail}` : "Agent"
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
$("menu").addEventListener("click", () => invoke("titlebar_menu"))
$("agent").addEventListener("click", () => invoke("titlebar_menu"))

listen("status", (e) => render(e.payload))
listen("maximized", (e) => maximized(!!e.payload))
invoke("get_status").then(render)
win.isMaximized().then(maximized)
