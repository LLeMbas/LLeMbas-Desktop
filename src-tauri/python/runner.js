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
      const cap = Number(limits.output_chars) || 20000
      finish({ stdout: String(data.stdout || "").slice(0, cap), result: data.result ?? null, error: data.error || "", files: data.files || [] })
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

// Here, and what it will load: the app waits for this before it says the chat has a runner.
window.parent.postMessage({ type: "ready", version }, "*")
