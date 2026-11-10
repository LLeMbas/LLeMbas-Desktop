// The two explorers of the Files page, kept apart as two tabs: this computer's -- the agent's
// folders, read through a command that reaches only them (src-tauri/src/files.rs) -- and the
// server's tree, for the chats, read through /api/v2. A file opens in the viewer either way.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, get, post, del, why } from "./bridge.js"
import { menu, ask } from "./popup.js"
import { openViewer } from "./viewer.js"

// The server's tree as the app's door gives it, read as the person (their own access, no chat):
//   GET /files?path=/a        -> { path, parent, entries: [{ name, path, kind: "dir"|"file"|"mount", size, mime, updated_at }] }
//   GET /files/content?path=  -> { path, name, size, mime, kind, language, sha, text, withheld?: { reason, message } }
// A path the person cannot read is the server's 404, in its words.
export const SERVER_FILES = {
  list: (path) => `/files?path=${encodeURIComponent(path || "/")}`,
  read: (path) => `/files/content?path=${encodeURIComponent(path)}`,
}

/** A directory in either tree: the server's mounts open like its folders. */
const isDir = (e) => e.kind === "dir" || e.kind === "mount"

/** How long a directory may take before the pane says it is still waiting, and offers to ask again. */
export const SLOW_MS = 8000

/**
 * A lazily opened tree in `box`. `list(path)` -> entries; `open(entry)` for a file; `actions(entry)`
 * (optional) -> menu items for an entry's more button. Returns `reload(path)`, which reads a
 * directory that is open again (the root by `rootPath`), the folders open inside it kept open.
 *
 * A directory is never an empty box: while it is read it says "Loading…" (and, past SLOW_MS, that
 * the answer has not come, with Try again); a refusal, or anything that breaks drawing it, is said
 * in its place with Try again. Only the latest reading of a directory is drawn: an answer that
 * comes after the directory was read again, closed or redrawn is dropped, not appended.
 */
function tree(box, { list, open, rootPath, actions }) {
  clear(box)
  const ul = h("ul", { class: "tree", role: "tree" })
  box.append(ul)
  const levels = new Map() // path -> { ul, depth }, each directory drawn now
  const opened = new Set() // the directories open now
  const asked = new WeakMap() // ul -> the reading it shows now (a number)
  const level = async (parent, path, depth) => {
    levels.set(path, { ul: parent, depth })
    const mine = (asked.get(parent) || 0) + 1
    asked.set(parent, mine)
    const stale = () => asked.get(parent) !== mine || !parent.isConnected
    const again = () => {
      clear(parent)
      return level(parent, path, depth)
    }
    const retry = () => h("button", { type: "button", class: "btn btn--sm tree__retry", text: t("Try again"), onclick: again })
    const loading = h("li", { class: "tree__note is-loading", role: "status", "aria-live": "polite" }, h("span", { text: t("Loading…") }))
    loading.style.setProperty("--depth", String(depth))
    parent.append(loading)
    const slow = setTimeout(() => {
      if (stale()) return
      loading.append(h("span", { text: ` ${t("The server has not answered in %(n)s seconds.", { n: Math.round(SLOW_MS / 1000) })}` }), retry())
    }, SLOW_MS)
    const said = (text) => {
      const note = h("li", { class: "tree__note is-error", role: "alert" }, h("span", { text }), retry())
      note.style.setProperty("--depth", String(depth))
      return note
    }
    let entries
    try {
      entries = await list(path)
    } catch (err) {
      clearTimeout(slow)
      if (!stale()) loading.replaceWith(said(why(err)))
      return
    } finally {
      clearTimeout(slow)
    }
    if (stale()) return
    try {
      if (!Array.isArray(entries)) throw { detail: t("The server's answer could not be read.") }
      const items = []
      if (!entries.length) items.push(h("li", { class: "tree__note", text: t("Empty folder") }))
      for (const e of entries) items.push(item(e, depth))
      loading.replaceWith(...items)
    } catch (err) {
      loading.replaceWith(said(err instanceof Error ? err.message : why(err)))
    }
  }
  const item = (e, depth) => {
    const row = h(
      "button",
      { type: "button", class: "tree__row", title: e.path, "aria-expanded": isDir(e) ? "false" : null },
      h("span", { class: "tree__chevron" }, isDir(e) ? icon(ICONS.chevron) : null),
      icon(isDir(e) ? ICONS.folder : ICONS.file),
      h("span", { class: "tree__name", text: e.name }),
      h("span", { class: "tree__size", text: isDir(e) ? "" : bytes(e.size) }),
    )
    row.style.setProperty("--depth", String(depth))
    const items = actions?.(e) || []
    const li = h(
      "li",
      { role: "treeitem", class: items.length ? "tree__item" : null, dataset: { path: e.path } },
      row,
      items.length
        ? h("button", { type: "button", class: "tool tree__more", "aria-label": t("More"), title: t("More"), onclick: (ev) => menu(ev.currentTarget, items) }, icon(ICONS.more))
        : null,
    )
    if (isDir(e)) {
      let kids = null
      const expand = async (opening) => {
        row.setAttribute("aria-expanded", String(opening))
        if (!opening) {
          opened.delete(e.path)
          levels.delete(e.path)
          kids?.remove()
          kids = null
          return
        }
        opened.add(e.path)
        kids?.remove()
        kids = h("ul", { role: "group" })
        li.append(kids)
        await level(kids, e.path, depth + 1)
      }
      row.addEventListener("click", () => expand(row.getAttribute("aria-expanded") !== "true"))
      if (opened.has(e.path)) expand(true)
    } else row.addEventListener("click", () => open(e))
    return li
  }
  const done = level(ul, rootPath, 0)
  const reload = (path) => {
    const at = levels.get(path) || levels.get(rootPath)
    if (!at) return Promise.resolve()
    clear(at.ul)
    return level(at.ul, levels.has(path) ? path : rootPath, at.depth)
  }
  return { done, reload }
}

