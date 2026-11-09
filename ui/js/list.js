// The sidebar's chats: agent chats and chats on the server in one list, newest first, under
// Today and Earlier. An agent chat carries the agent's mark and its folder's name; one that works
// on another device of the account says so in its title. The search line above narrows the list
// by title (and an agent chat by its folder) as it is typed; Ctrl+K searches everything.

import { $, h, clear, append, icon, ICONS } from "./dom.js"
import { get, why } from "./bridge.js"

let ctx = null // { thisDevices(), open(id, kind), current(), menu(anchor, chat) }
let rows = []
let more = false
let query = ""

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
    const r = await get("/chats?limit=50")
    rows = r.chats || []
    more = !!r.more
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
  const today = visible.filter((r) => isToday(r.updated_at))
  const earlier = visible.filter((r) => !isToday(r.updated_at))
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
