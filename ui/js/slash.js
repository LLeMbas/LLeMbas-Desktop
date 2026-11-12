// The composer's two menus, as the web interface has them: `/` at the start of the box lists
// commands -- the app's own, then the device's on an agent chat -- and `@` after white space
// lists what can be mentioned: the device's files (an agent chat), a page to read, the server's
// files, and what is already in this chat.
//
// The rule that matters is the web's: a message that merely starts with a slash is still sent.
// Only an exact match against the app's own table is taken as a command; `//` and anything
// unknown go as written. A device's command chosen here is sent as the literal `/name args`
// message, which the device expands as its terminal would.
//
// The menu is a box inside the composer card, placed by the card itself: its width, directly
// above it (app.css `.cmenu`). Nothing is measured, so it is where the card is at any width.
//
// The three reads and the one write below are the server's `/api/v2` menu routes; their answers
// are pinned in tests/ui/fixtures (device_commands, device_files, mentions, mentions_url,
// attachment_from). Each is marked `CONTRACT` where it is called. A server without them answers
// 404: the device's and the server's groups are then simply absent.

import { $, h, clear, icon, ICONS } from "./dom.js"
import { get, post } from "./bridge.js"
import { attachFrom } from "./attach.js"

let ctx = null // set by initSlash: see chat.js `menuContext`
let menu = null // the box, built on first use
let list = null
let keys = null
let open = false
let kind = "" // "/" or "@" while open
let active = -1
let pending = 0 // the debounce timer of the `@` lookups
let asked = 0 // which `@` lookup is the latest: an older one's late answer is dropped

const DEBOUNCE = 150

const enc = encodeURIComponent
const box = () => $("composer-text")

// --- The token being typed ------------------------------------------------------------------------

/**
 * The token under the caret, or null. `@` is claimed wherever it follows white space (or starts
 * the box), so "see @src/main.py" works mid-sentence and an email address opens nothing. A slash
 * command is only ever the first thing in the box, with the caret at its end.
 */
export function tokenAt(value, caret, caretEnd = caret) {
  if (caret !== caretEnd) return null
  const before = value.slice(0, caret)
  const at = before.lastIndexOf("@")
  if (at !== -1 && (at === 0 || /\s/.test(before[at - 1]))) {
    const query = before.slice(at + 1)
    if (!/\s/.test(query)) return { kind: "@", query, start: at, end: caret }
  }
  if (before[0] === "/" && before[1] !== "/") {
    const word = before.slice(1)
    if (!/\s/.test(word) && caret === value.length) return { kind: "/", query: word, start: 0, end: caret }
  }
  return null
}

