// The title bar: the app's own, in the page (the window has no system decoration). Moving and
// double-click maximising come from `data-tauri-drag-region`; the edges resize the window (Tauri
// does that for an undecorated one). The menu opens the app's native menu; the agent's chip opens
// a small panel with what the agent says and the one thing to do about it.

import { $, h, icon, ICONS } from "./dom.js"
import { invoke, listen, win } from "./bridge.js"
import { agentBlock, onAgentChange } from "./agent.js"
import { popover, closePopover } from "./popup.js"

const WORDS = {
  off: () => t("agent off"),
  not_linked: () => t("not linked"),
  starting: () => t("agent starting…"),
  connecting: () => t("agent connecting…"),
  running: () => t("agent running"),
  waiting: () => t("agent waiting"),
  refused: () => t("agent refused"),
  elsewhere: () => t("agent running (service)"),
  elsewhere_waiting: () => t("agent waiting"),
  failed: () => t("agent stopped"),
  no_folders: () => t("agent: no folders"),
}

let ctx = null // { status(), openSettings() }
let pop = null

/**
 * The chip's state: what the CLI says of its link, not whether a process runs. Linked but allowed
 * into no folder is said too -- a green light would say it works when it cannot.
 */
export function pillState(s) {
  const a = s.agent
  const noFolders = s.remote && !(s.remote.enabled && s.remote.roots.length)
  const linked = a.state === "running" || (a.state === "elsewhere" && a.detail?.linked)
  if (linked && noFolders) return "no_folders"
  if (a.state === "elsewhere" && !a.detail?.linked) return "elsewhere_waiting"
  return a.state
}

/** Why the agent is not working, in the CLI's words, when it said. */
export function agentWhy(a) {
  if (a.state === "elsewhere") return a.detail?.why || ""
  return typeof a.detail === "string" ? a.detail : ""
}

export function renderBar(s) {
  let host = ""
  try {
    host = s.server ? new URL(s.server).host : ""
  } catch {}
  $("host").textContent = host
  $("host").title = s.server || ""
  const state = pillState(s)
  const reason = agentWhy(s.agent)
  $("agent").dataset.state = state
  $("agent-text").textContent = WORDS[state] ? WORDS[state]() : state
  $("agent").title = reason ? t("Agent: %(why)s", { why: reason }) : t("Agent")
  $("update").hidden = !s.update
  $("update").textContent = s.update ? t("update %(version)s", { version: s.update }) : t("update")
  $("update").title = s.update ? t("LLeMbas %(version)s is available (this is %(current)s)", { version: s.update, current: s.version }) : ""
  pop?.redraw()
}

/** The chip's panel: the agent's state and its button, then start or stop, and Settings. */
function agentPanel() {
  const s = ctx.status()
  const box = h("div", { class: "pop__body" }, h("p", { class: "pop__title", text: t("Agent") }), agentBlock(s))
  const row = h("div", { class: "pop__actions" })
  if (s.linked) {
    row.append(h("button", { type: "button", class: "btn btn--sm", text: s.agent_wanted ? t("Stop the agent") : t("Start the agent"), onclick: () => invoke("set_agent", { on: !s.agent_wanted }) }))
  }
  row.append(
    h("button", {
      type: "button",
      class: "btn btn--sm",
      text: t("Settings"),
      onclick: () => {
        closePopover()
        ctx.openSettings("agent")
      },
    }),
  )
  box.append(row)
  return box
}

function toggleAgent() {
  if (pop) {
    closePopover()
    return
  }
  $("agent").setAttribute("aria-expanded", "true")
  pop = popover($("agent"), agentPanel, {
    align: "end",
    label: t("Agent"),
    onClose: () => {
      pop = null
      $("agent").setAttribute("aria-expanded", "false")
    },
  })
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

export function initBar(context) {
  ctx = context
  $("minimize").replaceChildren(icon(ICONS.min))
  $("close").replaceChildren(icon(ICONS.close))
  $("menu").replaceChildren(icon(ICONS.menu))
  $("side-toggle").replaceChildren(icon(ICONS.side))
  $("minimize").addEventListener("click", () => win.minimize())
  $("maximize").addEventListener("click", () => win.toggleMaximize())
  $("close").addEventListener("click", () => win.close())
  $("update").addEventListener("click", () => invoke("update_app"))
  $("menu").addEventListener("click", (e) => menuAt(e.currentTarget))
  $("agent").addEventListener("click", toggleAgent)
  onAgentChange(() => pop?.redraw())
  listen("maximized", (e) => maximized(!!e.payload))
  win.isMaximized().then(maximized).catch(() => maximized(false))
}
