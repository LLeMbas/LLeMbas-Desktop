// The title bar: the app's own, in the page (the window has no system decoration). Moving and
// double-click maximising come from `data-tauri-drag-region`; the edges resize the window (Tauri
// does that for an undecorated one); the menu and the agent pill open the app's native menu.

import { $, icon, ICONS } from "./dom.js"
import { invoke, listen, win } from "./bridge.js"

const WORDS = {
  off: () => t("agent off"),
  not_linked: () => t("not linked"),
  starting: () => t("agent starting…"),
  running: () => t("agent running"),
  elsewhere: () => t("agent running (service)"),
  failed: () => t("agent stopped"),
  no_folders: () => t("agent: no folders"),
}

export function renderBar(s) {
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
  $("agent-text").textContent = WORDS[state] ? WORDS[state]() : state
  $("agent").title = state === "failed" ? t("Agent stopped: %(why)s", { why: s.agent.detail }) : t("Agent")
  $("update").hidden = !s.update
  $("update").textContent = s.update ? t("update %(version)s", { version: s.update }) : t("update")
  $("update").title = s.update ? t("LLeMbas %(version)s is available (this is %(current)s)", { version: s.update, current: s.version }) : ""
}

function maximized(on) {
  const b = $("maximize")
  b.replaceChildren(icon(on ? ICONS.restore : ICONS.max))
  b.setAttribute("aria-label", on ? t("Restore") : t("Maximise"))
  b.title = on ? t("Restore") : t("Maximise")
}

// The menu opens under the button that was clicked: its bottom-left corner, in page pixels.
function menuAt(button) {
  const r = button.getBoundingClientRect()
  return invoke("titlebar_menu", { x: r.left, y: r.bottom })
}

export function initBar() {
  $("minimize").replaceChildren(icon(ICONS.min))
  $("close").replaceChildren(icon(ICONS.close))
  $("menu").replaceChildren(icon(ICONS.menu))
  $("side-toggle").replaceChildren(icon(ICONS.side))
  $("minimize").addEventListener("click", () => win.minimize())
  $("maximize").addEventListener("click", () => win.toggleMaximize())
  $("close").addEventListener("click", () => win.close())
  $("update").addEventListener("click", () => invoke("update_app"))
  $("menu").addEventListener("click", (e) => menuAt(e.currentTarget))
  $("agent").addEventListener("click", (e) => menuAt(e.currentTarget))
  listen("maximized", (e) => maximized(!!e.payload))
  win.isMaximized().then(maximized).catch(() => maximized(false))
}
