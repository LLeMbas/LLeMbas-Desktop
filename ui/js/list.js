// The sidebar's chats: agent chats and chats on the server in one list, newest first. The
// pinned ones first, then the account's chat folders (`GET /folders`, nested, each folding as the
// server keeps it), then the rest under Today and Earlier. An agent chat carries the agent's mark
// and its project folder's name; one that works on another device of the account says so in its
// title. The search line above narrows the list by title (and an agent chat by its folder) as it
// is typed, flat; Ctrl+K searches everything.
//
// Folders are made, renamed and deleted here (`POST/PATCH/DELETE /folders`); a chat is pinned and
// moved from its own menu (`PATCH /chats/{id}` `pinned`, `folder_id`). Deleting a folder never
// deletes a chat: its chats go back to the list.

import { $, h, clear, append, icon, ICONS } from "./dom.js"
import { get, post, patch, del, why } from "./bridge.js"
import { menu, ask } from "./popup.js"

let ctx = null // { thisDevices(), open(id, kind), current(), menu(anchor, chat), note(text) }
let rows = []
let more = false
let query = ""
let folders = [] // { id, name, parent_id, collapsed, position }

/** Lower case, without diacritics: "Príliš" is found by "prilis". */
function fold(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
}

/** The list again, from the server. */
export async function refreshList() {
  try {
    const [r, f] = await Promise.all([get("/chats?limit=50"), get("/folders").catch(() => ({ folders: [] }))])
    rows = r.chats || []
    more = !!r.more
    folders = f.folders || []
    render()
  } catch (err) {
    clear($("chat-list")).append(h("li", { class: "list__note is-error", text: why(err) }))
  }
}

async function loadMore() {
  const last = rows[rows.length - 1]
  if (!last) return
  const r = await get(`/chats?limit=50&before=${encodeURIComponent(last.id)}`)
  rows = rows.concat(r.chats || [])
  more = !!r.more
  render()
}

export function markCurrent() {
  const id = ctx.current()
  for (const b of $("chat-list").querySelectorAll(".chatrow")) b.setAttribute("aria-current", String(b.dataset.id === id))
}

/** The folder's last part: what tells one project from another at a glance. */
export function folderName(dir) {
  const parts = String(dir || "").replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || dir || ""
}

function row(c) {
  const agent = c.kind === "agent"
  const elsewhere = agent && c.device && !ctx.thisDevices().includes(c.device.token_id)
  const title = c.title || t("New chat")
  const b = h(
    "button",
    {
      type: "button",
      class: `chatrow${c.unread ? " is-unread" : ""}`,
      dataset: { id: c.id, kind: c.kind },
      title: agent && c.device?.directory ? `${title}\n${c.device.directory}${elsewhere ? ` · ${t("Another device")}` : ""}` : title,
    },
    h("span", { class: `chatrow__icon${agent ? " is-agent" : ""}` }, icon(agent ? ICONS.terminal : ICONS.chat)),
    h("span", { class: "chatrow__title", text: title }),
    agent && c.device?.directory ? h("span", { class: "chatrow__where", text: folderName(c.device.directory) }) : h("span", { class: "chatrow__where" }),
    h("span", { class: `chatrow__state${c.running ? " is-busy" : c.unread ? " is-new" : ""}`, "aria-hidden": "true" }),
  )
  b.addEventListener("click", () => ctx.open(c.id, c.kind))
  // The chat's own menu (rename, archive, delete…) on a right click, or the context-menu key.
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    ctx.menu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : b, c)
  })
  return h("li", null, b)
}

/** A folder's head: it folds and unfolds; its menu renames it, makes one inside, deletes it. */
function folderHead(f, depth, count) {
  const open = !f.collapsed
  const head = h(
    "button",
    {
      type: "button",
      class: "folderrow",
      dataset: { folder: f.id },
      style: depth ? `--depth: ${depth}` : null,
      "aria-expanded": String(open),
      title: f.name,
      onclick: () => foldFolder(f, !f.collapsed),
    },
    h("span", { class: "folderrow__chev" }, icon(open ? ICONS.chevronDown : ICONS.chevron)),
    h("span", { class: "folderrow__icon" }, icon(ICONS.folder)),
    h("span", { class: "folderrow__name", text: f.name }),
    h("span", { class: "folderrow__count", text: count ? String(count) : "" }),
  )
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    folderMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : head, f)
  })
  const more = h("button", { type: "button", class: "folderrow__more", "aria-label": t("More"), title: t("More"), onclick: (e) => folderMenu(e.currentTarget, f) }, icon(ICONS.more))
  return h("li", { class: "list__folder" }, head, more)
}

async function foldFolder(f, collapsed) {
  f.collapsed = collapsed
  render()
  try {
    await patch(`/folders/${encodeURIComponent(f.id)}`, { collapsed })
  } catch {
    // Folding is the sidebar's own business: drawn as asked even where the server did not keep it.
  }
}

function folderMenu(anchor, f) {
  menu(anchor, [
    { label: t("Rename folder"), run: () => renameFolder(f) },
    { label: t("New folder"), run: () => newFolder(f.id) },
    null,
    { label: t("Delete folder"), danger: true, run: () => deleteFolder(f) },
  ])
}

