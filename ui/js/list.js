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

/** Which reading of the list is the latest: an older one's answer is dropped. */
let listRead = 0

const stamp = (c) => Date.parse(c?.updated_at || "") || 0

/**
 * The list again, from the server: its first page -- where every chat that changed is, the
 * list being newest first. Pages loaded after it (More) stay as they are: a chat no longer in
 * the first page that is older than that page's last is further down, as it was; one that is
 * not older would be in the page were it still there, and goes (deleted or archived somewhere
 * else). The rows are changed in place (`render`): the same elements where nothing of the chat
 * changed, so the list keeps its place, and a row its focus.
 */
export async function refreshList() {
  const mine = ++listRead
  // (What the events stream said before now is older than the answer this asks for.)
  said.clear()
  try {
    const [r, f] = await Promise.all([get("/chats?limit=50"), get("/folders").catch(() => ({ folders: [] }))])
    if (mine !== listRead) return
    const first = r.chats || []
    const ids = new Set(first.map((c) => c.id))
    const oldest = first.length ? stamp(first[first.length - 1]) : 0
    const deeper = r.more && rows.length > first.length ? rows.filter((c) => !ids.has(c.id) && stamp(c) <= oldest) : []
    rows = first.concat(deeper)
    more = deeper.length ? more : !!r.more
    folders = f.folders || []
    // What the events stream said since this reading was asked for is newer than its answer.
    for (const [id, running] of said) {
      const c = rows.find((x) => x.id === id)
      if (c) c.running = running
    }
    for (const id of [...busy.keys()]) if (!rows.find((x) => x.id === id)?.running) busy.delete(id)
    look()
    render()
  } catch (err) {
    if (mine !== listRead) return
    clear($("chat-list")).append(h("li", { class: "list__note is-error", text: why(err) }))
    drawn.clear()
  }
}

async function loadMore() {
  const last = rows[rows.length - 1]
  if (!last) return
  const r = await get(`/chats?limit=50&before=${encodeURIComponent(last.id)}`)
  const have = new Set(rows.map((c) => c.id))
  rows = rows.concat((r.chats || []).filter((c) => !have.has(c.id)))
  more = !!r.more
  render()
}

// --- Replies said by the events stream --------------------------------------------------------------
//
// The server's `reply` frame ({chat_id, message_id, live}; main.js hands each on): a reply
// started in a chat (`live`), or -- the same frame again with `live: false` -- has ended. The
// chat's row shows it at once, in place: the running mark set or cleared. The order, the unread
// mark and a chat not listed yet are the server's to say: the list's first page is read a
// moment later, so that frames in a row are one reading.
//
// A server from before the frame was sent again at a reply's end says nothing when a reply
// nobody here follows has ended. Until this server has been seen to say an end (a `live: false`
// for a reply it had said as started), a chat that runs somewhere else is looked for in the
// list a few times, each look later than the one before, and then no more: the list's own
// reading every half minute (main.js) has it from there. Once an end has been seen, nothing is
// looked for at all.

/** After how long (ms) the list is looked at for a chat said to run elsewhere: each look, then no more. */
const BUSY_LOOKS = [5000, 10000, 20000]
/** The chats said to run elsewhere, with how often each has been looked for. */
const busy = new Map()
let busyTimer = 0
let soon = 0
/** What the stream said of a chat since the list was last asked for: chat id -> running. */
const said = new Map()
/** The replies the stream said as started, by message id (the last few hundred): an end said for one of them is an end frame. */
const started = new Set()
/** Whether this server says a reply's end. */
let saysEnds = false

/** The reading of the list a moment from now, once for frames in a row. */
function readSoon() {
  clearTimeout(soon)
  soon = setTimeout(refreshList, 150)
}

/** The timer for the next look, as `busy` stands: the soonest any of its chats is due, or none. */
function look() {
  clearTimeout(busyTimer)
  busyTimer = 0
  if (saysEnds) busy.clear()
  for (const [id, n] of busy) if (n >= BUSY_LOOKS.length || id === ctx.current()) busy.delete(id)
  if (!busy.size) return
  const n = Math.min(...busy.values())
  busyTimer = setTimeout(async () => {
    busyTimer = 0
    for (const [id, k] of busy) if (k === n) busy.set(id, k + 1)
    // (Not read for while the window is not seen; the look still counts.)
    if (document.visibilityState === "visible") await refreshList()
    else look()
  }, BUSY_LOOKS[n])
}

/**
 * The stream's `reply` frame, for the list. `watch`: the chat is not one this window follows
 * (not the open one), so nothing here will say when the reply has ended. `read` false: the
 * list is not read for this frame (the end of a reply the open chat follows: that reply's own
 * stream says it, and the list is read then).
 */
export function replySaid(frame, watch, read = true) {
  const id = frame?.chat_id
  if (typeof id !== "string" || !id) return
  const live = frame.live !== false
  const reply = typeof frame.message_id === "string" ? frame.message_id : ""
  if (live && reply) {
    started.add(reply)
    if (started.size > 400) started.delete(started.values().next().value)
  } else if (reply && started.delete(reply)) saysEnds = true
  said.set(id, live)
  const c = rows.find((x) => x.id === id)
  if (c && !!c.running !== live) {
    c.running = live
    render()
  }
  if (!live || !watch || saysEnds) busy.delete(id)
  else if (!busy.has(id)) busy.set(id, 0)
  look()
  if (read) readSoon()
}

