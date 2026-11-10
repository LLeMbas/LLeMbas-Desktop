// The terminal panel: a shell on the device an agent chat works on, beside the chat -- the web
// page's panel (the server's static/js/terminal.js), in this app. Two places it opens:
//
//   - an open agent chat: the chat's own shell (`{ chat }`), the one the web page shares;
//   - a new agent chat, as soon as its device and folder are chosen (`{ device, directory }`):
//     a shell there before the first message, which the chat that message makes takes over.
//
// The socket is Rust's (bridge.js `openTerminal`): the page never holds the token. xterm is the
// server's vendored build (ui/vendor, scripts/fetch-vendor.sh), loaded the first time the panel
// opens. Never beside the activity panel: the shell's layout has one panel column (as the web
// page has), so opening one closes the other -- the shell stays open behind it.
//
// Three things about xterm the web panel learnt the hard way, kept here: it cannot fit while its
// box is hidden (so every fit waits until the panel is shown), the panel changes size without a
// window `resize` (so a ResizeObserver), and it reads no CSS variables (so the theme is read from
// the computed tokens, and again when the theme changes).

import { $, h, icon, ICONS } from "./dom.js"
import { openTerminal, why } from "./bridge.js"

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]
const MAX_MARKED = 200

let ctx = { layout: () => {}, composer: () => {} }
let target = null // what the panel is for: { key, chat } | { key, device, directory }, with `name`
let term = null
let fit = null
let session = null // the open socket's handle, and which target it is for: { handle, key, draft }
let observer = null
let loading = null
// A device's shell marks its own commands (OSC 133 A/B/C/D, OSC 7 for where it is) and says so
// in its ready frame (`osc`): then a command and its output are read from the panel's own
// buffer. Without the marks, "send" falls back to the screen as it is, and says so.
let osc = false
let pending = null
let finished = []
let visiting = -1

const panel = () => $("terminal")

function say(text, isError) {
  const el = $("terminal-message")
  el.textContent = text || ""
  el.classList.toggle("is-error", !!isError)
}

/** Whether the panel is shown. */
export function terminalOpen() {
  return !panel().hidden
}

/** Whether there is a shell to open for what the chat page shows now. */
export function terminalAvailable() {
  return !!target
}

// --- xterm, loaded once --------------------------------------------------------------------------

function load() {
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    if (typeof window.Terminal === "function" && window.FitAddon) return resolve()
    document.head.append(h("link", { rel: "stylesheet", href: "vendor/xterm.css" }))
    const script = (src) =>
      new Promise((ok, fail) => {
        const s = h("script", { src })
        s.addEventListener("load", ok)
        s.addEventListener("error", () => fail(new Error(src)))
        document.head.append(s)
      })
    script("vendor/xterm.js")
      .then(() => script("vendor/xterm-addon-fit.js"))
      .then(resolve, reject)
  })
  loading.catch(() => {
    loading = null
  })
  return loading
}

