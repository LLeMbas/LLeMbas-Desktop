// The Files page: two explorers, kept apart as two tabs -- this computer's (the agent's folders,
// read through a command that reaches only them, src-tauri/src/files.rs) and the server's (the
// person's files, as the chats see them, read through /api/v2). Each is the web explorer's shape,
// using the window's width: where you are (crumbs) and what can be done there, the folder tree,
// the list (name, type, size, changed), and the chosen file's details and preview. A file opens in
// the viewer either way.
//
// Nothing here is ever an empty box: a directory being read says Loading…, past SLOW_MS it says
// the server has not answered (with Try again, the late answer still drawn), and a refusal, an
// answer that is not a listing or a failure to draw it is said in its place with Try again.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, get, post, del, why } from "./bridge.js"
import { menu, ask } from "./popup.js"
import { openViewer, showKind, withheldWords } from "./viewer.js"

// The server's tree as the app's door gives it, read as the person (their own access, no chat):
//   GET /files?path=/a        -> { path, parent, entries: [{ name, path, kind: "dir"|"file"|"mount", size, mime, updated_at }] }
//   GET /files/content?path=  -> { path, name, size, mime, kind, language, sha, text, withheld?: { reason, message } }
// A path the person cannot read is the server's 404, in its words. `/` answers with where the
// person's explorer opens (`fs.start`): `/` itself for an organisation's owner or administrator,
// the person's home for anyone else -- its `path` says which.
export const SERVER_FILES = {
  list: (path) => `/files?path=${encodeURIComponent(path || "/")}`,
  read: (path) => `/files/content?path=${encodeURIComponent(path)}`,
}

/** How long a directory may take before the pane says it is still waiting, and offers to ask again. */
export const SLOW_MS = 8000

/** How long an answer is shared between the tree and the list after it came. */
const SHARED_MS = 1500

/** The most of a file the details pane previews: the viewer has the rest. */
const PREVIEW_CHARS = 6000

/** A directory in either tree: the server's mounts open like its folders. */
const isDir = (e) => e.kind === "dir" || e.kind === "mount"

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i

/** An entry's icon, by what the viewer would make of it (the web's `file_icon`). */
function iconOf(e) {
  if (e.kind === "mount") return ICONS.drive
  if (isDir(e)) return ICONS.folder
  if ((e.mime || "").startsWith("image/") || IMAGE.test(e.name)) return ICONS.picture
  const { kind } = showKind(e.path || e.name)
  return kind === "code" || kind === "html" ? ICONS.fileCode : kind === "markdown" || kind === "text" ? ICONS.fileText : ICONS.file
}

/** The Type column: a folder, a mount, or the extension (the web's `type_label`). */
function typeOf(e) {
  if (e.kind === "mount") return t("mount")
  if (isDir(e)) return t("folder")
  const i = e.name.lastIndexOf(".")
  return i > 0 ? e.name.slice(i + 1).toLowerCase() : ""
}

/** A stamp as a date the person reads, and the whole of it for a title. */
function dateOf(stamp) {
  if (!stamp) return { short: "", full: "" }
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return { short: "", full: "" }
  const lang = document.documentElement.lang || undefined
  return {
    short: new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(d),
    full: new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(d),
  }
}

/** Is the details pane on the screen (wide windows): a file is chosen there, else opened. */
const detailsShown = (el) => !!el && getComputedStyle(el).display !== "none"

/**
 * Read something into `holder` and draw it, never leaving it empty: Loading… at once, the slow
 * note and Try again past SLOW_MS, a refusal or a failure to draw in its place. `tag` is the
 * element the notes are (an `li` inside a list). Only the latest reading of a holder is drawn:
 * one that comes after the holder was read again, or left the page, is dropped. Returns a promise
 * that settles once the reading is drawn or said.
 */