// --- This computer ------------------------------------------------------------------------------

let local = { root: "", roots: [], fixed: false }

/**
 * Point this computer's pane at a folder: `fixed` (an agent chat's working directory, which is
 * what the pane shows while that chat is open) or one of the agent's folders, chosen in the pane.
 */
export function showLocal({ roots, root, fixed }) {
  const changed = root !== local.root || fixed !== local.fixed || roots.join("\n") !== local.roots.join("\n")
  local = { roots, root: root || (roots.includes(local.root) ? local.root : roots[0] || ""), fixed: !!fixed }
  if (changed) renderLocal()
}

function renderLocal() {
  const head = clear($("local-where"))
  const box = $("local-tree")
  if (!local.roots.length) {
    clear(box).append(
      h("p", { class: "pane__note", text: t("No project folder yet: the agent can open nothing on this computer.") }),
      h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") }),
    )
    return
  }
  if (local.fixed) {
    head.append(h("span", { class: "pane__path", title: local.root }, h("bdi", { text: local.root })))
  } else {
    const pick = h(
      "select",
      { class: "pane__pick", "aria-label": t("Folder"), onchange: (e) => showLocal({ roots: local.roots, root: e.target.value, fixed: false }) },
      local.roots.map((r) => h("option", { value: r, text: r, selected: r === local.root })),
    )
    head.append(pick)
  }
  const root = local.root
  return tree(box, {
    rootPath: "",
    list: async (path) => (await invoke("local_list", { root, path })).entries,
    open: async (e) => {
      const where = t("This computer")
      try {
        const f = await invoke("local_read", { root, path: e.path })
        openViewer({ name: f.name, path: `${f.root}/${f.path}`, where, text: f.text, withheld: f.withheld, size: f.size })
      } catch (err) {
        openViewer({ name: e.name, path: e.path, where, error: why(err) })
      }
    },
  })
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

let server = null // the tree drawn now: { reload(path) }
let serverRoot = "/" // the directory the server answered `/` with: the person's home

const parentOf = (path) => path.replace(/\/[^/]*$/, "") || "/"
const reloadServer = (dir) => server?.reload(dir === serverRoot ? "/" : dir)

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
  if (e.kind !== "mount") items.push(...(items.length ? [null] : []), { label: t("Rename"), run: () => renameEntry(e) }, { label: t("Delete"), danger: true, run: () => deleteEntry(e) })
  return items
}

export function renderServer() {
  const box = $("server-tree")
  serverSaid("")
  server = tree(box, {
    rootPath: "/",
    list: async (path) => {
      const r = await get(SERVER_FILES.list(path))
      if (!r || !Array.isArray(r.entries)) throw { detail: t("The server's answer could not be read.") }
      if (path === "/" && r.path) serverRoot = r.path
      return r.entries
    },
    open: (e) => openServerFile(e.path, e.name),
    actions: serverActions,
  })
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

/** Show one of the two trees: `local` (this computer) or `server`. The server's is read once. */
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
  $("server-where").textContent = t("Your files on the server, as the chats see them.")
  $("server-refresh").replaceChildren(icon(ICONS.refresh))
  $("server-refresh").addEventListener("click", renderServer)
  $("server-upload").replaceChildren(icon(ICONS.send))
  $("server-upload").addEventListener("click", () => uploadInto(serverRoot))
  $("server-mkdir").replaceChildren(icon(ICONS.folder))
  $("server-mkdir").addEventListener("click", () => makeFolder(serverRoot))
  $("local-refresh").replaceChildren(icon(ICONS.refresh))
  $("local-refresh").addEventListener("click", renderLocal)
}
