// One chat: its transcript, the reply being written (followed as the server streams it), the
// cards that wait for an answer, and the composer with the chat's settings as chips under the
// text (folder, mode, model, effort, agents). And a new chat, which is the same page empty: a
// greeting, the choice of an agent chat on this computer or a chat on the server, and the composer.
//
// The transcript is the server's /api/v2 serialisation (tests/fixtures/api_v2 in the server's
// repository is the contract): a person's message is their text as typed; a reply is its steps --
// thinking, text (markdown, model output), tool calls, messages taken in while it ran.

import { $, h, clear, append, icon, ICONS, bytes } from "./dom.js"
import { api, get, getText, post, patch, del, follow, why, invoke, openLink } from "./bridge.js"
import { markdown } from "./markdown.js"
import { openViewer, showKind } from "./viewer.js"
import { readLocal } from "./explorer.js"
import { menu, ask, showLine, popover, closePopover } from "./popup.js"
import { avatar, agentsControl, teamPossible, namedOnly, subagentsCap, noteSubagentsCap, SUBAGENTS_HINT, SUBAGENTS_OWN, levelsOf, levelWord, picture } from "./models.js"
import { readyIds, sending, sent, discard } from "./attach.js"
import { watchActivity, activityChanged, planList, activityButton, treeChanged, showPanel, panelOpen, stateWord } from "./activity.js"
import { agentBlock, agentReady, agentState, onAgentChange } from "./agent.js"
import { folderName, listed, folderTree, newFolder } from "./list.js"
import { unarchive } from "./archived.js"
import { isProgress, progressLine, progressTicks } from "./progress.js"
import { ACTIONS, callDuration, callFacts, callTitle, changeText, count, diffCounts, drawn, endLine } from "./display.js"
import { DISPLAY } from "./spec.js"
import { initSlash, commandIn, commandTable, closeComposerMenu } from "./slash.js"
import { accountThemes, accountTheme, chooseTheme } from "./look.js"
import { pythonFor, pythonState, retryPython } from "./python.js"
import { pageMount, pageWriting } from "./pages.js"
import { aimTerminal, terminalButton, terminalOpen, toggleTerminal } from "./terminal.js"
import { scopePopover } from "./scope.js"
import { readAloudButton } from "./voice.js"

const MODES = ["manual", "edit", "auto", "plan"]

let ctx = null // set by initChat: { status(), thisDevices(), devices(), models(), me(), changed(chat), opened(chat), gone(chat) }
let open = null // { chat, live, more, first }

export function openChatId() {
  return open?.chat?.id || null
}

// --- Reading -----------------------------------------------------------------------------------

export function onThisComputer(chat) {
  return !!chat?.device && ctx.thisDevices().includes(chat.device.token_id)
}

/** A linked device, as `GET /devices` lists it (with `terminal`: whether it opens one). */
function deviceOf(id) {
  return (ctx.devices?.() || []).find((d) => d.id === id) || null
}

/** This computer's device: the one linked right now, else the last one it was. */
function hereDevice() {
  const mine = ctx.thisDevices()
  return mine.find((id) => deviceOf(id)) || mine[0] || ""
}

/**
 * The device a new agent chat goes to: the one chosen on its chip while it is still linked, else
 * this computer's.
 */
function draftDevice() {
  if (draft?.device && deviceOf(draft.device)) return draft.device
  return hereDevice()
}

/** Whether the new agent chat works here (the agent built into this app) or on another device. */
function draftHere() {
  const d = draftDevice()
  return !d || ctx.thisDevices().includes(d)
}

/** The other linked devices of this account: where else a new agent chat can work. */
function otherDevices() {
  const mine = ctx.thisDevices()
  return (ctx.devices?.() || []).filter((d) => !mine.includes(d.id))
}

/**
 * The folders an agent chat on another device has worked in: the sidebar's agent chats there,
 * newest first. This app cannot browse another computer; these and a typed path are the choice.
 */
function knownFolders(device) {
  const out = []
  for (const c of listed()) {
    const dir = c.kind === "agent" && c.device?.token_id === device ? c.device.directory : ""
    if (dir && !out.includes(dir)) out.push(dir)
  }
  return out.slice(0, 8)
}

/**
 * Why the Terminal cannot be opened for the agent chat the page shows, or null where it can (or
 * where there is no agent chat with a folder to open one for): `{ words, how, here }` -- what
 * stands in the way, how to switch it on, and whether it is this computer's to switch.
 * The computer is not linked right now (it is not in `GET /devices`), or it is and does not open
 * terminals for this account (`terminal: false`).
 */
function terminalBlock() {
  let id = ""
  if (draft) {
    if (draft.kind !== "agent" || !draft.dir) return null
    id = draftDevice()
  } else {
    const chat = open?.chat
    if (chat?.kind !== "agent" || !chat.device) return null
    id = chat.device.token_id
  }
  const device = deviceOf(id)
  if (device?.terminal) return null
  const here = !id || ctx.thisDevices().includes(id)
  if (!device) {
    return {
      here,
      words: here ? t("This computer's agent is not linked to the server right now.") : t("That computer is not linked to the server right now."),
      how: t("The Terminal can be opened as soon as it is linked again."),
    }
  }
  // The server says which thing stands in the way (`terminal_reason`: permission, instance,
  // unlinked, device) and what to do about it, in a sentence (`terminal_hint`). Where it is this
  // computer's own switch, the way to it is here.
  const hint = typeof device.terminal_hint === "string" ? device.terminal_hint.trim() : ""
  const mine = here && (device.terminal_reason === "device" || !device.terminal_reason)
  if (mine) {
    return {
      here,
      off: true,
      words: t("The terminal is switched off for this computer."),
      how: t("Switch it on in Settings, under %(section)s: %(setting)s.", { section: t("Project folders"), setting: t("Let the server open a terminal here") }),
    }
  }
  return {
    here,
    words: hint || t("That computer does not open terminals for you."),
    how: hint ? "" : t("Switch it on there: in LLeMbas Desktop under Settings, or in the LLeMbas CLI's settings, remote.terminal. If it is on, your account may not be allowed the terminal: ask the administrator."),
  }
}

/** Whether the page waits for a computer to open terminals: its devices are then read again. */
export function terminalWaiting() {
  return !!terminalBlock()
}

/**
 * The header's Terminal control: the button; or, where the computer does not open one now, the
 * same button dimmed, which says why and how to switch it on instead of opening anything.
 */
function terminalControl() {
  if (terminalTarget()) return terminalButton()
  const block = terminalBlock()
  if (!block) return null
  const label = `${t("Terminal")}: ${block.words}`
  return h(
    "button",
    {
      type: "button",
      class: "tool is-off",
      "aria-label": label,
      title: label,
      "aria-haspopup": "dialog",
      "data-terminal-off": "",
      onclick: (e) =>
        popover(
          e.currentTarget,
          h(
            "div",
            { class: "pop__body" },
            h("p", { class: "pop__title", text: t("Terminal") }),
            h("p", { text: block.words }),
            block.how ? h("p", { class: "hint", text: block.how }) : null,
            block.off && ctx.nav?.settings ? h("div", { class: "pop__actions" }, h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Open Settings"), onclick: () => (closePopover(), ctx.nav.settings("folders")) })) : null,
          ),
          { align: "end", label: t("Terminal") },
        ),
    },
    icon(ICONS.terminal),
  )
}

/**
 * What the Terminal panel is for, as the page stands: a new agent chat whose device and folder
 * are chosen (the shell before the first message), an open agent chat on a device that opens
 * terminals, or nothing.
 */
function terminalTarget() {
  if (draft) {
    if (draft.kind !== "agent" || !draft.dir) return null
    const device = deviceOf(draftDevice())
    if (!device?.terminal) return null
    return { device: device.id, directory: draft.dir, name: device.name || (draftHere() ? t("This computer") : t("Another device")) }
  }
  const chat = open?.chat
  if (chat?.kind !== "agent" || !chat.device) return null
  const device = deviceOf(chat.device.token_id)
  if (!device?.terminal) return null
  return { chat: chat.id, device: device.id, directory: chat.device.directory, name: device.name || t("Terminal") }
}

// A new agent chat's subagent facts (spec 3.4.0 §14): `/models?kind=agent&device=` -- each model's
// `subagents` for an agent chat, and `agent_subagents { offered, device_runs }` once. Read per
// device, again when a new chat starts; a server before 3.4.0 says nothing (no setting, as before).
const agentFacts = new Map() // device -> { at, models: Map(id -> subagents), offered, runs } | null

async function readAgentFacts(device) {
  if (!device) return null
  const known = agentFacts.get(device)
  if (known && Date.now() - known.at < 5000) return known
  try {
    const r = await get(`/models?kind=agent&device=${encodeURIComponent(device)}`)
    if (!r.agent_subagents) {
      agentFacts.set(device, { at: Date.now(), none: true })
      return agentFacts.get(device)
    }
    noteSubagentsCap(r.subagents_cap)
    const facts = { at: Date.now(), models: new Map((r.models || []).map((m) => [m.id, m.subagents])), offered: !!r.agent_subagents.offered, runs: r.agent_subagents.device_runs }
    agentFacts.set(device, facts)
    return facts
  } catch {
    return null
  }
}

/** Whether a new agent chat on `model` is offered subagents: `{ cap, own }`, or null. */
function agentOffer(facts, model) {
  if (!facts || facts.none || !facts.offered || facts.runs === false) return null
  const said = facts.models.get(model?.id)
  if (said !== undefined && said !== null && !(typeof said === "object" ? said.offered : said)) return null
  return { cap: subagentsCap(), own: namedOnly(said) }
}

/** Text into the message box, after what is there, for the person to read before sending. */
export function intoComposer(text) {
  const box = $("composer-text")
  box.value = box.value.trim() ? `${box.value.replace(/\s*$/, "")}\n\n${text}` : text
  box.dispatchEvent(new Event("input"))
  box.focus()
}

function nearBottom() {
  const th = $("thread")
  return th.scrollHeight - th.scrollTop - th.clientHeight < 80
}

function toBottom(force) {
  const th = $("thread")
  if (force || nearBottom()) th.scrollTop = th.scrollHeight
}

/** A small icon button under a message. */
function action(ico, label, onclick, cls = "") {
  return h("button", { type: "button", class: `msg__act ${cls}`, "aria-label": label, title: label, onclick }, icon(ico))
}

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {})
}

/**
 * A file a message carries, as a tile: a picture as its thumbnail (read through the bridge, as
 * a `data:` URL), anything else as its icon, name and size.
 */
export function fileTile(a) {
  const tile = h(
    "li",
    { class: `tile${a.image ? " tile--image" : ""}`, title: a.name },
    h("span", { class: "tile__icon" }, icon(ICONS.file)),
    h("span", { class: "tile__name" }, h("bdi", { text: a.name })),
    h("span", { class: "tile__size", text: a.size ? bytes(a.size) : "" }),
  )
  if (a.image && a.id) {
    picture(`/attachments/${a.id}`).then((url) => {
      if (!url || !url.startsWith("data:image/")) return
      tile.classList.add("has-thumb")
      tile.prepend(h("img", { class: "tile__thumb", src: url, alt: "", draggable: "false" }))
    })
  }
  return tile
}

function userMessage(m) {
  const el = h(
    "article",
    { class: `msg msg--user${m.queued ? " is-queued" : ""}${m.machine ? " is-machine" : ""}`, dataset: { id: m.id } },
    m.attachments?.length ? h("ul", { class: "tiles msg__files" }, m.attachments.map(fileTile)) : null,
    m.text ? h("div", { class: "msg__bubble" }, h("div", { class: "msg__text", text: m.text })) : null,
    m.queued ? h("p", { class: "msg__note", text: t("Waiting for the reply before it") }) : null,
  )
  // A background job's report is not the person's to rewrite (the server refuses it too).
  if (!m.machine) {
    el.append(
      h(
        "div",
        { class: "msg__actions" },
        action(ICONS.edit, t("Edit message"), () => startEdit(el, m)),
        action(ICONS.copy, t("Copy"), () => copyText(m.text || "")),
      ),
    )
  }
  return el
}

/**
 * Edit one of the person's messages in place. Saving rewrites it, drops everything after it and
 * starts the reply again (on the device too, for an agent chat): the server's rule, said first.
 */
