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
import { invoke, listen, post, carry, why } from "./bridge.js"
import { ask } from "./popup.js"
import { mountFile, viewerDirty, onViewerDirty } from "./viewer.js"
import { explorer, localSource, serverSource, deviceSource, DEVICE_FILES } from "./explorer.js"
import { pickFolder } from "./filedialogs.js"
import { bytes } from "./dom.js"
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
// The tabs of a person who is not signed in now (the sign-in was refused, or they signed out
// with nothing unsaved): put by, with what they hold, and put back when that person is back.
// Nobody else sees them; an edit among them still counts as not saved.
const shelf = new Map() // `server|email` -> { tabs, active, chosen }

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

/** A place as Rust's `carry` names it. */
const placeOf = (key, src) => ({ place: key === "local" ? "local" : key === "server" ? "server" : "device", root: src.root ?? null, device: src.device ?? null })

/** The most files and folders one carrying takes, everything chosen and everything under it counted: more is said, and nothing is begun. */
const FOLDER_MOST = 2000
/** How deep a folder is walked: past this it is taken for a folder that leads back into itself. */
const FOLDER_DEEP = 40

/** The carrying under way: one at a time, with the one line that says how far it is and its own Cancel. */
let carrying = null

/** Whose the window is: a carrying begun for one person never goes on for another. */
const whoNow = () => `${ctx.status()?.server || ""}|${ctx.status()?.account?.email || ctx.status()?.account?.name || ""}`

/** How far the transfer under way is, at the foot of the files. */
function showCarry(name, frame) {
  const box = $("work-carry")
  box.hidden = false
  const total = Number(frame?.total)
  const done = Number(frame?.done) || 0
  const far = frame?.state === "sending" ? t("sending…") : Number.isFinite(total) && total > 0 ? t("%(done)s of %(total)s", { done: bytes(done), total: bytes(total) }) : done ? bytes(done) : t("starting…")
  $("work-carry-name").textContent = name
  $("work-carry-name").title = name
  $("work-carry-far").textContent = far
  const bar = $("work-carry-bar")
  bar.hidden = !(Number.isFinite(total) && total > 0)
  bar.max = total > 0 ? total : 1
  bar.value = Math.min(done, total > 0 ? total : 1)
}

/** Whether the carrying may go on: not cancelled, and still the same person's window. */
function goesOn(batch) {
  if (!batch.cancelled && whoNow() !== batch.who) batch.cancelled = batch.left = true
  return !batch.cancelled
}

/** One file from a place into a folder of another: counted into `batch` as gone, not gone (with why), or cancelled. */
async function carryFile(here, there, path, dir, name, batch) {
  if (!goesOn(batch)) return
  try {
    showCarry(name, { state: "reading" })
    const job = (batch.job = await carry({ ...here, path }, { ...there, path: dir }, (f) => batch.job === job && showCarry(name, f)))
    // (Cancel pressed while it was being asked for: told now.)
    if (batch.cancelled) job.cancel()
    await job.done
    batch.sent++
    // Cancelled, and it went all the same: the whole of it had gone before it could be stopped.
    if (batch.cancelled) batch.late.push(name)
  } catch (err) {
    if (err?.cancelled) batch.cancelled = true
    else batch.failed.push({ path: name, error: why(err) })
  } finally {
    batch.job = null
  }
}

/** A new folder `name` in `dir` of a place; its path there. */
async function makeFolder(key, target, dir, name) {
  if (key === "local") return invoke("local_make", { root: target.root, dir, name, folder: true })
  if (key === "server") {
    await post("/files/mkdir", { path: dir, name })
    return `${String(dir).replace(/\/$/, "")}/${name}`
  }
  const r = await post(DEVICE_FILES.act(target.device, "mkdir"), { path: dir, name })
  return r?.path || `${String(dir).replace(/\/$/, "")}/${name}`
}

/**
 * What would be carried, looked at whole before anything is: every file and folder chosen and
 * everything under the folders, counted as it is listed. `{ file }`, `{ dir, children, partial,
 * error }` (`partial`: the folder holds more than its listing said) or `{ skip }` (what cannot be
 * carried). Past `FOLDER_MOST` entries, or `FOLDER_DEEP` folders down (a link that leads back
 * into the folder it is in), `count.over` is set and the looking stops.
 */
