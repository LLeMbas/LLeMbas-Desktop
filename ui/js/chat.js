// One chat: its transcript, the reply being written (followed as the server streams it), the
// cards that wait for an answer, and the composer. And the form a new chat starts from -- an
// agent chat on this computer, in one of the agent's folders, or a chat on the server.
//
// The transcript is the server's /api/v2 serialisation (tests/fixtures/api_v2 in the server's
// repository is the contract): a person's message is their text as typed; a reply is its steps --
// thinking, text (markdown, model output), tool calls, messages taken in while it ran.

import { $, h, clear, append, icon, ICONS, bytes } from "./dom.js"
import { api, get, getText, post, patch, del, follow, why, invoke, openLink } from "./bridge.js"
import { markdown } from "./markdown.js"
import { openViewer, showKind } from "./viewer.js"
import { readLocal } from "./explorer.js"
import { menu, ask } from "./popup.js"
import { avatar, modelPicker } from "./models.js"
import { readyIds, sending, sent, discard } from "./attach.js"

const MODES = ["manual", "edit", "auto", "plan"]

let ctx = null // set by initChat: { status(), thisDevices(), models(), me(), changed(chat), opened(chat), gone(chat) }
let open = null // { chat, live, more, first }

export function openChatId() {
  return open?.chat?.id || null
}

// --- Reading -----------------------------------------------------------------------------------

function onThisComputer(chat) {
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

function userMessage(m) {
  const el = h(
    "article",
    { class: `msg msg--user${m.queued ? " is-queued" : ""}${m.machine ? " is-machine" : ""}`, dataset: { id: m.id } },
    h("div", { class: "msg__text", text: m.text || "" }),
    m.attachments?.length
      ? h(
          "ul",
          { class: "msg__files" },
          m.attachments.map((a) => h("li", { class: "chip", title: a.name }, h("bdi", { text: a.name }), a.size ? ` · ${bytes(a.size)}` : "")),
        )
      : null,
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
      model ? h("span", { class: "chip chip--model", title: model.id }, avatar(model), h("span", { text: model.name })) : null,
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
        h("summary", null, t("Thought"), s.label ? h("span", { class: "muted", text: ` ${s.label}` }) : null),
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
    h("span", { class: "call__title", title: block.title || c.name, text: block.title || c.name || "" }),
    h("span", { class: "call__chips" }, (block.chips || []).map((x) => h("span", { class: "chip", text: x }))),
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
    } else reload()
  }
}

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

function planList(plan) {
  return h(
    "ol",
    { class: "plan" },
    (plan.phases || []).map((p) =>
      h("li", null, h("span", { class: "plan__phase", text: p.title }), h("ul", null, (p.tasks || []).map((task) => h("li", { class: `plan__task is-${task.status}`, text: task.text })))),
    ),
  )
}

// --- Opening a chat --------------------------------------------------------------------------------

function setTitle(title) {
  $("chat-title").textContent = title || t("New chat")
  $("chat-title").title = title || ""
}

function renderHead(chat) {
  setTitle(chat.title)
  const place = clear($("chat-place"))
  const tools = clear($("chat-tools"))
  if (chat.kind === "agent" && chat.device) {
    const here = onThisComputer(chat)
    place.append(
      h("span", { class: `chip${here ? " chip--leaf" : ""}`, text: here ? t("This computer") : t("Another device") }),
      h("span", { class: "head__dir", title: chat.device.directory }, h("bdi", { text: chat.device.directory })),
    )
    const mode = h(
      "select",
      { class: "head__mode", "aria-label": t("Mode"), onchange: (e) => patch(`/chats/${encodeURIComponent(chat.id)}`, { mode: e.target.value }).catch((err) => alertIn(why(err))) },
      MODES.map((m) => h("option", { value: m, text: modeName(m), selected: chat.mode === m })),
    )
    tools.append(mode)
  }
  const slot = h("span", { class: "head__model" })
  tools.append(slot)
  chatModels(chat).then((models) => {
    if (open?.chat?.id === chat.id) headModel(slot, chat, models)
  })
  tools.append(h("button", { type: "button", class: "pane__btn", "aria-label": t("More"), title: t("More"), onclick: (e) => chatMenu(e.currentTarget, open?.chat || chat) }, icon(ICONS.more)))
}

/** The models this chat may switch to (its data group's), or the account's when that fails. */
async function chatModels(chat) {
  try {
    return (await get(`/models?chat=${encodeURIComponent(chat.id)}`)).models || []
  } catch {
    return ctx.models()
  }
}

/** The chat's model, and its effort where the model offers more than one. */
function headModel(slot, chat, models) {
  const mayPick = ctx.me()?.permissions?.["chat.model_select"] !== false
  const current = models.find((m) => m.id === chat.model) || { id: chat.model, name: chat.model, efforts: [] }
  const parts = []
  if (mayPick && models.length > 1) {
    parts.push(
      modelPicker({
        models,
        value: chat.model,
        label: t("Model"),
        onChange: async (id) => {
          try {
            const r = await patch(`/chats/${encodeURIComponent(chat.id)}`, { model: id })
            if (open?.chat?.id === chat.id) {
              open.chat = r.chat
              headModel(slot, r.chat, models)
            }
          } catch (err) {
            alertIn(why(err))
            headModel(slot, chat, models)
          }
        },
      }),
    )
  } else if (chat.model) {
    parts.push(h("span", { class: "chip chip--model", title: current.id }, avatar(current), h("span", { text: current.name })))
  }
  const efforts = current.efforts || []
  if (efforts.length > 1) {
    parts.push(
      h(
        "select",
        {
          class: "head__mode",
          "aria-label": t("Reasoning effort"),
          title: t("Reasoning effort"),
          onchange: (e) => patch(`/chats/${encodeURIComponent(chat.id)}`, { effort: e.target.value }).catch((err) => alertIn(why(err))),
        },
        chat.effort ? null : h("option", { value: "", text: "—", selected: true }),
        efforts.map((x) => h("option", { value: x, text: x, selected: chat.effort === x })),
      ),
    )
  }
  slot.replaceChildren(...parts)
}