function startEdit(el, m) {
  if (!open?.chat?.id || el.querySelector(".msg__edit")) return
  const box = h("textarea", { class: "msg__edit", rows: "3", value: m.text || "", "aria-label": t("Edit message") })
  const note = h("p", { class: "hint", text: t("Saving starts the reply again; everything after this message is dropped.") })
  const said = h("p", { class: "msg__note is-error", hidden: true })
  const save = h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Save") })
  const cancel = h("button", { type: "button", class: "btn btn--sm", text: t("Cancel") })
  const form = h("div", { class: "msg__editor" }, box, note, said, h("div", { class: "msg__editbar" }, cancel, save))
  const parts = [...el.children]
  for (const c of parts) c.hidden = true
  el.append(form)
  const close = () => {
    form.remove()
    for (const c of parts) c.hidden = false
  }
  cancel.addEventListener("click", close)
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close()
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save.click()
  })
  save.addEventListener("click", async () => {
    const text = box.value.trim()
    if (!text && !m.attachments?.length) return box.focus()
    save.disabled = cancel.disabled = true
    try {
      await post(`/chats/${encodeURIComponent(open.chat.id)}/messages/${encodeURIComponent(m.id)}/edit`, { text })
      reload()
    } catch (err) {
      said.textContent = why(err)
      said.hidden = false
      save.disabled = cancel.disabled = false
    }
  })
  box.focus()
  box.setSelectionRange(box.value.length, box.value.length)
}

/** The reply's words, as Markdown: what Copy puts on the clipboard. */
function replyText(m) {
  return (m.steps || [])
    .filter((s) => s.kind === "text")
    .map((s) => s.markdown || "")
    .join("\n\n")
}

async function regenerate(m) {
  if (!open?.chat?.id) return
  alertIn("")
  try {
    await post(`/chats/${encodeURIComponent(open.chat.id)}/messages/${encodeURIComponent(m.id)}/regenerate`)
    reload()
  } catch (err) {
    alertIn(why(err))
  }
}

function metricsLine(x) {
  if (!x) return null
  const parts = []
  if (x.total_tokens) parts.push(t("%(n)s tokens", { n: count(x.total_tokens) }))
  if (x.tok_s) parts.push(`${x.tok_s} tok/s`)
  if (x.elapsed_ms) parts.push(`${(x.elapsed_ms / 1000).toFixed(1)} s`)
  if (x.context_limit && x.percent !== undefined) parts.push(`${x.percent} % ctx`)
  return parts.length ? h("p", { class: "msg__metrics", text: parts.join(" · ") }) : null
}

/**
 * How a reply that did not finish ended, as a progress object (spec 3.7.0, display.md §4): the
 * one the server stored with it (`end`) or the last the stream sent, else what the message's
 * own `error` and `stopped` say -- a reason only where one is known. Null for a finished reply.
 */
function endOf(m, last) {
  if (endLine(m.end)) return m.end
  if (endLine(last)) return last
  if (m.error) return { phase: "failed", reason: String(m.error).trim().split("\n")[0] }
  if (m.stopped) return { phase: "stopped" }
  return null
}

function assistantMessage(m, chat, last = null) {
  const el = h("article", { class: "msg msg--assistant", dataset: { id: m.id } })
  const steps = h("div", { class: "msg__steps" })
  renderSteps(steps, m.steps || [], chat, false, m.id)
  el.append(steps)
  const end = endOf(m, last)
  if (end) {
    el.append(h("p", { class: `msg__end is-${end.phase}`, text: endLine(end) }))
    // The line is the error's first line; the whole of a longer one is behind Details, not in a tooltip.
    const whole = end.phase === "failed" && m.error ? String(m.error).trim() : ""
    if (whole.includes("\n")) el.append(h("details", { class: "msg__error" }, h("summary", { text: t("Details") }), h("pre", { class: "call__pre", text: whole })))
  }
  const meta = metricsLine(m.metrics)
  const model = m.model ? ctx.models().find((x) => x.id === m.model) || { id: m.model, name: m.model } : null
  el.append(
    h(
      "footer",
      { class: "msg__foot" },
      h(
        "div",
        { class: "msg__actions" },
        action(ICONS.copy, t("Copy"), () => copyText(replyText(m))),
        readAloudButton(m.id, () => replyText(m)),
        // Only the last reply: CSS shows it there and nowhere else (app.css, .msg__regen).
        action(ICONS.refresh, t("Regenerate reply"), () => regenerate(m), "msg__regen"),
      ),
      model ? h("span", { class: "msg__model", title: model.id }, avatar(model), h("span", { text: model.name })) : null,
      meta,
    ),
  )
  return el
}

function renderSteps(box, steps, chat, live = false, owner = "") {
  // What the person opened or closed stays so while the reply is written: a call is known by
  // its id (or its place), and the server sends every step again with each change.
  const was = new Map([...box.querySelectorAll("details[data-key]")].map((d) => [d.dataset.key, d.open]))
  clear(box)
  for (const s of steps) box.append(step(s, chat, live, owner))
  for (const d of box.querySelectorAll("details[data-key]")) if (was.has(d.dataset.key)) d.open = was.get(d.dataset.key)
}

function step(s, chat, live, owner) {
  switch (s.kind) {
    case "thinking":
      return h(
        "details",
        { class: "step step--thinking", open: s.open || null, dataset: { key: `think${s.index ?? ""}` } },
        h("summary", { class: "step__row" }, h("span", { class: "step__icon" }, icon(ICONS.bulb)), h("span", { class: "step__label" }, t("Thought"), s.label ? h("span", { class: "step__meta", text: ` · ${s.label}` }) : null), h("span", { class: "step__chev" }, icon(ICONS.chevron))),
        h("div", { class: "step__pre", text: s.text || "" }),
      )
    case "text":
      // A page the model wrote (`pages`: the server names each) is a sealed frame in its place;
      // while the reply is written, its title only.
      return h("div", { class: "step step--text md" }, markdown(s.markdown || "", live ? { writing: pageWriting } : s.pages?.length && owner ? { list: s.pages, mount: (pg) => pageMount({ kind: "m", owner, title: pg.title, digest: pg.digest }) } : null))
    case "tools":
      return h("div", { class: "step step--tools" }, (s.calls || []).map((c, i) => toolCall(c, chat, live, `call${s.index ?? ""}.${c.id || i}`)))
    case "steer":
      return h(
        "div",
        { class: "step step--steer" },
        h("p", { class: "muted", text: t("Taken in while it ran:") }),
        (s.messages || []).map((m) => h("p", { class: "steer__text", text: m.text })),
      )
    default:
      return h("div", { class: "step" })
  }
}

/**
 * Where the text of a file the agent showed comes from, or null when there is none to fetch:
 * - an agent chat on this computer: the file itself, read here (the card's path, or the call's
 *   own `args.path` for a step the card does not describe);
 * - otherwise the server, through the card (`show`): `?node=&version=` for a file in the tree,
 *   `?shown=` for the copy a device sent. The server checks the chat's access again then.
 */
function shownSource(call, chat) {
  if (onThisComputer(chat) && chat.device.directory) {
    const path = call.show?.path || call.args?.path || ""
    return path ? { local: true, path } : null
  }
  const s = call.show
  if (!s || !chat?.id) return null
  const q = s.shown_id
    ? `shown=${encodeURIComponent(s.shown_id)}`
    : s.node_id && s.version_id
      ? `node=${encodeURIComponent(s.node_id)}&version=${encodeURIComponent(s.version_id)}`
      : ""
  return q ? { local: false, path: s.path || "", url: `/chats/${encodeURIComponent(chat.id)}/show?${q}` } : null
}

// --- A tool call, as every LLeMbas client shows one (harness spec 3.7.0, display.md) ---------------
//
// One row: the state's mark, the kind's icon, what the tool is called, the call's one short
// title, the facts from its result (+3 −1, exit 2, 14 hits), how long it took. The server says
// the kind, the title and an edit's counts in the call's `block`; the page adds nothing of its
// own to them and falls back to the spec's rules (display.js) only where the server says nothing.

const KIND_ICONS = { shell: ICONS.terminal, edit: ICONS.edit, read: ICONS.fileText, search: ICONS.search, web: ICONS.link, task: ICONS.users, tool: ICONS.tools }
const STATE_WORDS = { running: () => t("Running"), done: () => t("Done"), failed: () => t("Failed"), denied: () => t("Denied") }

/**
 * Which of the four states a call is in: the server's word where it sends one, else from the
 * call's `status`. A call still "running" in a reply that is no longer being written never got
 * its result: failed, not left spinning.
 */
function callState(c, live) {
  const said = c.block?.state || c.state
  if (DISPLAY.states.includes(said)) return said === "running" && !live ? "failed" : said
  if (c.status === "denied" || c.denied) return "denied"
  if (c.status === "error" || c.error) return "failed"
  if (c.status === "running") return live ? "running" : "failed"
  return "done"
}

const firstLine = (x) => String(typeof x === "string" ? x : JSON.stringify(x)).trim().split("\n")[0]

/** A unified diff, a line a row: added, removed, a hunk's header, the rest. */
function diffBlock(diff) {
  const pre = h("pre", { class: "call__pre call__diff" })
  for (const line of String(diff).replace(/\n$/, "").split("\n")) {
    const cls = /^(\+\+\+ |--- |diff |index |Index: |=====)/.test(line) ? "is-meta" : line.startsWith("@@") ? "is-hunk" : line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-del" : ""
    pre.append(h("span", { class: `diff__line ${cls}`, text: line || " " }))
  }
  return pre
}

function toolCall(c, chat, live, key) {
  const block = c.block || {}
  const kind = block.kind || "tool"
  if (!drawn(kind)) return null
  const state = callState(c, live)
  const title = block.title || callTitle(c.args) || ""
  const label = block.label || c.label || c.name || ""
  // The facts after the title: from the server's own numbers, written the spec's way.
  const facts = []
  if (kind === "edit") {
    const n = block.added || block.removed ? { added: block.added || 0, removed: block.removed || 0 } : typeof c.diff === "string" && c.diff ? diffCounts(c.diff) : null
    if (n) facts.push(h("span", { class: "call__fact call__change", title: changeText(n) }, h("span", { class: "is-add", text: `+${count(n.added)}` }), " ", h("span", { class: "is-del", text: `−${count(n.removed)}` })))
  } else if ((kind === "shell" && typeof c.exit === "number") || (kind === "search" && typeof c.hits === "number")) {
    // From the call's own numbers, so a count is written as the page's language writes it.
    for (const f of callFacts({ block: kind, exit: c.exit, hits: c.hits })) facts.push(h("span", { class: `call__fact${kind === "shell" ? " is-bad" : ""}`, text: f }))
  } else {
    for (const x of block.chips || []) facts.push(h("span", { class: "call__fact", text: x }))
  }
  // How long it took: the server's own word (`block.duration`, written the one way), else from
  // the call's milliseconds; none while it runs or where it was not run.
  const took = callDuration(state, 0) === null ? null : typeof block.duration === "string" && block.duration ? block.duration : callDuration(state, c.ms ?? block.duration_ms ?? c.duration_ms)
  const why = state === "failed" || state === "denied" ? firstLine(c.error || c.reason || "") : ""
  const body = h("div", { class: "call__body" })
  if (c.purpose) body.append(h("p", { class: "muted", text: c.purpose }))
  if (c.args?.command) body.append(h("pre", { class: "call__pre", text: c.args.command }))
  if (c.diff) body.append(typeof c.diff === "string" ? diffBlock(c.diff) : h("pre", { class: "call__pre", text: JSON.stringify(c.diff, null, 2) }))
  if (c.text) body.append(h("pre", { class: "call__pre", text: c.text }))
  if (c.error) body.append(h("p", { class: "msg__note is-error", text: typeof c.error === "string" ? c.error : JSON.stringify(c.error) }))
  if (c.truncated) body.append(h("p", { class: "muted", text: t("Cut short here; the whole of it is in the web interface.") }))
  if (!body.childElementCount && state === "running") body.append(h("p", { class: "muted", text: t("Running") }))
  const isShow = c.name === "show" && state === "done" && shownSource(c, chat)
  const summary = h(
    "summary",
    { class: "call__head" },
    h("span", { class: `call__state dot${state === "failed" ? " is-error" : state === "running" ? " is-busy" : state === "denied" ? " is-denied" : " is-ok"}`, role: "img", "aria-label": STATE_WORDS[state](), title: STATE_WORDS[state]() }),
    h("span", { class: "call__icon", "aria-hidden": "true" }, icon(KIND_ICONS[kind] || ICONS.tools)),
    h("span", { class: "call__name", text: label }),
    h("span", { class: "call__title", title: title || null, text: title }),
    why ? h("span", { class: "call__why", title: why, text: why }) : null,
    h("span", { class: "call__facts" }, state === "denied" ? h("span", { class: "call__fact is-bad", text: t("Denied") }) : null, facts, took ? h("span", { class: "call__fact call__took", text: took }) : null),
    h("span", { class: "step__chev" }, icon(ICONS.chevron)),
  )
  // An edit shows its change without a click, as the web and the phone do.
  const el = h("details", { class: `call call--${kind} is-${state}`, open: kind === "edit" && !!c.diff ? true : null, dataset: { key, state, kind } }, summary, body.childElementCount ? body : null)
  if (isShow) {
    el.append(h("button", { type: "button", class: "btn btn--sm call__open", text: t("Open in the viewer"), onclick: () => openShown(c, chat) }))
  }
  return el
}

