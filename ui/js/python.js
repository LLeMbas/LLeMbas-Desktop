// The `python` tool, run in this window for the chat it shows.
//
// On the server a `python` call runs in a page of its chat: Pyodide (CPython in WebAssembly) in
// the person's own browser, never on the server. This window is such a page. While a chat on the
// server is shown it says so (announce, and again every 20 seconds), takes the chat's calls by
// long poll, has each run, and answers with what it printed, its last value, an error and the
// files it was asked to save -- the server's own protocol (`services/pages.py`), on the app's
// door:
//
//   POST /chats/{chat}/page/announce { page_id }       here, and able to run Python
//   POST /chats/{chat}/page/withdraw { page_id }       leaving
//   GET  /chats/{chat}/page/take?page=                 the next call (200), none yet (null), or
//                                                      410: the server does not know this page
//   POST /chats/{chat}/page/answer { page_id, call_id, result }
//
// The code does not run in this page. Rust fetches the server's pinned Pyodide files, checks each
// against the server's list, and serves them with a small runner on a scheme of their own; a
// hidden frame loads it (`python_prepare` gives its address). That frame has no bridge and no
// network: a call goes in by `postMessage` and its result comes back the same way.
//
// An agent chat's code runs on its computer, not here; where Python is switched off on the
// server there is nothing to run. Neither is announced.

import { h } from "./dom.js"
import { invoke, get, post } from "./bridge.js"

const ANNOUNCE_EVERY = 20000
const enc = encodeURIComponent

let ctx = { me: () => null }
let runner = null // { url, version, frame, ready: Promise } once the frame is asked for
let attached = null // the chat this window is a page of: { chat, page, stopped, timer }
let nextCall = Promise.resolve() // one call at a time: the frame has one worker

/** A page id of the server's shape: 24 hex digits, new for every attachment. */
function pageId() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Whether the server has Python for this account's chats, as `/me` says (`python.enabled`). */
export function pythonOffered() {
  return ctx.me()?.python?.enabled === true
}

// --- The runner's frame --------------------------------------------------------------------------

/**
 * The frame, made once and kept: Rust makes the files ready and says where the runner is; the
 * frame says `ready` when it is. Rejects where Python is off, or the files could not be fetched
 * or did not verify (Rust's words) -- and is then tried afresh the next time it is wanted.
 */
function frame() {
  if (runner) return runner.ready
  const mine = { url: "", version: "", frame: null, ready: null }
  mine.ready = (async () => {
    const said = await invoke("python_prepare")
    if (!said?.enabled || !said.url) throw { status: 409, detail: "Python is not switched on here." }
    mine.url = said.url
    mine.version = said.version
    const el = h("iframe", { class: "pyrunner", id: "python-runner", title: "Python", "aria-hidden": "true", tabindex: "-1", src: said.url })
    mine.frame = el
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", heard)
        reject({ status: 0, detail: "Python's runner did not start." })
      }, 30000)
      function heard(e) {
        if (e.source !== el.contentWindow || e.data?.type !== "ready") return
        clearTimeout(timer)
        window.removeEventListener("message", heard)
        resolve()
      }
      window.addEventListener("message", heard)
      document.body.append(el)
    })
    return mine
  })()
  mine.ready.catch(() => {
    mine.frame?.remove()
    if (runner === mine) runner = null
  })
  runner = mine
  return mine.ready
}

/** Throw the frame away (it stopped answering): the next call makes a new one. */
function dropFrame() {
  runner?.frame?.remove()
  runner = null
}

/**
 * Who a call may be delivered to: the runner's own origin where the webview gives its scheme
 * one, else anyone -- which is still only that frame's window, and the frame can load nothing
 * but the runner (the app refuses every other navigation, and its policy every other source).
 */
function originOf(url) {
  try {
    const origin = new URL(url).origin
    return origin && origin !== "null" ? origin : "*"
  } catch {
    return "*"
  }
}

