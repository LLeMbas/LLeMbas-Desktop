// The app's page: which view (the setup card, or the app), and the app itself -- the sidebar (New
// chat, search, Scheduled, Files, the chats, Settings), and in the main area one of: a chat (a new
// one is the same page, empty), the files, the scheduled tasks, or the settings; the activity
// panel and the viewer beside it. Everything it knows comes from Rust: `status` (the app, the
// agent, the server) and `api` (the server's /api/v2, as the signed-in account).

import { $, h, icon, ICONS } from "./dom.js"
import { invoke, listen, get, why } from "./bridge.js"
import { renderBar, initBar } from "./titlebar.js"
import { renderSetup, initSetup } from "./setup.js"
import { renderSettings, initSettings, scrollToSection } from "./settings.js"
import { initViewer, onViewer, closeViewer } from "./viewer.js"
import { initExplorer, showLocal, showFilesTab, openServerFile } from "./explorer.js"
import { initList, refreshList, markCurrent } from "./list.js"
import { initChat, openChat, newChat, closeChat, openChatId, chatMenu, statusChanged, draftKind, onThisComputer, modelsChanged, intoComposer } from "./chat.js"
import { initTerminal, showTerminal, terminalOpen, terminalAvailable, toggleTerminal } from "./terminal.js"
import { applyTheme, noteMe } from "./look.js"
import { initAttach, allowAttach } from "./attach.js"
import { initPalette, openPalette } from "./palette.js"
import { initActivity, showPanel, togglePanel, panelOpen } from "./activity.js"
import { initAgent, link } from "./agent.js"
import { initScheduled, showScheduled, scheduledCommands } from "./scheduled.js"
import { initArchived, showArchived } from "./archived.js"
import { showMemory } from "./memory.js"
import { initVoice, voiceFor } from "./voice.js"
import { canDraw, openDraw } from "./draw.js"
import { closePopover } from "./popup.js"
import { noteSubagentsCap } from "./models.js"

let status = null
let view = "" // "setup" | "app"
let page = "chat" // "chat" | "files" | "scheduled" | "archived" | "memory" | "settings"
let me = null
let models = []
let devices = [] // this account's linked devices
let started = false
let currentChat = null

const SIDE_KEY = "lembas.side"

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

// --- Views ------------------------------------------------------------------------------------

function route() {
  const ready = status.checked && status.discovery && !status.refused && status.account
  const want = ready ? "app" : "setup"
  if (want !== view) {
    view = want
    $("setup").hidden = want !== "setup"
    $("shell").hidden = want !== "app"
    // The sidebar's button keeps its place in the title bar, unseen while there is no sidebar.
    $("side-toggle").style.visibility = want === "app" ? "" : "hidden"
    if (want === "app") startApp()
    else stopApp()
  }
  if (view === "setup") renderSetup(status)
  if (view === "app") {
    if (page === "settings") renderSettings(status)
    localPane()
    statusChanged()
    accountButton()
  }
}

async function startApp() {
  started = true
  try {
    me = await get("/me")
    noteMe(me)
    voiceFor(me)
  } catch (err) {
    $("thread-note").textContent = why(err)
    $("thread-note").hidden = false
  }
  await Promise.all([loadModels(), loadDevices()])
  $("new-chat-btn").disabled = me?.permissions && me.permissions["chat.create"] === false
  allowAttach(me?.permissions?.["files.upload"] !== false)
  accountButton()
  refreshList()
  if (!openChatId()) startNew()
  invoke("remote_refresh")
}

function stopApp() {
  started = false
  closeChat()
  closeViewer()
}

let modelsAt = 0 // when /models was last read

/** The account's models, with what a new chat on each is offered. `keep`: a failed read keeps the last list. */
async function loadModels({ keep = false } = {}) {
  try {
    const r = await get("/models")
    models = r.models || []
    noteSubagentsCap(r.subagents_cap)
    modelsAt = Date.now()
  } catch {
    if (!keep) models = []
  }
}

async function loadDevices() {
  try {
    devices = (await get("/devices")).devices || []
  } catch {
    devices = []
  }
}

/** The sidebar's foot: Settings, with the account it is signed in as. */
function accountButton() {
  const who = status?.account?.name || me?.name || status?.account?.email || ""
  const initial = (who.trim()[0] || "?").toUpperCase()
  $("settings-btn").replaceChildren(
    h("span", { class: "navrow__avatar", "aria-hidden": "true", text: initial }),
    h("span", { class: "navrow__two" }, h("span", { class: "navrow__label", text: t("Settings") }), who ? h("span", { class: "navrow__sub", text: who }) : null),
    h("span", { class: "navrow__icon" }, icon(ICONS.gear)),
  )
}

// --- The pages ----------------------------------------------------------------------------------