/** A file the agent showed: from this computer when the chat runs here, else from the server. */
async function openShown(call, chat) {
  const src = shownSource(call, chat)
  if (!src) return
  const path = src.path
  const { language } = showKind(path)
  const line = call.show?.line || (src.local ? call.args?.line : 0) || 0
  const base = { name: call.show?.name || path.split("/").pop(), path, kind: call.show?.kind, language: call.show?.language || language, line }
  try {
    if (src.local) {
      const dir = chat.device.directory.replace(/\/+$/, "")
      const rel = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path
      const f = await readLocal(dir, rel)
      openViewer({ ...base, where: `${t("Shown by the agent")} · ${t("This computer")}`, text: f.text, withheld: f.withheld, size: f.size })
    } else {
      // Plain text, at most 1 MB; the server's 404 (no longer the chat's), 413 (too large) and
      // 415 (not text) come back as its own words. HTML is its source: the viewer seals it.
      const text = await getText(src.url)
      openViewer({ ...base, where: `${t("Shown by the agent")} · ${t("Server")}`, text })
    }
  } catch (err) {
    openViewer({ ...base, where: t("Shown by the agent"), error: why(err) })
  }
}

// --- The reply being written ---------------------------------------------------------------------

class Live {
  constructor(chat, messageId) {
    this.chat = chat
    this.id = messageId
    this.steps = h("div", { class: "msg__steps" })
    this.tail = h("div", { class: "step step--text md msg__tail" })
    this.thinking = h("p", { class: "msg__thinking muted" })
    this.status = h("p", { class: "msg__status muted", text: t("Writing…") })
    this.jobs = h("ul", { class: "msg__jobs", hidden: true })
    this.calls = h("div", { class: "step step--tools msg__running", hidden: true })
    this.el = h("article", { class: "msg msg--assistant is-live", dataset: { id: messageId } }, this.steps, this.thinking, this.tail, this.calls, this.jobs, this.status)
    this.done = false
    this.handle = null
    this.progress = null // the stream's `progress` (spec 3.4.0), drawn in place of `status` when it comes
    this.said = "" // the last `status` text, for a server that sends no progress
    this.clock = 0
  }

  /** The status line: the progress object's line where the server sends one, else its text. */
  drawStatus() {
    const p = this.progress
    this.status.textContent = isProgress(p) ? progressLine(p) : this.said || t("Writing…")
    this.status.dataset.phase = isProgress(p) ? p.phase : ""
    const ticks = progressTicks(p)
    if (ticks && !this.clock) this.clock = setInterval(() => (this.done ? this.stopClock() : this.drawStatus()), 1000)
    else if (!ticks) this.stopClock()
  }

  stopClock() {
    clearInterval(this.clock)
    this.clock = 0
  }

  async start() {
    this.opened = Date.now()
    this.frames = 0
    try {
      this.handle = await follow(`/chats/${encodeURIComponent(this.chat.id)}/messages/${encodeURIComponent(this.id)}/stream`, {
        onFrame: (event, data) => this.frame(event, data),
        onEnd: (err) => this.end(err),
      })
    } catch (err) {
      this.end(err)
    }
  }

  stop() {
    this.done = true
    this.stopClock()
    this.handle?.close()
  }

  frame(event, data) {
    // The chat's name from a model, which follows `done` on the same stream (server
    // 2.0.0-beta.11: the reply ends when it is saved, the naming a moment later).
    if (event === "title") return this.named(data?.chat)
    if (this.done) return
    this.frames = (this.frames || 0) + 1
    // Any frame that carries `progress` (the status frame does, from server 2.0.0-beta.8 on):
    // the object, or null for nothing running -- then the status text again.
    if (data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "progress")) {
      this.progress = isProgress(data.progress) ? data.progress : null
      if (event !== "status") this.drawStatus()
    }
    switch (event) {
      case "steps":
        renderSteps(this.steps, data.steps || [], this.chat, true, this.id)
        this.tailed(data.tail)
        break
      case "tail":
        this.tailed(data)
        break
      case "status":
        this.said = data.text || ""
        this.drawStatus()
        break
      case "ask":
        renderCards(this.chat, data.cards || [])
        break
      case "tree":
        // The subagent tree as it changed (spec 3.4.0): the activity panel draws it.
        treeChanged(this.chat.id, data.tree)
        break
      case "jobs":
        this.jobs.hidden = !(data.jobs || []).length
        append(
          clear(this.jobs),
          (data.jobs || []).map((j) =>
            h("li", { class: `job job--${j.state}` }, h("span", { class: "chip", text: stateWord(j.state) }), h("span", { text: j.description || j.command || j.agent || "" })),
          ),
        )
        break
      case "steered":
        for (const id of data.ids || []) document.querySelector(`.msg--user[data-id="${CSS.escape(id)}"]`)?.classList.remove("is-queued")
        break
      case "done":
        this.done = true
        ended = { id: "", n: 0 }
        this.stopClock()
        // How it ended (stopped, failed) stays on the reply: the stream's last progress says why.
        this.el.replaceWith(assistantMessage(data.message, this.chat, this.progress))
        renderCards(this.chat, [])
        if (data.chat?.title) setTitle(data.chat.title)
        ctx.changed(this.chat)
        if (open?.live === this) open.live = null
        setRunning(false)
        // A message queued behind this reply has one of its own now: read the chat again.
        if (data.next) reload()
        break
      default:
        break
    }
    toBottom(false)
  }

  named(chat) {
    if (!chat?.title || chat.id !== this.chat.id) return
    if (open?.chat?.id === chat.id) {
      open.chat = { ...open.chat, title: chat.title }
      setTitle(chat.title)
    }
    ctx.changed(this.chat)
  }

  tailed(tail) {
    if (!tail) return
    this.thinking.textContent = tail.thinking ? `${t("Thinking")} ${tail.label || ""}…` : ""
    this.thinking.hidden = !tail.thinking
    clear(this.tail).append(markdown(tail.text || "", { writing: pageWriting }))
    // The calls running right now (`tail.calls`), drawn as finished ones are; what the person
    // opened stays open as the frames come again.
    const calls = Array.isArray(tail.calls) ? tail.calls : []
    const was = new Set([...this.calls.querySelectorAll("details[open]")].map((d) => d.dataset.key))
    this.calls.replaceChildren(...calls.map((c, i) => toolCall(c, this.chat, true, `tail.${c.id || i}`)).filter(Boolean))
    for (const d of this.calls.querySelectorAll("details")) if (was.has(d.dataset.key)) d.open = true
    this.calls.hidden = !this.calls.childElementCount
  }

  end(err) {
    if (this.done) return
    this.done = true
    this.stopClock()
    if (open?.live === this) open.live = null
    setRunning(false)
    // A stream that ends without `done` is read again -- but a reply whose stream keeps ending
    // so (the chat still says it is being written, the stream closes as it opens) would be read
    // and followed in a loop as fast as the server answers: after a few times it is said, and
    // the person reads again.
    // Only a stream that gave nothing counts: one that sent frames for a while and was then
    // closed (a proxy's time limit on a long reply) is simply followed again, however often.
    if (!err) {
      const empty = !this.frames || Date.now() - this.opened < QUICK_END
      if (!empty) ended = { id: "", n: 0 }
      else ended = ended.id === this.id ? { id: this.id, n: ended.n + 1 } : { id: this.id, n: 1 }
      if (ended.n > 3) err = { detail: t("The connection was lost.") }
    }
    if (err) {
      this.status.textContent = t("The connection to the reply was lost: %(why)s", { why: why(err) })
      this.status.classList.add("is-error")
      this.el.append(h("button", { type: "button", class: "btn btn--sm", text: t("Read again"), onclick: reload }))
    } else {
      reload()
      activityChanged()
    }
  }
}

/** While a reply is written, Stop takes Send's place (Send comes back beside it for a message typed meanwhile). */
function setRunning(on) {
  $("send").hidden = on && !$("composer-text").value.trim()
  $("stop").hidden = !on
  $("composer").dataset.running = String(on)
}

/** The reply whose stream last ended without `done` having given anything, and how many times running. */
let ended = { id: "", n: 0 }
/** A stream that ends sooner than this (ms) after it was opened gave nothing worth the name. */
const QUICK_END = 5000

function follower(chat, messageId) {
  if (open?.live) open.live.stop()
  const live = new Live(chat, messageId)
  open.live = live
  $("messages").append(live.el)
  setRunning(true)
  live.start()
  toBottom(true)
}

// --- Cards ----------------------------------------------------------------------------------------

/**
 * The cards waiting for an answer, as the stream's `ask` frame lists them. A card already on the
 * screen is kept as it is -- the server sends the frame again whenever anything in it changes, its
 * countdown included, and drawing it again would take away a command being corrected or an option
 * already picked. New ones are added in the server's order; the ones no longer listed go.
 */
function renderCards(chat, cards) {
  const box = $("cards")
  const ids = cards.map((c) => String(c.id))
  for (const el of [...box.children]) if (el.dataset.chat !== chat.id || !ids.includes(el.dataset.card)) el.remove()
  cards.forEach((card, i) => {
    let el = [...box.children].find((x) => x.dataset.card === String(card.id))
    if (!el) {
      try {
        el = cardOf(chat, card)
      } catch (err) {
        // Never an empty box under a status that says the reply waits: say what went wrong.
        console.error("card", card, err)
        el = h("section", { class: "ask" }, h("p", { class: "msg__note is-error", text: String(err) }))
      }
      el.dataset.card = String(card.id)
      el.dataset.chat = chat.id
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null)
  })
  box.hidden = !box.children.length
}

// The server's mark for "the answer is what was typed beside it" (services/interaction.py OTHER):
// sent only where typed words go with picked options; alone, they are the answer as they are.
const OTHER = "__other__"

/**
 * One card, with what every LLeMbas client offers on it (harness spec 3.7.0, display.md §5, the
 * words `display.actions`), answered through POST /chats/{chat}/interactions/{card}:
 *  - an approval: Allow once, Always allow, Deny, and Deny, and say why (the words go to the
 *    model as `reason`); a command can be corrected before it is allowed (`texts[key]`);
 *  - a question: its options, the recommended first; Something else (typed: `texts[key]`) and a
 *    question asked back (`asks[key]`) where the item takes free text; Dismiss where the card may be;
 *  - a plan: Approve -- into Edit or Manual where the device offers the choice (`choices[key]`)
 *    -- Revise with what to change (`reason`, verdict deny), and Dismiss;
 *  - something to do on the phone: said, and Decline.
 */
