// A stand-in for Pyodide's entry (pyodide.mjs), for tests/ui: the runner's frame and worker
// (src-tauri/python/) are the real ones, and this is what they load in place of CPython, so the
// path of a call -- the frame, the worker, files in and out, the time limit -- is held without
// 13 MB of WebAssembly in the repository. It "runs" a few lines a test writes:
//
//   print("…")                 printed
//   raise "…"                  an error
//   read /path                 prints the file's text (one the call handed in)
//   write /path text…          writes a file (read back when the call asks to save it)
//   forever                    never finishes (the time limit ends the worker)
//   = value                    the run's last value
//
// The real thing is proved by `PYODIDE_DIR=<a verified release> node tests/ui/run.mjs PY`.
export async function loadPyodide({ indexURL }) {
  if (!indexURL.endsWith("/")) throw new Error("indexURL")
  const files = new Map()
  let out = { batched: () => {} }
  return {
    setStdout: (o) => (out = o),
    setStderr: () => {},
    FS: {
      mkdir: () => {},
      writeFile: (path, bytes) => files.set(path, bytes),
      readFile: (path) => {
        if (!files.has(path)) throw new Error(`No such file: ${path}`)
        return files.get(path)
      },
    },
    async runPythonAsync(code) {
      let value
      for (const line of String(code).split("\n")) {
        const [word, ...rest] = line.trim().split(" ")
        const arg = rest.join(" ")
        if (word === "print") out.batched(arg)
        else if (word === "raise") throw new Error(arg)
        else if (word === "read") out.batched(new TextDecoder().decode(files.get(arg) || new Uint8Array()))
        else if (word === "write") files.set(rest[0], new TextEncoder().encode(rest.slice(1).join(" ")))
        else if (word === "forever") await new Promise(() => {})
        else if (word === "=") value = arg
      }
      return value
    },
  }
}