/** Show one page in the main area: the chat, the files, the scheduled tasks, the archived chats, or the settings. */
function showPage(name) {
  page = name
  closePopover()
  $("shell").dataset.view = name
  $("main").hidden = name !== "chat"
  $("page-files").hidden = name !== "files"
  $("page-scheduled").hidden = name !== "scheduled"
  $("page-archived").hidden = name !== "archived"
  $("page-memory").hidden = name !== "memory"
  $("settings").hidden = name !== "settings"
  for (const b of document.querySelectorAll(".navrow[data-view]")) b.setAttribute("aria-current", String(b.dataset.view === name))
  if (name !== "chat") {
    showPanel(false)
    showTerminal(false)
  }
  if (narrow()) sideOpen(false)
}

/** This computer's tree: the open agent chat's folder when it runs here, else the one chosen. */
function localPane(chat) {
  const roots = status?.remote?.enabled ? status.remote.roots : []
  const c = chat || currentChat
  const here = c?.device && thisDevices().includes(c.device.token_id)
  showLocal({ roots, root: here && roots.includes(c.device.directory) ? c.device.directory : "", fixed: false })
}

/** A new chat in the main view, of the kind chosen last (an agent chat, at first). */
function startNew(kind) {
  showPage("chat")
  currentChat = null
  newChat(kind || draftKind())
  markCurrent()
  localPane()
  // What a new chat is offered (its models, Subagents) is the server's word now, not at sign-in:
  // an administrator may have switched subagents on or added a model while the app stayed open in
  // the tray. Drawn at once from the last list, then again from the fresh one.
  if (started && Date.now() - modelsAt > 5000) loadModels({ keep: true }).then(modelsChanged)
}

/** Open a chat, from the list or the palette. */
function showChat(id) {
  showPage("chat")
  openChat(id).then(markCurrent)
}

function showSettings(on, section) {
  if (!on) {
    showPage("chat")
    return
  }
  showPage("settings")
  renderSettings(status)
  invoke("remote_refresh")
  if (section) scrollToSection(section)
}

function showArchivedPage() {
  showPage("archived")
  showArchived()
}

function showMemoryPage(focus) {
  showPage("memory")
  showMemory(focus || "")
}

function showFiles(which) {
  showPage("files")
  if (which) showFilesTab(which)
  invoke("remote_refresh")
}

/** The palette's commands: what the menus and buttons do, by name. */
function commands() {
  const out = [
    { label: t("New agent chat"), run: () => startNew("agent") },
    { label: t("New chat"), run: () => startNew("chat") },
    { label: t("Scheduled"), run: () => (showPage("scheduled"), showScheduled()) },
    ...scheduledCommands(),
    { label: t("Files"), run: () => showFiles() },
    { label: t("Archived"), run: showArchivedPage },
    { label: t("Memory"), run: () => showMemoryPage() },
    { label: t("Settings"), run: () => showSettings(true) },
  ]
  if (canDraw(me)) out.push({ label: t("Draw a picture"), run: openDraw })
  if (openChatId()) out.push({ label: panelOpen() ? t("Close the activity panel") : t("Open the activity panel"), run: togglePanel })
  if (terminalAvailable()) out.push({ label: terminalOpen() ? t("Close terminal") : t("Terminal"), run: toggleTerminal })
  if (status?.linked) out.push({ label: status.agent_wanted ? t("Stop the agent") : t("Start the agent"), run: () => invoke("set_agent", { on: !status.agent_wanted }) })
  out.push(
    { label: status?.linked ? t("Link again") : t("Link this computer"), run: link },
    { label: status?.update ? t("Install LLeMbas %(version)s…", { version: status.update }) : t("Check for updates…"), run: () => invoke("update_app") },
  )
  return out
}

function narrow() {
  return window.matchMedia("(max-width: 48rem)").matches
}

/** The sidebar: shown or folded away (remembered); a drawer over the page on a narrow window. */
function sideOpen(on) {
  $("shell").dataset.side = String(on)
  $("side-toggle").setAttribute("aria-expanded", String(on))
  if (!narrow()) {
    try {
      localStorage.setItem(SIDE_KEY, on ? "open" : "closed")
    } catch {}
  }
}

// --- Start --------------------------------------------------------------------------------------

