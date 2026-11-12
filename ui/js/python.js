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
//
// One chat's Python never meets another's. The worker in the frame keeps its globals and the
// files a call handed it for as long as it lives, so a frame that has run a call is thrown away
// -- behind any call still running -- whenever the window becomes another chat's page or leaves
// a chat, and the next call gets a new one. The same when the account, the server or the
// server's Pyodide (its version, its files' hashes) is no longer the one the frame was made for.
//
// The window says it is a chat's page only once its runner is there: while the files are still
// being fetched, or could not be, nothing is announced (another page of the chat -- a browser
// tab -- stays the one the server asks), and making it ready is tried again, more slowly each time.

import { h } from "./dom.js"
import { invoke, get, post } from "./bridge.js"

const ANNOUNCE_EVERY = 20000
const enc = encodeURIComponent

let ctx = { me: () => null }
let runner = null // { url, version, frame, ready: Promise, sig, used } once the frame is asked for
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
  if (runner && runner.sig !== signature()) dropFrame()
  if (runner) return runner.ready
  const mine = { url: "", version: "", frame: null, ready: null, sig: signature(), used: false }
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

/** Throw the frame away -- its worker, globals and files with it: the next call makes a new one. */
function dropFrame() {
  runner?.frame?.remove()
  runner = null
}

/**
 * What a frame was made for: the account, and the server's Pyodide as `/me` names it (version,
 * each file's hash). A frame made for another is not used again.
 */
function signature() {
  const me = ctx.me() || {}
  const py = me.python || {}
  const who = me.account && typeof me.account === "object" ? me.account.id || me.account.email || "" : me.account || ""
  return JSON.stringify([who, py.version || "", (py.files || []).map((f) => [f.name, f.sha256])])
}

/**
 * The window is another chat's page now, or no chat's: behind any call still running, a frame
 * that has run one (or was made for another account or release) is thrown away. `always`: also
 * one that has run nothing (no chat is shown: nothing is kept waiting).
 */
function fresh(always) {
  nextCall = nextCall.then(() => {
    if (runner && (always || runner.used || runner.sig !== signature())) dropFrame()
  })
  return nextCall
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

/** The most a call's saved files may weigh together, as base64 (about 48 MB of bytes). */
const MAX_FILES = 64 * 1024 * 1024

/**
 * A call's answer, held to its limits whatever the frame said: what it printed, its value and
 * its error to `output_chars`; only files the call asked to save, each once, text only, and
 * together no more than `MAX_FILES`.
 */
function bounded(x, request) {
  const cap = Math.max(1, Number(request.limits?.output_chars) || 20000)
  const cut = (v) => String(v).slice(0, cap)
  const wanted = new Set((request.save || []).map(String))
  const files = []
  let weight = 0
  let error = cut(x.error || "")
  for (const f of Array.isArray(x.files) ? x.files : []) {
    if (!f || typeof f.path !== "string" || typeof f.content_b64 !== "string" || !wanted.delete(f.path)) continue
    weight += f.content_b64.length
    if (weight > MAX_FILES) {
      error = error || "The files to save are too large together: nothing more was saved."
      break
    }
    files.push({ path: f.path, content_b64: f.content_b64 })
  }
  return { stdout: cut(x.stdout || ""), result: x.result === null || x.result === undefined ? null : cut(x.result), error, files }
}

/**
 * Run one call in the frame and give its result. The frame ends a call that runs past its time;
 * should the frame itself say nothing a while after that, it is replaced and the call says so.
 */
async function run(request) {
  let r
  try {
    r = await frame()
  } catch (err) {
    return { ...failed(`Python could not start: ${err?.detail || err?.message || err}`), unready: true }
  }
  r.used = true
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
      resolve(bounded(e.data.result || {}, request))
    }
    window.addEventListener("message", heard)
    r.frame.contentWindow.postMessage({ type: "run", request }, originOf(r.url))
  })
}

// --- Being the chat's page ---------------------------------------------------------------------------

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
/** A poll answered with nothing sooner than this (ms) was not held by the server. */
const QUICK = 1000

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
  let quiet = QUICK
  while (!a.stopped) {
    let request
    const asked = Date.now()
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
    if (!request || typeof request.call_id !== "string") {
      // Nothing to run. The server holds a poll for a while before saying so; an answer that
      // came at once (a proxy that does not hold it, a server that changed its mind) is not
      // asked again at once -- that would be a loop as fast as the bridge -- but after a pause
      // that grows while it goes on.
      if (Date.now() - asked < QUICK) {
        await wait(quiet)
        quiet = Math.min(quiet * 2, 30000)
      } else quiet = QUICK
      continue
    }
    quiet = QUICK
    const { unready, ...result } = await (nextCall = nextCall.then(() => run(request)))
    await post(`/chats/${enc(a.chat)}/page/answer`, { page_id: a.page, call_id: request.call_id, result }).catch(() => {})
    if (unready && !a.stopped) {
      // The runner is gone and could not be made again: this window is not the chat's page
      // until it can be -- said, so the server asks another page meanwhile.
      clearInterval(a.timer)
      post(`/chats/${enc(a.chat)}/page/withdraw`, { page_id: a.page }).catch(() => {})
      return attach(a)
    }
  }
}

/**
 * Make the runner ready, then say this window is the chat's page and take its calls. Until the
 * runner is there nothing is announced; where it cannot be made (the files could not be fetched
 * or did not verify) it is tried again, each time after longer, and nothing is shown: the chat
 * works as it does without a page here. Python off (409) ends it.
 */
async function attach(a) {
  let pause = 2000
  while (!a.stopped) {
    try {
      // Behind what is queued: the frame of the chat before is thrown away first.
      await nextCall
      if (a.stopped) return
      await frame()
      break
    } catch (err) {
      if (err?.status === 409) return stop(a)
      await wait(pause)
      pause = Math.min(pause * 2, 60000)
    }
  }
  if (a.stopped) return
  announce(a)
  a.timer = setInterval(() => announce(a), ANNOUNCE_EVERY)
  loop(a)
}

/**
 * The chat the window shows changed: `chat` (as the server serialises it) or null. A chat on the
 * server, where Python is on, gets this window as its page; the one before is let go.
 */
export function pythonFor(chat) {
  const want = chat?.id && chat.kind === "chat" && !chat.archived && pythonOffered() ? chat.id : ""
  if (attached?.chat === want && !attached?.stopped) return
  // Another chat's page, or none: what the chat before ran is not kept for the next.
  fresh(!want)
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
  // The runner is made ready in the background; the chat does not wait for it, and the window
  // is announced as its page only once it is there.
  attach(a)
}

export function initPython(context) {
  ctx = { ...ctx, ...context }
  // The window is closing or loading again: said, so the server does not wait on a page that is gone.
  window.addEventListener("pagehide", () => pythonFor(null))
}
