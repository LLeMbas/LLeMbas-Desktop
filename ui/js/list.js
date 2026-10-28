// The sidebar's chats: agent chats (the default -- the agent on this computer is what the app is
// for) or chats on the server. Agent chats on this computer come first; those on another device
// of the account follow under their own heading.

import { $, h, clear, when, append } from "./dom.js"
import { get, why } from "./bridge.js"

let ctx = null // { kind(), thisDevices(), open(id), current() }
let rows = []
let more = false

/** The list again, from the server. */
export async function refreshList() {
  const kind = ctx.kind()
  try {
    const r = await get(`/chats?kind=${kind}&limit=50`)
    if (ctx.kind() !== kind) return
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
  const kind = ctx.kind()
  const r = await get(`/chats?kind=${kind}&limit=50&before=${encodeURIComponent(last.id)}`)
  if (ctx.kind() !== kind) return
  rows = rows.concat(r.chats || [])
  more = !!r.more
  render()
}

export function markCurrent() {
  const id = ctx.current()
  for (const b of $("chat-list").querySelectorAll(".chatrow")) b.setAttribute("aria-current", String(b.dataset.id === id))
}

function row(c) {
  const b = h(
    "button",
    { type: "button", class: `chatrow${c.unread ? " is-unread" : ""}`, dataset: { id: c.id }, title: c.title || "" },
    h("span", { class: `dot${c.running ? " is-busy" : c.unread ? " is-new" : ""}`, "aria-hidden": "true" }),
    h("span", { class: "row__title", text: c.title || t("New chat") }),
    h("span", { class: "row__when", text: when(c.updated_at) }),
    c.device?.directory ? h("span", { class: "row__sub", title: c.device.directory }, h("bdi", { text: c.device.directory })) : null,
  )
  b.addEventListener("click", () => ctx.open(c.id))
  return h("li", null, b)
}

function render() {
  const list = clear($("chat-list"))
  const kind = ctx.kind()
  const visible = rows.filter((r) => !r.archived && !r.temporary)
  if (!visible.length) {
    list.append(
      h("li", {
        class: "list__note",
        text: kind === "agent" ? t("No agent chat yet. Start one: it works in a folder on this computer.") : t("No chat yet."),
      }),
    )
    return
  }
  if (kind === "agent") {
    const mine = ctx.thisDevices()
    const here = visible.filter((r) => r.device && mine.includes(r.device.token_id))
    const there = visible.filter((r) => !(r.device && mine.includes(r.device.token_id)))
    if (here.length) append(list, [h("li", { class: "list__head", text: t("This computer") }), here.map(row)])
    if (there.length) append(list, [h("li", { class: "list__head", text: t("Other devices") }), there.map(row)])
  } else append(list, visible.map(row))
  if (more) list.append(h("li", null, h("button", { type: "button", class: "btn btn--sm list__more", text: t("More"), onclick: loadMore })))
  markCurrent()
}

export function initList(context) {
  ctx = context
}