function readTheme() {
  const style = getComputedStyle(document.documentElement)
  const token = (name, fallback) => (style.getPropertyValue(name) || "").trim() || fallback
  const theme = {
    background: token("--code-bg", "black"),
    foreground: token("--ink", "white"),
    cursor: token("--accent", "white"),
    cursorAccent: token("--code-bg", "black"),
    selectionBackground: token("--accent-soft", "gray"),
  }
  for (const name of ANSI) {
    const value = token(`--ansi-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, "")
    if (value) theme[name] = value
  }
  return theme
}

/** The theme changed: xterm's colours are read again. */
export function terminalThemeChanged() {
  if (term) term.options.theme = readTheme()
}

function build() {
  if (term) return
  const style = getComputedStyle(document.documentElement)
  term = new window.Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace",
    fontSize: parseFloat(style.getPropertyValue("--terminal-font-size")) || 13,
    scrollback: 5000,
    theme: readTheme(),
  })
  fit = new window.FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open($("terminal-screen"))
  term.parser.registerOscHandler(133, onCommandMark)
  term.parser.registerOscHandler(7, onWhere)
  term.onData((data) => session?.handle?.input(data))
  // Ctrl+C is the shell's interrupt; copy and paste are the shifted pair, as in every terminal.
  term.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey || !e.shiftKey || e.type !== "keydown") return true
    if (osc && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      visit(e.key === "ArrowUp" ? -1 : 1)
      return false
    }
    const key = e.key.toLowerCase()
    if (key === "c") {
      const text = term.getSelection()
      if (text) navigator.clipboard.writeText(text).catch(() => {})
      return false
    }
    if (key === "v") {
      navigator.clipboard
        .readText()
        .then((text) => session?.handle?.input(text))
        .catch(() => {})
      return false
    }
    return true
  })
  observer = new ResizeObserver(() => refit())
  observer.observe($("terminal-screen"))
}

function refit() {
  if (!term || !fit || !terminalOpen() || !$("terminal-screen").offsetWidth) return
  try {
    fit.fit()
  } catch {
    return
  }
  session?.handle?.resize(term.cols, term.rows)
}

// --- The socket ------------------------------------------------------------------------------------

function decode(b64) {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function connect() {
  if (!target || !term || session) return
  const t0 = target
  // The session exists before the socket answers, so frames that come first are this one's.
  const mine = { handle: null, key: t0.key, draft: !t0.chat }
  session = mine
  say(t("Connecting…"))
  let handle
  try {
    handle = await openTerminal(t0.chat ? { chat: t0.chat } : { device: t0.device, directory: t0.directory }, term.cols || 80, term.rows || 24, {
      onOutput: (b64) => {
        if (session === mine) term.write(decode(b64))
      },
      onControl: (frame) => {
        if (session === mine) control(frame)
      },
      onEnd: (end) => {
        if (session !== mine) return
        session = null
        ended(end)
      },
    })
  } catch (err) {
    if (session === mine) session = null
    say(why(err), true)
    return
  }
  mine.handle = handle
  // Let go of meanwhile (another chat, the panel's target changed): closed at once.
  if (session !== mine) handle.close()
}

function control(frame) {
  if (frame.t === "ready") {
    say(frame.shared ? t("Connected. This shell is also open in another tab, and they share a size.") : t("Connected."))
    if (frame.dir) $("terminal-where").textContent = frame.dir
    osc = !!frame.osc
    showMarkControls()
    showLast("")
    refit()
    if (terminalOpen()) term.focus()
  } else if (frame.t === "behind") {
    // This window stopped reading and was let go so the others kept up. The scrollback is the
    // state: connecting again costs nothing.
    say(frame.message || t("Reconnecting…"))
    drop()
    term.reset()
    forgetMarks()
    connect()
  } else if (frame.t === "closed" || frame.t === "error") {
    // No reconnect of its own: a new shell has lost the folder, the environment and the
    // half-typed command, and quietly putting one in its place is worse than saying it went.
    say(frame.message || t("This terminal closed."), frame.t === "error")
    drop()
  }
}

function ended(end) {
  if (end.code === 4401 || end.status === 401) say(t("Sign in again: the server no longer accepts this app's sign-in."), true)
  else if (end.status === 404) say(t("The terminal needs a newer LLeMbas server. Ask its administrator to update it."), true)
  else if (end.error) say(end.error, true)
  else say(t("Disconnected. Close and reopen to reconnect."))
}

/** Let go of the socket (the shell on the device lives on, as the server keeps it). */
function drop() {
  const s = session
  session = null
  s?.handle?.close()
}

// --- What the panel is for -----------------------------------------------------------------------

/**
 * Tell the panel what the chat page shows: `{ chat, name, directory }` for an open agent chat,
 * `{ device, directory, name }` for a new one with its device and folder chosen, or null (no shell
 * to open). A new chat's shell becomes its chat's when the first message has made the chat: the
 * server took that shell over, so the socket stays as it is.
 */
export function aimTerminal(next) {
  const key = next ? (next.chat ? `chat:${next.chat}` : `device:${next.device}:${next.directory}`) : ""
  const before = target
  target = next ? { ...next, key } : null
  if (target) {
    $("terminal-title").textContent = target.name || t("Terminal")
    $("terminal-where").textContent = target.directory || ""
    $("terminal-where").title = target.directory || ""
  }
  if (before?.key === key) return
  // The draft's shell is the new chat's now: the same socket, said for the chat from here on.
  const adopted = session?.draft && before && !before.chat && target?.chat && before.directory === target.directory && before.device === target.device
  if (adopted) {
    session.key = key
    session.draft = false
    return
  }
  if (session) {
    drop()
    if (term) term.reset()
    forgetMarks()
    say("")
  }
  if (!target) {
    if (terminalOpen()) showTerminal(false)
    return
  }
  if (terminalOpen()) connect()
}

// --- Showing it ------------------------------------------------------------------------------------

/** Show or hide the panel. Hiding keeps the shell and its socket: reopening is instant. */
export async function showTerminal(on) {
  if (on && !target) return
  panel().hidden = !on
  ctx.layout(on)
  markOpen()
  if (!on) return
  // Whether this showing is to open a shell: none was open as it began. One that ends meanwhile
  // (before the frame below) is said, not quietly replaced.
  const wanted = !session
  try {
    await load()
  } catch {
    say(t("The terminal could not be loaded."), true)
    return
  }
  if (!terminalOpen()) return
  build()
  // A frame later: the panel has only just been shown and has no width to fit to yet.
  requestAnimationFrame(() => {
    refit()
    if (wanted && terminalOpen()) connect()
    term.focus()
  })
}

export function toggleTerminal() {
  showTerminal(!terminalOpen())
}

function markOpen() {
  for (const b of document.querySelectorAll("[data-terminal-toggle]")) b.setAttribute("aria-pressed", String(terminalOpen()))
}

/** The header's button for an open chat; a new chat has the chip under the composer instead. */
export function terminalButton() {
  return h(
    "button",
    {
      type: "button",
      class: "tool",
      "aria-label": t("Terminal"),
      title: t("Terminal"),
      "aria-controls": "terminal",
      "aria-pressed": String(terminalOpen()),
      "data-terminal-toggle": "",
      onclick: toggleTerminal,
    },
    icon(ICONS.terminal),
  )
}

// --- A device shell's own marks ----------------------------------------------------------------------

function onCommandMark(data) {
  if (!osc || !term) return false
  const [kind, code] = String(data).split(";")
  if (kind === "A") pending = { prompt: term.registerMarker(0) }
  else if (kind === "B") {
    pending = pending || {}
    pending.input = term.registerMarker(0)
    pending.inputX = term.buffer.active.cursorX
  } else if (kind === "C") {
    pending = pending || {}
    pending.output = term.registerMarker(0)
    pending.command = commandText(pending)
  } else if (kind === "D") {
    if (pending?.output) {
      pending.exit = parseInt(code, 10) || 0
      pending.end = term.registerMarker(0)
      commandDone(pending)
    }
    pending = null
  }
  return true
}

function onWhere(data) {
  if (!osc) return false
  let path = String(data).replace(/^file:\/\/[^/]*/, "")
  try {
    path = decodeURIComponent(path)
  } catch {}
  if (path) $("terminal-where").textContent = path
  return true
}

function linesBetween(from, to, firstX) {
  const buffer = term.buffer.active
  const out = []
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const text = line.translateToString(true, y === from ? firstX || 0 : 0)
    if (line.isWrapped && out.length) out[out.length - 1] += text
    else out.push(text)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join("\n")
}

function commandText(mark) {
  if (!mark.input || !mark.output || mark.input.line < 0) return ""
  return linesBetween(mark.input.line, Math.max(mark.output.line, mark.input.line + 1), mark.inputX).trim()
}

function outputOf(mark) {
  if (!mark.output || !mark.end || mark.output.line < 0 || mark.end.line < 0) return ""
  return linesBetween(mark.output.line, mark.end.line, 0)
}

function commandDone(mark) {
  finished.push(mark)
  if (finished.length > MAX_MARKED) finished.shift()
  visiting = -1
  showLast((mark.command || "…") + (mark.exit ? ` · exit ${mark.exit}` : ""))
}

function blockOf(mark) {
  const where = $("terminal-where").textContent
  const head = `${where ? `${where} ` : ""}$ ${mark.command || ""}`
  return "```\n" + head + "\n" + outputOf(mark) + "\n```\n" + (mark.exit ? `exit ${mark.exit}\n` : "")
}

function lastFinished() {
  for (let i = finished.length - 1; i >= 0; i--) if (finished[i].output && finished[i].output.line >= 0) return finished[i]
  return null
}

function visit(step) {
  const live = finished.filter((m) => (m.prompt || m.input || m.output)?.line >= 0)
  if (!live.length) return
  visiting = visiting < 0 ? live.length : visiting
  visiting = Math.max(0, Math.min(live.length - 1, visiting + step))
  const m = live[visiting]
  term.scrollToLine((m.prompt || m.input || m.output).line)
}

function forgetMarks() {
  finished = []
  pending = null
  visiting = -1
  osc = false
  showMarkControls()
  showLast("")
}

function showMarkControls() {
  $("terminal-prev").hidden = !osc
  $("terminal-next").hidden = !osc
}

function showLast(text) {
  $("terminal-last").textContent = text || ""
}

// --- Handing it to the chat --------------------------------------------------------------------------

/** What "send" and "copy" take: the selection; else the last command (with marks); else the screen. */
function capture() {
  if (!term) return ""
  const chosen = term.getSelection()
  if (chosen && chosen.trim()) return "```\n" + chosen + "\n```\n"
  if (osc) {
    const mark = lastFinished()
    if (!mark) {
      say(t("Nothing has been run in this shell yet."))
      return ""
    }
    return blockOf(mark)
  }
  const buffer = term.buffer.active
  const last = buffer.baseY + buffer.cursorY
  const lines = []
  for (let y = Math.max(0, last - 40); y <= last; y++) {
    const line = buffer.getLine(y)
    if (line) lines.push(line.translateToString(true))
  }
  const text = lines.join("\n").replace(/\n+$/, "")
  if (!text.trim()) {
    say(t("Nothing to send: select some output first."))
    return ""
  }
  say(t("Copied the last of the screen, as it appeared. This shell does not mark where commands begin."))
  return "```\n" + text + "\n```\n"
}

/** Into the message box, never sent: what a machine printed is for the person to read first. */
function sendToChat() {
  const text = capture()
  if (!text) return
  ctx.composer(text)
  // Where the panel covers the chat (a narrow window), it steps aside to show the message box.
  if (window.matchMedia("(max-width: 64rem)").matches) showTerminal(false)
}

function copyOut() {
  const text = capture()
  if (!text) return
  navigator.clipboard.writeText(text).then(
    () => say(t("Copied.")),
    () => {},
  )
}

export function initTerminal({ onLayout, composer }) {
  ctx = { layout: onLayout || (() => {}), composer: composer || (() => {}) }
  $("terminal-icon").replaceChildren(icon(ICONS.terminal))
  $("terminal-prev").replaceChildren(icon(ICONS.chevronUp))
  $("terminal-next").replaceChildren(icon(ICONS.chevronDown))
  $("terminal-copy").replaceChildren(icon(ICONS.copy))
  $("terminal-send").prepend(icon(ICONS.send))
  $("terminal-close").replaceChildren(icon(ICONS.close))
  $("terminal-prev").addEventListener("click", () => visit(-1))
  $("terminal-next").addEventListener("click", () => visit(1))
  $("terminal-copy").addEventListener("click", copyOut)
  $("terminal-send").addEventListener("click", sendToChat)
  $("terminal-close").addEventListener("click", () => showTerminal(false))
}
