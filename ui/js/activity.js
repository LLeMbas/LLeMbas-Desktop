// The chat's activity panel, beside it: what is in its context, by category, against the model's
// window; the files the chat and its agents wrote; every background agent -- a team's members as
// a tree, helpers and commands -- with its state, how long it has run, its model, its latest step
// and what it is writing, its whole conversation read-only and a button to stop it; the team's
// room; and the plan. The strip above the message box sums the agents up and opens it. The same
// facts as the server's own panel (`services/activity.py`), from /api/v2:
//
//   GET  /chats/{chat}/activity?since=&context=   everything, with a `version`
//   GET  /chats/{chat}/activity/events            `activity` {version, summary} on each change
//   GET  /chats/{chat}/agents/{kind}/{id}         one agent and its conversation
//   POST /chats/{chat}/agents/{kind}/{id}/stop
//
// The events stream is followed for as long as a chat is open: it keeps the strip current, and
// while the panel is open a new `version` reads the panel again. The context is the costly part
// of a read; it is asked for when the panel opens, after a reply and at most every so often.
//
// Every name, role, brief, step, room message and conversation here is a model's words: set as
// text, and a room message or a reply through the page's own markdown (markdown.js), which
// builds elements and never parses HTML.

import { $, h, clear, icon, ICONS } from "./dom.js"
import { get, post, follow, why } from "./bridge.js"
import { markdown } from "./markdown.js"
import { ask } from "./popup.js"
import { openServerFile } from "./explorer.js"

const ACTIVE = ["queued", "working", "waiting"]
// How many live agents show before "Show N more", as on the server's panel.
const SHOWN = 6
// The context is read again on a change at most this often (ms); always on opening and after a reply.
const CONTEXT_EVERY = 15000

let layout = () => {} // (on) -> the shell makes room for the panel
let chat = null // the open chat: { id, kind, … }
let stream = null // the events stream's handle
let retry = 0 // the reconnect timer
let failures = 0
let summary = null
let version = ""
let data = null // the last `activity`
let room = [] // the room so far: each read asks only for what came after `cursor`
let cursor = 0
let readAt = 0 // when `data` was read: the elapsed times count on from there
let contextAt = 0
let reading = null // the read in flight
let readAgain = "" // "", "plain" or "context": what to read again once the read in flight is done
let view = null // null: the panel; { kind, id, name }: one agent's conversation
const openRows = new Set() // agents unfolded, by kind:id; sections folded, by name
let ticker = 0

// --- Words ----------------------------------------------------------------------------------------