/** A new folder, at the top level or inside `parent`: its id once made, else "". */
export async function newFolder(parent = "") {
  const name = await ask({ title: t("New folder"), text: t("Folder name"), value: "", ok: t("Create"), cancel: t("Cancel") })
  if (!name) return ""
  try {
    const r = await post("/folders", parent ? { name, parent_id: parent } : { name })
    await refreshList()
    return r.folder?.id || ""
  } catch (err) {
    ctx.note?.(why(err))
    return ""
  }
}

async function renameFolder(f) {
  const name = await ask({ title: t("Rename folder"), text: t("Folder name"), value: f.name, ok: t("Rename"), cancel: t("Cancel") })
  if (!name || name === f.name) return
  try {
    await patch(`/folders/${encodeURIComponent(f.id)}`, { name })
    await refreshList()
  } catch (err) {
    ctx.note?.(why(err))
  }
}

async function deleteFolder(f) {
  const ok = await ask({ title: t("Delete folder"), text: t("“%(name)s” and the folders inside it are deleted. Their chats stay, back in the list.", { name: f.name }), ok: t("Delete"), cancel: t("Cancel"), danger: true })
  if (!ok) return
  try {
    await del(`/folders/${encodeURIComponent(f.id)}`)
    await refreshList()
  } catch (err) {
    ctx.note?.(why(err))
  }
}

/** The account's chat folders, as the list last read them. */
export function listedFolders() {
  return folders
}

/** The folders as a tree, depth first, each with its depth: what a menu of them lists. */
export function folderTree() {
  const out = []
  const known = new Set(folders.map((f) => f.id))
  const walk = (parent, depth) => {
    const kids = folders.filter((f) => (f.parent_id && known.has(f.parent_id) ? f.parent_id : null) === parent).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name))
    for (const f of kids) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function isToday(stamp) {
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return false
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function render() {
  const list = clear($("chat-list"))
  const words = fold(query).split(/\s+/).filter(Boolean)
  const visible = rows
    .filter((r) => !r.archived && !r.temporary)
    .filter((r) => {
      if (!words.length) return true
      const text = fold(`${r.title || t("New chat")} ${r.device?.directory ? folderName(r.device.directory) : ""}`)
      return words.every((w) => text.includes(w))
    })
  if (!visible.length) {
    list.append(h("li", { class: "list__note", text: words.length ? t("Nothing matches.") : t("No chat yet. Start one with New chat.") }))
    return
  }
  // Searching: every match, flat. Otherwise the pinned first, then the folders, then the rest.
  let rest = visible
  if (!words.length) {
    const pinned = visible.filter((r) => r.pinned)
    if (pinned.length) append(list, [h("li", { class: "list__head", text: t("Pinned chats") }), pinned.map(row)])
    const known = new Set(folders.map((f) => f.id))
    const filed = (r) => !r.pinned && r.folder_id && known.has(r.folder_id)
    const tree = folderTree()
    if (tree.length) {
      const inside = (id) => {
        // A folder's count: its own chats and those of the folders inside it.
        const ids = new Set([id])
        for (const { folder } of tree) if (folder.parent_id && ids.has(folder.parent_id)) ids.add(folder.id)
        return visible.filter((r) => filed(r) && ids.has(r.folder_id)).length
      }
      const hidden = new Set() // folders under a folded one
      for (const { folder, depth } of tree) {
        if (folder.parent_id && hidden.has(folder.parent_id)) {
          hidden.add(folder.id)
          continue
        }
        list.append(folderHead(folder, depth, inside(folder.id)))
        if (folder.collapsed) {
          hidden.add(folder.id)
          continue
        }
        for (const r of visible.filter((x) => filed(x) && x.folder_id === folder.id)) {
          const li = row(r)
          li.firstChild.style.setProperty("--depth", String(depth + 1))
          li.firstChild.classList.add("is-filed")
          list.append(li)
        }
      }
    }
    rest = visible.filter((r) => !r.pinned && !filed(r))
  }
  const today = rest.filter((r) => isToday(r.updated_at))
  const earlier = rest.filter((r) => !isToday(r.updated_at))
  if (today.length) append(list, [h("li", { class: "list__head", text: t("Today") }), today.map(row)])
  if (earlier.length) append(list, [h("li", { class: "list__head", text: t("Earlier") }), earlier.map(row)])
  if (more && !words.length) list.append(h("li", null, h("button", { type: "button", class: "btn btn--sm list__more", text: t("More"), onclick: loadMore })))
  markCurrent()
}

/** The chats as the list has them (the palette's and the sidebar's first look). */
export function listed() {
  return rows
}

export function initList(context) {
  ctx = context
  $("side-search-icon").replaceChildren(icon(ICONS.search))
  $("side-search").addEventListener("input", (e) => {
    query = e.target.value
    render()
  })
  $("side-search").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.value) {
      e.stopPropagation()
      e.target.value = ""
      query = ""
      render()
    } else if (e.key === "Enter") {
      // The first match opens.
      $("chat-list").querySelector(".chatrow")?.click()
    }
  })
}
