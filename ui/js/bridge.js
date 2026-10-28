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

/** A web link, in the system's browser. */
export function openLink(url) {
  return invoke("open_external", { url }).catch(() => {})
}