/** A duration as both harnesses write one: 5s, 1m 05s, 2h 03m. */
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** A token count at a glance: 950, 14.2k, 180k, 1.54M (the server's `compact_tokens`). */
export function compact(value) {
  const n = Math.trunc(Number(value) || 0)
  const trim = (x, digits) => x.toFixed(digits).replace(/\.?0+$/, "")
  if (n < 1000) return String(n)
  if (n < 100000) return `${trim(n / 1000, 1)}k`
  if (n < 1000000) return `${Math.round(n / 1000)}k`
  return `${trim(n / 1000000, 2)}M`
}

/** "3 agents working · 1 queued · 2 finished", or "" for none (the server's `summary_text`). */
export function summaryText(counts) {
  if (!counts) return ""
  const parts = []
  if (counts.working === 1) parts.push(t("1 agent working"))
  else if (counts.working) parts.push(t("%(n)s agents working", { n: counts.working }))
  if (counts.queued) parts.push(t("%(n)s queued", { n: counts.queued }))
  if (counts.waiting) parts.push(t("%(n)s waiting", { n: counts.waiting }))
  if (counts.finished) parts.push(t("%(n)s finished", { n: counts.finished }))
  return parts.join(" · ")
}

function stateWord(state) {
  return { queued: t("queued"), working: t("working"), waiting: t("waiting"), done: t("done"), stopped: t("stopped"), error: t("failed") }[state] || String(state || "")
}

function contextWord(key) {
  return (
    {
      messages: t("Messages"),
      system: t("System prompt"),
      memory: t("Memory and personal"),
      instructions: t("Instruction files"),
      tools: t("Tools"),
      mcp_tools: t("MCP tools"),
      since: t("Since the last reply"),
      buffer: t("Compaction buffer"),
      free: t("Free space"),
    }[key] || String(key)
  )
}

/** A percentage through a sentence written the server's way (`%%` is a percent sign). */
function percentSentence(text, fields) {
  return t(text, fields).replace(/%%/g, "%")
}

/** A plan's phases and their tasks, done ones struck through: the panel's and the cards'. */
export function planList(plan) {
  return h(
    "ol",
    { class: "plan" },
    (plan.phases || []).map((p) =>
      h("li", null, h("span", { class: "plan__phase", text: p.title }), h("ul", null, (p.tasks || []).map((task) => h("li", { class: `plan__task is-${task.status}`, text: task.text })))),
    ),
  )
}

// --- Following a chat -----------------------------------------------------------------------------

const enc = encodeURIComponent

export function panelOpen() {
  return !$("activity").hidden
}

/** The chat whose activity is followed: the one open, or null for none (a new chat, the settings). */
export function watchActivity(next) {
  const id = next?.id || null
  if (id && chat?.id === id) {
    chat = next
    return
  }
  stop()
  chat = id ? next : null
  summary = null
  version = ""
  data = null
  room = []
  cursor = 0
  readAt = contextAt = 0
  view = null
  openRows.clear()
  renderStrip()
  $("activity-open")?.setAttribute("aria-expanded", String(panelOpen()))
  if (!chat) {
    if (panelOpen()) showPanel(false)
    return
  }
  listenTo(chat.id)
  if (panelOpen()) {
    render()
    read(true)
  }
}

/** A reply has ended, or the chat's settings changed: the context and the outputs move with it. */
export function activityChanged() {
  if (chat && panelOpen()) read(true)
}

function stop() {
  clearTimeout(retry)
  retry = 0
  failures = 0
  stream?.close()
  stream = null
}

async function listenTo(id) {
  // Held while the stream opens, so nothing opens a second one meanwhile.
  const pending = { close() {} }
  stream = pending
  let ended = false
  let handleId = null
  try {
    const handle = await follow(`/chats/${enc(id)}/activity/events`, {
      onFrame: (event, frame) => {
        if (chat?.id !== id || event !== "activity" || !frame || typeof frame !== "object") return
        failures = 0
        heard(frame)
      },
      // The server closes the stream after a while (`close`): it is opened again at once. A broken
      // one is opened again later, more slowly each time -- polling, in effect, while it fails.
      onEnd: (err) => {
        ended = true
        if (chat?.id !== id) return
        if (stream === pending || stream?.id === handleId) stream = null
        // Not while the window is hidden (in the tray): it is opened again when it shows.
        if (document.visibilityState === "hidden") return
        failures = err ? failures + 1 : 0
        retry = setTimeout(() => {
          retry = 0
          if (chat?.id === id && !stream) {
            if (err && panelOpen()) read(false)
            listenTo(id)
          }
        }, err ? Math.min(60000, 5000 * failures) : 500)
      },
    })
    handleId = handle.id
    if (chat?.id !== id || stream !== pending) handle.close()
    else if (!ended) stream = handle
  } catch {
    if (stream === pending) stream = null
    if (chat?.id !== id) return
    failures += 1
    retry = setTimeout(() => {
      retry = 0
      if (chat?.id === id && !stream) listenTo(id)
    }, Math.min(60000, 5000 * failures))
  }
}

function heard(frame) {
  summary = frame.summary || summary
  renderStrip()
  if (frame.version && frame.version !== version) {
    version = frame.version
    if (panelOpen()) read(Date.now() - contextAt > CONTEXT_EVERY)
  }
}

/** Read the panel's facts; one read at a time, and one more after it if asked for meanwhile. */
async function read(withContext) {
  if (!chat) return
  if (reading) {
    readAgain = withContext ? "context" : readAgain || "plain"
    return reading
  }
  const id = chat.id
  reading = (async () => {
    try {
      const a = (await get(`/chats/${enc(id)}/activity?since=${cursor}&context=${withContext ? "true" : "false"}`)).activity
      if (chat?.id !== id || !a) return
      if (!withContext) a.context = data?.context ?? null
      else contextAt = Date.now()
      if (a.team) {
        // A cursor lower than ours is a room begun again (a new team): read from the start.
        if (a.team.cursor < cursor) {
          room = []
          cursor = 0
          readAgain = readAgain || "plain"
        }
        for (const m of a.team.room || []) if (m.n > cursor) room.push(m)
        cursor = Math.max(cursor, a.team.cursor || 0)
      } else {
        room = []
        cursor = 0
      }
      data = a
      version = a.version || version
      summary = a.summary || summary
      readAt = Date.now()
      renderStrip()
      if (view) await readAgent()
      else render()
    } catch (err) {
      if (chat?.id === id && !data) renderError(why(err))
    }
  })()
  await reading
  reading = null
  if (readAgain) {
    const ctxToo = readAgain === "context"
    readAgain = ""
    read(ctxToo)
  }
}

// --- The strip above the message box ---------------------------------------------------------------

function renderStrip() {
  const strip = $("activity-strip")
  // While something runs, as the server's strip: a chat whose helpers all finished long ago does
  // not carry "12 finished" above its message box for ever (the panel still lists them).
  const text = chat && summary?.active ? summaryText(summary) : ""
  strip.hidden = !text
  if (!text) return clear(strip)
  strip.replaceChildren(
    h(
      "button",
      { type: "button", class: "strip__btn", "aria-label": `${text} — ${t("Open the activity panel")}`, onclick: () => showPanel(true) },
      h("span", { class: "dot is-busy", "aria-hidden": "true" }),
      h("span", { class: "strip__text", text }),
      icon(ICONS.chevron),
    ),
  )
}

// --- The panel ------------------------------------------------------------------------------------------

/** Open or close the panel (the header's Activity button, the strip, Escape). */
export function showPanel(on) {
  if (on && !chat) return
  $("activity").hidden = !on
  layout(on)
  $("activity-open")?.setAttribute("aria-expanded", String(on))
  clearInterval(ticker)
  ticker = 0
  if (!on) {
    view = null
    return
  }
  ticker = setInterval(tick, 1000)
  render()
  read(true)
  $("activity-close").focus()
}

export function togglePanel() {
  showPanel(!panelOpen())
}

/** The elapsed times of agents still at work count on between reads. */
function tick() {
  if (document.visibilityState !== "visible") return
  const extra = (Date.now() - readAt) / 1000
  for (const el of document.querySelectorAll("#activity .agent__time[data-active]")) {
    el.textContent = duration(Number(el.dataset.seconds) + extra)
  }
}

function renderError(text) {
  clear($("activity-body")).append(h("p", { class: "activity__empty is-error", text }))
}

function section(name, title, count, ...body) {
  const el = h(
    "details",
    { class: "activity__section", open: !openRows.has(`section:${name}`) },
    h("summary", { class: "activity__heading" }, h("span", { text: title }), count ? h("span", { class: "activity__count", text: String(count) }) : null),
    ...body,
  )
  el.addEventListener("toggle", () => (el.open ? openRows.delete(`section:${name}`) : openRows.add(`section:${name}`)))
  return el
}

function render() {
  $("activity").dataset.view = "panel"
  const head = $("activity-title")
  $("activity-back").hidden = true
  head.textContent = t("Activity")
  const body = $("activity-body")
  if (!data) {
    clear(body).append(h("p", { class: "activity__empty", text: t("Loading…") }))
    return
  }
  // Kept where the reader was: the panel is drawn again on every change.
  const scroll = body.scrollTop
  body.replaceChildren(
    section("context", t("Context"), 0, contextPart(data.context)),
    section("outputs", t("Outputs"), (data.outputs || []).length, outputsPart(data.outputs || [])),
    section("tasks", t("Background tasks"), 0, tasksPart()),
    data.plan ? section("plan", t("Plan"), 0, h("div", { class: "activity__plan" }, planList(data.plan))) : null,
  )
  body.scrollTop = scroll
}

function contextPart(c) {
  if (!c) return h("p", { class: "activity__empty", text: t("Not measured.") })
  const known = c.percent !== null && c.percent !== undefined
  const used = h(
    "p",
    { class: "ctx__used" },
    h("span", { text: known ? percentSentence("%(percent)s%% used", { percent: c.percent }) : t("%(tokens)s tokens", { tokens: compact(c.used) }) }),
    h("span", { class: "ctx__of", text: known ? `${compact(c.used)} / ${compact(c.limit)}` : t("window unknown") }),
  )
  const cats = c.categories || []
  const bar = c.limit
    ? h(
        "div",
        { class: "ctx__bar", role: "img", "aria-label": percentSentence("%(percent)s%% of the context window used", { percent: c.percent ?? 0 }) },
        cats
          .filter((r) => r.key !== "free" && r.tokens)
          .map((r) => {
            const seg = h("span", { class: `ctx__seg ctx--${safeKey(r.key)}` })
            seg.style.setProperty("--share", `${Math.max(0, Math.min(100, Number(r.percent) || 0))}%`)
            return seg
          }),
      )
    : null
  const rows = h(
    "ul",
    { class: "ctx__rows" },
    cats.map((r) =>
      h(
        "li",
        { class: "ctx__row" },
        h("span", { class: `ctx__key ctx--${safeKey(r.key)}`, "aria-hidden": "true" }),
        h("span", { class: "ctx__name", text: contextWord(r.key) }),
        h("span", { class: "ctx__num", text: compact(r.tokens) }),
        h("span", { class: "ctx__num", text: r.percent === null || r.percent === undefined ? "—" : `${r.percent}%` }),
      ),
    ),
  )
  const note = h(
    "p",
    { class: "ctx__note" },
    `${c.measured ? t("Counted by the model at the last reply; the categories are estimated.") : t("Estimated: no reply has been counted yet.")} ${t("%(n)s tools offered.", { n: c.tools_count ?? 0 })}`,
  )
  return h("div", { class: "ctx" }, used, bar, rows, note)
}

/** A category's key as a class name: the server's words, kept to letters and underscores. */
function safeKey(key) {
  return String(key).replace(/[^a-z_]/gi, "") || "other"
}

function outputsPart(outputs) {
  if (!outputs.length) return h("p", { class: "activity__empty", text: t("No files written in this chat yet.") })
  return h(
    "ul",
    { class: "outs" },
    outputs.map((o) =>
      h(
        "li",
        { class: "outs__row" },
        icon(ICONS.file),
        h("button", { type: "button", class: "outs__name", title: `${o.path} — ${t("Open in the viewer")}`, onclick: () => openServerFile(o.path, o.name) }, h("bdi", { text: o.name || o.path })),
        h(
          "span",
          { class: "outs__diff" },
          o.added === null || o.added === undefined ? null : [h("span", { class: "outs__add", text: `+${o.added}` }), h("span", { class: "outs__del", text: `−${o.removed ?? 0}` })],
        ),
      ),
    ),
  )
}

function tasksPart() {
  const entries = data.agents || []
  const team = data.team
  const box = h("div", { class: "tasks", "aria-live": "polite" })
  if (!entries.length && !team) {
    box.append(h("p", { class: "activity__empty", text: t("Nothing runs in the background. Helpers, commands and a team's members show here while they work.") }))
    return box
  }
  box.append(h("p", { class: "tasks__summary", text: summaryText(data.summary) || t("Nothing running.") }))
  if (team) {
    box.append(h("p", { class: "tasks__team", text: t("Team: %(size)s of %(max)s agents", { size: team.size, max: team.max }) }))
    if (team.goal) box.append(h("p", { class: "tasks__goal", text: team.goal }))
  }
  const live = entries.filter((e) => ACTIVE.includes(e.state))
  const ended = entries.filter((e) => !ACTIVE.includes(e.state))
  if (live.length) {
    box.append(h("div", { class: "tasks__list" }, live.slice(0, SHOWN).map(agentRows)))
    if (live.length > SHOWN) box.append(fold("more", t("Show %(n)s more", { n: live.length - SHOWN }), live.slice(SHOWN)))
  }
  if (ended.length) box.append(fold("finished", t("%(n)s finished", { n: ended.length }), ended))
  if (team) {
    box.append(h("h3", { class: "activity__subheading", text: t("Room") }))
    box.append(
      room.length
        ? h(
            "ol",
            { class: "room" },
            room.map((m) =>
              h(
                "li",
                { class: `room__entry${m.report ? " is-report" : ""}` },
                h(
                  "div",
                  { class: "room__meta" },
                  h("span", { class: "room__n", text: `#${m.n}` }),
                  h("span", { class: "room__route", text: `${m.from} → ${(m.to || []).join(", ")}` }),
                  m.report ? h("span", { class: "chip room__badge", text: t("report") }) : null,
                ),
                h("div", { class: "room__text md" }, markdown(String(m.text || ""))),
              ),
            ),
          )
        : h("p", { class: "activity__empty", text: t("Nothing has been said in the room yet.") }),
    )
  }
  return box
}

/** A folded list of agents ("Show 3 more", "12 finished"), remembered open across redraws. */
function fold(name, label, list) {
  const el = h("details", { class: "tasks__more", open: openRows.has(`fold:${name}`) }, h("summary", { text: label }), h("div", { class: "tasks__list" }, list.map(agentRows)))
  el.addEventListener("toggle", () => (el.open ? openRows.add(`fold:${name}`) : openRows.delete(`fold:${name}`)))
  return el
}

/** An agent and, under it, the agents it leads or started. */
function agentRows(a) {
  return [agentRow(a), ...(a.children || []).map(agentRows)]
}

function agentRow(a) {
  const key = `${a.kind}:${a.id}`
  const active = ACTIVE.includes(a.state)
  const time = h("span", { class: "agent__time", title: stateWord(a.state), text: duration(a.seconds) })
  if (active) {
    time.dataset.active = ""
    time.dataset.seconds = String(Number(a.seconds) || 0)
  }
  const stopBtn = a.stoppable
    ? h(
        "button",
        {
          type: "button",
          class: "pane__btn agent__stop",
          "aria-label": t("Stop %(name)s", { name: a.name }),
          title: t("Stop %(name)s", { name: a.name }),
          onclick: (e) => {
            e.preventDefault()
            e.stopPropagation()
            stopAgent(a)
          },
        },
        icon(ICONS.stop),
      )
    : h("span", { class: "agent__stop", "aria-hidden": "true" })
  const facts = h(
    "p",
    { class: "agent__facts" },
    h("span", { class: "agent__state", text: stateWord(a.state) }),
    a.agent ? h("span", { text: a.agent }) : null,
    a.model ? h("span", { class: "agent__model", text: a.model }) : null,
    a.steps ? h("span", { text: t("%(steps)s steps, %(tools)s tools", { steps: a.steps, tools: a.tools }) }) : null,
  )
  const step = a.step
    ? h(
        "p",
        { class: `agent__step${a.step.error ? " is-error" : ""}` },
        h("span", { class: `dot${a.step.error ? " is-error" : a.step.running ? " is-busy" : " is-ok"}`, "aria-hidden": "true" }),
        h("span", { class: "agent__verb", text: a.step.label || a.step.tool || "" }),
        a.step.title ? h("code", { class: "agent__title", text: a.step.title }) : null,
      )
    : null
  const el = h(
    "details",
    { class: `agent is-${safeKey(a.state)}`, open: openRows.has(key) },
    h(
      "summary",
      { class: "agent__row" },
      h("span", { class: "agent__dot", "aria-hidden": "true" }),
      h("span", { class: "agent__what" }, h("span", { class: "agent__name", text: a.name || a.id }), a.role ? h("span", { class: "agent__role", text: a.role }) : null),
      time,
      stopBtn,
    ),
    h(
      "div",
      { class: "agent__body" },
      facts,
      a.brief ? h("p", { class: "agent__brief", text: a.brief }) : null,
      step,
      a.text ? h("p", { class: "agent__text", text: a.text }) : null,
      a.transcript
        ? h("button", { type: "button", class: "btn btn--sm", text: t("Open its conversation"), onclick: () => openAgent(a) })
        : null,
    ),
  )
  el.style.setProperty("--depth", String(Math.max(0, Math.min(6, Number(a.depth) || 0))))
  el.addEventListener("toggle", () => (el.open ? openRows.add(key) : openRows.delete(key)))
  return el
}

async function stopAgent(a) {
  if (!chat) return
  if (a.kind === "member") {
    const yes = await ask({
      title: t("Stop %(name)s", { name: a.name }),
      text: t("Stop %(name)s and the members under it? They leave the team.", { name: a.name }),
      ok: t("Stop"),
      cancel: t("Cancel"),
      danger: true,
    })
    if (!yes) return
  }
  try {
    await post(`/chats/${enc(chat.id)}/agents/${enc(a.kind)}/${enc(a.id)}/stop`)
  } catch (err) {
    // 409: it had finished meanwhile; the read below shows that.
    if (err?.status !== 409) renderError(why(err))
  }
  read(false)
}

// --- One agent's conversation, read-only ------------------------------------------------------------

function openAgent(a) {
  view = { kind: a.kind, id: a.id, name: a.name || a.id }
  $("activity").dataset.view = "agent"
  $("activity-title").textContent = view.name
  $("activity-back").hidden = false
  clear($("activity-body")).append(h("p", { class: "activity__empty", text: t("Loading…") }))
  readAgent()
}

function closeAgent() {
  view = null
  render()
  $("activity-close").focus()
}

async function readAgent() {
  if (!chat || !view) return
  const { kind, id } = view
  let r
  try {
    r = await get(`/chats/${enc(chat.id)}/agents/${enc(kind)}/${enc(id)}`)
  } catch (err) {
    if (view?.id === id) clear($("activity-body")).append(h("p", { class: "activity__empty is-error", text: why(err) }))
    return
  }
  if (view?.kind !== kind || view?.id !== id) return
  const a = r.agent || {}
  const body = $("activity-body")
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40
  const head = h(
    "div",
    { class: "convo__head" },
    h(
      "p",
      { class: "agent__facts" },
      h("span", { class: "agent__state", text: stateWord(a.state) }),
      h("span", { text: duration(a.seconds) }),
      a.model ? h("span", { class: "agent__model", text: a.model }) : null,
    ),
    a.role ? h("p", { class: "agent__role", text: a.role }) : null,
    a.stoppable ? h("button", { type: "button", class: "btn btn--sm", text: t("Stop %(name)s", { name: a.name || id }), onclick: () => stopAgent(a) }) : null,
  )
  const turns = (r.transcript || []).map((turn) => {
    if (turn.role === "user") {
      return h("article", { class: `msg msg--user convo__turn${turn.machine ? " is-machine" : ""}` }, h("div", { class: "msg__text", text: String(turn.text || "") }))
    }
    return h(
      "article",
      { class: "msg msg--assistant convo__turn" },
      turn.text ? h("div", { class: "md" }, markdown(String(turn.text))) : null,
      turn.tools?.length
        ? h(
            "ul",
            { class: "convo__tools" },
            turn.tools.map((c) =>
              h(
                "li",
                { class: "convo__tool" },
                h("span", { class: `dot${c.isError ? " is-error" : " is-ok"}`, "aria-hidden": "true" }),
                h("span", { class: "agent__verb", text: String(c.name || "") }),
                c.title ? h("code", { class: "agent__title", text: String(c.title) }) : null,
              ),
            ),
          )
        : null,
      turn.error ? h("p", { class: "msg__note is-error", text: String(turn.error) }) : null,
      turn.running ? h("p", { class: "msg__status muted", text: t("Writing…") }) : null,
    )
  })
  body.replaceChildren(head, h("div", { class: "convo" }, turns.length ? turns : h("p", { class: "activity__empty", text: t("Nothing yet.") })))
  if (atEnd) body.scrollTop = body.scrollHeight
}

// --- Start ------------------------------------------------------------------------------------------

export function initActivity({ onLayout }) {
  layout = onLayout || layout
  $("activity-close").replaceChildren(icon(ICONS.close))
  $("activity-close").addEventListener("click", () => showPanel(false))
  $("activity-back").replaceChildren(icon(ICONS.back))
  $("activity-back").addEventListener("click", closeAgent)
  // Before the viewer's own Escape (capture): while the viewer is open, it closes first and the
  // panel stays; one Escape closes one thing.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !panelOpen() || e.defaultPrevented || document.querySelector("dialog[open], .menu")) return
      if (!$("viewer").hidden) return
      e.preventDefault()
      if (view) closeAgent()
      else showPanel(false)
    },
    true,
  )
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !chat) return
    if (!stream && !retry) listenTo(chat.id)
    if (panelOpen()) read(false)
  })
}
