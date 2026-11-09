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
import { avatar, agentsControl, teamPossible, namedOnly, subagentsCap, SUBAGENTS_HINT, SUBAGENTS_OWN, levelsOf, levelWord, picture } from "./models.js"
import { readyIds, sending, sent, discard } from "./attach.js"
import { watchActivity, activityChanged, planList, activityButton } from "./activity.js"
import { agentBlock, agentReady, agentState, onAgentChange } from "./agent.js"
import { folderName } from "./list.js"

const MODES = ["manual", "edit", "auto", "plan"]

let ctx = null // set by initChat: { status(), thisDevices(), models(), me(), changed(chat), opened(chat), gone(chat) }
let open = null // { chat, live, more, first }

export function openChatId() {
  return open?.chat?.id || null
}

// --- Reading -----------------------------------------------------------------------------------

export function onThisComputer(chat) {
  return !!chat?.device && ctx.thisDevices().includes(chat.device.token_id)
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
  if (x.total_tokens) parts.push(t("%(n)s tokens", { n: x.total_tokens.toLocaleString() }))
  if (x.tok_s) parts.push(`${x.tok_s} tok/s`)
  if (x.elapsed_ms) parts.push(`${(x.elapsed_ms / 1000).toFixed(1)} s`)
  if (x.context_limit && x.percent !== undefined) parts.push(`${x.percent} % ctx`)
  return parts.length ? h("p", { class: "msg__metrics", text: parts.join(" · ") }) : null
}

function assistantMessage(m, chat) {
  const el = h("article", { class: "msg msg--assistant", dataset: { id: m.id } })
  const steps = h("div", { class: "msg__steps" })
  renderSteps(steps, m.steps || [], chat)
  el.append(steps)
  if (m.error) el.append(h("p", { class: "msg__note is-error", text: m.error }))
  if (m.stopped) el.append(h("p", { class: "msg__note", text: t("Stopped.") }))
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
        // Only the last reply: CSS shows it there and nowhere else (app.css, .msg__regen).
        action(ICONS.refresh, t("Regenerate reply"), () => regenerate(m), "msg__regen"),
      ),
      model ? h("span", { class: "msg__model", title: model.id }, avatar(model), h("span", { text: model.name })) : null,
      meta,
    ),
  )
  return el
}

function renderSteps(box, steps, chat) {
  clear(box)
  for (const s of steps) box.append(step(s, chat))
}