function cardOf(chat, card) {
  const answers = { choices: {}, texts: {}, asks: {} }
  const kind = card.kind || (card.items.some((i) => i.kind === "plan") ? "plan" : card.items.some((i) => i.kind === "approval") ? "approval" : "question")
  const el = h("section", { class: `ask ask--${kind}`, "aria-label": t("Waiting for your answer") })
  if (card.why) el.append(h("p", { class: "muted", text: t("It says: %(purpose)s", { purpose: card.why }) }))
  for (const item of card.items) {
    const part = h("div", { class: "ask__item" })
    // A background subagent asks, not the conversation's own turn: said first (`job`).
    if (item.job) part.append(h("p", { class: "ask__header", text: t("%(job)s asks:", { job: item.job }) }))
    // A subagent of the tree asks, for a call nobody in the tree may allow (spec 3.4.0, §7).
    if (item.subagent) {
      const sub = item.subagent
      part.append(h("p", { class: "ask__header ask__subagent", text: t("Subagent %(name)s (%(id)s), %(position)s, asks:", { name: sub.name || sub.id, id: sub.id, position: sub.position || "—" }) }))
    }
    if (item.header) part.append(h("p", { class: "ask__header", text: item.header }))
    let detailShown = false
    if (item.kind === "approval") {
      part.append(h("p", { class: "ask__title", text: item.tool ? t("The agent asks to run %(tool)s:", { tool: item.tool }) : t("The agent asks:") }))
      if (item.editable) {
        // A command, correctable before it runs. The server says it in `detail` and puts a fixed
        // "Run a command" in the title (services/device_link.py); a corrected command goes back as
        // this item's text, and only when it differs -- an untouched one is not an edit.
        const command = item.detail || item.title
        detailShown = true
        const edit = h("textarea", { class: "ask__edit", rows: "2", spellcheck: "false", "aria-label": t("Command"), value: command })
        edit.addEventListener("input", () => {
          if (edit.value !== command) answers.texts[item.key] = edit.value
          else delete answers.texts[item.key]
        })
        part.append(edit)
      } else {
        // What it wants to do (a tool's own title), then its input as the device sent it.
        part.append(h("p", { class: "ask__what", text: item.title }))
        if (item.detail) part.append(h("pre", { class: "call__pre", text: item.detail }))
        detailShown = true
      }
    } else if (item.kind === "plan") {
      part.append(h("p", { class: "ask__title", text: item.plan?.title || item.title || t("The plan") }))
      if (item.plan) part.append(planList(item.plan))
      else if (item.detail) part.append(h("div", { class: "ask__plan md" }, markdown(item.detail)))
      detailShown = true
    } else if (item.kind === "phone_action") {
      part.append(h("p", { class: "ask__title", text: item.title }), h("p", { class: "muted", text: t("Confirm it on your phone, in the app. It is not done until you do.") }))
      detailShown = true
    } else {
      part.append(h("p", { class: "ask__title", text: item.title }))
    }
    if (item.detail && !detailShown) part.append(h("p", { class: "muted", text: item.detail }))
    // The model's account of what it is for, attributed to it; then the server's reason for asking.
    if (item.purpose) part.append(h("p", { class: "muted", text: t("It says: %(purpose)s", { purpose: item.purpose }) }))
    if (item.reason) part.append(h("p", { class: "muted ask__reason", text: item.reason }))
    if (item.kind === "question") part.append(questionOptions(item, answers))
    el.append(part)
  }
  const said = h("p", { class: "ask__said", "aria-live": "polite" })
  const send = async (verdict, more = {}) => {
    for (const b of el.querySelectorAll("button")) b.disabled = true
    const body = { verdict, choices: { ...answers.choices, ...(more.choices || {}) }, texts: answers.texts }
    if (Object.keys(answers.asks).length) body.asks = answers.asks
    if (more.reason) body.reason = more.reason
    try {
      await post(`/chats/${encodeURIComponent(chat.id)}/interactions/${encodeURIComponent(card.id)}`, body)
      el.remove()
      if (!$("cards").children.length) $("cards").hidden = true
    } catch (err) {
      if (err?.status === 409) {
        el.remove()
        reload()
        return
      }
      said.textContent = why(err)
      for (const b of el.querySelectorAll("button")) b.disabled = false
    }
  }
  const btn = (label, onclick, cls = "") => h("button", { type: "button", class: `btn ${cls}`, onclick }, h("span", { text: label }))
  const actions = h("div", { class: "ask__actions" })
  // A second step in the card's own place: words for the model with a refusal (why not; what to
  // change in the plan). The first row comes back with Cancel; nothing is sent until its button.
  const explain = ({ label, placeholder, sendLabel, cls }) => {
    const box = h("textarea", { class: "ask__reason-input", rows: "2", spellcheck: "false", "aria-label": label, placeholder })
    const go = btn(sendLabel, () => send("deny", { reason: box.value.trim() }), cls)
    const form = h("div", { class: "ask__explain" }, box, h("div", { class: "ask__actions" }, go, btn(t("Cancel"), () => (form.remove(), (actions.hidden = false)))))
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) go.click()
    })
    actions.hidden = true
    actions.after(form)
    box.focus()
  }
  if (kind === "plan") {
    const item = card.items.find((i) => i.kind === "plan") || card.items[0]
    if (item?.mode_choice) {
      // A device's plan: approved into the mode the work goes on in, never beyond these two.
      actions.append(
        btn(t(ACTIONS.plan.approve_edit), () => send("allow", { choices: { [item.key]: ["edit"] } }), "btn--primary"),
        btn(t(ACTIONS.plan.approve_manual), () => send("allow", { choices: { [item.key]: ["manual"] } })),
      )
    } else {
      el.append(h("p", { class: "muted ask__note", text: t("Approving ends Plan mode: the model carries the plan out in this reply, keeping it current above the message box.") }))
      actions.append(btn(t("Approve"), () => send("allow"), "btn--primary"))
    }
    actions.append(
      btn(t(ACTIONS.plan.revise), () => explain({ label: t("What to change"), placeholder: t("What to change in the plan…"), sendLabel: t("Send it back"), cls: "btn--primary" })),
      btn(t("Dismiss"), () => send("deny")),
    )
  } else if (kind === "approval") {
    append(
      actions,
      btn(t(ACTIONS.approval.once), () => send("allow"), "btn--primary"),
      // "Always allow" only where the server offers it (`always` on the item; a server that
      // does not say offers it): a call that may only ever be allowed once has none.
      card.items.some((i) => i.always === false) ? null : btn(t(ACTIONS.approval.always), () => send("allow_always")),
      btn(t(ACTIONS.approval.deny), () => send("deny")),
      btn(t(ACTIONS.approval.deny_reason), () => explain({ label: t("Why not, and what to do instead"), placeholder: t("Why not, and what to do instead…"), sendLabel: t(ACTIONS.approval.deny_reason), cls: "btn--danger" })),
    )
  } else if (kind === "phone_action") {
    actions.append(btn(t("Decline"), () => send("deny")))
  } else {
    actions.append(btn(card.items.length === 1 ? t("Answer") : t("Send answers"), () => send(""), "btn--primary"))
    if (card.dismissable) actions.append(btn(t("Dismiss"), () => send("deny")))
    el.append(h("p", { class: "muted ask__note", text: card.items.length > 1 ? t("All of them at once. Leave any blank to skip it.") : t("Leave any blank to skip it.") }))
  }
  el.append(actions, said)
  return el
}

/**
 * A question's answers: its options (the recommended first, marked), one or several as the
 * model said; and, where it takes free text, a row of the person's own -- Something else -- and
 * a question back to the model instead of an answer. Each row is the same two tracks, so the
 * typed rows line up with the options above them.
 */
function questionOptions(item, answers) {
  const picked = new Set()
  let typed = ""
  const opts = h("div", { class: "ask__options", role: item.multiple ? "group" : "radiogroup" })
  const settle = () => {
    // Typed words beside picked options need the server's mark to count; alone they are the answer.
    const picks = [...picked]
    if (typed && picks.length) picks.push(OTHER)
    if (picks.length) answers.choices[item.key] = picks
    else delete answers.choices[item.key]
    if (typed) answers.texts[item.key] = typed
    else delete answers.texts[item.key]
  }
  const options = [...(item.options || [])].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended))
  const other = item.free_text ? h("input", { type: "text", class: "ask__text", autocomplete: "off", placeholder: t("Your own answer…"), "aria-label": t(ACTIONS.question.something_else) }) : null
  for (const o of options) {
    const b = h(
      "button",
      { type: "button", class: "opt", "aria-pressed": "false" },
      h("span", { class: "opt__label", text: o.label }),
      o.description ? h("span", { class: "opt__desc", text: o.description }) : null,
      o.recommended ? h("span", { class: "chip", text: t("Recommended") }) : null,
    )
    b.addEventListener("click", () => {
      if (!item.multiple) {
        const was = picked.has(o.label)
        picked.clear()
        for (const x of opts.querySelectorAll("button.opt")) x.setAttribute("aria-pressed", "false")
        if (was) picked.add(o.label)
        // One answer: choosing an option puts the typed one aside.
        if (other && !was) {
          other.value = ""
          typed = ""
          other.closest(".opt").dataset.on = "false"
        }
      }
      if (picked.has(o.label)) picked.delete(o.label)
      else picked.add(o.label)
      b.setAttribute("aria-pressed", String(picked.has(o.label)))
      settle()
    })
    opts.append(b)
  }
  if (other) {
    const row = h("label", { class: "opt opt--typed", dataset: { on: "false" } }, h("span", { class: "opt__label", text: t(ACTIONS.question.something_else) }), other)
    other.addEventListener("input", () => {
      typed = other.value.trim()
      row.dataset.on = String(!!typed)
      if (typed && !item.multiple) {
        picked.clear()
        for (const x of opts.querySelectorAll("button.opt")) x.setAttribute("aria-pressed", "false")
      }
      settle()
    })
    const back = h("input", { type: "text", class: "ask__text", autocomplete: "off", placeholder: t("Your question for the model…"), "aria-label": t("Ask it something back") })
    const backRow = h("label", { class: "opt opt--typed", dataset: { on: "false" } }, h("span", { class: "opt__label", text: t("Ask it something back") }), back)
    back.addEventListener("input", () => {
      const q = back.value.trim()
      backRow.dataset.on = String(!!q)
      if (q) answers.asks[item.key] = q
      else delete answers.asks[item.key]
    })
    opts.append(row, backRow)
  }
  return opts
}

// --- Opening a chat --------------------------------------------------------------------------------

function setTitle(title) {
  $("chat-title").textContent = title || t("New chat")
  $("chat-title").title = title || ""
}

/** The chat's header: its title, where it works (an agent chat's folder and device), and its tools. */
function renderHead(chat) {
  setTitle(chat.title)
  const place = clear($("chat-place"))
  const tools = clear($("chat-tools"))
  // The conversation that continues a report says which report, with the way back to Reports:
  // it is in no list of chats.
  if (chat.kind === "report") {
    const of = ctx.reportOf?.(chat.id)
    setTitle(`${t("Report")}: ${of?.title || chat.title || ""}`)
    place.append(h("button", { type: "button", class: "place place--back", id: "chat-report-back", title: t("Back to Reports"), onclick: () => ctx.nav?.reports?.(of?.id || "") }, icon(ICONS.back), h("span", { class: "place__name", text: t("Back to Reports") })))
  }
  if (chat.kind === "agent" && chat.device) {
    const here = onThisComputer(chat)
    place.append(
      h(
        "span",
        { class: `place${here ? " is-here" : ""}`, title: chat.device.directory },
        icon(ICONS.folder),
        h("span", { class: "place__name", text: folderName(chat.device.directory) }),
        h("span", { class: "place__where", text: here ? t("This computer") : t("Another device") }),
      ),
    )
    // The Terminal panel where the chat's device opens one (`GET /devices` says so per device);
    // "Continue in a terminal" stays in the chat's menu.
    const terminal = terminalControl()
    if (terminal) tools.append(terminal)
  }
  // A chat on the server whose Python runs here says so, quietly, beside its title.
  if (chat.kind === "chat") {
    place.append(h("span", { id: "chat-python", hidden: true }))
    renderPython()
  }
  // An archived chat says so where it is read, with the way back into the sidebar.
  if (chat.archived) tools.append(h("button", { type: "button", class: "btn btn--sm head__unarchive", text: t("Restore chat"), title: t("Archived"), onclick: () => unarchiveChat(open?.chat || chat) }))
  if (!chat.archived) tools.append(h("button", { type: "button", class: "tool", id: "scope-open", "aria-label": t("Tools and skills…"), title: t("Tools and skills…"), "aria-haspopup": "dialog", onclick: (e) => scopePopover(e.currentTarget, open?.chat || chat) }, icon(ICONS.tools)))
  tools.append(activityButton())
  tools.append(h("button", { type: "button", class: "tool", "aria-label": t("More"), title: t("More"), onclick: (e) => chatMenu(e.currentTarget, open?.chat || chat) }, icon(ICONS.more)))
  fitHead()
}