async function planOf(src, entry, into, count, depth, batch) {
  if (count.over || !goesOn(batch)) return
  if (++count.n > FOLDER_MOST || depth > FOLDER_DEEP) return void (count.over = true)
  if (entry.outside || entry.kind === "other" || entry.kind === "mount") return void into.push({ skip: entry })
  if (!isDir(entry)) return void into.push({ file: entry })
  const node = { dir: entry, children: [], partial: false, error: "" }
  into.push(node)
  try {
    const listing = await src.list(src.ask(entry.path))
    node.partial = listing.more === true || listing.truncated === true
    for (const e of listing.entries || []) await planOf(src, e, node.children, count, depth + 1, batch)
  } catch (err) {
    node.error = why(err)
  }
}

/** Carry what was planned into `dir`: a folder is made there first, then what is in it. */
async function carryPlan(nodes, here, to, target, there, dir, batch) {
  for (const node of nodes) {
    if (!goesOn(batch)) return
    if (node.skip) batch.failed.push({ path: node.skip.name, error: t("Not a file or a folder that can be carried.") })
    else if (node.file) await carryFile(here, there, node.file.path, dir, node.file.name, batch)
    else {
      let made
      try {
        made = await makeFolder(to, target, dir, node.dir.name)
        batch.folders++
      } catch (err) {
        batch.failed.push({ path: `${node.dir.name}/`, error: why(err) })
        continue
      }
      await carryPlan(node.children, here, to, target, there, made, batch)
      // What its listing did not hold was not carried: said, never passed over.
      if (node.error) batch.failed.push({ path: `${node.dir.name}/`, error: node.error })
      if (node.partial) batch.failed.push({ path: `${node.dir.name}/`, error: t("This folder holds more than was listed: the rest of it was not carried.") })
    }
  }
}

/**
 * What was chosen, into a folder of another place: asked for by walking to it, then carried --
 * any file, whatever it holds, and a folder with all in it. One carrying at a time: a second
 * is refused in words while one is under way. Everything is counted before anything is made;
 * more than the bound begins nothing. How far it is, and Cancel, at the foot of the files; one
 * line at the end of what went and what did not -- "transferred" only where all of it did.
 */
async function across(entries, to) {
  const from = place
  const src = source
  const mine = pane
  if (!mine || !src || to === from) return
  const busy = () => (carrying ? (mine.say(t("A transfer is still under way: wait for it, or cancel it first."), true), true) : false)
  if (busy()) return
  // (What was dragged is no longer known to the tree: said as that, not as something else.)
  if (!entries.length) return mine.say(t("That is no longer in the tree: read the folder again."), true)
  const target = sourceOf(to)
  if (!target) return mine.say(t("Choose a folder in %(place)s first.", { place: placeName(to) }), true)
  const way = wayOf(from, to)
  const dir = await pickFolder({ source: target, start: target.top(), title: way === "upload" ? t("Upload to which folder?") : way === "download" ? t("Download to which folder?") : t("Transfer to which folder?"), ok: way === "upload" ? t("Upload here") : way === "download" ? t("Download here") : t("Transfer here") })
  if (dir === null || dir === undefined || busy()) return
  const batch = (carrying = { sent: 0, folders: 0, failed: [], late: [], cancelled: false, left: false, job: null, who: whoNow() })
  $("work-carry-cancel").onclick = () => {
    batch.cancelled = true
    batch.job?.cancel()
  }
  const here = placeOf(from, src)
  const there = placeOf(to, target)
  const where = way === "transfer" ? placeName(to) : baseName(dir) || target.rootName()
  mine.say("")
  try {
    // Counted first, the whole of it: over the bound, nothing is begun.
    showCarry(t("Counting…"), { state: "reading" })
    const plan = []
    const count = { n: 0, over: false }
    for (const e of entries) await planOf(src, e, plan, count, 0, batch)
    if (count.over) return mine.say(t("More than %(n)s files and folders, or folders that lead back into themselves: nothing was begun.", { n: FOLDER_MOST }), true)
    if (goesOn(batch)) await carryPlan(plan, here, to, target, there, dir, batch)
  } finally {
    carrying = null
    $("work-carry").hidden = true
  }
  // (Another person's window by now: nothing of this is theirs to read.)
  if (batch.left) return
  // One line of what went, then what did not, each with why. "Uploaded", "downloaded",
  // "transferred" only where all of it went; a part is called a part.
  const n = batch.sent
  const whole = !batch.failed.length && !batch.cancelled
  const went = !whole
    ? n
      ? t("Only part went to %(place)s: %(n)s.", { place: where, n })
      : t("Nothing went to %(place)s.", { place: where })
    : way === "upload"
    ? t("Uploaded to %(folder)s: %(n)s.", { folder: where, n })
    : way === "download"
    ? t("Downloaded to %(folder)s: %(n)s.", { folder: where, n })
    : t("Transferred to %(place)s: %(n)s.", { place: where, n })
  const lines = [batch.cancelled ? `${t("Cancelled.")} ${went}` : went]
  if (batch.folders) lines[0] += ` ${t("Folders made: %(n)s.", { n: batch.folders })}`
  if (batch.late.length) lines.push(t("Cancel came too late for %(names)s: it had already gone.", { names: batch.late.join(", ") }))
  if (batch.failed.length) lines.push(t("Not carried: %(n)s.", { n: batch.failed.length }), ...batch.failed.map((f) => `${f.path}: ${f.error}`))
  mine.say(lines.join("\n"), !whole)
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
  // Walked to among the computer's own folders (its roots, as it lists them): no path is typed.
  const dir = await pickFolder({ source: deviceSource(d.id, "", computerName(d)), start: rootOf(place) || "", title: t("Work in which folder on %(computer)s?", { computer: computerName(d) }), ok: t("Work here") })
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
  $("work-filter").hidden = true
}

