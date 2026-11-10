// The subagent tree (harness spec 3.4.0, subagents.md §12) as the activity panel draws it, the
// server's own panel in this app (`chat/_activity_tasks.html` tree_row): the main agent at the
// root, every subagent under its parent in the order added, how many slots are open, then the
// ended ones folded apart, dimmed, with how each ended. A row is the tasks' grid -- chevron, who
// it is and what it is doing, its context use in the time column, a stop square -- and opened,
// its facts (state, model, mode and request options, messages, findings), its task, its phase
// line, the last room message to or from it, and the buttons to read its conversation and its
// findings. Its subagents nest under it.
//
// The data is the server's `GET /api/v2/chats/{chat}/tree` (and the stream's `tree` frame):
//
//   { min, max, size, open_slots,
//     agents: [{ id, name, position, parent, state, model, mode, request, manager, task,
//                context: { used, window }, progress, findings, messages }],
//     ended:  [{ ..., ended }] }
//
// Everything in it but the numbers is a model's words: set as text, never as markup.

import { h, icon, ICONS } from "./dom.js"
import { progressLine, progressText } from "./progress.js"

/** The states' words (loop.json team.read.states; the server's TREE_STATE_WORDS). */
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
/** A subagent that may still be stopped (the server's TREE_LIVE). */
export const TREE_LIVE = ["working", "waiting", "paused"]

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

/** The agents in tree order (an agent, then those under it, depth first), each with its depth. */
export function treeOrder(agents) {
  const names = new Map()
  for (const a of agents) names.set(a.id, a.id).set(a.name, a.id)
  const parentOf = (a) => {
    const p = a.parent ? names.get(a.parent) : null
    return p && p !== a.id ? p : null
  }
  const under = new Map()
  for (const a of agents) {
    const p = parentOf(a)
    if (!under.has(p)) under.set(p, [])
    under.get(p).push(a)
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

/** The room's messages to or from an agent (by name). */
function messagesOf(room, a) {
  return room.filter((m) => m.from === a.name || (m.to || []).includes(a.name) || (m.recipients || []).includes(a.name))
}

function firstLine(text) {
  return String(text || "").split("\n").find((l) => l.trim()) || ""
}

/**
 * The tree as rows. `act` holds what the rows can do: `open(a)` (its conversation, read-only),
 * `findings(a)`, `stop(a)`; `isOpen(key)` / `toggled(key, open)` keep unfolded rows unfolded
 * across redraws. `room` is the room as read so far; `device` says the subagents run on the
 * computer the chat runs on (an agent chat).
 */
export function treePart(tree, { room = [], act = {}, now = Date.now(), device = false } = {}) {
  const box = h("div", { class: "subagents" })
  box.append(h("p", { class: "tasks__team", text: t("%(size)s of %(max)s", { size: tree.size ?? (tree.agents || []).length, max: tree.max ?? "?" }) }))
  if (Number(tree.open_slots) > 0) box.append(h("p", { class: "tasks__goal subagents__slots", text: t("Open slots: %(n)s", { n: tree.open_slots }) }))
  if (device) box.append(h("p", { class: "tasks__goal", text: t("They run on the computer this chat runs on.") }))
  box.append(h("div", { class: "tasks__list subagents__list" }, treeOrder(tree.agents || []).map(({ agent, depth }) => row(agent, depth, { room, act, now, ended: false }))))
  const ended = tree.ended || []
  if (ended.length) {
    const key = "fold:ended"
    const fold = h(
      "details",
      { class: "tasks__more subagents__ended", open: !!act.isOpen?.(key) },
      h("summary", null, h("span", { class: "tasks__chev", "aria-hidden": "true" }, icon(ICONS.chevron)), h("span", { text: `${t("Ended")} ${ended.length}` })),
      h("div", { class: "tasks__list" }, ended.map((a) => row(a, 0, { room, act, now, ended: true }))),
    )
    fold.addEventListener("toggle", () => act.toggled?.(key, fold.open))
    box.append(fold)
  }
  return box
}

function row(a, depth, { room, act, now, ended }) {
  const key = `sub:${a.id}`
  const main = !a.parent && (a.id === "lead" || a.name === "lead")
  const pct = ended ? null : contextPercent(a.context)
  const said = messagesOf(room, a)
  const last = said[said.length - 1]
  const mode = a.mode ? (a.request?.length ? `${a.mode} + ${a.request.join(", ")}` : a.mode) : ""
  const live = !ended && TREE_LIVE.includes(a.state)
  const phase = !ended && a.progress ? progressText(a.progress, now) : ""
  const stop =
    live && !main && act.stop
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
    { class: `agent subagent is-${String(a.state || "").replace(/[^a-z_]/g, "")}${ended ? " is-ended" : ""}`, open: !!act.isOpen?.(key), dataset: { id: a.id } },
    h(
      "summary",
      { class: "agent__row" },
      h("span", { class: "agent__chev", "aria-hidden": "true" }, icon(ICONS.chevron)),
      h(
        "span",
        { class: "agent__what" },
        h(
          "span",
          { class: "subagent__who" },
          h("bdi", { class: "agent__name", text: a.name || a.id }),
          a.id !== a.name ? h("span", { class: "agent__id", text: a.id }) : null,
        ),
        main ? h("span", { class: "agent__role", text: t("the main agent") }) : a.position ? h("span", { class: "agent__role", text: a.position }) : null,
        // The phase alone where a row has no room for its clock (progress.md §3); ended: how.
        h("span", { class: "subagent__phase", dataset: { phase: phase ? a.progress.phase : "" }, text: phase || treeState(a.state) }),
      ),
      h("span", { class: "agent__time", title: t("Context used"), text: pct === null ? "" : `${pct}%` }),
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
        mode ? h("span", { text: mode }) : null,
        h("span", { text: t("messages: %(n)s", { n: a.messages ?? said.length }) }),
        a.findings ? h("span", { text: t("findings: %(n)s", { n: a.findings }) }) : null,
      ),
      a.task && !main ? h("p", { class: "agent__brief", text: a.task }) : null,
      phase ? h("p", { class: "agent__text subagent__line", dataset: { progress: JSON.stringify(a.progress) }, text: progressLine(a.progress, now) }) : null,
      last ? h("p", { class: "agent__text", text: `${last.from} → ${(last.to || []).join(", ")}: ${firstLine(last.text)}` }) : null,
      main
        ? null
        : h(
            "p",
            { class: "subagent__buttons" },
            act.open ? h("button", { type: "button", class: "btn btn--sm", text: t("Open its conversation"), onclick: () => act.open(a) }) : null,
            act.findings ? h("button", { type: "button", class: "btn btn--sm", text: t("Findings"), onclick: () => act.findings(a) }) : null,
          ),
    ),
  )
  el.style.setProperty("--depth", String(Math.max(0, Math.min(6, depth))))
  el.addEventListener("toggle", () => act.toggled?.(key, el.open))
  return el
}

/** The tree's phase lines move on by themselves between reads (their clock). */
export function tickTree(root, now = Date.now()) {
  for (const el of root.querySelectorAll(".subagent__line[data-progress]")) {
    try {
      el.textContent = progressLine(JSON.parse(el.dataset.progress), now)
    } catch {}
  }
}
