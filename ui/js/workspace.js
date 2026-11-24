// The workspace: one view for working on a folder. Where the files are is chosen at its top --
// this computer, another linked computer, or the server -- and the three are the same thing to
// work in: a tree of the folder's files, files open in tabs, the agent's chat for that folder
// beside them, and a terminal on the same machine below.
//
// It is built out of the app's own parts, not beside them:
//   - the tree is the Files page's explorer (explorer.js) over the same three places, listing
//     files as well as folders, with the same hands on every line: new file and folder, rename,
//     move, copy, delete, a line dragged onto a folder;
//   - a tab is the viewer (viewer.js `mountFile`): the same drawing of every kind of file and the
//     same editing, with the same "changed since you opened it" when a save finds the file other
//     than it was read;
//   - the chat is the chat (chat.js), shown in the panel column and pointed at the folder; with
//     a message it is told the open file, the cursor and the selection;
//   - the terminal is the terminal (terminal.js), on the computer the chat works on, laid out
//     under the files instead of beside the chat.
// What is the workspace's own: the tabs, the place switch, what a drop does between places and
// from outside the window -- said in words while it is held: moved, copied, uploaded, downloaded
// or transferred -- and the editor's helper (assist.js).
//
// A narrow window shows one part at a time: Files, Editor, Chat, Terminal.

import { $, h, clear, icon, ICONS } from "./dom.js"
import { invoke, listen, api, why } from "./bridge.js"
import { ask } from "./popup.js"
import { mountFile } from "./viewer.js"
import { explorer, localSource, serverSource, deviceSource, DEVICE_FILES } from "./explorer.js"
import { pickFolder } from "./filedialogs.js"
import { pickDirectory } from "./dirpick.js"
import { assistExtensions, assistButtons, assistControls, loadAssist, resetAssist } from "./assist.js"
import { terminalAvailable, terminalOpen, showTerminal } from "./terminal.js"

let ctx = null // { status(), devices(), thisDevices(), models(), chatFor(target), knownFolders(device), shown() }
let place = "local" // "local" | "server" | "device:<id>"
const chosen = new Map() // a place -> the folder chosen there (this computer's: one of the agent's; a computer's: any it lists)
let pane = null // the explorer drawn now
let source = null // its place
let drawnFor = "" // what the tree was drawn for: place and folder
const tabs = [] // { id, key, place, path, name, entry, source, button, panel, slots, inst, hooks }
let active = null
let nextTab = 0
let whose = "" // the account the tabs belong to

const isDir = (e) => e.kind === "dir" || e.kind === "mount"
const baseName = (p) => String(p).replace(/\/+$/, "").split("/").pop() || String(p)
const narrow = () => window.matchMedia("(max-width: 64rem)").matches

// --- The places -----------------------------------------------------------------------------------

/** The other linked computers of the account: each a place of its own. */
const computers = () => (ctx.devices() || []).filter((d) => !ctx.thisDevices().includes(d.id))
const computerOf = (key) => computers().find((d) => `device:${d.id}` === key) || null
const computerName = (d) => d?.host || d?.name || t("A linked computer")

function places() {
  return [{ key: "local", label: t("This computer"), ico: ICONS.terminal }, ...computers().map((d) => ({ key: `device:${d.id}`, label: computerName(d), ico: ICONS.drive })), { key: "server", label: t("Server"), ico: ICONS.file }]
}
const placeName = (key) => places().find((p) => p.key === key)?.label || ""

/** This computer's folders: the agent's, the only ones the app reads. */
const localRoots = () => (ctx.status()?.remote?.enabled ? ctx.status().remote.roots || [] : [])

/** The folder a place stands in: chosen, else this computer's first; "" where none is chosen yet. */
function rootOf(key) {
  if (key === "server") return "/"
  if (key === "local") {
    const roots = localRoots()
    return roots.includes(chosen.get(key)) ? chosen.get(key) : roots[0] || ""
  }
  return chosen.get(key) || ""
}

/** A place as the explorer takes it (explorer.js `source`), or null where it has no folder yet. */
function sourceOf(key) {
  const root = rootOf(key)
  if (key === "server") return serverSource()
  if (!root) return null
  if (key === "local") return localSource(root)
  const d = computerOf(key)
  return d ? deviceSource(d.id, root, computerName(d)) : null
}

// --- What a drop between two places does, in words -----------------------------------------------------

/** "upload" | "download" | "transfer": a file from one place to another. */
const wayOf = (from, to) => (from === "local" && to === "server" ? "upload" : from === "server" && to === "local" ? "download" : "transfer")