function step(s, chat) {
  switch (s.kind) {
    case "thinking":
      return h(
        "details",
        { class: "step step--thinking", open: s.open || null },
        h("summary", { class: "step__row" }, h("span", { class: "step__icon" }, icon(ICONS.bulb)), h("span", { class: "step__label" }, t("Thought"), s.label ? h("span", { class: "step__meta", text: ` · ${s.label}` }) : null), h("span", { class: "step__chev" }, icon(ICONS.chevron))),
        h("div", { class: "step__pre", text: s.text || "" }),
      )
    case "text":
      return h("div", { class: "step step--text md" }, markdown(s.markdown || ""))
    case "tools":
      return h("div", { class: "step step--tools" }, (s.calls || []).map((c) => toolCall(c, chat)))
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

function toolCall(c, chat) {
  const block = c.block || {}
  const failed = c.status === "error" || !!c.error
  const body = h("div", { class: "call__body" })
  if (c.purpose) body.append(h("p", { class: "muted", text: c.purpose }))
  if (c.args?.command) body.append(h("pre", { class: "call__pre", text: c.args.command }))
  if (c.diff) body.append(h("pre", { class: "call__pre call__diff", text: typeof c.diff === "string" ? c.diff : JSON.stringify(c.diff, null, 2) }))
  if (c.text) body.append(h("pre", { class: "call__pre", text: c.text }))
  if (c.error) body.append(h("p", { class: "msg__note is-error", text: typeof c.error === "string" ? c.error : JSON.stringify(c.error) }))
  if (c.truncated) body.append(h("p", { class: "muted", text: t("Cut short here; the whole of it is in the web interface.") }))
  const isShow = c.name === "show" && !failed && shownSource(c, chat)
  const summary = h(
    "summary",
    { class: "call__head" },
    h("span", { class: `dot${failed ? " is-error" : c.status === "running" ? " is-busy" : " is-ok"}`, "aria-hidden": "true" }),
    h("span", { class: "call__name", text: c.name || "" }),
    h("span", { class: "call__title", title: block.title || c.name, text: block.title && block.title !== c.name ? block.title : "" }),
    h("span", { class: "call__chips" }, (block.chips || []).map((x) => h("span", { class: "chip", text: x }))),
    h("span", { class: "step__chev" }, icon(ICONS.chevron)),
  )
  const el = h("details", { class: `call${failed ? " is-failed" : ""}` }, summary, body)
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
    this.el = h("article", { class: "msg msg--assistant is-live", dataset: { id: messageId } }, this.steps, this.thinking, this.tail, this.jobs, this.status)
    this.done = false
    this.handle = null
  }

  async start() {
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
    this.handle?.close()
  }

  frame(event, data) {
    if (this.done) return
    switch (event) {
      case "steps":
        renderSteps(this.steps, data.steps || [], this.chat)
        this.tailed(data.tail)
        break
      case "tail":
        this.tailed(data)
        break
      case "status":
        this.status.textContent = data.text || t("Writing…")
        break
      case "ask":
        renderCards(this.chat, data.cards || [])
        break
      case "jobs":
        this.jobs.hidden = !(data.jobs || []).length
        append(
          clear(this.jobs),
          (data.jobs || []).map((j) =>
            h("li", { class: `job job--${j.state}` }, h("span", { class: "chip", text: j.state }), h("span", { text: j.description || j.command || j.agent || "" })),
          ),
        )
        break
      case "steered":
        for (const id of data.ids || []) document.querySelector(`.msg--user[data-id="${CSS.escape(id)}"]`)?.classList.remove("is-queued")
        break
      case "done":
        this.done = true
        this.el.replaceWith(assistantMessage(data.message, this.chat))
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

  tailed(tail) {
    if (!tail) return
    this.thinking.textContent = tail.thinking ? `${t("Thinking")} ${tail.label || ""}…` : ""
    this.thinking.hidden = !tail.thinking
    clear(this.tail).append(markdown(tail.text || ""))
  }

  end(err) {
    if (this.done) return
    this.done = true
    if (open?.live === this) open.live = null
    setRunning(false)
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

function renderCards(chat, cards) {
  const box = clear($("cards"))
  box.hidden = !cards.length
  for (const card of cards) box.append(cardOf(chat, card))
}

function cardOf(chat, card) {
  const answers = { choices: {}, texts: {} }
  const decides = card.items.some((i) => i.kind === "approval" || i.kind === "plan")
  const el = h("section", { class: `ask ask--${card.kind}`, "aria-label": t("Waiting for your answer") })
  if (card.why) el.append(h("p", { class: "muted", text: card.why }))
  for (const item of card.items) {
    const part = h("div", { class: "ask__item" })
    if (item.header) part.append(h("p", { class: "ask__header", text: item.header }))
    if (item.kind === "approval") {
      part.append(h("p", { class: "ask__title", text: item.tool ? t("The agent asks to run %(tool)s:", { tool: item.tool }) : t("The agent asks:") }))
      if (item.editable) {
        const edit = h("textarea", { class: "ask__edit", rows: "2", "aria-label": t("Command"), value: item.title })
        edit.addEventListener("input", () => {
          if (edit.value !== item.title) answers.texts[item.key] = edit.value
          else delete answers.texts[item.key]
        })
        part.append(edit)
      } else part.append(h("pre", { class: "call__pre", text: item.title }))
    } else if (item.kind === "plan" && item.plan) {
      part.append(h("p", { class: "ask__title", text: item.plan.title || item.title }), planList(item.plan))
    } else {
      part.append(h("p", { class: "ask__title", text: item.title }))
    }
    if (item.detail) part.append(h("p", { class: "muted", text: item.detail }))
    if (item.purpose) part.append(h("p", { class: "muted", text: item.purpose }))
    if (item.options?.length) {
      const picked = new Set()
      const opts = h("div", { class: "ask__options", role: item.multiple ? "group" : "radiogroup" })
      for (const o of item.options) {
        const b = h(
          "button",
          { type: "button", class: "opt", "aria-pressed": "false" },
          h("span", { class: "opt__label", text: o.label }),
          o.description ? h("span", { class: "opt__desc", text: o.description }) : null,
          o.recommended ? h("span", { class: "chip", text: t("Recommended") }) : null,
        )
        b.addEventListener("click", () => {
          if (!item.multiple) {
            picked.clear()
            for (const x of opts.children) x.setAttribute("aria-pressed", "false")
          }
          if (picked.has(o.label)) picked.delete(o.label)
          else picked.add(o.label)
          b.setAttribute("aria-pressed", String(picked.has(o.label)))
          answers.choices[item.key] = [...picked]
        })
        opts.append(b)
      }
      part.append(opts)
    }
    if (item.free_text && item.kind === "question") {
      const typed = h("input", { type: "text", class: "ask__text", placeholder: t("Or type an answer"), "aria-label": t("Your answer") })
      typed.addEventListener("input", () => {
        answers.texts[item.key] = typed.value
      })
      part.append(typed)
    }
    el.append(part)
  }
  const said = h("p", { class: "ask__said", "aria-live": "polite" })
  const send = async (verdict) => {
    for (const b of el.querySelectorAll(".ask__actions button")) b.disabled = true
    try {
      await post(`/chats/${encodeURIComponent(chat.id)}/interactions/${encodeURIComponent(card.id)}`, {
        verdict,
        choices: answers.choices,
        texts: answers.texts,
      })
      el.remove()
      if (!$("cards").children.length) $("cards").hidden = true
    } catch (err) {
      if (err?.status === 409) {
        el.remove()
        reload()
        return
      }
      said.textContent = why(err)
      for (const b of el.querySelectorAll(".ask__actions button")) b.disabled = false
    }
  }
  const actions = h("div", { class: "ask__actions" })
  if (decides) {
    const isPlan = card.items.some((i) => i.kind === "plan")
    append(
      actions,
      h("button", { type: "button", class: "btn btn--primary", text: isPlan ? t("Carry it out") : t("Allow"), onclick: () => send("allow") }),
      isPlan ? null : h("button", { type: "button", class: "btn", text: t("Always allow"), onclick: () => send("allow_always") }),
      h("button", { type: "button", class: "btn", text: isPlan ? t("Not yet") : t("Deny"), onclick: () => send("deny") }),
    )
  } else {
    actions.append(h("button", { type: "button", class: "btn btn--primary", text: t("Answer"), onclick: () => send("") }))
  }
  el.append(actions, said)
  return el
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
    if (chat.device_session_id) {
      tools.append(
        h(
          "button",
          { type: "button", class: "tool", "aria-label": t("Continue in a terminal"), title: t("Continue in a terminal"), onclick: () => continueInTerminal(open?.chat || chat) },
          icon(ICONS.terminal),
        ),
      )
    }
  }
  tools.append(activityButton())
  tools.append(h("button", { type: "button", class: "tool", "aria-label": t("More"), title: t("More"), onclick: (e) => chatMenu(e.currentTarget, open?.chat || chat) }, icon(ICONS.more)))
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
function chip({ ico, lead, label, title, onclick, menuish = true, cls = "", disabled = false }) {
  return h(
    "button",
    { type: "button", class: `cchip ${cls}`, title: title || label, "aria-haspopup": menuish ? "menu" : null, disabled, onclick },
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

function modeChip(value, onChange, disabled) {
  return chip({
    ico: ICONS.shield,
    label: modeName(value),
    title: `${t("Mode")}: ${MODE_WORDS[value]?.() || value}`,
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
    label: control === "switch" ? (current === "off" ? t("off") : levelWord(current)) : levelWord(current),
    title: `${t("Reasoning effort")}: ${levelWord(current)}`,
    cls: current === "off" ? "is-dim" : "",
    onclick: (e) => menu(e.currentTarget, levels.map((l) => ({ label: words(l), hint: control === "switch" && l !== "off" ? levelWord(l) : "", checked: l === current, run: () => l !== current && onChange(l) }))),
  })
}

/**
 * The subagents a chat may run: a chip saying the fewest and the most, opening the two fields.
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
          h("label", { class: "pop__title", for: "agents-min", text: t("Subagents") }),
          h("div", { class: "agents__heads", "aria-hidden": "true" }, h("span", { text: t("Fewest") }), h("span"), h("span", { text: t("Most") })),
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
  if (!roots.length) return chip({ ico: ICONS.folder, label: t("Add folder…"), menuish: false, cls: "is-warn", onclick: () => invoke("remote_add") })
  return chip({
    ico: ICONS.folder,
    label: folderName(value),
    title: `${t("Folder")}: ${value}`,
    onclick: (e) =>
      menu(e.currentTarget, [
        ...roots.map((r) => ({ label: folderName(r), hint: r, checked: r === value, run: () => r !== value && onChange(r) })),
        null,
        { label: t("Add folder…"), run: () => invoke("remote_add") },
      ]),
  })
}

let chipsDrawn = 0 // which drawing is the latest: an older one's late answers are dropped

/** The chips for what the composer is writing to: a new chat (`draft`) or the open chat. */
async function renderChips() {
  const box = $("composer-chips")
  const drawing = ++chipsDrawn
  const mayPick = ctx.me()?.permissions?.["chat.model_select"] !== false
  if (draft) {
    const s = ctx.status()
    const models = ctx.models()
    const model = models.find((m) => m.id === draft.model)
    const parts = []
    if (draft.kind === "agent") {
      const roots = s?.remote?.enabled ? s.remote.roots : []
      if (!roots.includes(draft.dir)) draft.dir = roots[0] || ""
      parts.push(folderChip(roots, draft.dir, (d) => ((draft.dir = d), renderChips())))
      parts.push(modeChip(draft.mode, (m) => ((draft.mode = m), renderChips())))
    }
    parts.push(modelChip(models, draft.model, (id) => {
      draft.model = id
      draft.effort = levelsOf(models.find((m) => m.id === id)).start
      renderChips()
    }, mayPick))
    if (model) parts.push(effortChip(model, draft.effort, (l) => ((draft.effort = l), renderChips())))
    if (draft.kind === "chat" && teamPossible(model)) parts.push(agentsChip(draft.agents, (a) => ((draft.agents = a), renderChips()), { cap: subagentsCap(), own: namedOnly(model?.subagents) }))
    box.replaceChildren(...parts.filter(Boolean))
    return
  }
  const chat = open?.chat
  if (!chat?.kind) return box.replaceChildren()
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
  const current = models.find((m) => m.id === chat.model) || { id: chat.model, name: chat.model, efforts: [] }
  const parts = []
  if (chat.kind === "agent") parts.push(modeChip(chat.mode || "edit", (m) => save({ mode: m })))
  if (chat.model) parts.push(modelChip(models, chat.model, (id) => save({ model: id }), mayPick))
  parts.push(effortChip(current, chat.effort || levelsOf(current).start, (l) => save({ effort: l })))
  box.replaceChildren(...parts.filter(Boolean))
  const offer = await teamOffered(chat)
  if (!offer || drawing !== chipsDrawn || open?.chat?.id !== chat.id) return
  box.append(agentsChip(open.chat.agents || chat.agents, (a) => save({ agents: a }), offer))
}

/**
 * Above the composer, what stands in the way of an agent chat on this computer: not linked, the
 * server refused the link, no folder. A new agent chat says it; an open one on this computer too.
 */
function renderNotice() {
  const box = $("link-notice")
  const s = ctx.status()
  const wants = draft ? draft.kind === "agent" : open?.chat?.kind === "agent" && onThisComputer(open.chat)
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
  }
}

/** The chat's own menu, under its ⋯ button or a row of the sidebar: `chat` as the list has it. */
export function chatMenu(anchor, chat) {
  const base = ctx.status()?.server
  const mayDelete = ctx.me()?.permissions?.["chat.delete"] !== false
  const items = [{ label: t("Rename…"), run: () => renameChat(chat) }]
  if (chat.kind === "agent" && chat.device_session_id) items.push({ label: t("Continue in a terminal…"), run: () => continueInTerminal(chat) })
  if (base) items.push({ label: t("Open in the web interface"), run: () => openLink(`${base}/chat/${encodeURIComponent(chat.id)}`) })
  items.push(null, { label: t("Archive chat"), run: () => archiveChat(chat) })
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

function alertIn(text) {
  const box = $("thread-note")
  box.textContent = text
  box.hidden = !text
}

/** Open a chat by id: its newest page, and the reply being written, if one is. */
export async function openChat(id) {
  if (open?.chat?.id !== id) discard()
  if (open?.live) open.live.stop()
  open = { chat: { id }, live: null, more: false }
  draft = null
  closePopover()
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
  watchActivity(r.chat)
  renderHead(r.chat)
  renderChips()
  renderNotice()
  clear(list)
  if (r.more) list.append(earlier())
  for (const m of r.messages) {
    if (m.id === r.live) continue
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
  watchActivity(null)
  invoke("set_open_chat", { chat: null })
}


// --- A new chat ------------------------------------------------------------------------------------

let draft = null // { kind, dir, mode, model, effort, agents } while a new chat is being written
let lastKind = "agent"

/** The kind a new chat starts as: the last one chosen (an agent chat, at first). */
export function draftKind() {
  return draft?.kind || lastKind
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
      kind === "agent"
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
  draft = { kind: lastKind, dir: "", mode: "edit", model: start?.id || "", effort: levelsOf(start).start, agents: null }
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
  if (draft.kind === "agent") {
    const device = ctx.thisDevices()[0]
    if (!device || !agentReady(ctx.status())) {
      renderNotice()
      throw { detail: agentState(ctx.status()).sentence }
    }
    if (!draft.dir) throw { detail: t("No folder yet: add one under Settings, Project folders.") }
    Object.assign(body, { kind: "agent", device, directory: draft.dir, mode: draft.mode || "edit" })
  }
  const r = await post("/chats", body)
  draft = null
  $("new-chat").hidden = true
  $("main").dataset.new = "false"
  open = { chat: r.chat, live: null, more: false }
  invoke("set_open_chat", { chat: r.chat.id })
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
      const body = { text }
      if (files.length) body.attachments = files
      const r = await post(`/chats/${encodeURIComponent(open.chat.id)}/messages`, body)
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
  showComposer(false)
}
