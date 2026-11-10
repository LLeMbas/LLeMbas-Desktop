// Archived chats: the ones put away from the sidebar with Archive chat, newest first. Each can be
// opened (read, and written to, as any chat), taken back into the sidebar (Restore chat), or deleted.
//
//   GET   /chats?archived=true&limit=&before=   { chats: [chat], more }
//   PATCH /chats/{id}  { archived: false }      { chat }
//   DELETE /chats/{id}                          204
//
// A chat's title is the person's or a model's words, set as text.

import { $, h, clear, icon, ICONS, when } from "./dom.js"
import { get, patch, del, why } from "./bridge.js"
import { ask, menu } from "./popup.js"
import { folderName } from "./list.js"

let ctx = null // { open(id), changed(), me() }
let rows = []
let more = false
let error = ""
let loading = false

/** The page, read again from the server. */
export async function showArchived() {
  loading = true
  error = ""
  render()
  try {
    const r = await get("/chats?archived=true&limit=50")
    rows = r.chats || []
    more = !!r.more
  } catch (err) {
    rows = []
    more = false
    error = why(err)
  }
  loading = false
  render()
}

async function loadMore(button) {
  const last = rows[rows.length - 1]
  if (!last) return
  button.disabled = true
  try {
    const r = await get(`/chats?archived=true&limit=50&before=${encodeURIComponent(last.id)}`)
    rows = rows.concat(r.chats || [])
    more = !!r.more
  } catch (err) {
    error = why(err)
  }
  render()
}

/** Back into the sidebar. */
export async function unarchive(chat) {
  try {
    const r = await patch(`/chats/${encodeURIComponent(chat.id)}`, { archived: false })
    rows = rows.filter((x) => x.id !== chat.id)
    error = ""
    render()
    ctx?.changed(r?.chat || chat)
    return true
  } catch (err) {
    error = why(err)
    render()
    return false
  }
}

async function remove(chat) {
  const yes = await ask({
    title: t("Delete this chat?"),
    text: t("“%(title)s” is deleted on the server, with its messages and files. This cannot be undone.", { title: chat.title || t("New chat") }),
    ok: t("Delete"),
    cancel: t("Cancel"),
    danger: true,
  })
  if (!yes) return
  try {
    await del(`/chats/${encodeURIComponent(chat.id)}`)
    rows = rows.filter((x) => x.id !== chat.id)
    error = ""
  } catch (err) {
    error = why(err)
  }
  render()
}

function row(c) {
  const agent = c.kind === "agent"
  const title = c.title || t("New chat")
  const mayDelete = ctx.me()?.permissions?.["chat.delete"] !== false
  const sub = [agent && c.device?.directory ? folderName(c.device.directory) : "", when(c.updated_at)].filter(Boolean).join(" · ")
  return h(
    "li",
    { class: "arow", dataset: { id: c.id } },
    h("span", { class: `arow__icon${agent ? " is-agent" : ""}` }, icon(agent ? ICONS.terminal : ICONS.chat)),
    h(
      "button",
      { type: "button", class: "arow__open", title, onclick: () => ctx.open(c.id) },
      h("span", { class: "arow__title" }, h("bdi", { text: title })),
      h("span", { class: "arow__sub", text: sub }),
    ),
    h("button", { type: "button", class: "btn btn--sm arow__unarchive", text: t("Restore chat"), onclick: () => unarchive(c) }),
    mayDelete
      ? h(
          "button",
          {
            type: "button",
            class: "tool arow__more",
            "aria-label": t("More"),
            title: t("More"),
            onclick: (e) => menu(e.currentTarget, [{ label: t("Delete chat"), danger: true, run: () => remove(c) }]),
          },
          icon(ICONS.more),
        )
      : h("span", { class: "arow__more" }),
  )
}

function render() {
  const box = clear($("archived-body"))
  const parts = []
  if (error) parts.push(h("p", { class: "status is-error", text: error }))
  if (loading && !rows.length) parts.push(h("p", { class: "muted page__loading", text: t("Loading…") }))
  else if (!rows.length && !error) parts.push(h("p", { class: "muted arch__empty", text: t("No archived chats.") }))
  if (rows.length) {
    parts.push(h("ul", { class: "arch", "aria-label": t("Archived") }, rows.map(row)))
    if (more) parts.push(h("button", { type: "button", class: "btn btn--sm arch__more", text: t("More"), onclick: (e) => loadMore(e.currentTarget) }))
  }
  box.append(h("div", { class: "arch__page" }, parts))
}

export function initArchived(context) {
  ctx = context
}