const failed = (error) => ({ stdout: "", result: null, error, files: [] })

/**
 * Run one call in the frame and give its result. The frame ends a call that runs past its time;
 * should the frame itself say nothing a while after that, it is replaced and the call says so.
 */
async function run(request) {
  let r
  try {
    r = await frame()
  } catch (err) {
    return failed(`Python could not start: ${err?.detail || err?.message || err}`)
  }
  const seconds = Math.max(1, Number(request.limits?.seconds) || 30)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", heard)
      dropFrame()
      resolve(failed(`Stopped after ${seconds} seconds.`))
    }, seconds * 1000 + 15000)
    function heard(e) {
      if (e.source !== r.frame.contentWindow || e.data?.type !== "result" || e.data.call_id !== request.call_id) return
      clearTimeout(timer)
      window.removeEventListener("message", heard)
      const x = e.data.result || {}
      resolve({ stdout: String(x.stdout || ""), result: x.result ?? null, error: String(x.error || ""), files: Array.isArray(x.files) ? x.files : [] })
    }
    window.addEventListener("message", heard)
    r.frame.contentWindow.postMessage({ type: "run", request }, originOf(r.url))
  })
}

// --- Being the chat's page ---------------------------------------------------------------------------

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function announce(a) {
  if (a.stopped) return
  post(`/chats/${enc(a.chat)}/page/announce`, { page_id: a.page }).catch((err) => {
    // Python was switched off, or this is not a chat to run it for: nothing more to say.
    if (err?.status === 409 || err?.status === 404) stop(a)
  })
}

function stop(a) {
  if (a.stopped) return
  a.stopped = true
  clearInterval(a.timer)
}

/**
 * Take the chat's calls, one long poll after another, until this window is no longer its page.
 * A call that arrives is run and answered even if the chat was left meanwhile: the reply that
 * made it is still waiting.
 */
async function loop(a) {
  let retry = 2000
  while (!a.stopped) {
    let request
    try {
      request = await get(`/chats/${enc(a.chat)}/page/take?page=${a.page}`)
      retry = 2000
    } catch (err) {
      if (a.stopped) return
      if (err?.status === 410) {
        // The server does not know this page (it restarted, or forgot one that was quiet): said
        // again, and asked after a moment -- not at once, or this is a loop as fast as the network.
        announce(a)
        await wait(2000)
      } else if (err?.status === 409 || err?.status === 404) {
        return stop(a)
      } else {
        await wait(retry)
        retry = Math.min(retry * 2, 30000)
      }
      continue
    }
    if (!request || typeof request.call_id !== "string") continue
    const result = await (nextCall = nextCall.then(() => run(request)))
    await post(`/chats/${enc(a.chat)}/page/answer`, { page_id: a.page, call_id: request.call_id, result }).catch(() => {})
  }
}

/**
 * The chat the window shows changed: `chat` (as the server serialises it) or null. A chat on the
 * server, where Python is on, gets this window as its page; the one before is let go.
 */
export function pythonFor(chat) {
  const want = chat?.id && chat.kind === "chat" && !chat.archived && pythonOffered() ? chat.id : ""
  if (attached?.chat === want && !attached?.stopped) return
  if (attached) {
    const old = attached
    attached = null
    if (!old.stopped) {
      stop(old)
      post(`/chats/${enc(old.chat)}/page/withdraw`, { page_id: old.page }).catch(() => {})
    }
  }
  if (!want) return
  const a = { chat: want, page: pageId(), stopped: false, timer: 0 }
  attached = a
  // The frame is made ready in the background: the first call waits for it, the chat does not.
  frame().catch(() => {})
  announce(a)
  a.timer = setInterval(() => announce(a), ANNOUNCE_EVERY)
  loop(a)
}

export function initPython(context) {
  ctx = { ...ctx, ...context }
  // The window is closing or loading again: said, so the server does not wait on a page that is gone.
  window.addEventListener("pagehide", () => pythonFor(null))
}
