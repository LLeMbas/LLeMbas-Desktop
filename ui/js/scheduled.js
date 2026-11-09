// Scheduled tasks: standing instructions the server runs on its own -- "every weekday at 8:00,
// summarise …". The list (each task's next run, how its last run went, a switch to pause it), a
// task's page (what it does, when, how it tells, its history, Run now), and a new one said in
// words: the server turns them into a rule and a standalone instruction, the next five runs are
// shown, and only then is it saved. The server runs them; this page only reads and asks.
//
// Its routes are the server's /api/v2 for scheduling:
//
//   GET    /schedules                  { schedules: [Schedule] }
//   GET    /schedules/{id}             { schedule, runs: [Run], more }
//   POST   /schedules/compile          { text } -> { title, instruction, summary, rule, next: [stamp] }
//   POST   /schedules                  { request, title, instruction, rule, model?, notify?, mode? } -> { schedule }
//   PATCH  /schedules/{id}             { enabled?, notify?, mode?, model? } -> { schedule }
//   POST   /schedules/{id}/run         -> { run }
//   DELETE /schedules/{id}
//
// A server without them answers 404: the page says this server has no scheduled tasks yet.
// Everything a task says (its title, instruction, a run's error) is the person's or a model's
// words, set as text.

import { $, h, clear, icon, ICONS, when } from "./dom.js"
import { get, post, patch, del, why } from "./bridge.js"
import { ask, menu } from "./popup.js"
import { avatar } from "./models.js"

let ctx = null // { status(), models(), me(), openChat(id), show() }
let view = { name: "list" } // { name: "list" } | { name: "task", id } | { name: "new" }
let tasks = []
let missing = false // the server has no scheduling routes

const STATUS = {
  ok: () => t("Done"),
  silent: () => t("Nothing to report"),
  failed: () => t("Failed"),
  missed: () => t("Missed"),
  skipped: () => t("Skipped"),
  waiting: () => t("Waiting for a free model"),
  running: () => t("Running"),
}

const NOTIFY = {
  always: () => t("Always"),
  matters: () => t("When it matters"),
  never: () => t("Never"),
}

const MODE = {
  fresh: () => t("A new chat for each run"),
  continue: () => t("One chat that grows"),
}

const enc = encodeURIComponent

function statusChip(run) {
  if (!run) return h("span", { class: "schip", text: t("Not run yet") })
  const word = STATUS[run.status]?.() || run.status
  const n = run.status === "missed" && run.missed > 1 ? ` ×${run.missed}` : ""
  return h("span", { class: `schip is-${run.status}`, text: `${word}${n}` })
}

