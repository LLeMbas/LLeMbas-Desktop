// Scheduled tasks: standing instructions the server runs on its own -- "every weekday at 8:00,
// summarise …". The list (each task's next run, how its last run went, a switch to pause it), a
// task's page (what it does, when, its settings, the next runs, its history with each run's
// result, Run now, edit, pause, delete), and a task said in words: the server reads them into a
// rule and an instruction (compile), the next runs are shown, the settings chosen, and only then
// is it saved. The server runs them; this page only reads and asks.
//
// The server's /api/v2 for scheduling (LLeMbas `api/v2/schedules.py`; the shapes are its contract
// fixtures `schedules.json`, `schedule*.json`, `event_schedules.json`):
//
//   GET    /schedules                         { schedules: [schedule] }, newest first
//   POST   /schedules                         { title, instruction, request, rule, model, notify,
//                                              mode, effort, agents } -> 201 { schedule }
//   GET    /schedules/{id}                    { schedule }
//   PATCH  /schedules/{id}                    any of the create fields -> { schedule }
//   DELETE /schedules/{id}?keep_chat=true     204
//   POST   /schedules/{id}/pause | /resume    { schedule }
//   POST   /schedules/{id}/run                202 { run }: now, not counted against the rule
//   GET    /schedules/{id}/runs?before=&limit= { runs: [run], more }, newest first
//   GET    /schedules/{id}/runs/{run}         { run, text }: the result, Markdown (untrusted)
//   POST   /schedules/compile                 { text } -> { ok, reason, title, instruction,
//                                              target, rule, description, next_runs, timezone }
//   POST   /schedules/preview                 { rule } -> { rule, description, next_runs, timezone }
//   GET    /schedules/models                  { models: [model + free, busy, chosen], instance, mine }
//   PUT    /schedules/models                  { models: [id] }: the person's narrowing
//   GET    /events                            `schedules` frames, { version, schedules }: followed
//                                              by the app (Rust, watch.rs), handed here as the
//                                              `schedules` event
//
// A server without them answers 404: the page says this server has no scheduled tasks yet.
// Everything a task says (its title, instruction, a run's result or error) is the person's or a
// model's words, set as text; a result's Markdown goes through markdown.js.

import { $, h, clear, icon, ICONS, when } from "./dom.js"
import { api, get, post, patch, del, why, listen } from "./bridge.js"
import { ask, menu, popover } from "./popup.js"
import { avatar, levelsOf, levelWord } from "./models.js"
import { markdown } from "./markdown.js"

let ctx = null // { status(), models(), me(), openChat(id), show() }
let view = { name: "list" } // { name: "list" } | { name: "task", id } | { name: "form", task? }
let tasks = []
let missing = false // the server has no scheduling routes
let shown = null // the task whose page is open: { id, last, running }

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
  matters: () => t("When it matters"),
  always: () => t("Always"),
  never: () => t("Never"),
}

const NOTIFY_HINT = {
  matters: () => t("A result, but not a run with nothing to report."),
  always: () => t("Every result, even with nothing to report."),
  never: () => t("Only in its history."),
}

const MODE = {
  fresh: () => t("A new chat for each run"),
  continue: () => t("One chat that grows"),
}

const TIMING = {
  late: () => t("late"),
  catch_up: () => t("caught up"),
  manual: () => t("run by hand"),
}

const MAX_AGENTS = 8 // services/schedules.py MAX_AGENTS
const enc = encodeURIComponent
const RUNS_PAGE = 20

function statusChip(run, running) {
  if (running) return h("span", { class: "schip is-running", text: STATUS.running() })
  if (!run) return h("span", { class: "schip", text: t("Not run yet") })
  const word = STATUS[run.status]?.() || run.status
  // A missed run counts the slots that passed unrun; any other run says how many it followed.
  const n = run.status === "missed" ? (run.missed > 1 ? ` ×${run.missed}` : "") : run.missed > 0 ? ` · ${t("%(n)s missed", { n: run.missed })}` : ""
  return h("span", { class: `schip is-${run.status}`, title: `${word}${n}`, text: `${word}${n}` })
}

