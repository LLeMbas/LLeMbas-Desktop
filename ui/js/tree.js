// The subagent tree (harness spec 3.4.0, subagents.md §12) as the activity panel draws it: the
// main agent at the root, every subagent under its parent in the order added, the open slots,
// then the ended ones, dimmed, with how each ended. Per agent: its name and id, its position,
// its state, model, mode (and request options), how full its context is, its current phase (the
// progress line), its messages in the room, and -- for any subagent, live or ended -- its session
// read-only and its findings; a live one can be stopped.
//
// The data is the spec's, as the server passes it on in /api/v2 for a chat's own subagents and
// for an agent chat's alike:
//
//   { min, max, size, open_slots,
//     agents: [{ id, name, position, parent, state, model, mode, request, manager, task,
//                context: { used, window }, progress, findings, messages }],
//     ended:  [{ id, name, position, parent, state, ended, findings }] }
//
// Everything in it but the numbers is a model's words: set as text, never as markup.

import { h, icon, ICONS } from "./dom.js"
import { progressLine } from "./progress.js"

/** The states' words (loop.json team.read.states). */
const STATES = {
  working: "working",
  waiting: "waiting for a slot",
  finished: "finished",
  idle: "idle",
  paused: "paused: context full",
  done: "done",
  out_of_context: "out of context",
  stopped: "stopped",
}
export const TREE_SENTENCES = Object.values(STATES)

export function treeState(state) {
  return STATES[state] ? t(STATES[state]) : String(state || "")
}

/** floor(used × 100 / window), or null when the window is not known. */
export function contextPercent(c) {
  const used = Number(c?.used)
  const window = Number(c?.window)
  if (!(window > 0) || !(used >= 0)) return null
  return Math.min(100, Math.floor((used * 100) / window))
}

function modeWords(a) {
  if (!a.mode) return ""
  const req = (a.request || []).filter(Boolean)
  return req.length ? `${a.mode} ${req.map((r) => `+ ${r}`).join(" ")}` : a.mode
}

/** The agents in tree order (an agent, then those under it, depth first), each with its depth. */
export function treeOrder(agents) {
  const ids = new Set(agents.map((a) => a.id))
  const under = new Map()
  for (const a of agents) {
    const parent = a.parent && ids.has(a.parent) && a.parent !== a.id ? a.parent : null
    if (!under.has(parent)) under.set(parent, [])
    under.get(parent).push(a)
  }
  const out = []
  const seen = new Set()
  const walk = (parent, depth) => {
    for (const a of under.get(parent) || []) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push({ agent: a, depth })
      walk(a.id, depth + 1)
    }
  }
  walk(null, 0)
  for (const a of agents) if (!seen.has(a.id)) out.push({ agent: a, depth: 0 })
  return out
}

/** The room's messages to or from an agent (by name; `all` reaches everyone). */
function messagesOf(room, a) {
  return room.filter((m) => m.from === a.name || (m.to || []).includes(a.name) || (m.recipients || []).includes(a.name))
}

function firstLine(text) {
  return String(text || "").split("\n").find((l) => l.trim()) || ""
}

/**
 * The tree as rows. `act` holds what the rows can do: `open(a)` (its session, read-only),
 * `findings(a)`, `stop(a)`; `isOpen(key)` / `toggled(key, open)` keep unfolded rows unfolded
 * across redraws; `room` is the room as read so far.
 */
export function treePart(tree, { room = [], act = {}, now = Date.now() } = {}) {
  const rows = []
  for (const { agent, depth } of treeOrder(tree.agents || [])) rows.push(agentRow(agent, depth, { room, act, now, ended: false }))
  for (let i = 0; i < (Number(tree.open_slots) || 0); i++) {
    rows.push(h("div", { class: "subagent subagent--slot", style: `--depth: 1` }, h("span", { class: "subagent__slot", text: t("Open slot") })))
  }
  const ended = tree.ended || []
  const box = h("div", { class: "subagents" })
  box.append(
    h("p", { class: "subagents__size", text: t("%(size)s of at most %(max)s agents", { size: tree.size ?? (tree.agents || []).length, max: tree.max ?? "?" }) }),
    h("div", { class: "subagents__list" }, rows),
  )
  if (ended.length) {
    const key = "fold:ended"
    const fold = h(
      "details",
      { class: "tasks__more subagents__ended", open: act.isOpen?.(key) },
      h("summary", null, h("span", { class: "tasks__chev", "aria-hidden": "true" }, icon(ICONS.chevron)), h("span", { text: t("Ended %(n)s", { n: ended.length }) })),
      h(
        "div",
        { class: "subagents__list" },
        ended.map((a) => agentRow(a, 0, { room, act, now, ended: true })),
      ),
    )
    fold.addEventListener("toggle", () => act.toggled?.(key, fold.open))
    box.append(fold)
  }
  return box
}

