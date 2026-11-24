// The page's one way out: Tauri's commands (src-tauri/src/lib.rs). The page holds no token and
// makes no request of its own -- the content security policy allows it none but the bridge. The
// server is reached through `api` and `follow`, which Rust sends with the app's sign-in.

const tauri = window.__TAURI__
export const invoke = tauri.core.invoke
export const listen = tauri.event.listen
export const win = tauri.window.getCurrentWindow()

/** A request to the server's /api/v2: `path` from there on. Rejects with {status, detail}. */
export function api(method, path, body) {
  return invoke("api", { method, path, body: body === undefined ? null : body })
}
export const get = (path) => api("GET", path)
export const post = (path, body) => api("POST", path, body ?? {})
export const patch = (path, body) => api("PATCH", path, body)
export const del = (path) => api("DELETE", path)
/** A `GET` on /api/v2 that answers plain text (a shown file). Rejects with {status, detail}. */
export const getText = (path) => invoke("api_text", { path })

/** An error's words, whatever shape it came in. */
export function why(err) {
  if (err && typeof err === "object" && "detail" in err) return String(err.detail)
  return String(err)
}

// Frames of every followed reply arrive as one event; they are handed on by stream id. A frame
// can arrive before `stream_open` has answered with its id, so frames for an unknown id wait.
const followers = new Map()
const early = new Map()
listen("stream", (e) => {
  const { id, event, data } = e.payload
  const f = followers.get(id)
  if (f) deliver(f, id, event, data)
  else {
    if (!early.has(id)) early.set(id, [])
    early.get(id).push([event, data])
  }
})

function deliver(f, id, event, data) {
  if (event === "end") {
    followers.delete(id)
    f.onEnd(data)
  } else f.onFrame(event, data)
}

/**
 * Follow a reply: `onFrame(event, data)` for each frame, `onEnd(error|null)` once. The handle's
 * `close()` stops it (onEnd still comes).
 */
export async function follow(path, { onFrame, onEnd }) {
  const id = await invoke("stream_open", { path })
  const f = { onFrame, onEnd }
  followers.set(id, f)
  for (const [event, data] of early.get(id) || []) {
    if (!followers.has(id)) break
    deliver(f, id, event, data)
  }
  early.delete(id)
  return {
    id,
    close() {
      invoke("stream_close", { id })
    },
  }
}

// --- The terminal panel's socket -----------------------------------------------------------------
//
// Opened by Rust (`terminal_open`), which holds the token and the socket; the page gets the frames
// as `terminal` events -- `output` (the shell's bytes, base64), `control` (the server's JSON), a last
// `end` -- and sends keys, sizes and "close" through commands. As with a followed reply, a frame
// can come before `terminal_open` has answered with its id: those wait.

const terminals = new Map()
const earlyTerminal = new Map()
listen("terminal", (e) => {
  const { id, kind, data } = e.payload
  const f = terminals.get(id)
  if (f) deliverTerminal(f, id, kind, data)
  else {
    if (!earlyTerminal.has(id)) earlyTerminal.set(id, [])
    earlyTerminal.get(id).push([kind, data])
  }
})

function deliverTerminal(f, id, kind, data) {
  if (kind === "end") {
    terminals.delete(id)
    f.onEnd(data || {})
  } else if (kind === "output") f.onOutput(data)
  else if (kind === "control") f.onControl(data)
}

/**
 * Open a shell: `target` is `{ chat }` or `{ device, directory }`; `onOutput(base64)`,
 * `onControl(frame)`, and `onEnd({ code, reason, status, error })` once. The handle sends keys
 * (`input`), a size (`resize`), and lets go (`close`; onEnd still comes).
 */
export async function openTerminal(target, cols, rows, { onOutput, onControl, onEnd }) {
  const id = await invoke("terminal_open", {
    chat: target.chat ?? null,
    device: target.device ?? null,
    directory: target.directory ?? null,
    cols,
    rows,
  })
  const f = { onOutput, onControl, onEnd }
  terminals.set(id, f)
  for (const [kind, data] of earlyTerminal.get(id) || []) {
    if (!terminals.has(id)) break
    deliverTerminal(f, id, kind, data)
  }
  earlyTerminal.delete(id)
  return {
    id,
    input: (data) => invoke("terminal_input", { id, data }),
    resize: (c, r) => invoke("terminal_resize", { id, cols: c, rows: r }),
    close: () => invoke("terminal_close", { id }),
  }
}

// --- A file carried from one place to another ------------------------------------------------------
//
// Rust reads and writes (src-tauri/src/carry.rs); the page hears how it goes as `carry` events
// by the transfer's id: `reading` ({ done, total }), `sending`, and one last word -- `done`
// ({ name }), `failed` ({ error }) or `cancelled`. As with a followed reply, a word can come
// before `carry_start` has answered with the id: those wait.

const carries = new Map()
const earlyCarry = new Map()
listen("carry", (e) => {
  const f = e.payload || {}
  const c = carries.get(f.id)
  if (c) c(f)
  else {
    if (!earlyCarry.has(f.id)) earlyCarry.set(f.id, [])
    earlyCarry.get(f.id).push(f)
  }
})

/**
 * Carry one file: `from` `{ place: "local"|"server"|"device", root?, device?, path }` (the
 * file), `to` the same with `path` the folder it goes into. `said(frame)` for each word of how
 * it goes. Answers `{ id, cancel(), done }` -- `done` resolves with `{ name }`, and rejects with
 * `{ detail }` or, cancelled, `{ cancelled: true }`.
 */
export async function carry(from, to, said = () => {}) {
  const id = await invoke("carry_start", { from, to })
  let settle = null
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }))
  const hear = (f) => {
    said(f)
    if (f.state === "done") (carries.delete(id), settle.resolve({ name: f.name || "" }))
    else if (f.state === "failed") (carries.delete(id), settle.reject({ status: 0, detail: f.error || "" }))
    else if (f.state === "cancelled") (carries.delete(id), settle.reject({ cancelled: true, detail: "" }))
  }
  carries.set(id, hear)
  for (const f of earlyCarry.get(id) || []) hear(f)
  earlyCarry.delete(id)
  return { id, done, cancel: () => invoke("carry_cancel", { id }) }
}

/** A web link, in the system's browser. */
export function openLink(url) {
  return invoke("open_external", { url }).catch(() => {})
}

/** Let go of every reply followed and every shell open (the page is about to load again). */
export function letGoAll() {
  const ids = [...followers.keys()].map((id) => invoke("stream_close", { id }))
  const shells = [...terminals.keys()].map((id) => invoke("terminal_close", { id }))
  return Promise.allSettled([...ids, ...shells])
}
