// The `python` tool's runner, inside its own frame.
//
// LLeMbas Desktop draws this page in a hidden frame from an address of its own
// (`llembas-python://`, src-tauri/src/python.rs): not the app's origin, so nothing here can call
// the app -- there is no bridge in this frame -- and, by the policy this page is served under,
// nothing here can reach the network: only the files beside it (Pyodide, CPython in WebAssembly,
// fetched and verified by the app). The app's page hands a call in by `postMessage` and gets its
// result back the same way; that is the whole of what crosses.
//
// The call and its answer are the server's (`services/pages.py`, as the web page's runner has
// them): `{call_id, code, files: [{path, content_b64}], save: [path], limits: {seconds, memory,
// output_chars}}` in, `{stdout, result, error, files: [{path, content_b64}]}` out. A call that
// runs past its time is ended by ending the worker, and says so.

const version = new URLSearchParams(location.search).get("v") || ""
const indexURL = new URL(`pyodide/${version}/`, location.href).href
let worker = null
let busy = false

function freshWorker() {
  if (worker) worker.terminate()
  worker = new Worker(new URL("worker.js", location.href), { type: "module" })
  worker.postMessage({ type: "init", indexURL })
  return worker
}

function run(request) {
  const limits = request.limits || {}
  const seconds = Math.max(1, Number(limits.seconds) || 30)
  return new Promise((resolve) => {
    const w = worker || freshWorker()
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    // A little past the limit: the worker cannot be asked to stop, only ended.
    const timer = setTimeout(() => {
      w.terminate()
      if (worker === w) worker = null
      finish({ stdout: "", result: null, error: `Stopped after ${seconds} seconds.`, files: [] })
    }, seconds * 1000 + 5000)
    w.onerror = (event) => {
      // The worker itself failed (its script or Pyodide could not be loaded): a new one next time.
      w.terminate()
      if (worker === w) worker = null
      finish({ stdout: "", result: null, error: `Python could not start: ${event?.message || "the worker failed"}`, files: [] })
    }
    w.onmessage = (event) => {
      const data = event.data || {}
      if (data.type !== "result" || data.call_id !== request.call_id) return
      // Held to the call's limits here, and again by the app's page: what was printed, the
      // value and the error to `output_chars`; only the files the call asked to save.
      const cap = Math.max(1, Number(limits.output_chars) || 20000)
      const cut = (v) => String(v).slice(0, cap)
      const wanted = new Set((request.save || []).map(String))
      const files = (Array.isArray(data.files) ? data.files : []).filter((f) => f && typeof f.path === "string" && typeof f.content_b64 === "string" && wanted.delete(f.path))
      finish({ stdout: cut(data.stdout || ""), result: data.result === null || data.result === undefined ? null : cut(data.result), error: cut(data.error || ""), files })
    }
    w.postMessage({ type: "run", request })
  })
}

window.addEventListener("message", async (event) => {
  // Only the page that holds this frame speaks to it.
  if (event.source !== window.parent) return
  const data = event.data || {}
  const reply = (message) => window.parent.postMessage(message, event.origin && event.origin !== "null" ? event.origin : "*")
  if (data.type === "reset") {
    if (worker) worker.terminate()
    worker = null
    busy = false
    return
  }
  if (data.type !== "run" || !data.request || typeof data.request.call_id !== "string") return
  if (busy) return reply({ type: "result", call_id: data.request.call_id, result: { stdout: "", result: null, error: "Python is still running the call before this one.", files: [] } })
  busy = true
  try {
    reply({ type: "result", call_id: data.request.call_id, result: await run(data.request) })
  } finally {
    busy = false
  }
})

// A frame is made new for every chat, and nothing of the one before may be found by it: what
// code may have put in this origin's own storage (IndexedDB, caches) is cleared before the app
// is told the runner is here. Pyodide itself keeps its files in memory only.
async function forget() {
  try {
    for (const db of (await indexedDB.databases?.()) || []) if (db.name) indexedDB.deleteDatabase(db.name)
  } catch {}
  try {
    for (const key of await caches.keys()) await caches.delete(key)
  } catch {}
}

// Only as a frame of the app's page: opened as a page of its own, it does nothing.
if (window.parent !== window) {
  // Here, and what it will load. The app's page announces itself to the server as the chat's
  // page only after this arrives; Pyodide itself is loaded by the worker at the first call.
  forget().finally(() => window.parent.postMessage({ type: "ready", version }, "*"))
}
