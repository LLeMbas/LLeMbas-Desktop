// Reports: what the scheduled tasks had to tell (harness spec 3.8.0, reports.md). A run that
// has something to say files a report; this page lists them -- the unread first, then the
// newest -- and shows one as a page: its Markdown through markdown.js, a page a model wrote in
// it as a sealed frame (pages.js). A report can be marked read, deleted, and answered: Reply
// opens the conversation that continues it, an ordinary chat that is in no list of chats.
//
// The server's /api/v2 (its fixtures reports.json, report.json, report_reply.json,
// event_reports.json):
//
//   GET    /reports?unread=&schedule=   { reports: [item], unread: n }
//   GET    /reports/{id}                { report: item + body, text, pages, model, chat }
//                                       (reading it does not mark it read)
//   POST   /reports/{id}/read           marks it read
//   DELETE /reports/{id}                204; the conversation that continued it goes with it
//   POST   /reports/{id}/reply          { chat }: the same chat every time
//   GET    /events                      `reports` frames { unread, newest }: followed by the app
//                                       (Rust, watch.rs), handed here as the `reports` event
//
// item: { id, title, summary, importance: "normal" | "high", schedule: { id, title } | null,
// created, unread }. A server without the routes answers 404: the page says so. Everything a
// report says is a model's words: set as text, its body through markdown.js.

import { $, h, clear, icon, ICONS, when } from "./dom.js"
import { get, post, del, why, listen, invoke } from "./bridge.js"
import { ask } from "./popup.js"
import { markdown } from "./markdown.js"
import { pageMount } from "./pages.js"

let ctx = null // { show(), openChat(id), openSchedule(id), count(n) }
let view = { name: "list" } // { name: "list" } | { name: "report", id }
let rows = []
let unread = 0
let loading = false
let error = ""
let missing = true // the server has no reports routes (or it is not known yet that it has)
let answering = new Map() // the chat a report continues in -> { id, title } of the report

const enc = encodeURIComponent

/** The report a chat continues, where this window opened it from one: `{ id, title }`. */
export function reportOf(chat) {
  return answering.get(chat) || null
}

/** How many reports are unread, as last heard. */
export function unreadReports() {
  return unread
}

function counted(n) {
  unread = Math.max(0, Number(n) || 0)
  ctx?.count(unread)
}

async function read() {
  loading = true
  error = ""
  draw()
  try {
    const r = await get("/reports")
    rows = Array.isArray(r?.reports) ? r.reports : []
    counted(r?.unread ?? rows.filter((x) => x.unread).length)
    missing = false
  } catch (err) {
    rows = []
    missing = err?.status === 404
    error = missing ? "" : why(err)
  }
  loading = false
  draw()
}

/** The Reports page: the list, or one report (`id`). */
export async function showReports(id = "") {
  view = id ? { name: "report", id } : { name: "list" }
  invoke("pages_clear")
  if (view.name === "list") {
    invoke("set_open_report", { report: null })
    return read()
  }
  return open(id)
}

function head(title, tools = [], crumb = false) {
  const el = $("reports-title")
  if (crumb) el.replaceChildren(h("button", { type: "button", class: "crumb", id: "reports-back", text: t("Reports"), onclick: () => showReports() }), h("span", { class: "crumb__sep", "aria-hidden": "true", text: "›" }), h("span", { text: title }))
  else el.textContent = title
  $("reports-tools").replaceChildren(...tools)
}