/** A stamp as a date and time in the person's language: "Mon 10 Nov, 08:00". */
function stamp(value) {
  const d = new Date(value)
  if (!value || Number.isNaN(d.getTime())) return ""
  return d.toLocaleString(document.documentElement.lang || undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

function nextWords(task) {
  if (!task.enabled) return t("Paused")
  if (!task.next_run) return t("No more runs")
  return `${when(task.next_run)} · ${stamp(task.next_run)}`
}

function onPage() {
  return !$("page-scheduled").hidden
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

/** The scheduling models, in the order they are tried; null when the server has none to say. */
async function schedulingModels() {
  try {
    return await get("/schedules/models")
  } catch {
    return null
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
  shown = null
  body.append(h("p", { class: "muted page__loading", text: t("Loading…") }))
  try {
    if (view.name === "task") await drawTask(view.id)
    else if (view.name === "form") await drawForm(view.task)
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

function go(next) {
  view = next
  draw()
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
  tools.append(
    h("button", { type: "button", class: "btn btn--sm", id: "sched-models", "aria-haspopup": "dialog", onclick: (e) => modelsPanel(e.currentTarget) }, h("span", { text: t("Models") })),
    h("button", { type: "button", class: "btn btn--sm btn--primary", id: "sched-new", onclick: () => go({ name: "form" }) }, icon(ICONS.plus), h("span", { text: t("New scheduled task") })),
  )
  if (!tasks.length) {
    body.append(
      empty(t("Nothing is scheduled."), t("Say what should happen and when — “every weekday at 8:00, summarise the news on my reading list” — and the server runs it for you.")),
      h("div", { class: "empty__actions" }, h("button", { type: "button", class: "btn btn--primary", onclick: () => go({ name: "form" }) }, icon(ICONS.plus), h("span", { text: t("New scheduled task") }))),
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
  return h(
    "li",
    { class: `task${task.enabled ? "" : " is-paused"}`, dataset: { id: task.id } },
    h(
      "button",
      { type: "button", class: "task__open", onclick: () => go({ name: "task", id: task.id }) },
      h("span", { class: "task__icon" }, icon(ICONS.clock)),
      h("span", { class: "task__what" }, h("span", { class: "task__title", text: task.title || task.request || "" }), h("span", { class: "task__rule", text: task.description || "" })),
      h(
        "span",
        { class: "task__next", title: task.enabled && task.next_run ? stamp(task.next_run) : "" },
        h("span", { class: "task__label", text: t("Next run") }),
        h("span", { class: "task__value", text: task.enabled && task.next_run ? when(task.next_run) : nextWords(task) }),
      ),
      h("span", { class: "task__last" }, statusChip(task.last_run, task.running)),
    ),
    h("label", { class: "toggle task__toggle" }, toggle),
  )
}

/** Pause or resume: the server's own verbs, which answer the schedule as it now is. */
async function setEnabled(task, on) {
  try {
    const r = await post(`/schedules/${enc(task.id)}/${on ? "resume" : "pause"}`)
    Object.assign(task, r.schedule || { enabled: on })
  } catch (err) {
    await ask({ title: t("Scheduled"), text: why(err), ok: t("Close"), cancel: t("Cancel") })
  }
  if (view.name === "list") drawList()
  else draw()
}

/**
 * The scheduling models: the ones scheduled work may run on, in the order they are tried, each
 * free now or busy (and why). A task without a model of its own runs on the first free one of
 * those ticked; ticking none means all of them.
 */
async function modelsPanel(anchor) {
  const data = await schedulingModels()
  if (!data) return
  let mine = new Set(data.mine || [])
  const said = h("p", { class: "status is-error", hidden: true })
  const save = async () => {
    try {
      const r = await api("PUT", "/schedules/models", { models: data.models.filter((m) => mine.has(m.id)).map((m) => m.id) })
      Object.assign(data, r)
      mine = new Set(r.mine || [])
      said.hidden = true
    } catch (err) {
      said.textContent = why(err)
      said.hidden = false
    }
    pop.redraw()
  }
  const content = () =>
    h(
      "div",
      { class: "pop__body smodels" },
      h("p", { class: "pop__title", text: t("Models for scheduled tasks") }),
      h("p", { class: "smodels__hint", text: t("A task without a model of its own runs on the first free one of these, in this order. None ticked: all of them.") }),
      h(
        "ul",
        { class: "smodels__list", role: "list" },
        data.models.map((m) =>
          h(
            "li",
            null,
            h(
              "label",
              { class: "smodel" },
              h("input", {
                type: "checkbox",
                checked: mine.has(m.id),
                onchange: (e) => {
                  if (e.target.checked) mine.add(m.id)
                  else mine.delete(m.id)
                  save()
                },
              }),
              avatar(m),
              h("span", { class: "smodel__name", text: m.name }),
              h("span", { class: `smodel__state${m.free ? " is-free" : ""}`, title: m.busy || "", text: m.free ? t("free") : t("busy") }),
            ),
          ),
        ),
      ),
      data.models.length ? null : h("p", { class: "muted", text: t("No model is available to this account.") }),
      said,
    )
  const pop = popover(anchor, content, { align: "end", label: t("Models for scheduled tasks") })
}

// --- One task -----------------------------------------------------------------------------------

async function drawTask(id) {
  const [r, page] = await Promise.all([get(`/schedules/${enc(id)}`), get(`/schedules/${enc(id)}/runs?limit=${RUNS_PAGE}`)])
  const task = r.schedule
  shown = { id: task.id, last: task.last_run?.id || null, status: task.last_run?.status || null, running: task.running }
  header(task.title || t("Scheduled"), () => go({ name: "list" }))
  const tools = clear($("scheduled-tools"))
  tools.append(
    h("button", { type: "button", class: "btn btn--sm btn--primary", id: "sched-run", disabled: !!task.running, onclick: (e) => runNow(task, e.currentTarget) }, icon(ICONS.play), h("span", { text: t("Run now") })),
    h("button", { type: "button", class: "btn btn--sm", id: "sched-edit", onclick: () => go({ name: "form", task }) }, icon(ICONS.edit), h("span", { text: t("Edit") })),
    h(
      "button",
      {
        type: "button",
        class: "tool",
        "aria-label": t("More"),
        title: t("More"),
        onclick: (e) =>
          menu(e.currentTarget, [
            { label: task.enabled ? t("Pause") : t("Resume"), run: () => setEnabled(task, !task.enabled) },
            ...(task.chat_id ? [{ label: t("Open its chat"), run: () => ctx.openChat(task.chat_id) }] : []),
            null,
            { label: t("Delete"), danger: true, run: () => remove(task) },
          ]),
      },
      icon(ICONS.more),
    ),
  )
  const models = (await schedulingModels())?.models || ctx.models()
  const body = clear($("scheduled-body"))
  body.append(
    h(
      "section",
      { class: "sched" },
      task.failure_streak > 0 && task.last_error ? h("p", { class: "status is-error sched__trouble", text: t("The last %(n)s runs failed: %(why)s", { n: task.failure_streak, why: task.last_error }) }) : null,
      h(
        "div",
        { class: "sched__facts" },
        fact(t("When"), h("span", { text: task.description || "" }), task.timezone ? t("Times in %(zone)s", { zone: task.timezone }) : ""),
        fact(t("Next run"), h("span", { text: nextWords(task) })),
        fact(t("Last run"), statusChip(task.last_run, task.running)),
        fact(t("Model"), modelWords(models, task.model)),
        fact(t("Reasoning effort"), h("span", { text: task.effort ? levelWord(task.effort) : t("The model's own") })),
        fact(t("Agents"), h("span", { text: task.agents ? t("A team of up to %(n)s", { n: task.agents }) : t("No team") })),
        fact(t("Tell me"), h("span", { text: NOTIFY[task.notify]?.() || NOTIFY.matters() })),
        fact(t("Runs"), h("span", { text: MODE[task.mode]?.() || MODE.fresh() })),
      ),
      h("div", { class: "sched__what" }, h("h2", { class: "sched__h", text: t("What it does") }), h("p", { class: "sched__instruction", text: task.instruction || task.request || "" }), task.request && task.request !== task.instruction ? h("p", { class: "sched__asked", text: t("You asked: “%(text)s”", { text: task.request }) }) : null),
      upcoming(task.next_runs || []),
    ),
    history(task, page.runs || [], page.more),
  )
}

function fact(label, value, hint) {
  return h("div", { class: "fact" }, h("span", { class: "fact__label", text: label }), h("span", { class: "fact__value" }, value), hint ? h("span", { class: "fact__hint", text: hint }) : null)
}

function modelWords(models, id) {
  if (!id) return h("span", { text: t("The first free scheduling model") })
  const m = models.find((x) => x.id === id)
  return m ? h("span", { class: "sched__model" }, avatar(m), h("span", { text: m.name })) : h("span", { text: id })
}

function upcoming(next) {
  if (!next.length) return null
  return h("div", { class: "sched__next" }, h("h2", { class: "sched__h", text: t("The next runs") }), h("ol", { class: "runs-next" }, next.slice(0, 5).map((s) => h("li", null, h("span", { text: stamp(s) }), h("span", { class: "muted", text: when(s) })))))
}

/** The history: one row per run on fixed tracks -- status, when, model, and a way to its result. */
function history(task, runs, more) {
  const box = h("section", { class: "sched__history" }, h("h2", { class: "sched__h", text: t("History") }))
  if (!runs.length) {
    box.append(h("p", { class: "muted", text: t("It has not run yet.") }))
    return box
  }
  const list = h("ul", { class: "runs" })
  const add = (page) => {
    for (const run of page) list.append(runRow(task, run))
  }
  add(runs)
  box.append(list)
  if (more) {
    const earlier = h("button", { type: "button", class: "btn btn--sm sched__more", text: t("Earlier runs") })
    earlier.addEventListener("click", async () => {
      earlier.disabled = true
      try {
        const last = list.lastElementChild?.dataset.id || ""
        const r = await get(`/schedules/${enc(task.id)}/runs?limit=${RUNS_PAGE}&before=${enc(last)}`)
        add(r.runs || [])
        if (!r.more) earlier.remove()
        else earlier.disabled = false
      } catch (err) {
        earlier.disabled = false
        await ask({ title: t("History"), text: why(err), ok: t("Close"), cancel: t("Cancel") })
      }
    })
    box.append(earlier)
  }
  return box
}

/** What a run that did not finish well says: waiting and until when, or its error. */
function runNote(run) {
  if (run.status === "waiting") {
    const again = run.retry_at ? t("tried again %(when)s", { when: when(run.retry_at) }) : ""
    return [run.error?.text || STATUS.waiting(), again].filter(Boolean).join(" · ")
  }
  return run.error?.text || ""
}

function runRow(task, run) {
  const model = run.model || {}
  const switched = model.reason === "switched" && model.switched_from ? t("%(model)s was busy, so it ran on this one.", { model: model.switched_from }) : ""
  const hasResult = run.message_id || run.report_path || run.preview
  const detail = h("div", { class: "run__detail", hidden: true })
  const open = hasResult
    ? h("button", { type: "button", class: "btn btn--sm run__open", "aria-expanded": "false", text: t("Result") })
    : null
  open?.addEventListener("click", async () => {
    const opening = detail.hidden
    open.setAttribute("aria-expanded", String(opening))
    if (!opening) {
      detail.hidden = true
      return
    }
    detail.hidden = false
    detail.replaceChildren(h("p", { class: "muted", text: t("Loading…") }))
    try {
      const r = await get(`/schedules/${enc(task.id)}/runs/${enc(run.id)}`)
      detail.replaceChildren(
        r.text ? h("div", { class: "md run__text" }, markdown(r.text)) : h("p", { class: "muted", text: run.preview || t("The result is no longer there.") }),
        r.run?.report_path ? h("p", { class: "run__report", text: t("Written to %(path)s", { path: r.run.report_path }) }) : null,
        r.run?.chat_id ? h("div", { class: "set__buttons" }, h("button", { type: "button", class: "btn btn--sm", text: t("Open the chat"), onclick: () => ctx.openChat(r.run.chat_id) })) : null,
      )
    } catch (err) {
      detail.replaceChildren(h("p", { class: "status is-error", text: why(err) }))
    }
  })
  const note = runNote(run)
  return h(
    "li",
    { class: "run", dataset: { id: run.id } },
    h("span", { class: "run__status" }, statusChip(run)),
    h(
      "span",
      { class: "run__when", title: run.due_at ? t("Due %(when)s", { when: stamp(run.due_at) }) : "" },
      h("span", { text: stamp(run.started_at || run.due_at) }),
      TIMING[run.timing] ? h("span", { class: "run__late", text: TIMING[run.timing]() }) : null,
    ),
    h("span", { class: "run__model", title: switched }, h("span", { text: model.name || "" }), switched ? h("span", { class: "run__switched", text: t("switched") }) : null),
    open || h("span", { class: "run__error", title: note, text: note }),
    detail,
  )
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
    await del(`/schedules/${enc(task.id)}?keep_chat=true`)
    go({ name: "list" })
  } catch (err) {
    await ask({ title: t("Delete"), text: why(err), ok: t("Close"), cancel: t("Cancel") })
  }
}

// --- A task said in words: new, or an existing one edited ---------------------------------------

/**
 * The form. The words first: Read them asks the server (compile) for the rule, its title and
 * instruction, and the next runs; the title and instruction can then be changed. Below, the
 * settings the server keeps per task. An existing task starts from what it is: its words, title,
 * instruction, and its rule read back (preview) -- a paused task's next runs too.
 */
async function drawForm(task) {
  const editing = !!task
  header(editing ? t("Edit %(title)s", { title: task.title }) : t("New scheduled task"), () => go(editing ? { name: "task", id: task.id } : { name: "list" }))
  clear($("scheduled-tools"))
  const smodels = (await schedulingModels())?.models || []
  // What will be saved: the rule only from the server's reading of words (or the task's own).
  const draft = {
    request: task?.request || "",
    title: task?.title || "",
    instruction: task?.instruction || "",
    rule: task?.rule || null,
    target: task?.target || "chat",
    model: task?.model || "",
    effort: task?.effort || "",
    agents: task?.agents || null,
    notify: task?.notify || "matters",
    mode: task?.mode || "fresh",
  }
  let reading = editing ? await post("/schedules/preview", { rule: task.rule }).catch(() => null) : null

  const words = h("textarea", { id: "sched-words", class: "sched__words", rows: "3", placeholder: t("Every weekday at 8:00, summarise the news on my reading list"), "aria-label": t("What should happen, and when"), value: draft.request })
  const readBtn = h("button", { type: "submit", class: "btn", text: editing ? t("Read again") : t("Preview") })
  const said = h("p", { class: "status is-error", hidden: true })
  const when_ = h("span", { class: "sched__desc", id: "sched-when" })
  const zone = h("p", { class: "hint" })
  const title = h("input", { type: "text", id: "sched-title", value: draft.title, "aria-label": t("Title") })
  const instruction = h("textarea", { id: "sched-instruction", class: "sched__words", rows: "3", "aria-label": t("What it does"), value: draft.instruction })
  const settings = h("div", { class: "fields sched__settings" })
  const saveBtn = h("button", { type: "button", class: "btn btn--primary", id: "sched-save", text: t("Save") })
  const saveSaid = h("p", { class: "status is-error", hidden: true })
  const nextBox = h("div", { class: "sched__nextbox" })
  const manual = manualRule((rule) => {
    post("/schedules/preview", { rule })
      .then((r) => {
        reading = r
        draft.rule = r.rule || {}
        drawWhen()
      })
      .catch((err) => {
        saveSaid.textContent = why(err)
        saveSaid.hidden = false
      })
  })
  const manualBtn = h("button", { type: "button", class: "btn btn--sm sched__manual-open", text: t("Set the time yourself"), onclick: () => ((manual.hidden = false), (manualBtn.hidden = true), manual.querySelector("input")?.focus()) })
  const rest = h(
    "div",
    { class: "sched__card", hidden: !editing },
    h("div", { class: "fields" }, field(t("Title"), title, "", "sched-title"), h("div", { class: "field" }, h("span", { class: "label", text: t("When") }), when_, zone)),
    manualBtn,
    manual,
    nextBox,
    h("label", { class: "sched__h", for: "sched-instruction", text: t("What it does") }),
    instruction,
    h("p", { class: "hint", text: t("The instruction each run is given, on its own: say everything it needs.") }),
    settings,
    saveSaid,
    h("div", { class: "set__buttons" }, saveBtn),
  )

  const drawWhen = () => {
    const r = reading
    const next = r?.next_runs || []
    const runs = !!(draft.rule && Object.keys(draft.rule).length)
    when_.textContent = (runs && r?.description) || t("These words give no run in the future.")
    when_.title = when_.textContent
    when_.classList.toggle("is-error", !runs)
    zone.textContent = runs && r?.timezone ? t("Times in %(zone)s", { zone: r.timezone }) : ""
    nextBox.replaceChildren(upcoming(next) || "")
    saveBtn.disabled = !(draft.rule && Object.keys(draft.rule).length)
  }

  const drawSettings = () => {
    const model = smodels.find((m) => m.id === draft.model) || ctx.models().find((m) => m.id === draft.model)
    const select = (id, table, key, onChange) =>
      h(
        "select",
        { id, onchange: (e) => ((draft[key] = e.target.value), onChange?.()) },
        Object.entries(table).map(([v, word]) => h("option", { value: v, text: word(), selected: draft[key] === v })),
      )
    const modelSelect = h(
      "select",
      { id: "sched-model", onchange: (e) => ((draft.model = e.target.value), (draft.effort = ""), drawSettings()) },
      h("option", { value: "", text: t("The first free scheduling model"), selected: !draft.model }),
      smodels.map((m) => h("option", { value: m.id, text: m.free ? m.name : `${m.name} · ${t("busy")}`, selected: draft.model === m.id })),
      draft.model && !smodels.some((m) => m.id === draft.model) ? h("option", { value: draft.model, text: draft.model, selected: true }) : null,
    )
    const levels = model ? levelsOf(model).levels.filter((l) => l !== "default") : []
    const effort = h(
      "select",
      { id: "sched-effort", disabled: !levels.length && !draft.effort, onchange: (e) => (draft.effort = e.target.value) },
      h("option", { value: "", text: t("The model's own"), selected: !draft.effort }),
      levels.map((l) => h("option", { value: l, text: levelWord(l), selected: draft.effort === l })),
      // A level the task has that its model no longer offers stays, as it is, until changed.
      draft.effort && !levels.includes(draft.effort) ? h("option", { value: draft.effort, text: levelWord(draft.effort), selected: true }) : null,
    )
    const agents = h(
      "select",
      { id: "sched-agents", onchange: (e) => (draft.agents = Number(e.target.value) || null) },
      h("option", { value: "", text: t("No team"), selected: !draft.agents }),
      Array.from({ length: MAX_AGENTS - 1 }, (_, i) => i + 2).map((n) => h("option", { value: String(n), text: t("A team of up to %(n)s", { n }), selected: draft.agents === n })),
    )
    settings.replaceChildren(
      field(t("Tell me"), select("sched-notify", NOTIFY, "notify", () => (settings.querySelector("#sched-notify-hint").textContent = NOTIFY_HINT[draft.notify]())), NOTIFY_HINT[draft.notify]?.() || "", "sched-notify", "sched-notify-hint"),
      field(t("Runs"), select("sched-mode", MODE, "mode"), draft.mode === "continue" ? t("Each run sees the ones before it.") : t("Each run starts with nothing but the instruction."), "sched-mode"),
      field(t("Model"), modelSelect, t("A busy model is waited for, then the next free one is used."), "sched-model"),
      field(t("Reasoning effort"), effort, levels.length ? "" : t("Choose a model to choose its effort."), "sched-effort"),
      field(t("Agents"), agents, t("A team works on it together, its own agent included."), "sched-agents"),
    )
    settings.querySelector("#sched-mode").addEventListener("change", drawSettings)
  }

  const form = h(
    "form",
    { class: "sched sched--new" },
    h("label", { class: "sched__h", for: "sched-words", text: t("What should happen, and when") }),
    words,
    h("p", { class: "hint", text: t("In your own words. The server reads them into a rule and an instruction, and shows you the next runs before anything is saved.") }),
    h("div", { class: "set__buttons" }, readBtn),
    said,
    rest,
  )
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    const text = words.value.trim()
    if (!text) return words.focus()
    readBtn.disabled = true
    said.hidden = true
    try {
      const c = await post("/schedules/compile", { text })
      draft.request = text
      draft.rule = c.rule || {}
      if (c.title || !editing) title.value = c.title || ""
      if (c.instruction || !editing) instruction.value = c.instruction || text
      if (c.target) draft.target = c.target
      reading = c
      if (!c.ok && c.reason) {
        said.textContent = c.reason
        said.hidden = false
      }
      // The words gave no rule: the form for one, rather than a task that cannot run.
      if (!(c.rule && Object.keys(c.rule).length)) {
        manual.hidden = false
        manualBtn.hidden = true
      }
      rest.hidden = false
      drawWhen()
      ;(c.ok ? saveBtn : instruction).focus()
    } catch (err) {
      said.textContent = why(err)
      said.hidden = false
    } finally {
      readBtn.disabled = false
    }
  })
  words.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit()
  })
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true
    saveSaid.hidden = true
    const body = {
      request: draft.request || words.value.trim(),
      title: title.value.trim(),
      instruction: instruction.value.trim(),
      rule: draft.rule,
      target: draft.target,
      model: draft.model,
      effort: draft.effort,
      agents: draft.agents,
      notify: draft.notify,
      mode: draft.mode,
    }
    try {
      const r = editing ? await patch(`/schedules/${enc(task.id)}`, body) : await post("/schedules", body)
      go({ name: "task", id: r.schedule.id })
    } catch (err) {
      saveSaid.textContent = why(err)
      saveSaid.hidden = false
      saveBtn.disabled = false
    }
  })
  clear($("scheduled-body")).append(form)
  drawSettings()
  drawWhen()
  words.focus()
}

/**
 * The rule set by hand, for words the server could not read into one: the days of the week (none
 * ticked: every day) and a time, as the rule's calendar (`{ at: { weekdays, times } }`, Monday 0).
 * `onRule(rule)` on every change; the server reads it back (preview).
 */
function manualRule(onRule) {
  const lang = document.documentElement.lang || undefined
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2024, 0, 1 + i) // 1 January 2024 was a Monday
    return h("label", { class: "sday", title: d.toLocaleDateString(lang, { weekday: "long" }) }, h("input", { type: "checkbox", value: String(i) }), h("span", { text: d.toLocaleDateString(lang, { weekday: "short" }) }))
  })
  const time = h("input", { type: "time", id: "sched-time", value: "08:00", required: true })
  const box = h(
    "div",
    { class: "sched__manual", hidden: true },
    h("div", { class: "fields" }, h("div", { class: "field" }, h("span", { class: "label", text: t("Days") }), h("div", { class: "sdays", role: "group", "aria-label": t("Days") }, days), h("p", { class: "hint", text: t("No day ticked: every day.") })), field(t("Time"), time, "", "sched-time")),
  )
  const changed = () => {
    if (!time.value) return
    const weekdays = days.map((d) => d.querySelector("input")).filter((i) => i.checked).map((i) => Number(i.value))
    onRule({ at: { ...(weekdays.length ? { weekdays } : {}), times: [time.value] } })
  }
  box.addEventListener("change", changed)
  return box
}