function reading(holder, { tag = "div", depth = 0, load, draw }) {
  const mine = (readings.get(holder) || 0) + 1
  readings.set(holder, mine)
  const stale = () => readings.get(holder) !== mine || !holder.isConnected
  const again = () => reading(holder, { tag, depth, load, draw })
  const retry = () => h("button", { type: "button", class: "btn btn--sm fnote__retry", text: t("Try again"), onclick: again })
  const note = (cls, role, text) => {
    const n = h(tag, { class: `fnote ${cls}`, role }, h("span", { text }))
    n.style.setProperty("--depth", String(depth))
    return n
  }
  clear(holder)
  const loading = note("is-loading", "status", t("Loading…"))
  loading.setAttribute("aria-live", "polite")
  holder.append(loading)
  const slow = setTimeout(() => {
    if (!stale()) loading.append(h("span", { text: t("The server has not answered in %(n)s seconds.", { n: Math.round(SLOW_MS / 1000) }) }), retry())
  }, SLOW_MS)
  const said = (text) => {
    const n = note("is-error", "alert", text)
    n.append(retry())
    clear(holder).append(n)
  }
  return Promise.resolve()
    .then(load)
    .then(
      (answer) => {
        clearTimeout(slow)
        if (stale()) return
        try {
          clear(holder)
          draw(answer)
        } catch (err) {
          said(err instanceof Error ? err.message : why(err))
        }
      },
      (err) => {
        clearTimeout(slow)
        if (!stale()) said(why(err))
      },
    )
}
const readings = new WeakMap() // holder -> the reading it shows now (a number)

/**
 * One explorer, inside the pane's elements (`crumbs`, `tree`, `list`, `details`). `source`:
 *   key           "local" | "server" (the rows' data, the tests' handle)
 *   list(path)    -> { path, entries } (`path` as answered: the server's `/` says where it is)
 *   top()         the directory the explorer opens at (the server's: as `/` answered)
 *   ask(path)     the path to ask for a directory (the server's top is asked as `/`)
 *   crumbs(path)  -> [[name, path], ...] from the top down
 *   rootName()    the tree's first line
 *   open(entry)   in the viewer
 *   preview(entry) -> { text, withheld, size }
 *   actions(entry) (optional) -> menu items
 */