/**
 * Whether this window runs the chat's Python (python.js), beside the title: said in a few quiet
 * words where it does; where the runner could not be made ready, that -- a press says why and
 * tries again. Nothing where Python is off on the server, the chat is an agent's (its code runs
 * on its computer), or the runner is still being made ready.
 */
export function pythonChanged() {
  renderPython()
  fitHead()
}

function renderPython() {
  const at = $("chat-python")
  if (!at) return
  const { state, reason } = open?.chat?.kind === "chat" ? pythonState() : { state: "off", reason: "" }
  at.hidden = state === "off"
  if (state === "ready") {
    const words = t("Python runs in this window")
    at.replaceChildren(h("span", { class: "place place--python", title: words }, icon(ICONS.fileCode), h("span", { class: "place__where", text: words })))
  } else if (state === "failed") {
    const words = t("Python cannot run in this window")
    at.replaceChildren(
      h(
        "button",
        {
          type: "button",
          class: "place place--python is-warn",
          "aria-haspopup": "dialog",
          title: words,
          onclick: (e) =>
            popover(
              e.currentTarget,
              h(
                "div",
                { class: "pop__body" },
                h("p", { class: "pop__title", text: words }),
                reason ? h("p", { text: reason }) : null,
                h("p", { class: "hint", text: t("It is tried again by itself. Until it can, this chat's Python runs in a browser tab that has the chat open.") }),
                h("div", { class: "pop__actions" }, h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Try again"), onclick: () => (closePopover(), retryPython()) })),
              ),
              { label: words },
            ),
        },
        icon(ICONS.fileCode),
        h("span", { class: "place__where", text: words }),
      ),
    )
  } else at.replaceChildren()
}

// --- The chat's settings, top right ---------------------------------------------------------------
//
// The model, how hard it thinks, the subagents and an agent chat's mode sit in the chat's header,
// beside the Terminal, the activity panel, the tools and skills and the chat's menu; the composer
// keeps only what belongs to the message. Where the header has no room for them all on its line,
// they fold behind one button (Chat settings), which opens them as a row of their own under the
// header -- wrapped, every one reachable, never a line cut off at its end. Whether they fit is
// measured, not guessed: a long model name or one more chip folds them at any width.

function fitHead() {
  const head = $("chat-head")
  const box = $("chat-settings")
  if (!head || !box) return
  const any = box.childElementCount > 0
  head.dataset.fold = "false"
  // Folded when the settings are cut at their end, or when they leave where the chat works (its
  // folder) less than its own width or 10rem, whichever is less.
  const place = $("chat-place")
  const room = Math.min(place.scrollWidth, 10 * parseFloat(getComputedStyle(document.documentElement).fontSize))
  const squeezed = place.childElementCount > 0 && place.clientWidth + 1 < room
  const fold = any && (box.scrollWidth > box.clientWidth + 1 || squeezed)
  head.dataset.fold = String(fold)
  if (!fold) head.dataset.unfold = "false"
  $("chat-fold").hidden = !fold
  $("chat-fold").setAttribute("aria-expanded", String(head.dataset.unfold === "true"))
}

function initHead() {
  $("chat-fold").replaceChildren(icon(ICONS.sliders))
  $("chat-fold").hidden = true
  $("chat-fold").addEventListener("click", () => {
    const head = $("chat-head")
    head.dataset.unfold = String(head.dataset.unfold !== "true")
    $("chat-fold").setAttribute("aria-expanded", head.dataset.unfold)
    if (head.dataset.unfold === "true") $("chat-settings").querySelector("button")?.focus()
  })
  new ResizeObserver(() => fitHead()).observe($("chat-head"))
}

/** The models this chat may switch to (its data group's), or the account's when that fails. */
async function chatModels(chat) {
  try {
    return (await get(`/models?chat=${encodeURIComponent(chat.id)}`)).models || []
  } catch {
    return ctx.models()
  }
}

/**
 * Whether this chat is offered subagents: `{ cap, own }` (the instance's most; whether only a model
 * the person names could serve them), or null. The chat's own `subagents` where the server gives
 * it (2.0.0-beta.7), else its team's word (`GET /chats/{chat}/team`) -- only a chat on the server.
 */
async function teamOffered(chat) {
  const said = chat.subagents
  if (said !== undefined && said !== null) {
    const offered = typeof said === "object" ? said.offered : said
    return offered ? { cap: subagentsCap(said), own: namedOnly(said) } : null
  }
  if (chat.kind !== "chat") return null
  try {
    const team = (await get(`/chats/${encodeURIComponent(chat.id)}/team`)).team
    return team?.offered ? { cap: subagentsCap(), own: false } : null
  } catch {
    return null
  }
}

// --- The chips under the text -------------------------------------------------------------------
//
// A chat's settings are small buttons under what is being written, each opening a menu: the
// folder and the mode (an agent chat), the model with its picture, how hard it thinks (as the
// model offers it: nothing for one level), and the team's size (where a team is offered). For a
// new chat they say what it will start with; for an open one, changing one changes the chat.

/** One chip: an icon or a lead (an avatar), its words, and a chevron when it opens a menu. */
function chip({ ico, lead, label, title, onclick, menuish = true, cls = "", disabled = false, name = "" }) {
  return h(
    "button",
    { type: "button", class: `cchip ${cls}`, title: title || label, "aria-haspopup": menuish ? "menu" : null, disabled, onclick },
    // What the chip is, in front of what it says: shown only where the bar's chips are a column.
    name ? h("span", { class: "target__name", text: name }) : null,
    lead || (ico ? icon(ico) : null),
    h("span", { class: "cchip__label", text: label }),
    menuish ? h("span", { class: "cchip__chev" }, icon(ICONS.chevronDown)) : null,
  )
}

const MODE_WORDS = {
  manual: () => t("Manual — asks first"),
  edit: () => t("Edit — asks before commands"),
  auto: () => t("Auto — asks nothing"),
  plan: () => t("Plan — changes nothing"),
}

// --- Draw a picture: the next message's reply is a picture (`force_tool: "image_generate"`) -------

let wantPicture = false // the next message, in a chat (not an agent chat), asks for a picture

/** Whether a chat here may be asked for a picture: the server draws for this account. */
function picturesOffered() {
  const me = ctx.me()
  return !!me?.services?.images && me?.permissions?.["tools.image"] !== false
}

function pictureChip() {
  const b = chip({
    ico: ICONS.picture,
    label: t("Draw a picture"),
    title: t("The reply to the next message is a picture drawn from it."),
    menuish: false,
    cls: "cchip--picture",
    onclick: () => {
      wantPicture = !wantPicture
      b.setAttribute("aria-pressed", String(wantPicture))
      $("composer-text").placeholder = wantPicture ? t("What to draw…") : t("Message")
      $("composer-text").focus()
    },
  })
  b.setAttribute("aria-pressed", String(wantPicture))
  return b
}

/** The message's body, asking for a picture while the switch is on. */
function takePicture(body) {
  return wantPicture ? { ...body, force_tool: "image_generate" } : body
}

/** The message went: the switch goes off with it. */
function pictureSent() {
  if (!wantPicture) return
  wantPicture = false
  $("composer-text").placeholder = t("Message")
  document.querySelector(".cchip--picture")?.setAttribute("aria-pressed", "false")
}

function modeChip(value, onChange, disabled) {
  return chip({
    ico: ICONS.shield,
    label: modeName(value),
    title: `${t("Mode")}: ${MODE_WORDS[value]?.() || value}`,
    cls: "cchip--mode",
    name: t("Mode"),
    disabled,
    onclick: (e) => menu(e.currentTarget, MODES.map((m) => ({ label: MODE_WORDS[m](), checked: m === value, run: () => m !== value && onChange(m) }))),
  })
}

function modelChip(models, value, onChange, mayPick) {
  const m = models.find((x) => x.id === value) || (value ? { id: value, name: value } : null)
  if (!m) return chip({ ico: ICONS.info, label: t("No model is available to this account."), menuish: false, disabled: true })
  return chip({
    lead: avatar(m),
    label: m.name,
    title: `${t("Model")}: ${m.name} (${m.id})`,
    menuish: mayPick && models.length > 1,
    cls: "cchip--model",
    onclick: (e) => {
      if (!mayPick || models.length < 2) return
      menu(e.currentTarget, models.map((x) => ({ label: x.name, lead: avatar(x), checked: x.id === value, run: () => x.id !== value && onChange(x.id) })))
    },
  })
}

/** How hard the model thinks: nothing where it has one level; else its levels, in a menu. */
function effortChip(model, value, onChange) {
  const { levels, start, control } = levelsOf(model)
  if (control === "none") return null
  const current = levels.includes(value) ? value : start
  const words = (l) => (control === "switch" ? (l === "off" ? t("off") : t("Think before answering")) : levelWord(l))
  return chip({
    ico: ICONS.bulb,
    // A model with thinking on or off and nothing between: said as that, not as a level's name.
    label: control === "switch" ? (current === "off" ? `${t("Thinking")}: ${t("off")}` : t("Thinking")) : levelWord(current),
    title: control === "switch" ? `${t("Think before answering")}: ${current === "off" ? t("off") : levelWord(current)}` : `${t("Reasoning effort")}: ${levelWord(current)}`,
    cls: current === "off" ? "is-dim" : "",
    onclick: (e) => menu(e.currentTarget, levels.map((l) => ({ label: words(l), hint: control === "switch" && l !== "off" ? levelWord(l) : "", checked: l === current, run: () => l !== current && onChange(l) }))),
  })
}

/**
 * The subagents a chat may run: a chip saying Min–Max, opening one range with two handles.
 * `value` { min, max } or empty; `cap` the instance's most, where the server says it.
 */
function agentsChip(value, onChange, { cap, own } = {}) {
  const said = value?.min || value?.max ? `${value.min ?? "…"}–${value.max ?? "…"}` : t("default")
  return chip({
    ico: ICONS.users,
    label: `${t("Subagents")} ${said}`,
    title: own ? SUBAGENTS_OWN() : SUBAGENTS_HINT(),
    cls: `cchip--subagents${own ? " is-warn" : ""}`,
    onclick: (e) => {
      const fields = agentsControl({ value, id: "agents-min", cap })
      popover(
        e.currentTarget,
        h(
          "div",
          { class: "pop__body" },
          h("p", { class: "pop__title", text: t("Subagents") }),
          fields,
          own ? h("p", { class: "hint is-warn", text: SUBAGENTS_OWN() }) : null,
          h("p", { class: "hint", text: SUBAGENTS_HINT() }),
          h("div", { class: "pop__actions" }, h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Save"), onclick: () => (closePopover(), onChange(fields.value)) })),
        ),
        { up: true, label: t("Subagents") },
      )
    },
  })
}

/** The folder of a new agent chat: one of the agent's folders, or Add folder… where there is none. */
function folderChip(roots, value, onChange) {
  if (!roots.length) return chip({ ico: ICONS.folder, label: t("Add folder…"), name: t("Folder"), menuish: false, cls: "cchip--folder is-warn", onclick: () => invoke("remote_add") })
  return chip({
    ico: ICONS.folder,
    label: folderName(value),
    title: `${t("Folder")}: ${value}`,
    cls: "cchip--folder",
    name: t("Folder"),
    onclick: (e) =>
      menu(e.currentTarget, [
        ...roots.map((r) => ({ label: folderName(r), hint: r, checked: r === value, run: () => r !== value && onChange(r) })),
        null,
        { label: t("Add folder…"), run: () => invoke("remote_add") },
      ]),
  })
}

/**
 * Which computer a new agent chat works on: this one (the agent built into this app), or another
 * linked device of the account, as `GET /devices` lists them. Shown only where there is another.
 */
function deviceChip(others) {
  const here = draftHere()
  const current = deviceOf(draftDevice())
  const choose = (id) => {
    if (id === draftDevice()) return
    closeTarget()
    draft.device = id
    const elsewhere = !ctx.thisDevices().includes(id)
    draft.dir = elsewhere ? knownFolders(id)[0] || "" : ""
    renderChips()
    renderHello()
    renderNotice()
  }
  const items = [{ label: t("This computer"), hint: ctx.status()?.host || "", checked: here, run: () => choose(hereDevice() || "") }]
  // A computer's hint is what its name does not already say: one named after its host says the host once.
  const beside = (label, parts) => parts.filter((x) => x && String(x).toLowerCase() !== String(label).toLowerCase()).join(" · ")
  for (const d of others) items.push({ label: d.name || d.host || d.id, hint: beside(d.name || d.host || d.id, [d.host, d.platform]), checked: !here && current?.id === d.id, run: () => choose(d.id) })
  const label = deviceWord()
  return chip({ ico: ICONS.terminal, label, name: t("Computer"), title: `${t("Computer")}: ${label}`, cls: "cchip--device", onclick: (e) => menu(e.currentTarget, items) })
}

/** The computer a new agent chat works on, in a word: this one, or the other's name. */
function deviceWord() {
  const current = deviceOf(draftDevice())
  return draftHere() ? t("This computer") : current?.name || current?.host || t("Another device")
}

// --- Where a new agent chat works: one slim bar above the composer --------------------------------
//
// Computer · folder · mode, as the server's Working notes describe the bar the web interface and
// this app both build ("The agent target bar"): three chips of the header's family on one line,
// each opening its menu upward. The line never scrolls and never cuts a chip off: the mode is
// its words' width, the two names give with an ellipsis (their whole text in the title). Where
// the bar itself is narrow (a container query in app.css, not a measurement) the three are one
// summary chip -- "studio · project · Edit" -- which opens them as a column above it, each with
// its label in front; choosing, or pressing it again, closes them. Only before the chat exists:
// once the first message is sent the three are facts, beside the title and in the settings.

/** A choice was made in the folded bar's column: it closes, back to the one summary chip. */
function closeTarget() {
  $("chat-target").dataset.open = "false"
}

function renderTarget(chips, words) {
  const bar = $("chat-target")
  if (!chips) {
    bar.hidden = true
    bar.dataset.open = "false"
    bar.replaceChildren()
    return
  }
  const open = bar.dataset.open === "true"
  const part = (text, cls = "") => h("span", { class: `target__word ${cls}`, text })
  const dot = () => h("span", { class: "target__dot", "aria-hidden": "true", text: "·" })
  const sum = h(
    "button",
    {
      type: "button",
      class: "cchip target__sum",
      id: "target-sum",
      "aria-expanded": String(open),
      "aria-controls": "target-chips",
      title: words.map((w) => w.text).join(" · "),
      onclick: () => {
        bar.dataset.open = String(bar.dataset.open !== "true")
        sum.setAttribute("aria-expanded", bar.dataset.open)
        if (bar.dataset.open === "true") bar.querySelector(".target__chips button")?.focus()
      },
    },
    icon(ICONS.terminal),
    words.flatMap((w, i) => (i ? [dot(), part(w.text, w.cls)] : [part(w.text, w.cls)])),
    h("span", { class: "cchip__chev" }, icon(ICONS.chevronDown)),
  )
  bar.replaceChildren(sum, h("div", { class: "target__chips", id: "target-chips", role: "group", "aria-label": t("Where the agent works") }, chips))
  bar.hidden = false
}

/** The folder of a new agent chat on another device: one it has worked in, or one typed. */
function elsewhereFolderChip(device, value, onChange) {
  const type = async () => {
    const dir = await ask({ title: t("Folder on %(device)s", { device: deviceOf(device)?.name || t("Another device") }), text: t("The folder's full path on that computer. Its agent opens only folders it has been given."), value: value || "", ok: t("Choose"), cancel: t("Cancel") })
    if (dir) onChange(dir)
  }
  const known = knownFolders(device)
  if (!value && !known.length) return chip({ ico: ICONS.folder, label: t("Choose a folder…"), name: t("Folder"), menuish: false, cls: "cchip--folder is-warn", onclick: type })
  return chip({
    ico: ICONS.folder,
    label: value ? folderName(value) : t("Choose a folder…"),
    title: value ? `${t("Folder")}: ${value}` : "",
    cls: `cchip--folder${value ? "" : " is-warn"}`,
    name: t("Folder"),
    onclick: (e) =>
      menu(e.currentTarget, [
        ...known.map((r) => ({ label: folderName(r), hint: r, checked: r === value, run: () => r !== value && onChange(r) })),
        known.length ? null : undefined,
        { label: t("Type a folder…"), run: type },
      ].filter((x) => x !== undefined)),
  })
}

let chipsDrawn = 0 // which drawing is the latest: an older one's late answers are dropped

/** The chips for what the composer is writing to: a new chat (`draft`) or the open chat. */
async function renderChips() {
  const box = $("chat-settings")
  const message = $("composer-chips")
  const drawing = ++chipsDrawn
  const mayPick = ctx.me()?.permissions?.["chat.model_select"] !== false
  if (draft) {
    const s = ctx.status()
    const models = ctx.models()
    const model = models.find((m) => m.id === draft.model)
    const parts = []
    if (draft.kind === "agent") {
      // Computer, folder and mode: where and how the agent works, in the bar above the composer.
      const where = [deviceChip(otherDevices())]
      if (draftHere()) {
        const roots = s?.remote?.enabled ? s.remote.roots : []
        if (!roots.includes(draft.dir)) draft.dir = roots[0] || ""
        where.push(folderChip(roots, draft.dir, (d) => ((draft.dir = d), closeTarget(), renderChips())))
      } else {
        where.push(elsewhereFolderChip(draftDevice(), draft.dir, (d) => ((draft.dir = d), closeTarget(), renderChips())))
      }
      where.push(modeChip(draft.mode, (m) => ((draft.mode = m), closeTarget(), renderChips())))
      renderTarget(where, [
        { text: deviceWord() },
        { text: draft.dir ? folderName(draft.dir) : draftHere() ? t("Add folder…") : t("Choose a folder…"), cls: draft.dir ? "" : "is-warn" },
        { text: modeName(draft.mode) },
      ])
    } else renderTarget(null)
    $("chat-place").replaceChildren()
    const shell = terminalTarget()
    aimTerminal(shell)
    parts.push(modelChip(models, draft.model, (id) => {
      draft.model = id
      draft.effort = levelsOf(models.find((m) => m.id === id)).start
      renderChips()
    }, mayPick))
    if (model) parts.push(effortChip(model, draft.effort, (l) => ((draft.effort = l), renderChips())))
    if (draft.kind === "chat" && picturesOffered()) message.replaceChildren(pictureChip())
    else {
      wantPicture = false
      message.replaceChildren()
    }
    if (draft.kind === "chat" && teamPossible(model)) parts.push(agentsChip(draft.agents, (a) => ((draft.agents = a), renderChips()), { cap: subagentsCap(), own: namedOnly(model?.subagents) }))
    // An agent chat's subagents run on its device: offered as the server says for that device.
    const device = draft.kind === "agent" ? draftDevice() : ""
    const known = device ? agentFacts.get(device) : null
    const offer = device ? agentOffer(known, model) : null
    if (offer) parts.push(agentsChip(draft.agents, (a) => ((draft.agents = a), renderChips()), offer))
    if (device && (!known || Date.now() - known.at > 5000)) {
      readAgentFacts(device).then((f) => {
        if (f && drawing === chipsDrawn && draft?.kind === "agent") renderChips()
      })
    }
    // The Terminal, as an open chat has it: in the header's tools.
    const terminal = terminalControl()
    $("chat-tools").replaceChildren(...(terminal ? [terminal] : []))
    box.replaceChildren(...parts.filter(Boolean))
    fitHead()
    return
  }
  const chat = open?.chat
  renderTarget(null)
  aimTerminal(terminalTarget())
  if (!chat?.kind) {
    box.replaceChildren()
    message.replaceChildren()
    fitHead()
    return
  }
  const save = async (body) => {
    try {
      const r = await patch(`/chats/${encodeURIComponent(chat.id)}`, body)
      if (open?.chat?.id === chat.id) {
        open.chat = r.chat
        renderChips()
        if (body.model) activityChanged()
      }
      alertIn("")
    } catch (err) {
      alertIn(why(err))
    }
  }
  const models = await chatModels(chat)
  if (drawing !== chipsDrawn || open?.chat?.id !== chat.id) return
  open.models = models // the models this chat may use, as /effort reads its levels
  const current = models.find((m) => m.id === chat.model) || { id: chat.model, name: chat.model, efforts: [] }
  const parts = []
  if (chat.kind === "agent") parts.push(modeChip(chat.mode || "edit", (m) => save({ mode: m })))
  if (chat.model) parts.push(modelChip(models, chat.model, (id) => save({ model: id }), mayPick))
  parts.push(effortChip(current, chat.effort || levelsOf(current).start, (l) => save({ effort: l })))
  if (chat.kind === "chat" && picturesOffered() && !chat.archived) message.replaceChildren(pictureChip())
  else {
    wantPicture = false
    message.replaceChildren()
  }
  box.replaceChildren(...parts.filter(Boolean))
  fitHead()
  const [offer, pages] = await Promise.all([teamOffered(chat), pagesOffered(chat)])
  if (drawing !== chipsDrawn || open?.chat?.id !== chat.id) return
  if (offer) box.append(agentsChip(open.chat.agents || chat.agents, (a) => save({ agents: a }), offer))
  if (pages) box.append(pagesChip(chat, pages))
  if (offer || pages) fitHead()
}

/**
 * Whether this chat is offered pages in its answers, and whether they are on: the server's own
 * word (`GET /chats/{id}/html-pages` -> { offered, on }: the instance's switch and the model's
 * flag, never in an agent chat). Null where it is not offered, or the server has no such route.
 */
async function pagesOffered(chat) {
  if (chat.kind !== "chat" || chat.archived) return null
  try {
    const r = await get(`/chats/${encodeURIComponent(chat.id)}/html-pages`)
    return r?.offered === true ? { on: r.on === true } : null
  } catch {
    return null
  }
}

/** The chat's switch for pages in answers (experimental on the server): said, and switched by a press. */
function pagesChip(chat, state) {
  const words = t("Pages in answers")
  return chip({
    ico: ICONS.fileCode,
    label: `${words}: ${state.on ? t("on") : t("off")}`,
    title: t("The model may add a page to an answer: a table, a chart or a layout, shown in a sealed frame. Experimental."),
    cls: `cchip--pages${state.on ? "" : " is-dim"}`,
    menuish: false,
    onclick: async () => {
      try {
        await post(`/chats/${encodeURIComponent(chat.id)}/html-pages`, { on: !state.on })
        alertIn("")
      } catch (err) {
        alertIn(why(err))
      }
      if (open?.chat?.id === chat.id) renderChips()
    },
  })
}

/**
 * Above the composer, what stands in the way of an agent chat on this computer: not linked, the
 * server refused the link, no folder. A new agent chat says it; an open one on this computer too.
 */
function renderNotice() {
  const box = $("link-notice")
  const s = ctx.status()
  const wants = draft ? draft.kind === "agent" && draftHere() : open?.chat?.kind === "agent" && onThisComputer(open.chat)
  const show = !!s && wants && !agentReady(s) && agentState(s).tone !== "busy"
  box.hidden = !show
  if (show) box.replaceChildren(agentBlock(s, { compact: !draft }))
  else box.replaceChildren()
}

/** The app's status changed (the agent, its folders): what depends on it is drawn again. */
export function statusChanged() {
  renderNotice()
  if (draft) {
    renderChips()
    renderHello()
  } else if (open?.chat?.kind) {
    // The devices were read again: whether this chat's opens a terminal may have changed.
    renderHead(open.chat)
    aimTerminal(terminalTarget())
  }
}

/** The chat's own menu, under its ⋯ button or a row of the sidebar: `chat` as the list has it. */
export function chatMenu(anchor, chat) {
  const base = ctx.status()?.server
  const mayDelete = ctx.me()?.permissions?.["chat.delete"] !== false
  const items = [{ label: t("Rename…"), run: () => renameChat(chat) }]
  if (!chat.archived) {
    items.push({ label: chat.pinned ? t("Unpin chat") : t("Pin chat"), run: () => setChat(chat, { pinned: !chat.pinned }) })
    items.push({ label: t("Move to folder…"), run: () => moveMenu(anchor, chat) })
  }
  if (!chat.archived) items.push({ label: t("Tools and skills…"), run: () => scopePopover(anchor, chat) })
  if (chat.kind === "agent" && chat.device_session_id) items.push({ label: t("Continue in a terminal…"), run: () => continueInTerminal(chat) })
  if (base) items.push({ label: t("Open in the web interface"), run: () => openLink(`${base}/chat/${encodeURIComponent(chat.id)}`) })
  items.push(null, chat.archived ? { label: t("Restore chat"), run: () => unarchiveChat(chat) } : { label: t("Archive chat"), run: () => archiveChat(chat) })
  if (mayDelete) items.push({ label: t("Delete chat"), danger: true, run: () => deleteChat(chat) })
  menu(anchor, items)
}

/**
 * Continue an agent chat in a terminal: the CLI's own session on the device it works on
 * (`device_session_id`), opened with `lembas -s <id>` in the chat's folder. Shown to copy rather
 * than run: a terminal is not something every desktop opens the same way, and the command is the
 * person's to run where they want it. On this computer the first word is the CLI as it is
 * started here (`lembas` on PATH, else the app's own copy by its path).
 */
export async function continueInTerminal(chat) {
  const session = String(chat.device_session_id || "")
  if (!/^[A-Za-z0-9_-]+$/.test(session)) return
  const here = onThisComputer(chat)
  let word = "lembas"
  if (here) word = await invoke("terminal_word").catch(() => "lembas")
  const dir = chat.device?.directory || ""
  const quoted = /^[A-Za-z0-9/._+:@%=-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, "'\\''")}'`
  const code = `${dir ? `cd ${quoted} && ` : ""}${word} -s ${session}`
  await showLine({
    title: t("Continue in a terminal"),
    text: here
      ? t("Run this in a terminal: the agent's session goes on there, in this chat's folder, and the chat keeps it.")
      : t("Run this in a terminal on the computer this chat works on: the agent's session goes on there, and the chat keeps it."),
    code,
    copy: t("Copy"),
    copied: t("Copied"),
    close: t("Close"),
  })
}

/** Where a chat can go: no folder, any of the account's, or a new one. */
function moveMenu(anchor, chat) {
  const here = chat.folder_id || ""
  menu(anchor, [
    { label: t("No folder"), checked: !here, run: () => here && setChat(chat, { folder_id: null }) },
    ...folderTree().map(({ folder, depth }) => ({ label: `${"\u2003".repeat(depth)}${folder.name}`, checked: folder.id === here, run: () => folder.id !== here && setChat(chat, { folder_id: folder.id }) })),
    null,
    {
      label: t("New folder…"),
      run: async () => {
        const id = await newFolder()
        if (id) setChat(chat, { folder_id: id })
      },
    },
  ])
}

/** A change to a chat from its menu (pinned, its folder): the list drawn again from the server. */
async function setChat(chat, body) {
  try {
    const r = await patch(`/chats/${encodeURIComponent(chat.id)}`, body)
    if (open?.chat?.id === chat.id && r?.chat) open.chat = r.chat
    ctx.changed(r?.chat)
  } catch (err) {
    alertIn(why(err))
  }
}

async function renameChat(chat) {
  const title = await ask({ title: t("Rename chat"), value: chat.title || "", ok: t("Rename"), cancel: t("Cancel") })
  if (!title || title === chat.title) return
  try {
    const r = await patch(`/chats/${encodeURIComponent(chat.id)}`, { title })
    if (open?.chat?.id === chat.id) {
      open.chat = r.chat
      setTitle(r.chat.title)
    }
    ctx.changed(r.chat)
  } catch (err) {
    alertIn(why(err))
  }
}

async function archiveChat(chat) {
  try {
    await patch(`/chats/${encodeURIComponent(chat.id)}`, { archived: true })
    ctx.gone(chat)
  } catch (err) {
    alertIn(why(err))
  }
}

/** An archived chat, open or in its page's menu, back into the sidebar. */
async function unarchiveChat(chat) {
  if (!(await unarchive(chat))) return
  if (open?.chat?.id === chat.id) {
    open.chat = { ...open.chat, archived: false }
    renderHead(open.chat)
  }
}

async function deleteChat(chat) {
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
    ctx.gone(chat)
  } catch (err) {
    alertIn(why(err))
  }
}