/** A stamp as a date and time in the person's language: "Mon 10 Nov, 08:00". */
function stamp(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(document.documentElement.lang || undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

function nextWords(task) {
  if (!task.enabled) return t("Paused")
  if (!task.next_run_at) return t("No more runs")
  return `${when(task.next_run_at)} · ${stamp(task.next_run_at)}`
}

// --- Reading ------------------------------------------------------------------------------------

async function load() {
  try {
    tasks = (await get("/schedules")).schedules || []
    missing = false
  } catch (err) {
    tasks = []
    missing = err?.status === 404 || err?.status === 405
    if (!missing) throw err
  }
}

/** Show the page: the list, or one task's page (`id`). */
export async function showScheduled(id) {
  view = id ? { name: "task", id } : { name: "list" }
  await draw()
}

async function draw() {
  const body = clear($("scheduled-body"))
  clear($("scheduled-tools"))
  clear($("scheduled-place"))
  body.append(h("p", { class: "muted page__loading", text: t("Loading…") }))
  try {
    if (view.name === "task") await drawTask(view.id)
    else if (view.name === "new") drawNew()
    else {
      await load()
      drawList()
    }
  } catch (err) {
    clear(body).append(h("p", { class: "status is-error", text: why(err) }))
  }
}

/** The page's title; with a way back, "Scheduled ›" before it. */
function header(title, back) {
  const h1 = $("scheduled-title")
  if (back) h1.replaceChildren(h("button", { type: "button", class: "crumb", onclick: back, text: t("Scheduled") }), h("span", { class: "crumb__sep", "aria-hidden": "true", text: "›" }), h("span", { text: title }))
  else h1.textContent = title
}

// --- The list -------------------------------------------------------------------------------------

function drawList() {
  header(t("Scheduled"))
  const tools = clear($("scheduled-tools"))
  const body = clear($("scheduled-body"))
  if (missing) {
    body.append(empty(t("This server has no scheduled tasks yet."), t("Scheduled tasks need a newer LLeMbas server. Ask its administrator to update it.")))
    return
  }
  tools.append(h("button", { type: "button", class: "btn btn--sm btn--primary", onclick: () => go({ name: "new" }) }, icon(ICONS.plus), h("span", { text: t("New scheduled task") })))
  if (!tasks.length) {
    body.append(
      empty(t("Nothing is scheduled."), t("Say what should happen and when — “every weekday at 8:00, summarise the news on my reading list” — and the server runs it for you.")),
      h("div", { class: "empty__actions" }, h("button", { type: "button", class: "btn btn--primary", onclick: () => go({ name: "new" }) }, icon(ICONS.plus), h("span", { text: t("New scheduled task") }))),
    )
    return
  }
  const list = h("ul", { class: "tasks-list", role: "list" })
  for (const task of tasks) list.append(taskRow(task))
  body.append(list)
}

function empty(title, text) {
  return h("div", { class: "empty" }, h("span", { class: "empty__icon" }, icon(ICONS.clock)), h("h2", { class: "empty__title", text: title }), h("p", { class: "empty__text", text }))
}

/** One task: icon · title and its rule in words · next run · last status · pause switch. */
function taskRow(task) {
  const toggle = h("input", {
    type: "checkbox",
    role: "switch",
    checked: !!task.enabled,
    "aria-label": task.enabled ? t("Pause %(title)s", { title: task.title }) : t("Resume %(title)s", { title: task.title }),
    title: task.enabled ? t("Pause") : t("Resume"),
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => setEnabled(task, e.target.checked),
  })
  const row = h(
    "li",
    { class: `task${task.enabled ? "" : " is-paused"}` },
    h(
      "button",
      { type: "button", class: "task__open", onclick: () => go({ name: "task", id: task.id }) },
      h("span", { class: "task__icon" }, icon(ICONS.clock)),
      h("span", { class: "task__what" }, h("span", { class: "task__title", text: task.title || task.request || "" }), h("span", { class: "task__rule", text: task.summary || "" })),
      h("span", { class: "task__next" }, h("span", { class: "task__label", text: t("Next run") }), h("span", { class: "task__value", text: nextWords(task) })),
      h("span", { class: "task__last" }, statusChip(task.last_run)),
    ),
    h("label", { class: "toggle task__toggle" }, toggle),
  )
  return row
}

async function setEnabled(task, on) {
  try {
    const r = await patch(`/schedules/${enc(task.id)}`, { enabled: on })
    Object.assign(task, r.schedule || { enabled: on })
  } catch (err) {
    await ask({ title: t("Scheduled"), text: why(err), ok: t("Close"), cancel: t("Cancel") })
  }
  if (view.name === "list") drawList()
  else draw()
}

function go(next) {
  view = next
  draw()
}

// --- One task -----------------------------------------------------------------------------------

async function drawTask(id) {
  const r = await get(`/schedules/${enc(id)}`)
  const task = r.schedule
  const runs = r.runs || []
  header(task.title || t("Scheduled"), () => go({ name: "list" }))
  const tools = clear($("scheduled-tools"))
  tools.append(
    h("button", { type: "button", class: "btn btn--sm btn--primary", onclick: (e) => runNow(task, e.currentTarget) }, icon(ICONS.play), h("span", { text: t("Run now") })),
    h("button", {
      type: "button",
      class: "tool",
      "aria-label": t("More"),
      title: t("More"),
      onclick: (e) =>
        menu(e.currentTarget, [
          { label: task.enabled ? t("Pause") : t("Resume"), run: () => setEnabled(task, !task.enabled) },
          null,
          { label: t("Delete"), danger: true, run: () => remove(task) },
        ]),
    }, icon(ICONS.more)),
  )
  const models = ctx.models()
  const model = models.find((m) => m.id === task.model)
  const body = clear($("scheduled-body"))
  body.append(
    h(
      "section",
      { class: "sched" },
      h(
        "div",
        { class: "sched__facts" },
        fact(t("When"), h("span", { text: task.summary || "" })),
        fact(t("Next run"), h("span", { text: nextWords(task) })),
        fact(t("Last run"), statusChip(task.last_run)),
        fact(t("Model"), model ? h("span", { class: "sched__model" }, avatar(model), h("span", { text: model.name })) : h("span", { text: task.model || t("default") })),
        fact(t("Tell me"), h("span", { text: NOTIFY[task.notify]?.() || NOTIFY.matters() })),
        fact(t("Runs"), h("span", { text: MODE[task.mode]?.() || MODE.fresh() })),
      ),
      h("div", { class: "sched__what" }, h("h2", { class: "sched__h", text: t("What it does") }), h("p", { class: "sched__instruction", text: task.instruction || task.request || "" }), task.request && task.request !== task.instruction ? h("p", { class: "sched__asked", text: t("You asked: “%(text)s”", { text: task.request }) }) : null),
      upcoming(task.next || []),
    ),
    history(runs),
  )
}

function fact(label, value) {
  return h("div", { class: "fact" }, h("span", { class: "fact__label", text: label }), h("span", { class: "fact__value" }, value))
}

function upcoming(next) {
  if (!next.length) return null
  return h("div", { class: "sched__next" }, h("h2", { class: "sched__h", text: t("The next runs") }), h("ol", { class: "runs-next" }, next.slice(0, 5).map((s) => h("li", null, h("span", { text: stamp(s) }), h("span", { class: "muted", text: when(s) })))))
}

/** The history: one row per run on fixed tracks -- status, when, model, and its result. */
function history(runs) {
  const box = h("section", { class: "sched__history" }, h("h2", { class: "sched__h", text: t("History") }))
  if (!runs.length) {
    box.append(h("p", { class: "muted", text: t("It has not run yet.") }))
    return box
  }
  const models = ctx.models()
  const list = h("ul", { class: "runs" })
  for (const run of runs) {
    const m = models.find((x) => x.id === run.model)
    list.append(
      h(
        "li",
        { class: "run" },
        h("span", { class: "run__status" }, statusChip(run)),
        h("span", { class: "run__when", title: run.started_at || run.due_at || "" }, h("span", { text: stamp(run.started_at || run.due_at) }), run.timing === "late" || run.timing === "catch_up" ? h("span", { class: "run__late", text: run.timing === "late" ? t("late") : t("caught up") }) : null),
        h("span", { class: "run__model", title: run.model_reason || "" }, m ? avatar(m) : null, h("span", { text: m?.name || run.model || "" })),
        run.chat_id
          ? h("button", { type: "button", class: "btn btn--sm", text: t("Open the result"), onclick: () => ctx.openChat(run.chat_id) })
          : h("span", { class: "run__error", title: run.error || "", text: run.error || "" }),
      ),
    )
  }
  box.append(list)
  return box
}

async function runNow(task, btn) {
  btn.disabled = true
  try {
    await post(`/schedules/${enc(task.id)}/run`)
    await draw()
  } catch (err) {
    btn.disabled = false
    await ask({ title: t("Run now"), text: why(err), ok: t("Close"), cancel: t("Cancel") })
  }
}

async function remove(task) {
  const yes = await ask({ title: t("Delete this scheduled task?"), text: t("“%(title)s” stops, and its history goes. The chats it wrote stay."), ok: t("Delete"), cancel: t("Cancel"), danger: true })
  if (!yes) return
  try {
    await del(`/schedules/${enc(task.id)}`)
    go({ name: "list" })
  } catch (err) {
    await ask({ title: t("Delete"), text: why(err), ok: t("Close"), cancel: t("Cancel") })
  }
}

// --- A new task, said in words ------------------------------------------------------------------

let compiled = null // the server's reading of the words: { title, instruction, summary, rule, next }

function drawNew() {
  header(t("New scheduled task"), () => go({ name: "list" }))
  clear($("scheduled-tools"))
  compiled = null
  const words = h("textarea", { id: "sched-words", class: "sched__words", rows: "4", placeholder: t("Every weekday at 8:00, summarise the news on my reading list"), "aria-label": t("What should happen, and when") })
  const said = h("p", { class: "status is-error", hidden: true })
  const preview = h("div", { class: "sched__preview", hidden: true })
  const read = h("button", { type: "submit", class: "btn btn--primary", text: t("Preview") })
  const form = h(
    "form",
    { class: "sched sched--new" },
    h("label", { class: "sched__h", for: "sched-words", text: t("What should happen, and when") }),
    words,
    h("p", { class: "hint", text: t("In your own words. The server reads them into a rule and an instruction, and shows you the next runs before anything is saved.") }),
    h("div", { class: "set__buttons" }, read),
    said,
    preview,
  )
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    const text = words.value.trim()
    if (!text) return words.focus()
    read.disabled = true
    said.hidden = true
    try {
      compiled = await post("/schedules/compile", { text })
      drawPreview(preview, text)
    } catch (err) {
      said.textContent = why(err)
      said.hidden = false
    } finally {
      read.disabled = false
    }
  })
  words.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit()
  })
  clear($("scheduled-body")).append(form)
  words.focus()
}

