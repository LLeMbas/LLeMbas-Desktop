// The two explorers of the Files page, kept apart as two tabs: this computer's -- the agent's
// folders, read through a command that reaches only them (src-tauri/src/files.rs) -- and the
// server's tree, for the chats, read through /api/v2. A file opens in the viewer either way.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, get, why } from "./bridge.js"
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

/** A lazily opened tree in `box`. `list(path)` -> entries; `open(entry)` for a file. */
function tree(box, { list, open, rootPath }) {
  clear(box)
  const ul = h("ul", { class: "tree", role: "tree" })
  box.append(ul)
  const level = async (parent, path, depth) => {
    let entries
    try {
      entries = await list(path)
    } catch (err) {
      parent.append(h("li", { class: "tree__note is-error", text: why(err) }))
      return
    }
    if (!entries.length) parent.append(h("li", { class: "tree__note", text: t("Empty folder") }))
    for (const e of entries) {
      const row = h(
        "button",
        { type: "button", class: "tree__row", title: e.path, "aria-expanded": isDir(e) ? "false" : null },
        h("span", { class: "tree__chevron" }, isDir(e) ? icon(ICONS.chevron) : null),
        icon(isDir(e) ? ICONS.folder : ICONS.file),
        h("span", { class: "tree__name", text: e.name }),
        h("span", { class: "tree__size", text: isDir(e) ? "" : bytes(e.size) }),
      )
      row.style.setProperty("--depth", String(depth))
      const li = h("li", { role: "treeitem" }, row)
      if (isDir(e)) {
        let kids = null
        row.addEventListener("click", async () => {
          const opening = row.getAttribute("aria-expanded") !== "true"
          row.setAttribute("aria-expanded", String(opening))
          if (!opening) {
            kids?.remove()
            kids = null
            return
          }
          kids = h("ul", { role: "group" })
          li.append(kids)
          await level(kids, e.path, depth + 1)
        })
      } else row.addEventListener("click", () => open(e))
      parent.append(li)
    }
  }
  return level(ul, rootPath, 0)
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
  tree(box, {
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

export function renderServer() {
  const box = $("server-tree")
  tree(box, {
    rootPath: "/",
    list: async (path) => (await get(SERVER_FILES.list(path))).entries || [],
    open: (e) => openServerFile(e.path, e.name),
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
  $("local-refresh").replaceChildren(icon(ICONS.refresh))
  $("local-refresh").addEventListener("click", renderLocal)
}