// --- Finding a file by its name ----------------------------------------------------------------------

let filterTimer = 0
let filterAsked = 0

/**
 * The filter above the tree. A linked computer looks under the folder itself (its own search);
 * elsewhere the names the tree has listed are looked through. What is found stands in the
 * tree's place: a file opens, a folder is gone to.
 */
function filterTree() {
  clearTimeout(filterTimer)
  const q = $("work-filter").value.trim()
  const found = $("work-found")
  const mine = ++filterAsked
  if (!q || !pane) {
    // (Nothing of the last search stays behind an emptied filter.)
    found.replaceChildren()
    found.hidden = true
    $("work-tree").hidden = false
    return
  }
  filterTimer = setTimeout(async () => {
    const src = source
    const of = pane
    let result
    try {
      if (src.search) result = await src.search(q)
      else {
        const low = q.toLowerCase()
        result = { entries: of.listed().filter((e) => e.name.toLowerCase().includes(low)).map((e) => ({ ...e, name: e.path })), more: false, listed: true }
      }
    } catch (err) {
      result = { entries: [], error: why(err) }
    }
    if (mine !== filterAsked) return
    $("work-tree").hidden = true
    found.hidden = false
    const none = result.error || (result.entries.length ? "" : result.listed ? t("Nothing among the folders opened in the tree is called that.") : t("Nothing under this folder is called that."))
    found.replaceChildren(
      ...result.entries.map((e) =>
        h(
          "li",
          { dataset: { path: e.path } },
          h(
            "button",
            { type: "button", class: "ftree__row work__hit", title: e.path, onclick: () => (isDir(e) ? (($("work-filter").value = ""), filterTree(), of.go(e.path)) : src.open({ ...e, name: baseName(e.path) })) },
            icon(isDir(e) ? ICONS.folder : ICONS.file),
            h("bdi", { class: "ftree__name", text: e.name }),
          ),
        ),
      ),
      none ? h("li", { class: `fnote${result.error ? " is-error" : ""}` }, h("span", { text: none })) : null,
      result.more ? h("li", { class: "fnote" }, h("span", { text: t("There are more: type more of the name.") })) : null,
    )
  }, 250)
}