/** What the server made of the words: the rule in words, the instruction, the next five runs. */
function drawPreview(box, text) {
  const c = compiled
  box.hidden = false
  const choice = { notify: "matters", mode: "fresh" }
  const select = (key, table) =>
    h(
      "select",
      { "aria-label": key === "notify" ? t("Tell me") : t("Runs"), onchange: (e) => (choice[key] = e.target.value) },
      Object.entries(table).map(([v, word]) => h("option", { value: v, text: word(), selected: choice[key] === v })),
    )
  const save = h("button", { type: "button", class: "btn btn--primary", text: t("Save") })
  const said = h("p", { class: "status is-error", hidden: true })
  save.addEventListener("click", async () => {
    save.disabled = true
    try {
      const r = await post("/schedules", { request: text, title: c.title, instruction: c.instruction, rule: c.rule, notify: choice.notify, mode: choice.mode })
      go({ name: "task", id: r.schedule.id })
    } catch (err) {
      said.textContent = why(err)
      said.hidden = false
      save.disabled = false
    }
  })
  box.replaceChildren(
    h(
      "div",
      { class: "sched__card" },
      h("p", { class: "sched__title", text: c.title || "" }),
      h("div", { class: "sched__facts" }, fact(t("When"), h("span", { text: c.summary || "" })), fact(t("What it does"), h("span", { text: c.instruction || "" }))),
      upcoming(c.next || []) || h("p", { class: "status is-error", text: t("These words give no run in the future.") }),
      h("div", { class: "sched__facts" }, fact(t("Tell me"), select("notify", NOTIFY)), fact(t("Runs"), select("mode", MODE))),
      said,
      h("div", { class: "set__buttons" }, save),
    ),
  )
  save.focus()
}

/** The palette's commands for scheduled tasks. */
export function scheduledCommands() {
  return [
    {
      label: t("New scheduled task"),
      run: () => {
        ctx.show()
        go({ name: "new" })
      },
    },
  ]
}

export function initScheduled(context) {
  ctx = context
}