function stamp(value) {
  const d = new Date(value)
  if (!value || Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(document.documentElement.lang || undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

function row(r) {
  return h(
    "li",
    { class: `rrow${r.unread ? " is-unread" : ""}`, dataset: { id: r.id } },
    h(
      "button",
      { type: "button", class: "rrow__open", onclick: () => showReports(r.id) },
      h("span", { class: "rrow__dot", role: "img", "aria-label": r.unread ? t("Unread") : null }),
      h("span", { class: "rrow__what" }, h("span", { class: "rrow__title", text: r.title || t("Report") }), h("span", { class: "rrow__summary", text: r.summary || "" })),
      h("span", { class: "rrow__meta" }, r.importance === "high" ? h("span", { class: "schip is-failed", text: t("Important") }) : null, h("span", { class: "rrow__from", text: r.schedule?.title || "" }), h("span", { class: "rrow__when", title: stamp(r.created), text: when(r.created) })),
    ),
  )
}

function draw() {
  if (view.name !== "list") return
  head(t("Reports"), [h("button", { type: "button", class: "tool", "aria-label": t("Read again"), title: t("Read again"), onclick: () => read() }, icon(ICONS.refresh))])
  const box = clear($("reports-body"))
  const parts = []
  if (error) parts.push(h("p", { class: "status is-error", role: "alert", text: error }), h("button", { type: "button", class: "btn btn--sm", text: t("Try again"), onclick: () => read() }))
  if (missing) parts.push(h("p", { class: "muted arch__empty", text: t("This server has no reports yet. Ask its administrator to update it.") }))
  else if (loading && !rows.length) parts.push(h("p", { class: "muted page__loading", text: t("Loading…") }))
  else if (!rows.length && !error) parts.push(h("p", { class: "muted arch__empty", text: t("No reports yet. A scheduled task files one when it has something to tell you.") }))
  if (rows.length) parts.push(h("ul", { class: "rlist", "aria-label": t("Reports") }, rows.map(row)))
  box.append(h("div", { class: "arch__page" }, parts))
}

async function open(id) {
  head(t("Report"), [], true)
  const box = clear($("reports-body"))
  box.append(h("div", { class: "arch__page" }, h("p", { class: "muted page__loading", text: t("Loading…") })))
  let r
  try {
    r = (await get(`/reports/${enc(id)}`))?.report
    if (!r) throw { detail: t("The report is no longer there.") }
  } catch (err) {
    if (view.id !== id) return
    box.replaceChildren(h("div", { class: "arch__page" }, h("p", { class: "status is-error", role: "alert", text: err?.status === 404 ? t("The report is no longer there.") : why(err) }), h("button", { type: "button", class: "btn btn--sm", text: t("Back to Reports"), onclick: () => showReports() })))
    return
  }
  if (view.id !== id) return
  invoke("set_open_report", { report: id })
  const reply = h("button", { type: "button", class: "btn btn--sm btn--primary", id: "report-reply", onclick: () => answer(r, reply) }, icon(ICONS.chat), h("span", { text: t("Reply") }))
  const remove = h("button", { type: "button", class: "btn btn--sm", id: "report-delete", text: t("Delete"), onclick: () => removeReport(r) })
  head(r.title || t("Report"), [reply, remove], true)
  const pages = Array.isArray(r.pages) ? r.pages : []
  box.replaceChildren(
    h(
      "article",
      { class: "arch__page report", dataset: { id: r.id } },
      // The title whole, as the page's own heading: the header's is cut where the window is narrow.
      h("h2", { class: "report__title", text: r.title || t("Report") }),
      h(
        "p",
        { class: "report__meta" },
        r.importance === "high" ? h("span", { class: "schip is-failed", text: t("Important") }) : null,
        // The task that filed it, a press away -- where it is still there (the server says
        // `schedule: null` once it is gone; one deleted since is found out when asked for).
        r.schedule?.id ? h("button", { type: "button", class: "linkish", id: "report-schedule", text: r.schedule.title || t("Scheduled"), onclick: (e) => toSchedule(r.schedule, e.currentTarget) }) : r.schedule?.title ? h("span", { text: r.schedule.title }) : null,
        h("span", { title: when(r.created), text: stamp(r.created) }),
      ),
      h("div", { class: "md report__body" }, markdown(r.body || r.text || "", pages.length ? { list: pages, mount: (pg) => pageMount({ kind: "r", owner: r.id, title: pg.title, digest: pg.digest }) } : null)),
    ),
  )
  // Open here, it is read: said to the server. The count is the server's to say (its `reports`
  // frame follows); where no frame comes it is asked for once.
  if (r.unread) {
    post(`/reports/${enc(id)}/read`)
      .then(() => {
        rows = rows.map((x) => (x.id === id ? { ...x, unread: false } : x))
        const heard = frames
        setTimeout(() => heard === frames && recount(), 3000)
      })
      .catch(() => {})
  }
}

/** The unread count, asked of the server. */
function recount() {
  return get("/reports?unread=1").then((r) => counted(r?.unread))
}

/** To the task that filed a report -- unless it is gone, which is then said in the link's place. */
async function toSchedule(schedule, link) {
  try {
    await get(`/schedules/${enc(schedule.id)}`)
    ctx.openSchedule(schedule.id)
  } catch (err) {
    if (err?.status !== 404) return ctx.openSchedule(schedule.id)
    link.replaceWith(h("span", { id: "report-schedule-gone", title: t("This scheduled task is no longer there."), text: schedule.title || t("Scheduled") }))
  }
}

/** Reply: the conversation that continues the report -- the same one every time -- as a chat. */
async function answer(r, button) {
  button.disabled = true
  try {
    const said = await post(`/reports/${enc(r.id)}/reply`)
    if (!said?.chat) throw { detail: t("The server opened no conversation.") }
    answering.set(said.chat, { id: r.id, title: r.title || t("Report") })
    ctx.openChat(said.chat)
  } catch (err) {
    button.disabled = false
    $("reports-body").prepend(h("p", { class: "status is-error", role: "alert", text: why(err) }))
  }
}

async function removeReport(r) {
  const yes = await ask({ title: t("Delete this report?"), text: t("The conversation that continued it goes with it."), ok: t("Delete"), cancel: t("Cancel"), danger: true })
  if (!yes) return
  try {
    await del(`/reports/${enc(r.id)}`)
    for (const [chat, of] of answering) if (of.id === r.id) answering.delete(chat)
    showReports()
  } catch (err) {
    $("reports-body").prepend(h("p", { class: "status is-error", role: "alert", text: why(err) }))
  }
}

/** The commands of Ctrl+K: the page. */
export function reportsCommands() {
  return missing ? [] : [{ label: unread ? `${t("Reports")} · ${t("%(n)s unread", { n: unread })}` : t("Reports"), run: () => (ctx.show(), showReports()) }]
}

let frames = 0 // how many `reports` frames were heard

export function initReports(context) {
  ctx = context
  // The server's `reports` frame: the count beside Reports; the list too, where it is shown.
  // A server that sends one has reports.
  listen("reports", (e) => {
    const frame = e.payload || {}
    frames += 1
    missing = false
    counted(frame.unread)
    if (!$("page-reports").hidden && view.name === "list" && !loading) read()
  })
}

/**
 * Signed in: whether this server has reports, and how many are unread. Only an answer says it
 * has: a server without the routes (404) has no Reports row, and neither has one that refuses
 * or fails -- until it answers, or sends a `reports` frame.
 */
export function startReports() {
  const account = ++signedIn
  ctx.count(0, true)
  return get("/reports?unread=1")
    .then((r) => {
      if (account !== signedIn) return
      missing = false
      counted(r?.unread)
    })
    .catch(() => {
      if (account !== signedIn) return
      missing = true
      ctx.count(0, true)
    })
}

let signedIn = 0 // which sign-in the answers are for

/** Signed out: nothing of this account's reports stays for the next one. */
export function stopReports() {
  signedIn += 1
  view = { name: "list" }
  rows = []
  unread = 0
  loading = false
  error = ""
  missing = true
  answering = new Map()
  ctx.count(0, true)
  clear($("reports-body"))
  $("reports-tools").replaceChildren()
  invoke("set_open_report", { report: null })
}