function modeName(m) {
  return { manual: "Manual", edit: "Edit", auto: "Auto", plan: "Plan" }[m] || m
}

let noteTimer = 0

/** A line above the composer: something that went wrong (it stays), or `info` (it goes by itself). */
function alertIn(text, info = false) {
  const box = $("thread-note")
  clearTimeout(noteTimer)
  box.textContent = text
  box.hidden = !text
  box.classList.toggle("is-error", !info)
  box.classList.toggle("is-info", info)
  if (text && info) noteTimer = setTimeout(() => box.classList.contains("is-info") && alertIn(""), 6000)
}
const note = (text) => alertIn(text, true)

/** Open a chat by id: its newest page, and the reply being written, if one is. */
export async function openChat(id) {
  if (open?.chat?.id !== id) discard()
  if (open?.live) open.live.stop()
  if (open?.chat?.id !== id) pythonFor(null)
  open = { chat: { id }, live: null, more: false }
  draft = null
  closePopover()
  closeComposerMenu()
  invoke("set_open_chat", { chat: id })
  showComposer(true)
  $("new-chat").hidden = true
  $("main").dataset.new = "false"
  clear($("composer-chips"))
  renderNotice()
  const list = clear($("messages"))
  renderCards({ id }, [])
  alertIn("")
  list.append(h("p", { class: "muted thread__loading", text: t("Loading…") }))
  let r
  try {
    r = await get(`/chats/${encodeURIComponent(id)}`)
  } catch (err) {
    clear(list)
    alertIn(why(err))
    return
  }
  if (open?.chat?.id !== id) return
  open.chat = r.chat
  open.more = r.more
  // This window is the chat's page for the `python` tool (a chat on the server, Python on there).
  pythonFor(r.chat)
  watchActivity(r.chat)
  renderHead(r.chat)
  renderChips()
  renderNotice()
  clear(list)
  if (r.more) list.append(earlier())
  for (const m of r.messages) {
    if (m.id === r.live) continue
    // A report's conversation opens with a line the server wrote in the person's place (so the
    // report can be the first thing said): not theirs, and not shown.
    if (r.chat.kind === "report" && m.role === "user" && m.machine) continue
    list.append(m.role === "user" ? userMessage(m) : assistantMessage(m, r.chat))
  }
  ctx.opened(r.chat)
  if (r.live) follower(r.chat, r.live)
  else setRunning(false)
  toBottom(true)
  $("composer-text").focus()
}

