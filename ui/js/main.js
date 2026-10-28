// The app's page: which view (the setup card, or the app), and the app itself -- the sidebar
// (agent chats by default, chats on the server, and the two explorers), the chat, the viewer and
// the settings. Everything it knows comes from Rust: `status` (the app, the agent, the server) and
// `api` (the server's /api/v2, as the signed-in account).

import { $, h, clear, icon, ICONS } from "./dom.js"
import { invoke, listen, get, why } from "./bridge.js"
import { renderBar, initBar } from "./titlebar.js"
import { renderSetup, initSetup } from "./setup.js"
import { renderSettings, initSettings } from "./settings.js"
import { initViewer, onViewer, closeViewer } from "./viewer.js"
import { initExplorer, showLocal, renderServer } from "./explorer.js"
import { initList, refreshList, markCurrent } from "./list.js"
import { initChat, openChat, newChat, closeChat, openChatId } from "./chat.js"

let status = null
let view = "" // "setup" | "app"
let me = null
let models = []
let devices = [] // this account's linked devices
let kind = "agent"
let started = false
let currentChat = null

const remembered = (() => {
  try {
    return JSON.parse(localStorage.getItem("lembas.thisDevices") || "[]")
  } catch {
    return []
  }
})()

/**
 * The device ids that are this computer: a linked device whose host is this computer's name (the
 * CLI sends it at login). Remembered, so agent chats here are still known as here while the
 * agent is off and the device is not linked right now.
 */
function thisDevices() {
  let changed = false
  for (const d of devices) {
    if (status?.host && d.host === status.host && !remembered.includes(d.id)) {
      remembered.push(d.id)
      changed = true
    }
  }
  if (changed) {
    remembered.splice(0, Math.max(0, remembered.length - 8))
    try {
      localStorage.setItem("lembas.thisDevices", JSON.stringify(remembered))
    } catch {}
  }
  return remembered.slice()
}

function applyTheme(name) {
  if (name !== "moria" && name !== "shire") name = "moria"
  const root = document.documentElement
  root.dataset.theme = name
  root.dataset.base = name
}

// --- Views ------------------------------------------------------------------------------------

function route() {
  const ready = status.checked && status.discovery && !status.refused && status.account
  const want = ready ? "app" : "setup"
  if (want !== view) {
    view = want
    $("setup").hidden = want !== "setup"
    $("shell").hidden = want !== "app"
    if (want === "app") startApp()
    else stopApp()
  }
  if (view === "setup") renderSetup(status)
  if (view === "app") {
    if (!$("settings").hidden) renderSettings(status)
    localPane()
  }
}

async function startApp() {
  started = true
  try {
    me = await get("/me")
    applyTheme(me.theme)
    invoke("set_theme", { name: me.theme === "shire" ? "shire" : "moria" })
  } catch (err) {
    $("thread-note").textContent = why(err)
    $("thread-note").hidden = false
  }
  await Promise.all([loadModels(), loadDevices()])
  $("new-chat-btn").hidden = me?.permissions && me.permissions["chat.create"] === false
  setKind(kind)
  renderServer()
  invoke("remote_refresh")
}

function stopApp() {
  started = false
  closeChat()
  closeViewer()
}

async function loadModels() {
  try {
    models = (await get("/models")).models || []
  } catch {
    models = []
  }
}

async function loadDevices() {
  try {
    devices = (await get("/devices")).devices || []
  } catch {
    devices = []
  }
}

// --- The sidebar --------------------------------------------------------------------------------

function setKind(k) {
  kind = k
  for (const b of document.querySelectorAll(".switch button")) b.setAttribute("aria-selected", String(b.dataset.kind === k))
  $("new-chat-btn").lastChild.textContent = k === "agent" ? t("New agent chat") : t("New chat")
  clear($("chat-list"))
  refreshList()
  // With no chat open, the main view is where a chat of this kind starts.
  if (!openChatId() && $("settings").hidden) {
    currentChat = null
    newChat(k)
    localPane()
  }
}

/** This computer's pane: the open agent chat's folder when it runs here, else a folder chosen. */
function localPane(chat) {
  const roots = status?.remote?.enabled ? status.remote.roots : []
  const c = chat || currentChat
  const here = c?.device && thisDevices().includes(c.device.token_id)
  if (here && c.device.directory) showLocal({ roots, root: c.device.directory, fixed: true })
  else showLocal({ roots, root: "", fixed: false })
}

function narrow() {
  return window.matchMedia("(max-width: 48rem)").matches
}

function sideOpen(on) {
  $("shell").dataset.side = String(on)
  $("side-toggle").setAttribute("aria-expanded", String(on))
}

// --- Settings -----------------------------------------------------------------------------------

function showSettings(on) {
  $("settings").hidden = !on
  $("main").hidden = on
  if (on) {
    renderSettings(status)
    invoke("remote_refresh")
    $("settings-close").focus()
  }
}

// --- Start --------------------------------------------------------------------------------------

async function boot() {
  initBar()
  initViewer()
  initExplorer()
  initSetup(() => status)
  initSettings(() => status)
  initList({
    kind: () => kind,
    thisDevices,
    current: () => openChatId(),
    open: (id) => {
      showSettings(false)
      if (narrow()) sideOpen(false)
      openChat(id).then(markCurrent)
    },
  })
  initChat({
    status: () => status,
    thisDevices,
    models: () => models,
    me: () => me,
    changed: () => refreshList(),
    opened: (chat) => {
      currentChat = chat
      localPane(chat)
      markCurrent()
    },
  })
  onViewer((on) => {
    $("shell").dataset.viewer = String(on)
  })

  for (const b of document.querySelectorAll(".switch button")) b.addEventListener("click", () => setKind(b.dataset.kind))
  $("new-chat-btn").prepend(icon(ICONS.plus))
  $("new-chat-btn").addEventListener("click", () => {
    showSettings(false)
    currentChat = null
    if (narrow()) sideOpen(false)
    newChat(kind)
    markCurrent()
    localPane()
  })
  $("settings-btn").replaceChildren(icon(ICONS.gear), h("span", { text: t("Settings") }))
  $("settings-btn").addEventListener("click", () => showSettings($("settings").hidden))
  $("settings-close").replaceChildren(icon(ICONS.close))
  $("settings-close").addEventListener("click", () => showSettings(false))
  $("side-toggle").addEventListener("click", () => sideOpen($("shell").dataset.side !== "true"))
  $("scrim").addEventListener("click", () => sideOpen(false))
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("shell").dataset.side === "true") sideOpen(false)
  })

  invoke("set_words", { words: { reply: t("The reply is ready."), agent: t("The agent has finished.") } })
  listen("status", (e) => {
    const before = status
    status = e.payload
    renderBar(status)
    route()
    // The agent came up or went: which devices are linked changes with it.
    if (started && before && before.agent.state !== status.agent.state) loadDevices().then(refreshList)
  })
  listen("open-settings", () => {
    if (view === "app") showSettings(true)
  })
  status = await invoke("get_status")
  applyTheme(status.theme)
  renderBar(status)
  route()
  // The list keeps up with replies finished elsewhere (the web interface, the phone).
  setInterval(() => {
    if (view === "app" && document.visibilityState === "visible") refreshList()
  }, 30000)
}

boot()