/** The sentence for a drop held over another place's button, and for the menu's line. */
function acrossWords(from, to) {
  const way = wayOf(from, to)
  if (way === "upload") return t("Upload to the server")
  if (way === "download") return t("Download to this computer")
  return t("Transfer to %(place)s", { place: placeName(to) })
}

/** The files chosen, into a folder of another place: asked for by walking to it, then done and said. */
async function across(entries, to) {
  const from = place
  const src = source
  if (!pane || !src || to === from) return
  const files = entries.filter((e) => !isDir(e))
  if (!files.length) return pane.say(t("Only files go from one place to another for now, not folders."), true)
  const target = sourceOf(to)
  if (!target) return pane.say(t("Choose a folder in %(place)s first.", { place: placeName(to) }), true)
  const way = wayOf(from, to)
  const dir = await pickFolder({ source: target, start: target.top(), title: way === "upload" ? t("Upload to which folder?") : way === "download" ? t("Download to which folder?") : t("Transfer to which folder?"), ok: way === "upload" ? t("Upload here") : way === "download" ? t("Download here") : t("Transfer here") })
  if (dir === null || dir === undefined) return
  await pane.act(
    async () => {
      const failed = []
      let sent = 0
      if (way === "upload") {
        const r = await invoke("local_upload", { root: src.root, paths: files.map((e) => e.path), dir })
        sent = Number(r?.sent) || 0
        for (const f of r?.failed || []) failed.push({ path: f.name, error: f.error || "" })
      } else if (way === "download") {
        for (const e of files) {
          try {
            await invoke("local_download", { root: target.root, dir, path: e.path, name: e.name })
            sent++
          } catch (err) {
            failed.push({ path: e.name, error: why(err) })
          }
        }
      } else {
        // To or from a linked computer: a file's text, read in one place and written as a new
        // file in the other (never over one: a taken name is the refusal, in words).
        for (const e of files) {
          try {
            const f = await src.file(e)
            if (f.error) throw { detail: f.error }
            if (typeof f.text !== "string" || f.withheld) throw { detail: t("Only text files can go to or from a linked computer for now.") }
            await writeNew(to, target, dir, e.name, f.text)
            sent++
          } catch (err) {
            failed.push({ path: e.name, error: why(err) })
          }
        }
      }
      return { quiet: true, done: sent, failed }
    },
    (r) => (way === "upload" ? t("Uploaded to %(folder)s: %(n)s.", { folder: baseName(dir) || target.rootName(), n: r?.done ?? 0 }) : way === "download" ? t("Downloaded to %(folder)s: %(n)s.", { folder: baseName(dir) || target.rootName(), n: r?.done ?? 0 }) : t("Transferred to %(place)s: %(n)s.", { place: placeName(to), n: r?.done ?? 0 })),
  )
}

/** A new text file `name` in `dir` of a place. */
async function writeNew(key, target, dir, name, text) {
  const at = `${String(dir).replace(/\/$/, "")}/${name}`
  if (key === "server") return api("PUT", "/files/content", { path: at, text, create: true })
  if (key === "local") {
    await invoke("local_make", { root: target.root, dir, name, folder: false })
    return invoke("local_write", { root: target.root, path: dir ? `${dir}/${name}` : name, text, base: null, force: true })
  }
  return api("PUT", DEVICE_FILES.write(target.device), { path: at, text, create: true })
}

// --- The tree ------------------------------------------------------------------------------------------

function drawPlaces() {
  const box = $("work-places")
  const list = places()
  if (!list.some((p) => p.key === place)) place = "local"
  box.replaceChildren(
    ...list.map((p) =>
      h(
        "button",
        // (A line dragged from the tree is taken by another place's button: `data-place-drop`.)
        { type: "button", role: "tab", class: "tabs__tab work__place", title: p.label, dataset: { place: p.key, placeDrop: p.key }, "aria-selected": String(p.key === place), onclick: () => setPlace(p.key) },
        icon(p.ico),
        h("span", { class: "work__place-name", text: p.label }),
      ),
    ),
  )
}