function earlier() {
  return h("button", {
    type: "button",
    class: "btn btn--sm thread__earlier",
    text: t("Earlier messages"),
    onclick: async (e) => {
      const first = $("messages").querySelector(".msg")?.dataset.id
      if (!first || !open) return
      e.target.disabled = true
      try {
        const r = await get(`/chats/${encodeURIComponent(open.chat.id)}/messages?before=${encodeURIComponent(first)}`)
        const th = $("thread")
        const from = th.scrollHeight
        const frag = document.createDocumentFragment()
        if (r.more) frag.append(earlier())
        for (const m of r.messages) frag.append(m.role === "user" ? userMessage(m) : assistantMessage(m, open.chat))
        e.target.replaceWith(frag)
        th.scrollTop += th.scrollHeight - from
      } catch (err) {
        e.target.disabled = false
        alertIn(why(err))
      }
    },
  })
}

function reload() {
  if (open?.chat?.id) openChat(open.chat.id)
}

export function closeChat() {
  if (open?.live) open.live.stop()
  open = null
  pythonFor(null)
  watchActivity(null)
  invoke("set_open_chat", { chat: null })
}


// --- A new chat ------------------------------------------------------------------------------------

let draft = null // { kind, device, dir, mode, model, effort, agents } while a new chat is being written
let lastKind = "agent"

/** The kind a new chat starts as: the last one chosen (an agent chat, at first). */
export function draftKind() {
  return draft?.kind || lastKind
}

/** `/models` was read again: a new chat being written is drawn with what it says now. */
export function modelsChanged() {
  if (!draft) return
  const models = ctx.models()
  if (!models.some((m) => m.id === draft.model)) {
    const start = models.find((m) => m.default) || models[0]
    draft.model = start?.id || ""
    draft.effort = levelsOf(start).start
  }
  renderChips()
}

/** The greeting of a new chat, and the choice of what it is. */
function renderHello() {
  const box = $("new-chat")
  if (!draft) return
  const me = ctx.me()
  const first = String(me?.name || "").trim().split(/\s+/)[0]
  const kind = draft.kind
  const s = ctx.status()
  const server = (() => {
    try {
      return new URL(s?.server || "").host
    } catch {
      return ""
    }
  })()
  const tab = (k, ico, label) =>
    h(
      "button",
      {
        type: "button",
        role: "tab",
        class: "kind__tab",
        "aria-selected": String(kind === k),
        onclick: () => {
          if (draft.kind === k) return
          draft.kind = lastKind = k
          renderHello()
          renderChips()
          renderNotice()
          ctx.drafted?.(k)
          $("composer-text").focus()
        },
      },
      icon(ico),
      h("span", { text: label }),
    )
  box.replaceChildren(
    h("img", { class: "hello__mark", src: "logo-mark.svg", alt: "", width: "40", height: "40" }),
    h("h2", { class: "hello__title", text: first ? t("Hello, %(name)s", { name: first }) : t("Hello") }),
    h(
      "p",
      { class: "hello__sub" },
      kind === "agent" && !draftHere()
        ? t("An agent chat works in a folder on %(device)s, through the LLeMbas agent there.", { device: deviceOf(draftDevice())?.name || t("Another device") })
        : kind === "agent"
        ? t("An agent chat works in a folder on this computer, through the agent built into this app.")
        : t("A chat on %(server)s, with your account's models and files.", { server: server || t("Server") }),
    ),
    h("div", { class: "kind", role: "tablist", "aria-label": t("New chat") }, tab("agent", ICONS.terminal, t("Agent")), tab("chat", ICONS.chat, t("Chat"))),
  )
}

/** A new chat in the main view: the page empty, the greeting, and the composer ready. */
export function newChat(kind) {
  closeChat()
  discard()
  closePopover()
  const models = ctx.models()
  const start = models.find((m) => m.default) || models[0]
  lastKind = kind || lastKind
  draft = { kind: lastKind, device: "", dir: "", mode: "edit", model: start?.id || "", effort: levelsOf(start).start, agents: null }
  clear($("messages"))
  renderCards({ id: "" }, [])
  alertIn("")
  setTitle(t("New chat"))
  clear($("chat-place"))
  clear($("chat-tools"))
  $("main").dataset.new = "true"
  $("new-chat").hidden = false
  renderHello()
  renderChips()
  renderNotice()
  showComposer(true)
  setRunning(false)
  invoke("set_open_chat", { chat: null })
  $("composer-text").focus()
}

async function createChat(text, attachments) {
  const body = { text }
  if (attachments.length) body.attachments = attachments
  if (draft.model) body.model = draft.model
  if (typeof draft.effort === "string" && draft.effort) body.effort = draft.effort
  const agents = draft.agents
  if (agents && (agents.min || agents.max)) body.agents = agents
  if (draft.temporary && draft.kind === "chat") body.temporary = true
  if (draft.kind === "agent") {
    const device = draftDevice()
    if (draftHere()) {
      if (!device || !agentReady(ctx.status())) {
        renderNotice()
        throw { detail: agentState(ctx.status()).sentence }
      }
      if (!draft.dir) throw { detail: t("No folder yet: add one under Settings, Project folders.") }
    } else {
      if (!deviceOf(device)) throw { detail: t("This device is not linked right now.") }
      if (!draft.dir) throw { detail: t("Choose a folder first.") }
    }
    Object.assign(body, { kind: "agent", device, directory: draft.dir, mode: draft.mode || "edit" })
  }
  const r = await post("/chats", draft.kind === "chat" ? takePicture(body) : body)
  pictureSent()
  draft = null
  $("new-chat").hidden = true
  $("main").dataset.new = "false"
  open = { chat: r.chat, live: null, more: false }
  invoke("set_open_chat", { chat: r.chat.id })
  pythonFor(r.chat)
  watchActivity(r.chat)
  renderHead(r.chat)
  renderChips()
  renderNotice()
  clear($("messages"))
  if (r.message) $("messages").append(userMessage(r.message))
  ctx.changed(r.chat)
  ctx.opened(r.chat)
  if (r.reply) follower(r.chat, r.reply.id)
}

// --- The composer ------------------------------------------------------------------------------------

function showComposer(on) {
  $("composer").hidden = !on
}