function explorer(el, source) {
  let current = null // the directory listed now (as answered)
  let chosen = null // the file whose details show
  // One request per directory for the tree and the list together: an answer is shared while it
  // is on its way and for a moment after (the tree drawn again once the top is known); a refusal
  // is never kept, so Try again asks afresh. Read again and a change forget them all.
  const pending = new Map() // asked path -> promise
  const fetchDir = (path) => {
    const asked = source.ask(path)
    if (!pending.has(asked)) {
      const p = Promise.resolve().then(() => source.list(asked))
      pending.set(asked, p)
      const forget = () => pending.get(asked) === p && pending.delete(asked)
      p.then(() => setTimeout(forget, SHARED_MS), forget)
    }
    return pending.get(asked)
  }

  // --- The folder tree: folders only, opened lazily; a name lists its folder.
  const treeBox = el.tree
  const opened = new Set()
  const branches = new Map() // path -> { ul, depth }
  const drawTree = () => {
    clear(treeBox)
    const rootRow = h(
      "button",
      { type: "button", class: "ftree__row ftree__root", dataset: { path: source.top() }, onclick: () => go(source.top()) },
      icon(ICONS.folder),
      h("span", { class: "ftree__name", text: source.rootName() }),
    )
    const ul = h("ul", { class: "ftree", role: "tree", "aria-label": t("Folders") })
    treeBox.append(rootRow, ul)
    branch(ul, source.top(), 0)
    mark()
  }
  const branch = (ul, path, depth) => {
    branches.set(path, { ul, depth })
    return reading(ul, {
      tag: "li",
      depth,
      load: () => fetchDir(path),
      draw: (answer) => {
        const dirs = (answer.entries || []).filter(isDir)
        for (const e of dirs) ul.append(twig(e, depth))
        mark()
      },
    })
  }
  const twig = (e, depth) => {
    const chevron = h("button", { type: "button", class: "ftree__chevron", "aria-label": e.name, "aria-expanded": "false", tabindex: "-1" }, icon(ICONS.chevron))
    const row = h(
      "button",
      { type: "button", class: "ftree__row", title: e.path, dataset: { path: e.path } },
      icon(iconOf(e)),
      h("span", { class: "ftree__name", text: e.name }),
    )
    const line = h("div", { class: "ftree__line" }, chevron, row)
    line.style.setProperty("--depth", String(depth))
    const li = h("li", { role: "treeitem", dataset: { path: e.path } }, line)
    let kids = null
    const expand = (opening) => {
      chevron.setAttribute("aria-expanded", String(opening))
      li.setAttribute("aria-expanded", String(opening))
      kids?.remove()
      kids = null
      if (!opening) {
        opened.delete(e.path)
        branches.delete(e.path)
        return
      }
      opened.add(e.path)
      kids = h("ul", { role: "group" })
      li.append(kids)
      branch(kids, e.path, depth + 1)
    }
    chevron.addEventListener("click", () => expand(chevron.getAttribute("aria-expanded") !== "true"))
    row.addEventListener("click", () => {
      go(e.path)
      if (chevron.getAttribute("aria-expanded") !== "true") expand(true)
    })
    if (opened.has(e.path)) expand(true)
    return li
  }
  /** The tree's line for the folder listed now. */
  const mark = () => {
    for (const r of treeBox.querySelectorAll(".ftree__row")) {
      const here = r.dataset.path === current || (r.classList.contains("ftree__root") && current === source.top())
      r.classList.toggle("is-current", here)
      if (here) r.setAttribute("aria-current", "true")
      else r.removeAttribute("aria-current")
    }
  }

  // --- Where you are.
  const drawCrumbs = () => {
    const parts = source.crumbs(current ?? source.top())
    clear(el.crumbs).append(
      ...parts.flatMap(([name, at], i) => {
        const last = i === parts.length - 1
        const part = last
          ? h("span", { class: "crumbs__here", "aria-current": "page", title: at, text: name })
          : h("button", { type: "button", class: "crumbs__link", title: at, text: name, onclick: () => go(at) })
        return i ? [h("span", { class: "crumbs__sep", "aria-hidden": "true", text: "/" }), part] : [part]
      }),
    )
    el.crumbs.scrollLeft = el.crumbs.scrollWidth
  }

  // --- The list.
  const go = (path) => {
    current = path
    chosen = null
    drawDetails()
    drawCrumbs()
    mark()
    return reading(el.list, {
      load: () => fetchDir(path),
      draw: (answer) => {
        if (!answer || !Array.isArray(answer.entries)) throw { detail: t("The server's answer could not be read.") }
        if (answer.path !== undefined && answer.path !== path && source.ask(path) === source.ask(answer.path)) current = answer.path
        drawCrumbs()
        mark()
        drawRows(answer.entries)
      },
    })
  }
  const drawRows = (entries) => {
    if (!entries.length) {
      el.list.append(h("div", { class: "fx__empty" }, icon(ICONS.folder), h("p", { text: t("Nothing here yet. Not even a hobbit hole.") })))
      return
    }
    const head = h(
      "div",
      { class: "frow frow--head", role: "row" },
      h("span", { role: "columnheader", text: t("Name") }),
      h("span", { role: "columnheader", class: "frow__type", text: t("Type") }),
      h("span", { role: "columnheader", class: "frow__size", text: t("Size") }),
      h("span", { role: "columnheader", class: "frow__when", text: t("Changed") }),
      h("span", { role: "columnheader" }, h("span", { class: "visually-hidden", text: t("Actions") })),
    )
    el.list.append(h("div", { class: "frows", role: "table", "aria-label": t("Contents") }, head, entries.map(row)))
  }
  const row = (e) => {
    const date = dateOf(e.updated_at)
    const items = source.actions?.(e) || []
    const openRow = h(
      "button",
      { type: "button", class: "frow__open", title: e.path },
      h("span", { class: `frow__icon frow__icon--${e.kind === "mount" ? "mount" : isDir(e) ? "dir" : showKind(e.name).kind}` }, icon(iconOf(e))),
      h("span", { class: "frow__label", text: e.name }),
    )
    const r = h(
      "div",
      { class: "frow", role: "row", dataset: { path: e.path, kind: e.kind } },
      h("span", { role: "cell", class: "frow__name" }, openRow, e.kind === "mount" ? h("span", { class: "badge", text: t("mount") }) : null),
      h("span", { role: "cell", class: "frow__type", text: typeOf(e) }),
      h("span", { role: "cell", class: "frow__size", text: isDir(e) ? "" : bytes(e.size) }),
      h("span", { role: "cell", class: "frow__when", title: date.full, text: date.short }),
      h(
        "span",
        { role: "cell", class: "frow__actions" },
        items.length
          ? h("button", { type: "button", class: "tool frow__more", "aria-label": t("More for %(name)s", { name: e.name }), title: t("More for %(name)s", { name: e.name }), onclick: (ev) => menu(ev.currentTarget, items) }, icon(ICONS.more))
          : null,
      ),
    )
    openRow.addEventListener("click", () => {
      if (isDir(e)) go(e.path)
      else if (detailsShown(el.details)) choose(e)
      else source.open(e)
    })
    openRow.addEventListener("dblclick", () => {
      if (!isDir(e)) source.open(e)
    })
    return r
  }

  // --- The chosen file's details and preview.
  const choose = (e) => {
    chosen = e
    for (const r of el.list.querySelectorAll(".frow[data-path]")) r.classList.toggle("is-chosen", r.dataset.path === e.path)
    drawDetails()
  }
  const drawDetails = () => {
    const box = el.details
    if (!box) return
    for (const r of el.list.querySelectorAll(".frow.is-chosen")) if (!chosen || r.dataset.path !== chosen.path) r.classList.remove("is-chosen")
    clear(box)
    if (!chosen) {
      box.append(h("div", { class: "fdetails__none" }, icon(ICONS.file), h("p", { text: t("Choose a file to see it here.") })))
      return
    }
    const e = chosen
    const date = dateOf(e.updated_at)
    const fact = (label, value, title) => (value ? [h("dt", { text: label }), h("dd", { title: title || value, text: value })] : [])
    const preview = h("div", { class: "fdetails__preview", "aria-label": t("Preview") })
    box.append(
      h("div", { class: "fdetails__id" }, h("span", { class: `frow__icon frow__icon--${showKind(e.name).kind}` }, icon(iconOf(e))), h("h2", { class: "fdetails__name", title: e.name, text: e.name })),
      h("dl", { class: "fdetails__facts" }, fact(t("Type"), typeOf(e)), fact(t("Size"), bytes(e.size)), fact(t("Changed"), date.short, date.full), fact(t("Path"), e.path)),
      h("div", { class: "fdetails__do" }, h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Open in the viewer"), onclick: () => source.open(e) })),
      preview,
    )
    reading(preview, {
      load: () => source.preview(e),
      draw: (f) => {
        if (chosen !== e) return
        if (f.withheld) preview.append(h("p", { class: "fdetails__note", text: withheldWords(f.withheld, f.size ?? e.size) }))
        else {
          const text = String(f.text ?? "")
          preview.append(h("pre", { class: "fdetails__text", text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : text }))
        }
      },
    })
  }

  /** Read again: the list, the tree as it is open, the file chosen. */
  const refresh = () => {
    pending.clear()
    const at = current ?? source.top()
    drawTree()
    return go(at)
  }
  /** A directory changed (an upload, a new folder, a rename, a delete): draw what is there now. */
  const changed = (dir) => {
    pending.clear()
    const b = branches.get(dir)
    if (b) branch(b.ul, dir, b.depth)
    if (dir === current || source.ask(dir) === source.ask(current ?? source.top())) return go(current ?? source.top())
    return Promise.resolve()
  }
  return { go, refresh, changed, drawTree, current: () => current ?? source.top() }
}

// --- This computer ------------------------------------------------------------------------------

let local = { root: "", roots: [], fixed: false }
let localPane = null

/**
 * Point this computer's pane at a folder: `fixed` (an agent chat's working directory, which is
 * what the pane shows while that chat is open) or one of the agent's folders, chosen in the pane.
 */
export function showLocal({ roots, root, fixed }) {
  const changed = root !== local.root || fixed !== local.fixed || roots.join("\n") !== local.roots.join("\n")
  local = { roots, root: root || (roots.includes(local.root) ? local.root : roots[0] || ""), fixed: !!fixed }
  if (changed) renderLocal()
}

const baseName = (p) => String(p).replace(/\/+$/, "").split("/").pop() || p

function renderLocal() {
  const head = clear($("local-where"))
  const els = { crumbs: $("local-crumbs"), tree: $("local-tree"), list: $("local-list"), details: $("local-details") }
  $("pane-local").dataset.empty = String(!local.roots.length)
  if (!local.roots.length) {
    clear(els.crumbs)
    clear(els.tree)
    clear(els.details)
    clear(els.list).append(
      h(
        "div",
        { class: "fx__empty" },
        icon(ICONS.folder),
        h("p", { text: t("No project folder yet: the agent can open nothing on this computer.") }),
        h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") }),
      ),
    )
    localPane = null
    return
  }
  if (!local.fixed && local.roots.length > 1) {
    head.append(
      h(
        "select",
        { class: "pane__pick", "aria-label": t("Folder"), title: local.root, onchange: (e) => showLocal({ roots: local.roots, root: e.target.value, fixed: false }) },
        local.roots.map((r) => h("option", { value: r, text: r, selected: r === local.root })),
      ),
    )
  }
  const root = local.root
  const where = t("This computer")
  localPane = explorer(els, {
    key: "local",
    top: () => "",
    ask: (path) => path || "",
    rootName: () => baseName(root),
    crumbs: (path) => {
      const out = [[baseName(root), ""]]
      let at = ""
      for (const part of String(path).split("/").filter(Boolean)) {
        at = at ? `${at}/${part}` : part
        out.push([part, at])
      }
      return out
    },
    list: async (path) => {
      const r = await invoke("local_list", { root, path })
      if (!r || !Array.isArray(r.entries)) throw { detail: t("The server's answer could not be read.") }
      return {
        path: r.path ?? path,
        entries: r.entries.map((e) => ({ ...e, updated_at: e.modified ? new Date(e.modified * 1000).toISOString() : null })),
      }
    },
    preview: (e) => invoke("local_read", { root, path: e.path }),
    open: async (e) => {
      try {
        const f = await invoke("local_read", { root, path: e.path })
        openViewer({ name: f.name, path: `${f.root}/${f.path}`, where, text: f.text, withheld: f.withheld, size: f.size })
      } catch (err) {
        openViewer({ name: e.name, path: e.path, where, error: why(err) })
      }
    },
  })
  localPane.drawTree()
  localPane.go("")
}

/** Read a file the agent showed in a chat on this computer: `path` from the chat's folder. */
export async function readLocal(root, path) {
  return invoke("local_read", { root, path })
}

// --- The server ---------------------------------------------------------------------------------

export async function readServer(path) {
  return get(SERVER_FILES.read(path))
}

// The library's writes, as the person (each answers with the directory's listing, or a refusal
// in the server's words):
//   POST /files/upload?path=   multipart `files` (sent by Rust: `library_upload`, from the dialog)
//   POST /files/mkdir          { path, name }
//   POST /files/rename         { path, name }
//   DELETE /files?path=        to the trash, as on the web

let server = null // the explorer drawn now
let serverRoot = "/" // the directory the server answered `/` with: `/` or the person's home

const parentOf = (path) => path.replace(/\/[^/]*$/, "") || "/"
const reloadServer = (dir) => server?.changed(dir)

function serverSaid(text, error = false) {
  const line = $("server-status")
  line.hidden = !text
  line.textContent = text || ""
  line.className = `status${error ? " is-error" : ""}`
  line.setAttribute("role", error ? "alert" : "status")
}

/** Into `dir`: files chosen in the system's dialog. */
export async function uploadInto(dir) {
  serverSaid("")
  try {
    const r = await invoke("library_upload", { dir, title: t("Upload") })
    if (r.failed?.length) serverSaid(r.failed.map((f) => `${f.name}: ${f.error}`).join("\n"), true)
    if (r.sent) await reloadServer(dir)
  } catch (err) {
    serverSaid(why(err), true)
  }
}

async function makeFolder(dir) {
  const name = await ask({ title: t("New folder"), value: "", ok: t("Create"), cancel: t("Cancel") })
  if (!name) return
  try {
    await post("/files/mkdir", { path: dir, name })
    serverSaid("")
    await reloadServer(dir)
  } catch (err) {
    serverSaid(why(err), true)
  }
}

async function renameEntry(e) {
  const name = await ask({ title: t("Rename"), value: e.name, ok: t("Rename"), cancel: t("Cancel") })
  if (!name || name === e.name) return
  try {
    await post("/files/rename", { path: e.path, name })
    serverSaid("")
    await reloadServer(parentOf(e.path))
  } catch (err) {
    serverSaid(why(err), true)
  }
}

async function deleteEntry(e) {
  const yes = await ask({ title: t("Move to the trash"), text: t("Move “%(name)s” to the trash? It can be restored from there.", { name: e.name }), ok: t("Move to the trash"), cancel: t("Cancel"), danger: true })
  if (!yes) return
  try {
    await del(`/files?path=${encodeURIComponent(e.path)}`)
    serverSaid(t("Moved to the trash."))
    await reloadServer(parentOf(e.path))
  } catch (err) {
    serverSaid(why(err), true)
  }
}

/** What can be done to an entry of the server's tree: a mount (another store) is filled, never
 * renamed or deleted from here. A read-only place is refused by the server, in its words. */
function serverActions(e) {
  const items = []
  if (isDir(e)) items.push({ label: t("Upload"), run: () => uploadInto(e.path) }, { label: t("New folder"), run: () => makeFolder(e.path) })
  else items.push({ label: t("Open in the viewer"), run: () => openServerFile(e.path, e.name) })
  if (e.kind !== "mount") items.push(null, { label: t("Rename"), run: () => renameEntry(e) }, { label: t("Delete"), danger: true, run: () => deleteEntry(e) })
  return items
}

export function renderServer() {
  serverSaid("")
  const els = { crumbs: $("server-crumbs"), tree: $("server-tree"), list: $("server-list"), details: $("server-details") }
  let first = true
  server = explorer(els, {
    key: "server",
    top: () => serverRoot,
    // The top is asked as `/`, which is what the server opens a person at.
    ask: (path) => (!path || path === serverRoot ? "/" : path),
    rootName: () => (serverRoot === "/" ? t("All files") : t("Home")),
    crumbs: (path) => {
      const out = [[serverRoot === "/" ? t("All files") : t("Home"), serverRoot]]
      const rest = path.startsWith(serverRoot) ? path.slice(serverRoot.length) : path
      let at = serverRoot
      for (const part of rest.split("/").filter(Boolean)) {
        at = `${at.replace(/\/$/, "")}/${part}`
        out.push([part, at])
      }
      return out
    },
    list: async (path) => {
      const r = await get(SERVER_FILES.list(path))
      if (!r || !Array.isArray(r.entries)) throw { detail: t("The server's answer could not be read.") }
      if (path === "/" && r.path && r.path !== serverRoot) {
        serverRoot = r.path
        // The top is known now: the tree and the crumbs start there.
        if (first) queueMicrotask(() => server?.drawTree())
      }
      first = false
      return r
    },
    preview: (e) => readServer(e.path),
    open: (e) => openServerFile(e.path, e.name),
    actions: serverActions,
  })
  server.drawTree()
  return server.go(serverRoot)
}

/** A file in the server's tree, in the viewer: from the explorer and from a chat's outputs. */
export async function openServerFile(path, name) {
  const where = t("Server")
  try {
    const f = await readServer(path)
    openViewer({
      name: f.name || name,
      path: f.path || path,
      where,
      text: f.text,
      // The server's own kind and language: its table and the viewer's are the same one.
      kind: ["markdown", "code", "text", "html"].includes(f.kind) ? f.kind : undefined,
      language: f.language || undefined,
      withheld: f.withheld,
      size: f.size,
    })
  } catch (err) {
    openViewer({ name, path, where, error: why(err) })
  }
}

let tab = "local"
let serverRead = false

/** Show one of the two explorers: `local` (this computer) or `server`. The server's is read once. */
export function showFilesTab(which) {
  tab = which === "server" ? "server" : "local"
  for (const b of $("files-tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab))
  $("pane-local").hidden = tab !== "local"
  $("pane-server").hidden = tab !== "server"
  if (tab === "server" && !serverRead) {
    serverRead = true
    renderServer()
  }
}

export function initExplorer() {
  const tabBtn = (which, ico, label) =>
    h("button", { type: "button", role: "tab", class: "tabs__tab", dataset: { tab: which }, "aria-selected": String(which === tab), onclick: () => showFilesTab(which) }, icon(ico), h("span", { text: label }))
  $("files-tabs").replaceChildren(tabBtn("local", ICONS.folder, t("This computer")), tabBtn("server", ICONS.file, t("Server")))
  $("server-refresh").replaceChildren(icon(ICONS.refresh))
  $("server-refresh").addEventListener("click", () => {
    serverSaid("")
    return server ? server.refresh() : renderServer()
  })
  $("server-upload").replaceChildren(icon(ICONS.send))
  $("server-upload").addEventListener("click", () => uploadInto(server?.current() ?? serverRoot))
  $("server-mkdir").replaceChildren(icon(ICONS.folder))
  $("server-mkdir").addEventListener("click", () => makeFolder(server?.current() ?? serverRoot))
  $("local-refresh").replaceChildren(icon(ICONS.refresh))
  $("local-refresh").addEventListener("click", () => (localPane ? localPane.refresh() : renderLocal()))
}