/** The folder of the place: this computer's among the agent's (a choice where there are several), a computer's by walking to it. */
function drawWhere() {
  const box = clear($("work-where"))
  if (place === "local") {
    const roots = localRoots()
    if (roots.length > 1)
      box.append(
        h(
          "select",
          { class: "pane__pick", id: "work-root", "aria-label": t("Folder"), title: rootOf("local"), onchange: (e) => (chosen.set("local", e.target.value), drawTree()) },
          roots.map((r) => h("option", { value: r, text: r, selected: r === rootOf("local") })),
        ),
      )
    return
  }
  const d = computerOf(place)
  if (!d) return
  box.append(h("button", { type: "button", class: "btn btn--sm work__folder", id: "work-folder", title: rootOf(place), onclick: chooseFolder }, icon(ICONS.folder), h("span", { class: "work__folder-name", text: rootOf(place) ? baseName(rootOf(place)) : t("Choose a folder…") })))
}

async function chooseFolder() {
  const d = computerOf(place)
  if (!d) return
  const dir = await pickDirectory({ device: d.id, name: computerName(d), value: rootOf(place), recent: ctx.knownFolders(d.id) })
  if (!dir) return
  chosen.set(place, dir)
  drawTree()
}

const filesEls = () => ({ pane: $("work-files"), crumbs: $("work-crumbs"), tree: $("work-tree"), list: $("work-list"), details: $("work-details"), status: $("work-status"), batch: null })

function emptyTree(words, button) {
  pane = null
  source = null
  clear($("work-crumbs"))
  clear($("work-list"))
  $("work-status").hidden = true
  clear($("work-tree")).append(h("div", { class: "fx__empty" }, icon(ICONS.folder), h("p", { text: words }), button || null))
  for (const id of ["work-mkdir", "work-mkfile", "work-refresh"]) $(id).hidden = true
}