/** Draw the tree for the place and its folder (again where either changed), and point the chat at them. */
function drawTree(force = true) {
  drawPlaces()
  drawWhere()
  const key = `${place}\n${rootOf(place)}`
  if (!force && key === drawnFor && pane) return
  drawnFor = key
  $("work-filter").value = ""
  $("work-found").hidden = true
  $("work-tree").hidden = false
  dropWords()
  const base = sourceOf(place)
  if (!base) {
    if (place === "local") emptyTree(t("No project folder yet: the agent can open nothing on this computer."), h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") }))
    // (A computer that says it opens no files from outside -- an older LLeMbas there, or its files switched off: said, not tried.)
    else if (computerOf(place)?.files === false) emptyTree(t("%(computer)s does not open its files from here: update LLeMbas there, or switch its files on in its settings.", { computer: placeName(place) }))
    else emptyTree(t("Choose the folder on %(computer)s to work in.", { computer: placeName(place) }), h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Choose a folder…"), onclick: chooseFolder }))
    aimChat()
    return
  }
  for (const id of ["work-mkdir", "work-mkfile", "work-refresh"]) $(id).hidden = false
  $("work-filter").hidden = false
  const here = place
  const others = () => places().filter((p) => p.key !== here)
  const made = (source = {
    ...base,
    treeFiles: true,
    open: (e) => openFile(here, made, e),
    // The same as a drag onto another place's button, from the keyboard: the line's menu.
    // (Not what only leads out of the folder, nor what is neither a file nor a folder.)
    acrossItems: (e) => (e.outside || e.kind === "other" ? [] : others().map((p) => ({ label: `${acrossWords(here, p.key)}…`, run: () => across([e], p.key) }))),
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

/** Every edit not saved, of whoever's tabs: the ones on the screen and the ones put by for a person who is not signed in now. */
const unsaved = () => [...tabs, ...[...shelf.values()].flatMap((s) => s.tabs)].filter((x) => x.inst?.dirty)
let toldUnsaved = -1

/** Rust is told how many (it asks before Quit): only when the number changes. */
function tellUnsaved() {
  const n = unsaved().length + (viewerDirty() ? 1 : 0)
  if (n === toldUnsaved) return
  toldUnsaved = n
  invoke("set_unsaved", { count: n })
}

function drawTabs() {
  tellUnsaved()
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
  stillTheSame(tab)
}

/**
 * A tab brought to the front: where its place can say whether the file is still what was read
 * (a linked computer can), and it is not, that is said -- before a save finds it out.
 */
async function stillTheSame(tab) {
  const inst = tab?.inst
  if (!tab?.source.changed || !tab.file?.sha || !inst) return
  try {
    if (!(await tab.source.changed(tab.entry, tab.file.sha)) || tab.inst !== inst || !tabs.includes(tab)) return
    tab.hooks.say(t("This file changed on the computer since you opened it. A save will ask before it writes over that."), true)
  } catch {}
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
      // Shown another way (an SVG's picture for its source): an edit not saved is asked about first, as the viewer asks.
      reopen: async (again) => {
        if (tab.inst?.dirty && !(await ask({ title: t("Not saved yet"), text: tab.name, ok: t("Discard"), cancel: t("Cancel"), danger: true }))) return
        draw(again)
      },
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
 * Before the person signs out: the edits in the tabs that were not saved are named, and go only
 * on their word. True when there are none, or they may go (the tabs that held them are closed).
 */
export async function workspaceMayLeave() {
  const dirty = tabs.filter((x) => x.inst?.dirty)
  if (!dirty.length) return true
  const names = dirty.map((x) => x.name).join(", ")
  if (!(await ask({ title: t("Not saved yet"), text: t("In the workspace: %(names)s", { names }), ok: t("Discard"), cancel: t("Cancel"), danger: true }))) return false
  for (const tab of dirty) await closeTab(tab, true)
  return true
}

/**
 * What the person has in front of them, for the chat's message (harness spec 3.11.0, *Editor
 * context in a prompt*): the file in front, the line the cursor is on, what is selected (its
 * lines, from 1 and inclusive, and its text as the editor holds it, saved or not), and the other
 * open files of the same place. Null while the workspace is not what the window shows.
 */
export function editorContext() {
  // Only of the place and folder the chat beside is aimed at: a file of another machine that
  // is still open in a tab is none of that chat's.
  const here = (tab) => tab.place === place && (tab.source.root ?? "") === (source?.root ?? "")
  if (!ctx?.shown() || !active || !source || !here(active)) return null
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
  const open = tabs.filter((x) => x !== active && here(x)).map((x) => x.file?.path || x.path)
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
    // Another person's window now: nothing of the last one's tabs is theirs to see. The tabs
    // are put by as they are -- an edit not saved is not thrown away behind its owner's back --
    // and this person's own, from before, are put back.
    if (tabs.length) shelf.set(whose, { tabs: tabs.splice(0), active, chosen: new Map(chosen) })
    for (const s of shelf.values()) for (const tab of s.tabs) (tab.item.remove(), tab.panel.remove())
    active = null
    chosen.clear()
    const back = shelf.get(who)
    shelf.delete(who)
    if (back) {
      for (const tab of back.tabs) {
        tabs.push(tab)
        $("work-tabs").append(tab.item)
        $("work-panels").append(tab.panel)
      }
      active = back.active
      for (const [k, v] of back.chosen) chosen.set(k, v)
    }
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
  $("work-filter").addEventListener("input", filterTree)
  // The viewer panel's own edit is one of the edits not saved (what Quit asks about).
  onViewerDirty(tellUnsaved)
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
    // (Not from the chat beside, whose message box has its own Ctrl+W, nor from the terminal.)
    const on = document.activeElement
    if (on && on !== document.body && !$("page-workspace").contains(on)) return
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