/** The chat's own menu, under its ⋯ button or a row of the sidebar: `chat` as the list has it. */
export function chatMenu(anchor, chat) {
  const base = ctx.status()?.server
  const mayDelete = ctx.me()?.permissions?.["chat.delete"] !== false
  const items = [{ label: t("Rename…"), run: () => renameChat(chat) }]
  if (base) items.push({ label: t("Open in the web interface"), run: () => openLink(`${base}/chat/${encodeURIComponent(chat.id)}`) })
  items.push(null, { label: t("Archive chat"), run: () => archiveChat(chat) })
  if (mayDelete) items.push({ label: t("Delete chat"), danger: true, run: () => deleteChat(chat) })
  menu(anchor, items)
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
  invoke("set_open_chat", { chat: id })
  showComposer(true)
  $("new-chat").hidden = true
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
  renderHead(r.chat)
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
  invoke("set_open_chat", { chat: null })
}

// --- A new chat ------------------------------------------------------------------------------------

let draft = null // { kind }

/** The form a new chat starts from: `agent` (on this computer) or `chat` (on the server). */
export function newChat(kind) {
  closeChat()
  discard()
  draft = { kind }
  clear($("messages"))
  renderCards({ id: "" }, [])
  alertIn("")
  setTitle(kind === "agent" ? t("New agent chat") : t("New chat"))
  clear($("chat-place"))
  clear($("chat-tools"))
  const form = clear($("new-chat"))
  form.hidden = false
  const s = ctx.status()
  const models = ctx.models()
  const start = (models.find((m) => m.default) || models[0])?.id || ""
  const effort = h("select", { id: "new-effort" })
  const effortField = field(t("Reasoning effort"), effort, "")
  const showEfforts = (id) => {
    const efforts = models.find((m) => m.id === id)?.efforts || []
    effort.replaceChildren(h("option", { value: "", text: "—" }), ...efforts.map((x) => h("option", { value: x, text: x })))
    effortField.hidden = efforts.length < 2
  }
  const modelField = field(
    t("Model"),
    modelPicker({ id: "new-model", models, value: start, label: t("Model"), onChange: showEfforts }),
    models.length ? "" : t("No model is available to this account."),
  )
  showEfforts(start)
  if (kind === "agent") {
    const roots = s.remote?.enabled ? s.remote.roots : []
    const devices = ctx.thisDevices()
    form.append(
      h("p", { class: "muted", text: t("An agent chat works in a folder on this computer, through the agent built into this app.") }),
    )
    if (!devices.length) {
      form.append(
        h("p", { class: "new__warn", text: t("The agent is not connected to the server yet: start it, or link this computer, under Settings.") }),
      )
    }
    form.append(
      h(
        "div",
        { class: "fields" },
        field(
          t("Folder"),
          h("select", { id: "new-dir" }, roots.map((r) => h("option", { value: r, text: r }))),
          roots.length ? t("Only the agent's folders: Settings, Project folders.") : t("No folder yet: add one under Settings, Project folders."),
        ),
        field(
          t("Mode"),
          h(
            "select",
            { id: "new-mode" },
            MODES.map((m) => h("option", { value: m, text: modeName(m), selected: m === "edit" })),
          ),
          t("A chat asking for more than the folder allows is lowered to it."),
        ),
        modelField,
        effortField,
      ),
    )
  } else {
    form.append(h("div", { class: "fields" }, modelField, effortField))
  }
  showComposer(true)
  setRunning(false)
  invoke("set_open_chat", { chat: null })
  $("composer-text").focus()
}

/** A field: label, control, hint -- always all three, so a row of them lines up. */
function field(label, control, hint) {
  const id = control.id || `f${Math.random().toString(36).slice(2)}`
  control.id = id
  return h("div", { class: "field" }, h("label", { for: id, text: label }), control, h("p", { class: "hint", text: hint || "" }))
}

async function createChat(text, attachments) {
  const body = { text }
  if (attachments.length) body.attachments = attachments
  const model = $("new-model")?.value
  if (model) body.model = model
  const effort = $("new-effort")?.value
  if (effort) body.effort = effort
  if (draft.kind === "agent") {
    const device = ctx.thisDevices()[0]
    const dir = $("new-dir")?.value
    if (!device) throw { detail: t("The agent is not connected to the server yet: start it, or link this computer, under Settings.") }
    if (!dir) throw { detail: t("No folder yet: add one under Settings, Project folders.") }
    Object.assign(body, { kind: "agent", device, directory: dir, mode: $("new-mode")?.value || "edit" })
  }
  const r = await post("/chats", body)
  draft = null
  $("new-chat").hidden = true
  open = { chat: r.chat, live: null, more: false }
  invoke("set_open_chat", { chat: r.chat.id })
  renderHead(r.chat)
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
  showComposer(false)
}