/** Draw the tree for the place and its folder (again where either changed), and point the chat at them. */
function drawTree(force = true) {
  drawPlaces()
  drawWhere()
  const key = `${place}\n${rootOf(place)}`
  if (!force && key === drawnFor && pane) return
  drawnFor = key
  dropWords()
  const base = sourceOf(place)
  if (!base) {
    if (place === "local") emptyTree(t("No project folder yet: the agent can open nothing on this computer."), h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") }))
    else emptyTree(t("Choose the folder on %(computer)s to work in.", { computer: placeName(place) }), h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Choose a folder…"), onclick: chooseFolder }))
    aimChat()
    return
  }
  for (const id of ["work-mkdir", "work-mkfile", "work-refresh"]) $(id).hidden = false
  const here = place
  const others = () => places().filter((p) => p.key !== here)
  const made = (source = {
    ...base,
    treeFiles: true,
    open: (e) => openFile(here, made, e),
    // The same as a drag onto another place's button, from the keyboard: the line's menu.
    acrossItems: (e) => (isDir(e) ? [] : others().map((p) => ({ label: `${acrossWords(here, p.key)}…`, run: () => across([e], p.key) }))),
    dirItems: () => [],
    fileItems: () => [],
    across: { words: (to) => t("%(what)s: the folder is asked for next", { what: acrossWords(here, to) }), drop: (entries, to) => across(entries, to) },
  })
  const mine = (pane = explorer(filesEls(), source))
  const top = source.top()
  pane.drawTree()
  pane.go(top).then(() => {
    // (The server says where a person's files begin only with its first answer: the tree from there.)
    if (pane === mine && source.top() !== top) pane.drawTree()
  })
  aimChat()
}

/** The chat beside the files: the agent's chat for this folder on this machine; on the server, a chat there. */
function aimChat() {
  if (!ctx.shown()) return
  const root = rootOf(place)
  if (place === "server") return void ctx.chatFor({ kind: "chat" })
  if (!root) return
  ctx.chatFor({ kind: "agent", device: place === "local" ? "" : place.slice("device:".length), dir: root })
}

function setPlace(key) {
  if (key === place) return
  note("")
  place = key
  drawTree()
  showPane("files")
}

// --- Files dropped from outside the window ------------------------------------------------------------

/** What a drop from the system does here, said over the tree while files are held over the window. */
function dropWords() {
  const folder = pane ? baseName(pane.current()) || source.rootName() : ""
  $("work-drop").textContent = !pane
    ? ""
    : place === "local"
    ? t("Drop on a folder to copy the files into it; anywhere else they are copied into %(folder)s.", { folder })
    : place === "server"
    ? t("Drop on a folder to upload the files into it; anywhere else they are uploaded into %(folder)s.", { folder })
    : t("Drop on a folder to transfer the files to it on %(computer)s; anywhere else they go into %(folder)s.", { computer: placeName(place), folder })
}

/** Whether a point of the window is the workspace's own (not the chat's, which attaches what is dropped on it). */
function overWork(at) {
  const x = Number(at?.x)
  const y = Number(at?.y)
  if (!Number.isFinite(x)) return true
  const hit = document.elementFromPoint(x, y)
  return !!hit && $("page-workspace").contains(hit)
}

async function takeDrop(at) {
  if (!pane) return
  const dir = pane.folderAt(Number(at?.x), Number(at?.y))
  const here = place
  const src = source
  const name = baseName(dir) || src.rootName()
  await pane.act(
    async () => {
      const r = here === "local" ? await invoke("local_take_dropped", { root: src.root, dir }) : here === "server" ? await invoke("library_upload_dropped", { dir }) : await invoke("device_upload_dropped", { device: src.device, dir })
      return { done: Number(r?.sent) || 0, failed: (r?.failed || []).map((f) => ({ path: f.name, error: f.error || "" })) }
    },
    (r) => (here === "local" ? t("Copied into %(folder)s: %(n)s.", { folder: name, n: r?.done ?? 0 }) : here === "server" ? t("Uploaded to %(folder)s: %(n)s.", { folder: name, n: r?.done ?? 0 }) : t("Transferred to %(place)s: %(n)s.", { place: placeName(here), n: r?.done ?? 0 })),
  )
}

// --- The tabs --------------------------------------------------------------------------------------------

const tabOf = (key) => tabs.find((x) => x.key === key) || null

function drawTabs() {
  const strip = $("work-tabs")
  for (const tab of tabs) {
    tab.button.setAttribute("aria-selected", String(tab === active))
    tab.button.tabIndex = tab === active ? 0 : -1
    tab.item.dataset.dirty = String(!!tab.inst?.dirty)
    tab.mark.textContent = tab.inst?.dirty ? "●" : ""
    tab.mark.title = tab.inst?.dirty ? t("Not saved yet") : ""
    tab.panel.hidden = tab !== active
  }
  strip.hidden = !tabs.length
  $("work-none").hidden = !!tabs.length
  $("shell").dataset.wfile = String(!!active)
}

function activate(tab) {
  active = tab
  drawTabs()
  tab?.button.scrollIntoView({ block: "nearest", inline: "nearest" })
}

/** Draw a tab's file (again): read through its place, then the viewer's own drawing, opened to be edited. */
async function mount(tab) {
  tab.hooks.close?.()
  tab.inst?.close()
  clear(tab.slots.review).hidden = true
  const reload = () => mount(tab)
  const draw = (file) => {
    tab.inst?.close()
    tab.file = file
    tab.inst = mountFile(tab.slots, file, {
      edit: true,
      reopen: (again) => draw(again),
      extensions: (a) => assistExtensions(a, tab.hooks),
      changed: () => drawTabs(),
    })
    // The helper's buttons belong to a file that can be written; they show once its editor is there.
    tab.inst.ready.then(() => {
      if (tab.inst?.alive) tab.assist.hidden = !tab.inst.editable
      drawTabs()
    })
    return tab.inst.ready
  }
  tab.slots.body.replaceChildren(h("p", { class: "muted wpanel__loading", role: "status", text: t("Loading…") }))
  const file = await tab.source.file(tab.entry, reload)
  if (!tabs.includes(tab)) return
  await draw(file)
}

/** Open a file of a place in a tab: the one it is open in already, else a new one. */
function openFile(key, src, entry) {
  const id = `${key}\n${src.root ?? ""}\n${entry.path}`
  let tab = tabOf(id)
  if (!tab) {
    const n = ++nextTab
    const said = h("p", { class: "wpanel__said", role: "status" })
    const review = h("div", { class: "review", hidden: true, role: "region", "aria-label": t("Changes to accept or reject") })
    const slots = { body: h("div", { class: "viewer__body wpanel__body" }), modes: h("div", { class: "viewer__modes" }), bar: h("div", { class: "viewer__bar", hidden: true }), review }
    const hooks = {
      name: entry.path,
      cwd: key === "local" ? src.root : "",
      review,
      say: (text, error = false) => {
        said.textContent = text || ""
        said.classList.toggle("is-error", !!error)
        said.setAttribute("role", error ? "alert" : "status")
      },
      reviewing: (on) => (panel.dataset.review = String(!!on)),
    }
    const assist = h("span", { class: "wpanel__assist", hidden: true }, assistButtons(hooks))
    const where = `${placeName(key)} · ${entry.path}`
    const panel = h(
      "section",
      { class: "wpanel", id: `work-panel-${n}`, role: "tabpanel", "aria-labelledby": `work-tab-${n}`, hidden: true, dataset: { review: "false" } },
      h("header", { class: "wpanel__head" }, h("bdi", { class: "wpanel__path", title: where, text: where }), assist, slots.modes),
      slots.bar,
      said,
      slots.body,
      review,
    )
    const mark = h("span", { class: "wtab__mark", "aria-hidden": "true" })
    const button = h("button", { type: "button", class: "wtab__open", id: `work-tab-${n}`, role: "tab", "aria-controls": `work-panel-${n}`, title: where, onclick: () => (activate(tab), showPane("editor")) }, h("span", { class: "wtab__name", text: entry.name }), mark)
    const close = h("button", { type: "button", class: "wtab__close", "aria-label": t("Close %(name)s", { name: entry.name }), title: t("Close %(name)s", { name: entry.name }), onclick: () => closeTab(tab) }, icon(ICONS.close))
    const item = h("div", { class: "wtab", role: "presentation", dataset: { key: id, dirty: "false" } }, button, close)
    tab = { id: n, key: id, place: key, path: entry.path, name: entry.name, entry, source: src, button, item, mark, panel, slots, assist, hooks, inst: null, file: null }
    tabs.push(tab)
    $("work-tabs").append(item)
    $("work-panels").append(panel)
    mount(tab)
  }
  activate(tab)
  showPane("editor")
  return tab
}

/** Close a tab; an edit not saved is asked about first. */
async function closeTab(tab, sure = false) {
  if (!sure && tab.inst?.dirty && !(await ask({ title: t("Not saved yet"), text: tab.name, ok: t("Discard"), cancel: t("Cancel"), danger: true }))) return
  const at = tabs.indexOf(tab)
  if (at < 0) return
  tab.hooks.close?.()
  tab.inst?.close()
  tab.item.remove()
  tab.panel.remove()
  tabs.splice(at, 1)
  if (active === tab) activate(tabs[Math.min(at, tabs.length - 1)] || null)
  else drawTabs()
  if (!tabs.length && narrow()) showPane("files")
}

/** Whether any tab holds an edit that was not saved. */
export const workspaceDirty = () => tabs.some((x) => x.inst?.dirty)

/**
 * What the person has in front of them, for the chat's message (harness spec 3.11.0, *Editor
 * context in a prompt*): the file in front, the line the cursor is on, what is selected (its
 * lines, from 1 and inclusive, and its text as the editor holds it, saved or not), and the other
 * open files of the same place. Null while the workspace is not what the window shows.
 */
export function editorContext() {
  if (!ctx?.shown() || !active) return null
  const out = { path: active.file?.path || active.path }
  const view = active.inst?.editor
  if (view?.state) {
    const sel = view.state.selection.main
    const doc = view.state.doc
    out.cursor = { line: doc.lineAt(sel.head).number }
    if (!sel.empty) {
      const text = doc.sliceString(sel.from, sel.to)
      out.selection = { path: out.path, start: doc.lineAt(sel.from).number, end: doc.lineAt(sel.to > sel.from && doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to).number, text: text.length > SELECTION_CHARS ? text.slice(0, SELECTION_CHARS) : text }
    }
  }
  const open = tabs.filter((x) => x !== active && x.place === active.place).map((x) => x.file?.path || x.path)
  if (open.length) out.open = open.slice(0, 20)
  return out
}
/** The most of a selection's text sent with a message. */
const SELECTION_CHARS = 20000

// --- The parts, on a narrow window one at a time; the chat and the terminal ---------------------------------

/** Why there is no terminal to open now, in words: a terminal is a computer's. */
const noTerminal = () => (place === "server" ? t("The server's files have no terminal: a terminal opens on a computer.") : t("The terminal opens once the chat beside has its computer and folder, and the computer opens terminals."))

/** A line under the workspace's head: what could not be done, and why. */
function note(text) {
  $("work-note").textContent = text || ""
  $("work-note").hidden = !text
}

function showPane(name) {
  // No terminal to show: said, and the part shown stays (never an empty part).
  if (name === "terminal" && !terminalAvailable()) return void note(noTerminal())
  note("")
  $("shell").dataset.wpane = name
  for (const b of $("work-panes").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.pane === name))
  if (name === "terminal" && narrow() && terminalAvailable() && !terminalOpen()) showTerminal(true)
}

/** The workspace's own buttons, drawn for what is so now (the terminal aimed somewhere else, opened or closed). */
export function workspaceTools() {
  if (ctx?.shown()) drawTools()
}

function drawTools() {
  const chatOn = $("shell").dataset.wchat !== "false"
  const can = terminalAvailable()
  const term = h(
    "button",
    {
      type: "button",
      class: "tool",
      id: "work-terminal",
      "aria-pressed": String(terminalOpen()),
      "aria-label": t("Terminal"),
      // Where there is none, why: a terminal is a computer's.
      title: can ? t("Terminal") : noTerminal(),
      "data-terminal-toggle": "",
      onclick: () => {
        if (!terminalAvailable()) return void note(noTerminal())
        note("")
        showTerminal(!terminalOpen())
      },
    },
    icon(ICONS.terminal),
  )
  term.setAttribute("aria-disabled", String(!can))
  const chat = h("button", { type: "button", class: "tool", id: "work-chat", "aria-pressed": String(chatOn), "aria-label": t("The chat beside the files"), title: t("The chat beside the files"), onclick: () => (($("shell").dataset.wchat = String(!chatOn)), drawTools()) }, icon(ICONS.chat))
  $("work-tools").replaceChildren(assistControls(() => ctx.models()), chat, term)
}

/** Show the workspace (main.js has made its page the one shown). */
export function showWorkspace() {
  const who = `${ctx.status()?.server || ""}|${ctx.status()?.account?.email || ""}`
  if (who !== whose) {
    // Another person's window now: nothing of the last one's tabs is theirs to see.
    for (const tab of [...tabs]) closeTab(tab, true)
    chosen.clear()
    resetAssist()
    whose = who
    drawnFor = ""
  }
  if (!$("shell").dataset.wchat) $("shell").dataset.wchat = "true"
  if (!$("shell").dataset.wpane) showPane("files")
  loadAssist()
  drawTree(false)
  // (Back from another page: the chat beside is the folder's again.)
  aimChat()
  drawTools()
  drawTabs()
}

/** The app's status or its linked computers changed: the places, this computer's folders, the terminal. */
export function workspaceChanged() {
  if (!ctx?.shown()) return
  drawTree(false)
  drawTools()
}

export function initWorkspace(context) {
  ctx = context
  const tool = (id, ico, run) => {
    $(id).replaceChildren(icon(ico))
    $(id).addEventListener("click", run)
  }
  tool("work-refresh", ICONS.refresh, () => pane?.refresh())
  tool("work-mkdir", ICONS.folder, () => pane?.newIn(pane.current(), true))
  tool("work-mkfile", ICONS.fileText, () => pane?.newIn(pane.current(), false))
  const part = (name, ico, label) => h("button", { type: "button", role: "tab", class: "tabs__tab", dataset: { pane: name }, "aria-selected": "false", onclick: () => showPane(name) }, icon(ico), h("span", { text: label }))
  $("work-panes").replaceChildren(part("files", ICONS.folder, t("Files")), part("editor", ICONS.fileText, t("Editor")), part("chat", ICONS.chat, t("Chat")), part("terminal", ICONS.terminal, t("Terminal")))
  // The tabs from the keyboard: the arrows move along them, Delete closes the one stood on.
  $("work-tabs").addEventListener("keydown", (e) => {
    const at = tabs.findIndex((x) => x.button === document.activeElement)
    if (at < 0) return
    const to = e.key === "ArrowRight" ? tabs[at + 1] : e.key === "ArrowLeft" ? tabs[at - 1] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : null
    if (to) {
      e.preventDefault()
      activate(to)
      to.button.focus()
    } else if (e.key === "Delete") {
      e.preventDefault()
      closeTab(tabs[at])
    }
  })
  // Ctrl+W closes the tab in front, while the workspace is what the window shows.
  document.addEventListener("keydown", (e) => {
    if (!ctx.shown() || !active || document.querySelector("dialog[open]")) return
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault()
      closeTab(active)
    }
  })
  // Files held over the window, and dropped: on the workspace's own part they go into the
  // folder under them (or the one stood in) of the place shown; on the chat they are the chat's.
  let at = null
  listen("drop-at", (e) => {
    at = e.payload && typeof e.payload === "object" ? e.payload : null
  })
  listen("drag", (e) => {
    const on = !!e.payload && ctx.shown() && !!pane
    if (on) dropWords()
    $("work-files").dataset.drag = String(on)
  })
  listen("drop", () => {
    const where = at
    at = null
    // (Where it landed is looked up before anything on the page changes for it.)
    if (ctx.shown() && pane && overWork(where)) takeDrop(where)
    $("work-files").dataset.drag = "false"
  })
}