async function boot() {
  initAgent()
  initBar({ status: () => status, openSettings: (section) => showSettings(true, section) })
  initViewer()
  initExplorer()
  initSetup(() => status)
  initSettings(() => status)
  initList({
    thisDevices,
    current: () => openChatId(),
    open: (id) => {
      if (narrow()) sideOpen(false)
      showChat(id)
    },
    menu: (anchor, c) => chatMenu(anchor, c),
    note: (text) => {
      $("thread-note").textContent = text
      $("thread-note").hidden = !text
    },
  })
  initVoice()
  initChat({
    status: () => status,
    thisDevices,
    devices: () => devices,
    models: () => models,
    me: () => me,
    changed: () => refreshList(),
    opened: (chat) => {
      currentChat = chat
      localPane(chat)
      markCurrent()
    },
    // Archived or deleted: the list without it, and a new chat where it was open.
    gone: (chat) => {
      if (!openChatId() || openChatId() === chat.id) {
        currentChat = null
        newChat()
        localPane()
      }
      refreshList()
    },
  })
  initAttach({ chat: () => openChatId() || "", allowed: () => me?.permissions?.["files.upload"] !== false })
  initArchived({
    me: () => me,
    open: (id) => showChat(id),
    // Back in the sidebar: the list again.
    changed: () => refreshList(),
  })
  initPalette({
    commands,
    open: (c) => showChat(c.id),
    openFile: (path, name) => openServerFile(path, name),
    openMemory: (id) => showMemoryPage(id),
  })
  initScheduled({ status: () => status, models: () => models, me: () => me, openChat: (id) => showChat(id), show: () => showPage("scheduled") })
  onViewer((on) => {
    $("shell").dataset.viewer = String(on)
  })
  // One panel column: the activity panel and the terminal take turns in it (the shell stays open).
  initTerminal({
    onLayout: (on) => {
      $("shell").dataset.terminal = String(on)
      if (on && panelOpen()) showPanel(false)
    },
    composer: intoComposer,
  })
  initActivity({
    onLayout: (on) => {
      $("shell").dataset.activity = String(on)
      if (on && terminalOpen()) showTerminal(false)
    },
    here: onThisComputer,
    // The conversation as it now stands: the summary's divider, read again, if it is still open.
    compacted: (id) => openChatId() === id && openChat(id),
  })

  $("new-chat-btn").prepend(icon(ICONS.plus))
  $("new-chat-btn").addEventListener("click", () => {
    if (narrow()) sideOpen(false)
    startNew()
  })
  $("nav-scheduled").querySelector(".navrow__icon").replaceChildren(icon(ICONS.clock))
  $("nav-scheduled").addEventListener("click", () => {
    showPage("scheduled")
    showScheduled()
  })
  $("nav-files").querySelector(".navrow__icon").replaceChildren(icon(ICONS.folder))
  $("nav-files").addEventListener("click", () => showFiles())
  $("nav-archived").querySelector(".navrow__icon").replaceChildren(icon(ICONS.archive))
  $("nav-archived").addEventListener("click", showArchivedPage)
  $("archived-refresh").replaceChildren(icon(ICONS.refresh))
  $("archived-refresh").addEventListener("click", () => showArchived())
  $("nav-memory").querySelector(".navrow__icon").replaceChildren(icon(ICONS.bulb))
  $("nav-memory").addEventListener("click", () => showMemoryPage())
  $("memory-refresh").replaceChildren(icon(ICONS.refresh))
  $("memory-refresh").addEventListener("click", () => showMemory())
  accountButton()
  $("settings-btn").addEventListener("click", () => showSettings(page !== "settings"))
  $("settings-close").replaceChildren(icon(ICONS.close))
  $("settings-close").addEventListener("click", () => showSettings(false))
  $("side-toggle").addEventListener("click", () => sideOpen($("shell").dataset.side !== "true"))
  $("scrim").addEventListener("click", () => sideOpen(false))
  // A wide window starts with the sidebar as it was left; a narrow one with it closed.
  let saved = "open"
  try {
    saved = localStorage.getItem(SIDE_KEY) || "open"
  } catch {}
  sideOpen(!narrow() && saved !== "closed")
  window.matchMedia("(max-width: 48rem)").addEventListener("change", (e) => {
    if (e.matches) sideOpen(false)
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && narrow() && $("shell").dataset.side === "true") sideOpen(false)
    if (view !== "app" || document.querySelector("dialog[open]")) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    // Ctrl+K: the palette. Ctrl+N: a new chat. Ctrl+,: the settings. Ctrl+B: the sidebar.
    if (mod && !e.shiftKey && !e.altKey && key === "k") {
      e.preventDefault()
      openPalette()
    } else if (mod && !e.shiftKey && !e.altKey && key === "n") {
      e.preventDefault()
      startNew()
    } else if (mod && e.key === ",") {
      e.preventDefault()
      showSettings(true)
    } else if (mod && !e.shiftKey && !e.altKey && key === "b") {
      e.preventDefault()
      sideOpen($("shell").dataset.side !== "true")
    }
  })

  invoke("set_words", { words: { reply: t("The reply is ready."), agent: t("The agent has finished."), scheduled: t("A scheduled task has a result."), scheduled_failed: t("A scheduled task failed."), scheduled_pause: t("A scheduled task failed 3 times in a row. Pause it?") } })
  listen("status", (e) => {
    const before = status
    status = e.payload
    renderBar(status)
    route()
    // The agent came up or went: which devices are linked changes with it.
    if (started && before && before.agent.state !== status.agent.state) loadDevices().then(() => (refreshList(), statusChanged()))
  })
  listen("open-settings", () => {
    if (view === "app") showSettings(true)
  })
  // A notification clicked: the chat it told of, or the scheduled task whose run it was.
  listen("open-chat", (e) => {
    if (view === "app" && typeof e.payload === "string") showChat(e.payload)
  })
  listen("open-schedule", (e) => {
    const id = e.payload?.schedule
    if (view !== "app" || typeof id !== "string") return
    showPage("scheduled")
    showScheduled(id)
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