/** A path as the CLI's own `@` reads it: a space ends a mention and `#` starts a line range. */
export const escapePath = (path) => String(path).replace(/([\\ #])/g, "\\$1")

/** Whether `text` reads as a web address: what `@https://…` offers to fetch. */
const looksLikeUrl = (text) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(text) || /^www\.[^\s/]+\.[^\s]+$/i.test(text)

// --- The device's own commands --------------------------------------------------------------------

let deviceCommands = []
let deviceLabel = "" // the device's short name, as the server says it with its commands
let deviceKey = ""
let deviceAt = 0

/** Read the device's commands again, at most every few seconds for the same chat and folder. */
function refreshDevice() {
  const w = ctx.where()
  if (!w.device) {
    deviceCommands = []
    deviceKey = ""
    return
  }
  // CONTRACT: GET /devices/{id}/commands?chat=&cwd= -> { commands: [{ name, description, hint, kind }], device }
  const path = `/devices/${enc(w.device)}/commands?chat=${enc(w.chat)}&cwd=${enc(w.cwd)}`
  if (path === deviceKey && Date.now() - deviceAt < 5000) return
  deviceKey = path
  deviceAt = Date.now()
  get(path)
    .then((r) => {
      if (path !== deviceKey) return
      deviceLabel = typeof r?.device === "string" ? r.device : ""
      deviceCommands = (r?.commands || [])
        .filter((c) => c && typeof c.name === "string" && c.name)
        .map((c) => ({ name: c.name.replace(/^\/+/, ""), summary: c.description || "", argument: c.hint || "", device: true }))
      if (open && kind === "/") refresh()
    })
    .catch(() => {
      if (path === deviceKey) deviceCommands = []
    })
}

const argumentOf = (c) => (typeof c.argument === "function" ? c.argument() : c.argument || "")

/** The app's commands that make sense now, and the device's that the app has no name for. */
function available() {
  return ctx.commands().filter((c) => !c.when || c.when())
}
function fromDevice() {
  const mine = available().map((c) => c.name)
  return ctx.where().device ? deviceCommands.filter((c) => !mine.includes(c.name)) : []
}

/**
 * A command typed in full, or null -- and null is the important half: anything that is not one
 * of the app's own commands is left to be sent as the message it is.
 */
export function commandIn(value) {
  if (value[0] !== "/" || value[1] === "/") return null
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(value.trim())
  if (!m) return null
  const found = available().find((c) => c.name === m[1])
  return found ? { name: found.name, rest: m[2] || "" } : null
}

function runCommand(name, rest) {
  const own = available().find((c) => c.name === name)
  if (own) return own.run(rest || "")
  // A device's, chosen from the menu: sent as the message it is.
  const theirs = fromDevice().find((c) => c.name === name)
  if (theirs) ctx.send(`/${theirs.name}${rest ? ` ${rest}` : ""}`)
}

/** Every command with what it takes and does, for /help. */
export function commandTable() {
  return [...available(), ...fromDevice()].map((c) => ({ name: c.name, argument: argumentOf(c), summary: c.summary, device: !!c.device }))
}

// --- The menu ---------------------------------------------------------------------------------------

function build() {
  if (menu) return
  list = h("div", { class: "cmenu__list" })
  keys = h("p", { class: "cmenu__keys" })
  menu = h("div", { class: "cmenu", id: "composer-menu", role: "listbox", hidden: true }, list, keys)
  $("composer").prepend(menu)
  // Before the box loses focus, or the caret the choice is written at is already gone.
  menu.addEventListener("mousedown", (e) => e.preventDefault())
  menu.addEventListener("click", (e) => {
    const also = e.target.closest("[data-also]")
    const option = e.target.closest(".cmenu__option")
    if (option) choose(option, { attach: !!also })
  })
}

function hide() {
  clearTimeout(pending)
  asked++
  if (!menu) return
  menu.hidden = true
  open = false
  kind = ""
  active = -1
  box().removeAttribute("aria-activedescendant")
}

const options = () => (menu ? [...menu.querySelectorAll(".cmenu__option")] : [])

function highlight(index) {
  const all = options()
  if (!all.length) {
    active = -1
    return
  }
  active = (index + all.length) % all.length
  all.forEach((o, i) => o.setAttribute("aria-selected", String(i === active)))
  all[active].scrollIntoView?.({ block: "nearest" })
  box().setAttribute("aria-activedescendant", all[active].id)
  keysLine()
}

function keysLine() {
  const all = options()
  const on = all[active]
  keys.textContent = !all.length
    ? t("Esc dismiss")
    : kind === "/"
      ? t("↑↓ choose · Tab complete · Enter run · Esc dismiss")
      : on?.dataset.also
        ? t("↑↓ choose · Enter mention · Shift+Enter attach · Esc dismiss")
        : on?.dataset.path && !on.dataset.attach
          ? t("↑↓ choose · Enter mention · Esc dismiss")
          : t("↑↓ choose · Enter attach · Esc dismiss")
}

function show() {
  menu.hidden = false
  open = true
  box().setAttribute("aria-controls", "composer-menu")
}

let optionSeq = 0

/** One row: icon · name over its note, on the same tracks in every group. */
function option({ ico, name, note, mono = false, data = {}, also = null }) {
  return h(
    "div",
    { class: "cmenu__option", role: "option", id: `cmenu-${++optionSeq}`, "aria-selected": "false", dataset: data },
    h("span", { class: "cmenu__icon", "aria-hidden": "true" }, ico ? icon(ico) : null),
    h("span", { class: "cmenu__body" }, h("span", { class: `cmenu__name${mono ? " is-mono" : ""}` }, h("bdi", { text: name })), h("span", { class: `cmenu__note${mono ? "" : " is-plain"}`, text: note || "" })),
    also ? h("button", { type: "button", class: "tool cmenu__also", tabindex: "-1", dataset: { also: "1" }, "aria-label": also, title: also }, icon(ICONS.attach)) : h("span", { class: "cmenu__also", "aria-hidden": "true" }),
  )
}

function group(title, rows) {
  return [h("p", { class: "cmenu__group", text: title }), ...rows]
}

function empty(text) {
  return h("p", { class: "cmenu__empty", text })
}

function drawCommands(query) {
  const needle = query.toLowerCase()
  const own = available().filter((c) => c.name.startsWith(needle))
  const device = fromDevice().filter((c) => c.name.toLowerCase().startsWith(needle))
  clear(list)
  if (!own.length && !device.length) {
    list.append(empty(t("No command called “%(name)s”. It will be sent as a message.", { name: query })))
    return
  }
  const row = (c) => {
    const arg = argumentOf(c)
    // A device's command that takes something after its name is completed, never sent bare.
    return option({ ico: c.device ? ICONS.terminal : ICONS.bolt, name: `/${c.name}${arg ? ` ${arg}` : ""}`, note: c.summary, mono: true, data: { command: c.name, ...(c.device && arg ? { input: "1" } : {}) } })
  }
  if (own.length) list.append(...group(t("Commands"), own.map(row)))
  if (device.length) list.append(...group(deviceLabel || ctx.where().deviceName || t("On the device"), device.map(row)))
}

/** What `@` offers for `query`: asked of the device (an agent chat) and of the server, together. */
async function loadMentions(query) {
  const mine = ++asked
  const w = ctx.where()
  const nothing = { files: [] }
  // CONTRACT: GET /devices/{id}/files?q=&chat=&cwd= -> { files: [{ path, kind, name }], error, device }
  const device = w.device ? get(`/devices/${enc(w.device)}/files?q=${enc(query)}&chat=${enc(w.chat)}&cwd=${enc(w.cwd)}`).catch(() => nothing) : Promise.resolve(nothing)
  // CONTRACT: GET /mentions?q=&chat= -> { items: [{ kind: "attachment"|"file"|"url", id?, path?, url?, name, detail }] }
  const server = get(`/mentions?q=${enc(query)}&chat=${enc(w.chat)}`).catch(() => ({ items: [] }))
  const [d, s] = await Promise.all([device, server])
  // A round trip late: the caret may have left the mention, or a newer lookup is on its way.
  if (mine !== asked || kind !== "@") return
  const items = Array.isArray(s?.items) ? s.items : []
  const files = (Array.isArray(d?.files) ? d.files : []).filter((f) => f && typeof f.path === "string" && f.path)
  const of = (k) => items.filter((i) => i && i.kind === k)
  // A page to read: the server's word where it gives one, else what was typed when it reads as one.
  const urls = of("url").length ? of("url") : looksLikeUrl(query) ? [{ kind: "url", url: query, name: query }] : []
  const named = (typeof d?.device === "string" && d.device) || w.deviceName
  clear(list)
  // The device could not answer (its own words): said in its place, and the rest still shows.
  if (!files.length && typeof d?.error === "string" && d.error) list.append(h("p", { class: "cmenu__group", text: t("On the device") }), empty(d.error))
  if (files.length) {
    list.append(
      ...group(
        `${t("On the device")}${named ? ` · ${named}` : ""}`,
        files.map((f) => option({ ico: f.kind === "dir" ? ICONS.folder : ICONS.fileText, name: f.name || f.path.replace(/\/+$/, "").split("/").pop() || f.path, note: f.path, data: { token: f.path, path: "1" } })),
      ),
    )
  }
  if (urls.length) {
    list.append(...group(t("A page to read"), urls.map((u) => option({ ico: ICONS.link, name: t("Fetch this page"), note: u.url || u.name, data: { token: u.url || u.name, url: u.url || u.name, attach: "1" } }))))
  }
  if (of("file").length) {
    // A file in the server's tree: mentioned by its path in a chat on the server (the model reads
    // it itself, under the chat's access), or attached as a copy. A device cannot read the
    // server's tree, so in an agent chat it is attached.
    list.append(
      ...group(
        t("Files"),
        of("file").map((f) =>
          w.device
            ? option({ ico: ICONS.fileText, name: f.name, note: f.path || f.detail, data: { token: f.name, file: f.path || "", attach: "1" } })
            : option({ ico: ICONS.fileText, name: f.name, note: f.path || f.detail, data: { token: f.path || f.name, file: f.path || "", path: "1", also: "1" }, also: t("Attach a copy") }),
        ),
      ),
    )
  }
  if (of("attachment").length) {
    list.append(...group(t("Already in this chat"), of("attachment").map((a) => option({ ico: ICONS.attach, name: a.name, note: a.detail, mono: false, data: { token: a.name, attachment: a.id || "", attach: "1" } }))))
  }
  if (!list.querySelector(".cmenu__option") && !list.childElementCount) list.append(empty(query ? t("Nothing matches “%(q)s”.", { q: query }) : t("Nothing to mention yet.")))
  show()
  highlight(0)
  keysLine()
}

/** The box changed, or the caret moved: the menu follows the token under it. */
function refresh() {
  build()
  const input = box()
  const token = tokenAt(input.value, input.selectionStart, input.selectionEnd)
  if (!token) return hide()
  if (token.kind === "/") {
    clearTimeout(pending)
    asked++
    kind = "/"
    refreshDevice()
    drawCommands(token.query)
    show()
    highlight(0)
    keysLine()
    return
  }
  kind = "@"
  clearTimeout(pending)
  pending = setTimeout(() => loadMentions(token.query), DEBOUNCE)
}

// --- Choosing -----------------------------------------------------------------------------------------

function replaceToken(text) {
  const input = box()
  const token = tokenAt(input.value, input.selectionStart, input.selectionEnd)
  if (!token) return
  const head = input.value.slice(0, token.start)
  const written = `${token.kind}${text} `
  input.value = head + written + input.value.slice(token.end)
  const caret = head.length + written.length
  input.setSelectionRange(caret, caret)
  input.focus()
  ctx.changed()
}

/**
 * `complete` is Tab, otherwise Enter or a click. For a command that takes something after its
 * name Tab writes `/mode ` and leaves the caret there; Enter runs what is there. `attach` is
 * Shift+Enter, or the row's own Attach button: a copy of a server file instead of its path.
 */
function choose(el, { complete = false, attach = false } = {}) {
  const d = el.dataset
  if (d.command) {
    if (complete || d.input) {
      replaceToken(d.command)
      hide()
      return
    }
    hide()
    // Cleared before it runs: a command is the whole message, never left for the next Enter.
    box().value = ""
    ctx.changed()
    runCommand(d.command, "")
    return
  }
  const copy = !!d.attach || (attach && !!d.also)
  // A path goes in as the CLI's own `@` reads it; a file's or a page's name as it is.
  replaceToken(d.path ? escapePath(d.token) : d.token)
  hide()
  if (!copy) return
  const w = ctx.where()
  // CONTRACT: POST /attachments/from -- exactly one of { attachment } | { path } | { url }, with
  //           the chat where there is one (and, before it exists, the model a copy is for)
  //           -> what POST /attachments answers: { attachment: { id, name, size, image, … } }
  const body = d.attachment ? { attachment: d.attachment } : d.url ? { url: d.url } : { path: d.file }
  if (w.chat) body.chat = w.chat
  else if (d.attachment && w.model) body.model = w.model
  const name = d.url ? d.url : el.querySelector(".cmenu__name")?.textContent || d.token
  attachFrom(name, async () => {
    const r = await post("/attachments/from", body)
    const a = r?.attachment || r
    if (!a || !a.id) throw { detail: t("Could not attach that.") }
    return a
  })
}

/** A key in the box: the menu's while it is open, then a command typed in full. True when taken. */
function key(e) {
  if (e.isComposing) return false
  if (open) {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      hide()
      return true
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      highlight(active + (e.key === "ArrowDown" ? 1 : -1))
      return true
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const all = options()
      if (all.length && active >= 0) {
        e.preventDefault()
        e.stopPropagation()
        choose(all[active], { complete: e.key === "Tab", attach: e.key === "Enter" && e.shiftKey })
        return true
      }
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    // Not a menu key: a command typed in full. Never posted, so it cannot become a message.
    const command = commandIn(box().value)
    if (command) {
      e.preventDefault()
      e.stopPropagation()
      hide()
      box().value = ""
      ctx.changed()
      runCommand(command.name, command.rest)
      return true
    }
  }
  return false
}

/** Put a slash in the box and open the commands (the title bar's and the palette's way in). */
export function openCommands() {
  const input = box()
  if ($("composer").hidden) return
  input.focus()
  input.value = "/"
  input.setSelectionRange(1, 1)
  ctx.changed()
  refresh()
}

export function closeComposerMenu() {
  hide()
}

export function initSlash(context) {
  ctx = context
  const input = box()
  // Capture: before the box's own Enter-to-send sees the key.
  input.addEventListener("keydown", (e) => key(e) && e.stopImmediatePropagation(), true)
  input.addEventListener("input", refresh)
  input.addEventListener("click", refresh)
  input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refresh()
  })
  input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && hide(), 0))
  document.addEventListener("pointerdown", (e) => {
    if (open && !e.target.closest?.("#composer-menu") && e.target !== input) hide()
  })
}