/** A chat as this window changed it (renamed, pinned, moved): its row at once, wherever in the list it is. */
export function noteChat(chat) {
  const i = chat?.id ? rows.findIndex((c) => c.id === chat.id) : -1
  if (i < 0) return
  rows[i] = { ...rows[i], ...chat }
  render()
}

/** A chat is gone from the list (deleted, archived): its row at once, wherever in the list it is. */
export function dropChat(id) {
  const n = rows.length
  rows = rows.filter((c) => c.id !== id)
  busy.delete(id)
  if (rows.length !== n) render()
}

/** Signed out, or another server: nothing of the list is kept, and nothing is looked for. */
export function resetList() {
  listRead++
  clearTimeout(soon)
  clearTimeout(busyTimer)
  soon = busyTimer = 0
  busy.clear()
  said.clear()
  started.clear()
  saysEnds = false
  rows = []
  more = false
  folders = []
  query = ""
  if ($("side-search")) $("side-search").value = ""
  clear($("chat-list"))
  drawn.clear()
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

/** What each element of the list was drawn from: its key (what it is) and everything its drawing looked at. */
const drawn = new Map() // element -> { key, sig }

/**
 * The list as it should be now, put in the place of the list as it is: an element whose thing
 * is drawn from exactly what it was drawn from stays the element it is -- and stays where it is
 * unless the order changed -- so the list keeps its place, an open row its menu's anchor, and
 * the row the keyboard is on its focus (given back where the row itself had to be drawn anew
 * or moved).
 */
function render() {
  const list = $("chat-list")
  const want = [] // { key, sig, make }
  const put = (key, sig, make) => want.push({ key, sig: JSON.stringify(sig), make })
  const head = (text) => put(`head:${text}`, text, () => h("li", { class: "list__head", text }))
  const chat = (c, depth = -1) =>
    put(`chat:${c.id}`, [c, depth, ctx.thisDevices()], () => {
      const li = row(c)
      if (depth >= 0) {
        li.firstChild.style.setProperty("--depth", String(depth))
        li.firstChild.classList.add("is-filed")
      }
      return li
    })
  const words = fold(query).split(/\s+/).filter(Boolean)
  const visible = rows
    .filter((r) => !r.archived && !r.temporary)
    .filter((r) => {
      if (!words.length) return true
      const text = fold(`${r.title || t("New chat")} ${r.device?.directory ? folderName(r.device.directory) : ""}`)
      return words.every((w) => text.includes(w))
    })
  if (!visible.length) {
    const text = words.length ? t("Nothing matches.") : t("No chat yet. Start one with New chat.")
    put(`note:${text}`, text, () => h("li", { class: "list__note", text }))
  } else {
    // Searching: every match, flat. Otherwise the pinned first, then the folders, then the rest.
    let rest = visible
    if (!words.length) {
      const pinned = visible.filter((r) => r.pinned)
      if (pinned.length) {
        head(t("Pinned chats"))
        for (const r of pinned) chat(r)
      }
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
          const count = inside(folder.id)
          put(`folder:${folder.id}`, [folder, depth, count], () => folderHead(folder, depth, count))
          if (folder.collapsed) {
            hidden.add(folder.id)
            continue
          }
          for (const r of visible.filter((x) => filed(x) && x.folder_id === folder.id)) chat(r, depth + 1)
        }
      }
      rest = visible.filter((r) => !r.pinned && !filed(r))
    }
    const today = rest.filter((r) => isToday(r.updated_at))
    const earlier = rest.filter((r) => !isToday(r.updated_at))
    if (today.length) {
      head(t("Today"))
      for (const r of today) chat(r)
    }
    if (earlier.length) {
      head(t("Earlier"))
      for (const r of earlier) chat(r)
    }
    if (more && !words.length) put("more", "", () => h("li", null, h("button", { type: "button", class: "btn btn--sm list__more", text: t("More"), onclick: loadMore })))
  }
  // Where the keyboard is, should its row be drawn anew or moved.
  const active = list.contains(document.activeElement) ? document.activeElement : null
  const focusKey = active ? drawn.get(active.closest("#chat-list > li"))?.key || "" : ""
  const focusClass = active ? String(active.className).split(" ")[0] : ""
  const have = new Map()
  for (const el of [...list.children]) {
    const d = drawn.get(el)
    if (d && !have.has(d.key)) have.set(d.key, el)
    else {
      drawn.delete(el)
      el.remove()
    }
  }
  let at = list.firstElementChild
  for (const w of want) {
    let el = have.get(w.key)
    have.delete(w.key)
    if (el && drawn.get(el).sig !== w.sig) {
      const next = w.make()
      el.replaceWith(next)
      drawn.delete(el)
      if (at === el) at = next
      el = next
    } else if (!el) el = w.make()
    drawn.set(el, { key: w.key, sig: w.sig })
    if (el === at) at = at.nextElementSibling
    else list.insertBefore(el, at)
  }
  for (const el of have.values()) {
    drawn.delete(el)
    el.remove()
  }
  if (active && document.activeElement !== active) {
    const li = [...list.children].find((el) => drawn.get(el)?.key === focusKey)
    const to = active.isConnected ? active : (focusClass && li?.querySelector(`.${CSS.escape(focusClass)}`)) || li?.querySelector("button")
    to?.focus({ preventScroll: true })
  }
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
