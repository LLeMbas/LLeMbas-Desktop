// The two explorers, kept apart: this computer's -- the agent's working directory, read through
// a command that reaches only the agent's folders (src-tauri/src/files.rs) -- and the server's
// tree, for the chats, read through /api/v2. A file opens in the viewer either way.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, get, why } from "./bridge.js"
import { openViewer } from "./viewer.js"

// The server's tree as the app's door gives it. `/api/v2` has no file routes yet (the web UI's
// /files pages take the session cookie and answer HTML); these are the routes this pane is written
// against, and a 404 says "not on this server yet" instead of failing:
//   GET /files?path=/a        -> { path, entries: [{ name, path, kind: "dir"|"file", size, mime }] }
//   GET /files/content?path=  -> { path, name, size, text | null, withheld?: "binary"|"too_big" }
export const SERVER_FILES = {
  list: (path) => `/files?path=${encodeURIComponent(path || "/")}`,
  read: (path) => `/files/content?path=${encodeURIComponent(path)}`,
}

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
        { type: "button", class: "tree__row", title: e.path, "aria-expanded": e.kind === "dir" ? "false" : null },
        h("span", { class: "tree__chevron" }, e.kind === "dir" ? icon(ICONS.chevron) : null),
        icon(e.kind === "dir" ? ICONS.folder : ICONS.file),
        h("span", { class: "tree__name", text: e.name }),
        h("span", { class: "tree__size", text: e.kind === "dir" ? "" : bytes(e.size) }),
      )
      row.style.setProperty("--depth", String(depth))
      const li = h("li", { role: "treeitem" }, row)
      if (e.kind === "dir") {
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
      h("button", { type: "button", class: "btn btn--sm", text: t("Add folder…"), onclick: () => invoke("remote_add") }),
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
    list: async (path) => {
      try {
        const r = await get(SERVER_FILES.list(path))
        return r.entries || []
      } catch (err) {
        if (err && (err.status === 404 || err.status === 405)) {
          throw { detail: t("This server does not offer its files to the app yet.") }
        }
        throw err
      }
    },
    open: async (e) => {
      const where = t("Server")
      try {
        const f = await readServer(e.path)
        openViewer({ name: f.name || e.name, path: f.path || e.path, where, text: f.text, withheld: f.withheld, size: f.size })
      } catch (err) {
        openViewer({ name: e.name, path: e.path, where, error: why(err) })
      }
    },
  })
}

export function initExplorer() {
  for (const pane of document.querySelectorAll(".pane")) {
    const toggle = pane.querySelector(".pane__toggle")
    toggle.prepend(h("span", { class: "tree__chevron" }, icon(ICONS.chevron)))
    toggle.addEventListener("click", () => {
      const open = pane.dataset.open !== "true"
      pane.dataset.open = String(open)
      toggle.setAttribute("aria-expanded", String(open))
      $("side").dataset[pane.id === "pane-local" ? "local" : "server"] = String(open)
    })
  }
  $("server-refresh").replaceChildren(icon(ICONS.refresh))
  $("server-refresh").addEventListener("click", renderServer)
  $("local-refresh").replaceChildren(icon(ICONS.refresh))
  $("local-refresh").addEventListener("click", renderLocal)
}
