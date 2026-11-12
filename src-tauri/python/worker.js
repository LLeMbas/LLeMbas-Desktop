// The worker the `python` tool's code runs in (runner.js). Pyodide comes from the files beside
// this one; the code gets the files it was handed in Pyodide's own in-memory file system, and
// nothing is read back but the paths it was asked to save. The same worker as the LLeMbas web
// page's (its static/js/python-worker.js).
//
// A module worker: from 314 on Pyodide is ES modules only, so its entry, pyodide.mjs, is imported.

let ready = null

function b64ToBytes(text) {
  const raw = atob(text || "")
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function bytesToB64(bytes) {
  const chunks = []
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)))
  return btoa(chunks.join(""))
}

function ensureDir(py, path) {
  let at = ""
  for (const part of path.split("/").slice(1, -1)) {
    at += `/${part}`
    try {
      py.FS.mkdir(at)
    } catch {
      // already there
    }
  }
}

self.onmessage = (event) => {
  const data = event.data || {}
  if (data.type === "init") {
    ready = import(`${data.indexURL}pyodide.mjs`).then((module) => module.loadPyodide({ indexURL: data.indexURL }))
    // Said when a call comes, not as an unhandled rejection now.
    ready.catch(() => {})
    return
  }
  if (data.type !== "run" || !ready) return
  const request = data.request || {}
  ready
    .then((py) => {
      const out = []
      py.setStdout({ batched: (line) => out.push(line) })
      py.setStderr({ batched: (line) => out.push(line) })
      for (const file of request.files || []) {
        ensureDir(py, file.path)
        py.FS.writeFile(file.path, b64ToBytes(file.content_b64))
      }
      let result = null
      let error = ""
      return py
        .runPythonAsync(String(request.code || ""))
        .then((value) => {
          if (value !== undefined && value !== null) {
            result = String(value && value.toString ? value.toString() : value)
            if (value && value.destroy) value.destroy()
          }
        })
        .catch((problem) => {
          error = String((problem && problem.message) || problem)
        })
        .then(() => {
          const files = []
          for (const path of request.save || []) {
            try {
              files.push({ path, content_b64: bytesToB64(py.FS.readFile(path)) })
            } catch {
              // not written: nothing to save
            }
          }
          self.postMessage({ type: "result", call_id: request.call_id, stdout: out.join("\n"), result, error, files })
        })
    })
    .catch((problem) => {
      self.postMessage({ type: "result", call_id: request.call_id, stdout: "", result: null, error: `Python could not start: ${String((problem && problem.message) || problem)}`, files: [] })
    })
}