async function submit() {
  const box = $("composer-text")
  const text = box.value.trim()
  closeComposerMenu()
  // One of the app's own commands, sent with the button rather than Enter: run, never posted.
  const command = commandIn(box.value)
  if (command) {
    box.value = ""
    grow()
    slashCommands().find((c) => c.name === command.name)?.run(command.rest)
    return
  }
  if (sending()) {
    alertIn(t("Wait until the files are sent."))
    return
  }
  const files = readyIds()
  if (!text && !files.length) return
  $("send").disabled = true
  alertIn("")
  try {
    if (draft) await createChat(text, files)
    else if (open?.chat?.id) {
      let body = { text }
      if (files.length) body.attachments = files
      if (open.chat.kind === "chat") body = takePicture(body)
      const r = await post(`/chats/${encodeURIComponent(open.chat.id)}/messages`, body)
      pictureSent()
      if (r.message) $("messages").append(userMessage(r.message))
      if (r.reply) follower(open.chat, r.reply.id)
    } else return
    sent()
    box.value = ""
    grow()
    toBottom(true)
  } catch (err) {
    alertIn(why(err))
  } finally {
    $("send").disabled = false
    setRunning(!!open?.live)
  }
}

// --- The composer's commands: the web's set, each wired to what this app has ------------------------
//
// `when` says whether a command makes sense now; one that does not is not a command at all -- it
// is neither listed nor taken, and what was typed is sent as the message it is. `run(rest)` gets
// what follows the name. The device's own commands (an agent chat) are slash.js's: they are
// sent as the literal message.

const chatId = () => (draft ? "" : open?.chat?.id || "")
const isAgent = () => (draft ? draft.kind === "agent" : open?.chat?.kind === "agent")
const chatModel = () => {
  const id = draft ? draft.model : open?.chat?.model
  return (open?.models || []).find((m) => m.id === id) || ctx.models().find((m) => m.id === id) || (id ? { id, name: id, efforts: [] } : null)
}

async function saveChat(body, done) {
  const chat = open?.chat
  if (!chat?.id) return
  try {
    const r = await patch(`/chats/${encodeURIComponent(chat.id)}`, body)
    if (open?.chat?.id === chat.id && r?.chat) {
      open.chat = r.chat
      setTitle(r.chat.title)
      renderChips()
    }
    ctx.changed(r?.chat)
    if (done) note(done)
  } catch (err) {
    alertIn(why(err))
  }
}

function setEffort(rest) {
  const model = chatModel()
  const { levels, control } = levelsOf(model)
  if (!model || control === "none") return alertIn(t("This model offers no choice of effort. An administrator sets what it takes on the model's page."))
  const current = draft ? draft.effort : open?.chat?.effort || levelsOf(model).start
  let wanted = rest.trim().toLowerCase()
  const listed = levels.join(", ")
  if (!wanted) return note(t("Effort is %(level)s. /effort %(levels)s.", { level: current, levels: listed }))
  // Words fingers will type: "none" is off, and "on" the first level that is not off.
  if (wanted === "none") wanted = "off"
  else if (wanted === "on") wanted = levels.find((l) => l !== "off") || wanted
  if (!levels.includes(wanted)) return alertIn(t("“%(level)s” is not a level this model offers. Try %(levels)s.", { level: wanted, levels: listed }))
  const said = wanted === "off" ? t("Thinking switched off.") : t("Effort set to %(level)s.", { level: wanted })
  if (draft) {
    draft.effort = wanted
    renderChips()
    note(said)
  } else saveChat({ effort: wanted }, said)
}

function setMode(rest) {
  const wanted = rest.trim().toLowerCase()
  if (!wanted) return note(t("Modes: manual, edit, auto, plan."))
  if (!MODES.includes(wanted)) return alertIn(t("“%(mode)s” is not a mode.", { mode: wanted }))
  const said = t("Mode set to %(mode)s.", { mode: modeName(wanted) })
  if (draft) {
    draft.mode = wanted
    renderChips()
    note(said)
  } else saveChat({ mode: wanted }, said)
}

async function compactNow() {
  const id = chatId()
  if (!id) return
  const yes = await ask({
    title: t("Compact this chat"),
    text: t("Summarise everything before the last reply? The messages stay in the transcript; they just stop being sent to the model."),
    ok: t("Compact"),
    cancel: t("Cancel"),
  })
  if (!yes) return
  note(t("Summarising the earlier messages…"))
  try {
    await post(`/chats/${encodeURIComponent(id)}/compact`)
    alertIn("")
    if (openChatId() === id) reload()
    activityChanged()
  } catch (err) {
    alertIn(why(err))
  }
}

async function continueReply() {
  const id = chatId()
  if (!id || !$("messages").querySelector(".msg--assistant")) return note(t("There is no reply to continue yet."))
  try {
    const r = await post(`/chats/${encodeURIComponent(id)}/continue`)
    if (openChatId() !== id) return
    if (r.message) $("messages").append(userMessage(r.message))
    if (r.reply) follower(open.chat, r.reply.id)
    toBottom(true)
  } catch (err) {
    alertIn(why(err))
  }
}

function drawPicture(rest) {
  const wanted = rest.trim()
  if (!wanted) return note(t("Say what to draw: /image a red bicycle in the rain."))
  wantPicture = true
  $("composer-text").value = wanted
  submit()
}

function themeNames() {
  const offered = accountThemes()
  return offered ? offered.map((x) => (typeof x === "string" ? x : x.id || x.name || x.value)).filter(Boolean) : ["moria", "shire"]
}

async function setTheme(rest) {
  const names = themeNames()
  const wanted = rest.trim().toLowerCase()
  const now = document.documentElement.dataset.theme
  // A name the server offers, else the other of the two looks.
  const next = names.includes(wanted) ? wanted : names[(names.indexOf(accountThemes() ? accountTheme() : now) + 1) % names.length]
  try {
    await chooseTheme(next)
  } catch (err) {
    alertIn(why(err))
  }
}

/** Commands and keyboard shortcuts, as a sheet. Everything in it is text. */
function helpSheet() {
  const row = (a, b) => h("tr", null, h("td", { class: "sheet__key", text: a }), h("td", { text: b }))
  const keys = [
    ["Ctrl + K", t("Search chats, files and commands")],
    ["Ctrl + N", t("New chat")],
    ["Ctrl + B", t("Sidebar")],
    ["Ctrl + ,", t("Settings")],
    ["Enter", t("Send")],
    ["Shift + Enter", t("A new line")],
    ["/", t("Open the command menu")],
    ["@", t("Mention a file, or attach one")],
    ["Esc", t("Close what is open")],
  ]
  const close = h("button", { type: "button", class: "btn btn--primary", text: t("Close") })
  const dlg = h(
    "dialog",
    { class: "dialog dialog--wide", "aria-label": t("Commands and shortcuts") },
    h(
      "div",
      { class: "dialog__body" },
      h("h2", { class: "dialog__title", text: t("Commands and shortcuts") }),
      h("div", { class: "sheet__scroll" }, h("table", { class: "sheet" }, h("tbody", null, commandTable().map((c) => row(`/${c.name}${c.argument ? ` ${c.argument}` : ""}`, c.summary)))), h("h3", { class: "sheet__title", text: t("Keyboard") }), h("table", { class: "sheet" }, h("tbody", null, keys.map(([a, b]) => row(a, b))))),
      h("p", { class: "muted", text: t("A message that starts with a slash but is not a command is sent as written.") }),
      h("div", { class: "dialog__actions" }, close),
    ),
  )
  const done = () => {
    dlg.close()
    dlg.remove()
    $("composer-text").focus()
  }
  close.addEventListener("click", done)
  dlg.addEventListener("cancel", (e) => (e.preventDefault(), done()))
  dlg.addEventListener("click", (e) => e.target === dlg && done())
  document.body.append(dlg)
  dlg.showModal()
  close.focus()
}

function slashCommands() {
  const nav = ctx.nav || {}
  return [
    { name: "help", summary: t("Commands and keyboard shortcuts"), run: helpSheet },
    { name: "usage", summary: t("Tokens and context used by this chat"), when: () => !!chatId(), run: () => showPanel(true) },
    { name: "compact", summary: t("Summarise the earlier turns so they stop costing context"), when: () => !!chatId() && !!$("messages").querySelector(".msg"), run: compactNow },
    { name: "effort", summary: t("How hard a reasoning model should think"), argument: () => levelsOf(chatModel()).levels.join(" | ") || "low | medium | high | off", when: () => !!chatModel(), run: setEffort },
    { name: "mode", summary: t("Approval mode: manual, edit, auto or plan"), argument: "manual | edit | auto | plan", when: isAgent, run: setMode },
    {
      name: "title",
      summary: t("Rename this chat"),
      argument: t("the new title"),
      when: () => !!chatId(),
      run: (rest) => (rest.trim() ? saveChat({ title: rest.trim() }, t("Renamed.")) : note(t("Give it a title: /title Something."))),
    },
    { name: "terminal", summary: t("Show or hide the terminal"), when: () => !!terminalTarget(), run: () => toggleTerminal() },
    { name: "activity", summary: t("Show or hide the activity panel"), when: () => !!chatId(), run: () => showPanel(!panelOpen()) },
    { name: "sidebar", summary: t("Show or hide the sidebar"), when: () => !!nav.sidebar, run: () => nav.sidebar() },
    { name: "theme", summary: t("Switch theme"), argument: () => themeNames().join(" | "), run: setTheme },
    { name: "image", summary: t("Draw a picture"), argument: t("what to draw"), when: () => !isAgent() && picturesOffered() && !open?.chat?.archived, run: drawPicture },
    { name: "new", summary: t("Start a new chat"), when: () => !!nav.startNew, run: () => nav.startNew() },
    {
      name: "temp",
      summary: t("Start a temporary chat that saves nothing"),
      when: () => !!nav.startNew,
      run: () => {
        nav.startNew("chat")
        if (draft) draft.temporary = true
        setTitle(t("Temporary chat"))
        note(t("A temporary chat: nothing of it is kept once it is closed."))
      },
    },
    { name: "continue", summary: t("Carry on from where the reply stopped"), when: () => !!chatId() && !open?.live, run: continueReply },
    { name: "stop", summary: t("Stop the reply being written"), run: () => (open?.live ? $("stop").click() : note(t("Nothing is being written."))) },
    { name: "devices", summary: t("Your devices: the LLeMbas CLI signed in as you"), when: () => !!nav.settings, run: () => nav.settings("agent") },
    { name: "scheduled", summary: t("Your scheduled tasks"), when: () => !!nav.scheduled, run: () => nav.scheduled() },
  ]
}

/** What slash.js needs to know of the page: where the composer writes to, and how to act on it. */
function menuContext() {
  return {
    commands: slashCommands,
    where: () => {
      if (draft) {
        const device = draft.kind === "agent" ? draftDevice() : ""
        return { chat: "", device, cwd: device ? draft.dir || "" : "", deviceName: device ? deviceWord() : "", model: draft.model || "" }
      }
      const chat = open?.chat
      const device = chat?.kind === "agent" ? chat.device?.token_id || "" : ""
      return { chat: chat?.id || "", device, cwd: device ? chat.device.directory || "" : "", deviceName: device ? deviceOf(device)?.name || (onThisComputer(chat) ? t("This computer") : "") : "" }
    },
    send: (text) => {
      $("composer-text").value = text
      submit()
    },
    changed: () => {
      grow()
      if (open?.live) $("send").hidden = !$("composer-text").value.trim()
    },
  }
}

function grow() {
  const box = $("composer-text")
  box.style.height = "auto"
  box.style.height = `${Math.min(box.scrollHeight, window.innerHeight * 0.4)}px`
}

export function initChat(context) {
  ctx = context
  $("send").replaceChildren(icon(ICONS.send))
  $("stop").replaceChildren(icon(ICONS.stop))
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault()
    submit()
  })
  $("composer-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  })
  $("composer-text").addEventListener("input", () => {
    grow()
    if (open?.live) $("send").hidden = !$("composer-text").value.trim()
  })
  $("stop").addEventListener("click", async () => {
    const live = open?.live
    if (!live) return
    try {
      await api("POST", `/chats/${encodeURIComponent(live.chat.id)}/messages/${encodeURIComponent(live.id)}/stop`)
    } catch (err) {
      alertIn(why(err))
    }
  })
  onAgentChange(renderNotice)
  initSlash(menuContext())
  initHead()
  showComposer(false)
}