/** A field on the form's shared tracks: label, control, hint -- always all three. */
function field(label, control, hint, forId, hintId) {
  return h("div", { class: "field" }, h("label", { for: forId || null, text: label }), control, h("p", { class: "hint", id: hintId || null, text: hint || "" }))
}

// --- Live: the list as the server's event stream gives it ---------------------------------------

/** A `schedules` frame (`{ version, schedules }`), handed on by the app: redraw what it changes. */
function onSchedules(list) {
  if (!Array.isArray(list?.schedules)) return
  tasks = list.schedules
  missing = false
  if (!onPage() || popoverOpenHere()) return
  if (view.name === "list") drawList()
  else if (view.name === "task" && shown) {
    const now = tasks.find((x) => x.id === shown.id)
    if (!now) return go({ name: "list" })
    const last = now.last_run || {}
    if ((last.id || null) !== shown.last || (last.status || null) !== shown.status || now.running !== shown.running) draw()
  }
}

function popoverOpenHere() {
  return !!document.querySelector(".pop .smodels")
}

/** The palette's commands for scheduled tasks. */
export function scheduledCommands() {
  return [
    {
      label: t("New scheduled task"),
      run: () => {
        ctx.show()
        go({ name: "form" })
      },
    },
  ]
}

export function initScheduled(context) {
  ctx = context
  listen("schedules", (e) => onSchedules(e.payload))
}
