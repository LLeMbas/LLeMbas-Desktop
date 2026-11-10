// Memory: what the account's models remember about the person, as the web's Settings → Memory
// keeps it. Each record can be changed or removed; a new one is added at the top, into the data
// group chosen (where there is more than one).
//
//   GET    /memories            { memories: [memory], groups: [{ id, name }] }
//   POST   /memories            { content, data_group_id? }  -> { memory }
//   PATCH  /memories/{id}       { content }                  -> { memory }
//   DELETE /memories/{id}       204
//
// A record may be a model's words (`author` other than "user"): set as text, never markup.

import { $, h, clear, icon, ICONS, when } from "./dom.js"
import { get, post, patch, del, why } from "./bridge.js"
import { ask, menu } from "./popup.js"

let rows = []
let groups = []
let error = ""
let loading = false
let editing = "" // the record being changed
let mark = "" // the record to bring into view (from a search hit)

/** The page, read again from the server; `focus` a record to bring into view. */
export async function showMemory(focus = "") {
  mark = focus
  loading = true
  error = ""
  render()
  try {
    const r = await get("/memories")
    rows = r.memories || []
    groups = r.groups || []
  } catch (err) {
    rows = []
    error = why(err)
  }
  loading = false
  render()
}

async function add(form) {
  const text = form.querySelector("textarea")
  const content = text.value.trim()
  if (!content) return text.focus()
  const group = form.querySelector("select")?.value
  form.querySelector("button[type=submit]").disabled = true
  try {
    const r = await post("/memories", group ? { content, data_group_id: group } : { content })
    if (r?.memory) rows = [r.memory, ...rows]
    error = ""
    text.value = ""
  } catch (err) {
    error = why(err)
  }
  render()
  $("memory-new")?.focus()
}

async function save(m, content) {
  content = content.trim()
  if (!content || content === m.content) {
    editing = ""
    return render()
  }
  try {
    const r = await patch(`/memories/${encodeURIComponent(m.id)}`, { content })
    rows = rows.map((x) => (x.id === m.id ? r?.memory || { ...x, content } : x))
    editing = ""
    error = ""
  } catch (err) {
    error = why(err)
  }
  render()
}

async function remove(m) {
  const yes = await ask({ title: t("Remove this memory?"), text: m.content, ok: t("Remove"), cancel: t("Cancel"), danger: true })
  if (!yes) return
  try {
    await del(`/memories/${encodeURIComponent(m.id)}`)
    rows = rows.filter((x) => x.id !== m.id)
    error = ""
  } catch (err) {
    error = why(err)
  }
  render()
}

function row(m) {
  const sub = [groups.length > 1 ? m.data_group?.name : "", m.author && m.author !== "user" ? t("Noted by a model") : "", when(m.updated_at || m.created_at)].filter(Boolean).join(" · ")
  if (editing === m.id) {
    const box = h("textarea", { class: "textarea mrow__edit", rows: "3", "aria-label": t("Memory") })
    box.value = m.content
    const done = () => save(m, box.value)
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        editing = ""
        render()
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done()
    })
    queueMicrotask(() => box.focus())
    return h(
      "li",
      { class: "mrow is-editing", dataset: { id: m.id } },
      box,
      h(
        "div",
        { class: "set__buttons" },
        h("button", { type: "button", class: "btn btn--sm", text: t("Cancel"), onclick: () => ((editing = ""), render()) }),
        h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Save"), onclick: done }),
      ),
    )
  }
  return h(
    "li",
    { class: `mrow${mark === m.id ? " is-marked" : ""}`, dataset: { id: m.id } },
    h("div", { class: "mrow__words" }, h("p", { class: "mrow__text" }, h("bdi", { text: m.content })), h("p", { class: "mrow__sub", text: sub })),
    h("button", { type: "button", class: "btn btn--sm", text: t("Edit"), onclick: () => ((editing = m.id), render()) }),
    h(
      "button",
      { type: "button", class: "tool", "aria-label": t("More"), title: t("More"), onclick: (e) => menu(e.currentTarget, [{ label: t("Remove"), danger: true, run: () => remove(m) }]) },
      icon(ICONS.more),
    ),
  )
}

function render() {
  const box = clear($("memory-body"))
  const parts = [h("p", { class: "muted", text: t("What your models remember about you, across chats. Change or remove anything here.") })]
  const form = h(
    "form",
    {
      class: "mnew",
      onsubmit: (e) => {
        e.preventDefault()
        add(e.currentTarget)
      },
    },
    h("textarea", { class: "textarea", id: "memory-new", rows: "2", placeholder: t("Something to remember…"), "aria-label": t("Something to remember…") }),
    h(
      "div",
      { class: "mnew__foot" },
      groups.length > 1 ? h("select", { "aria-label": t("Data group") }, groups.map((g) => h("option", { value: g.id, text: g.name }))) : h("span"),
      h("button", { type: "submit", class: "btn btn--sm btn--primary", text: t("Add") }),
    ),
  )
  form.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit()
  })
  parts.push(form)
  if (error) parts.push(h("p", { class: "status is-error", role: "alert", text: error }))
  if (loading && !rows.length) parts.push(h("p", { class: "muted page__loading", text: t("Loading…") }))
  else if (!rows.length && !error) parts.push(h("p", { class: "muted arch__empty", text: t("Nothing remembered yet.") }))
  if (rows.length) parts.push(h("ul", { class: "arch mlist", "aria-label": t("Memory") }, rows.map(row)))
  box.append(h("div", { class: "arch__page" }, parts))
  if (mark) box.querySelector(`.mrow[data-id="${CSS.escape(mark)}"]`)?.scrollIntoView({ block: "center" })
}