function agentRow(a, depth, { room, act, now, ended }) {
  const key = `sub:${a.id}`
  const main = !a.parent && a.id === "lead"
  const pct = contextPercent(a.context)
  const line = a.progress ? progressLine(a.progress, now) : ""
  const said = messagesOf(room, a)
  const last = said[said.length - 1]
  const stop =
    !ended && !main && act.stop
      ? h(
          "button",
          {
            type: "button",
            class: "agent__stop",
            "aria-label": t("Stop %(name)s", { name: a.name }),
            title: t("Stop %(name)s", { name: a.name }),
            onclick: (e) => {
              e.preventDefault()
              e.stopPropagation()
              act.stop(a)
            },
          },
          h("span", { class: "agent__square", "aria-hidden": "true" }),
        )
      : h("span", { class: "agent__stop is-none", "aria-hidden": "true" })
  const el = h(
    "details",
    { class: `agent subagent is-${String(a.state || "").replace(/[^a-z_]/g, "")}${ended ? " is-ended" : ""}`, open: act.isOpen?.(key), dataset: { id: a.id } },
    h(
      "summary",
      { class: "agent__row" },
      h("span", { class: "agent__chev", "aria-hidden": "true" }, icon(ICONS.chevron)),
      h(
        "span",
        { class: "agent__what", title: a.position || a.name },
        h("bdi", { class: "agent__name", text: a.name || a.id }),
        h("span", { class: "subagent__id", text: ` (${a.id})` }),
        a.position ? h("span", { class: "subagent__position", text: ` — ${main ? t("the main agent") : a.position}` }) : null,
      ),
      h("span", { class: "subagent__pct", text: pct === null ? "" : `${pct}%`, title: pct === null ? "" : t("%(percent)s%% of the context window used", { percent: pct }).replace(/%%/g, "%") }),
      stop,
    ),
    h(
      "div",
      { class: "agent__body" },
      h(
        "p",
        { class: "agent__facts" },
        h("span", { class: "agent__state", text: treeState(a.state) }),
        a.model ? h("span", { class: "agent__model", text: a.model }) : null,
        modeWords(a) ? h("span", { class: "subagent__mode", text: modeWords(a) }) : null,
        a.findings ? h("span", { text: t("Findings: %(n)s", { n: a.findings }) }) : null,
      ),
      pct === null ? null : h("div", { class: "subagent__bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": t("Context") }, h("span", { style: `--pct: ${pct}%` })),
      line ? h("p", { class: "subagent__phase", "data-phase": a.progress?.phase || "", text: line }) : null,
      a.task ? h("p", { class: "agent__brief", text: a.task }) : null,
      said.length || a.messages
        ? h("p", { class: "subagent__room" }, h("span", { class: "chip", text: t("Messages: %(n)s", { n: a.messages ?? said.length }) }), last ? h("span", { class: "subagent__last", text: `${last.from}: ${firstLine(last.text)}` }) : null)
        : null,
      main
        ? null
        : h(
            "div",
            { class: "subagent__actions" },
            act.open ? h("button", { type: "button", class: "btn btn--sm", text: t("Open its session"), onclick: () => act.open(a) }) : null,
            act.findings ? h("button", { type: "button", class: "btn btn--sm", text: t("Findings"), onclick: () => act.findings(a) }) : null,
          ),
    ),
  )
  el.style.setProperty("--depth", String(Math.max(0, Math.min(6, depth))))
  el.addEventListener("toggle", () => act.toggled?.(key, el.open))
  return el
}
