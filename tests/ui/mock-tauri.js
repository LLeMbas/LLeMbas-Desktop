// A stand-in for Tauri's bridge, for the page under a headless browser (tests/ui/run.mjs). Runs
// before the page's own scripts: `window.__TAURI__` answers the commands the page invokes from a
// table the test hands in, and records every call, so a test can say what the page asked for.
//
// The table (`config`):
//   status   what `get_status` answers (the app, the agent, the server)
//   routes   { "GET /me": value, "POST /chats/c1/interactions/k1": value, ... } -- the server's
//            /api/v2 as the page reaches it through `api`. A path is looked up with its query,
//            then without it. A value `{ __error: { status, detail } }` is a refusal. Anything
//            not in the table is a 404, as an older server would answer.
//   hold     ["GET /files?path=%2F", ...] (a path with its query, or without for any query) -- answers that wait (a slow server) until the test
//            lets them go with `__mock.release(key)`; the table is read when they are let go.
//   streams  { "/chats/c1/messages/m1/stream": [[event, data], ...] } -- the frames a followed
//            reply sends as soon as it is opened. More can be sent later with `__mock.frame()`.
//   terminal [[kind, data], ...] -- what every terminal's socket sends as soon as it is opened
//            (`control` frames as the server's JSON, `output` as text, sent base64 as Rust does).
//            More with `__mock.shell(kind, data)`; `{ refuse: {status, detail} }` makes
//            `terminal_open` fail; `terminalDelay` (ms) is how long the socket takes to open
//            (the id comes at once, as from Rust; the frames after that long).
//   python   { url, version } -- where `python_prepare` says the `python` tool's runner frame is.
//   takes    { "/chats/c1/page/take": [call, …] } -- what a runner's long poll is handed, one
//            call a poll, each answered after `takeDelay` ms; with none left the poll is held
//            as the server holds it (`takeHold` ms, 25 s unless said), then answered with
//            nothing (204). `__mock.call(path, call)` queues another and lets a held poll go.
//
// Nothing here talks to a network: the page's policy allows it none, and this keeps it so.
;(function () {
  const config = window.__mockConfig || {}
  const listeners = new Map() // event name -> [callback]
  const streams = new Map() // stream id -> { path, started, queue }
  const terminals = new Map() // terminal id -> { target, open }
  let nextTerminal = 0
  let nextStream = 0
  const calls = []

  function dispatch(name, payload) {
    for (const cb of listeners.get(name) || []) cb({ event: name, payload })
  }

  const held = [] // [{ key, go }] answers waiting for `release`
  const polls = new Set() // long polls held with nothing to hand over: { bare, go }

  function route(method, path) {
    const key = (config.hold || []).find((k) => k === `${method} ${path}` || k === `${method} ${path.split("?")[0]}`)
    if (key) {
      return new Promise((resolve) => held.push({ key, go: resolve })).then(() => answer(method, path))
    }
    return answer(method, path)
  }

  function answer(method, path) {
    const routes = config.routes || {}
    const bare = path.split("?")[0]
    // A runner's long poll: the next queued call after a moment, or -- with none queued -- held
    // as the server holds it (`takeHold` ms, 25 s unless said) and then answered with nothing.
    // A call queued meanwhile (`__mock.call`) or a changed answer (`__mock.answer`) lets it go.
    if (method === "GET" && config.takes && Object.prototype.hasOwnProperty.call(config.takes, bare) && !Object.prototype.hasOwnProperty.call(routes, `GET ${bare}`)) {
      const next = () => JSON.parse(JSON.stringify(config.takes[bare].shift() ?? null))
      if (config.takes[bare].length) return new Promise((resolve) => setTimeout(() => resolve(next()), config.takeDelay ?? 50))
      return new Promise((resolve) => {
        const poll = { bare, go: () => (clearTimeout(timer), polls.delete(poll), resolve(answer(method, path))) }
        const timer = setTimeout(() => (polls.delete(poll), resolve(null)), config.takeHold ?? 25000)
        polls.add(poll)
      })
    }
    for (const key of [`${method} ${path}`, `${method} ${bare}`]) {
      if (Object.prototype.hasOwnProperty.call(routes, key)) {
        const value = routes[key]
        if (value && value.__error) return Promise.reject(value.__error)
        return Promise.resolve(JSON.parse(JSON.stringify(value)))
      }
    }
    return Promise.reject({ status: 404, detail: `Not in the test's table: ${method} ${path}` })
  }

  // The shell's bytes, base64 as Rust sends them (`terminal.rs`): UTF-8 first.
  const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

  function shell(kind, data, id) {
    const ids = id ? [id] : [...terminals.keys()].filter((k) => terminals.get(k).open)
    for (const tid of ids) {
      if (kind === "end") terminals.get(tid).open = false
      dispatch("terminal", { id: tid, kind, data: kind === "output" ? b64(data) : data })
    }
  }

  // A frame a test sends for a reply whose first frames (the table's) have not gone out yet
  // waits behind them: sent ahead, the table's would arrive after it and undo it.
  function frame(path, event, data) {
    for (const [id, s] of streams) {
      if (s.path !== path) continue
      if (s.started) dispatch("stream", { id, event, data })
      else s.queue.push([event, data])
    }
  }

  async function invoke(cmd, args) {
    calls.push({ cmd, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) })
    switch (cmd) {
      case "get_status":
        return JSON.parse(JSON.stringify(config.status))
      case "api":
        return route(args.method, args.path)
      case "api_text":
        return route("GET", args.path)
      case "stream_open": {
        const id = ++nextStream
        const s = { path: args.path, started: false, queue: [] }
        streams.set(id, s)
        const frames = (config.streams || {})[args.path] || []
        setTimeout(() => {
          for (const [event, data] of frames) dispatch("stream", { id, event, data })
          s.started = true
          for (const [event, data] of s.queue.splice(0)) if (streams.has(id)) dispatch("stream", { id, event, data })
        }, 0)
        return id
      }
      case "stream_close":
        streams.delete(args.id)
        return null
      case "terminal_open": {
        const t = config.terminal || []
        if (t.refuse) return Promise.reject(t.refuse)
        // As the real bridge: the id comes at once, before the socket is open (Rust keeps what
        // is typed meanwhile and sends it when it is); the socket's first frames come after
        // `terminalDelay` ms (a slow server), at once without one.
        const id = ++nextTerminal
        terminals.set(id, { target: { chat: args.chat, device: args.device, directory: args.directory }, open: true })
        setTimeout(() => {
          for (const [kind, data] of config.terminal || []) if (terminals.get(id).open) shell(kind, data, id)
        }, config.terminalDelay || 0)
        return id
      }
      case "terminal_input":
      case "terminal_resize":
        return !!terminals.get(args.id)?.open
      case "terminal_close": {
        const t = terminals.get(args.id)
        if (t?.open) setTimeout(() => shell("end", { code: 1000, reason: "", status: null, error: null }, args.id), 0)
        return null
      }
      case "python_prepare": {
        // The runner's frame, as Rust would serve it: `python: { url, version }` in the config
        // (tests/ui serves the frame's files at that address), `{ __error }` for a refusal, and
        // nothing for a server with Python off.
        // `pythonDelay` (ms): the files are still being fetched.
        if (config.pythonDelay) await new Promise((done) => setTimeout(done, config.pythonDelay))
        const py = config.python
        if (py && py.__error) return Promise.reject(py.__error)
        return py ? { enabled: true, version: py.version, url: py.url } : { enabled: false, version: "", url: "" }
      }
      case "page_open": {
        // A page of an answer, as Rust would hold it: the address of its sealed frame (tests/ui
        // serves the server's rebuilt document there, under Rust's own policy for it).
        // `pages: { __error }` refuses; `pages: { slow: ms }` takes that long.
        const pg = config.pages || {}
        if (pg.slow) await new Promise((done) => setTimeout(done, pg.slow))
        if (pg.__error) return Promise.reject(pg.__error)
        return { url: `http://sealed.test/${args.kind}/${args.owner}/${args.digest}`, title: "" }
      }
      case "model_image":
        return ""
      case "terminal_word":
        return "lembas"
      default: {
        // A command the test answers itself: `commands: { name: value }` (an `__error` rejects).
        const own = (config.commands || {})[cmd]
        if (own && own.__error) return Promise.reject(own.__error)
        return own === undefined ? null : JSON.parse(JSON.stringify(own))
      }
    }
  }

  const win = {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
  }

  window.__TAURI__ = {
    core: { invoke },
    event: {
      listen: async (name, cb) => {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(cb)
        return () => listeners.set(name, (listeners.get(name) || []).filter((x) => x !== cb))
      },
    },
    window: { getCurrentWindow: () => win },
  }

  window.__mock = {
    calls,
    /** Let the held answers for `key` go, in the order they were asked; stop holding new ones. */
    release(key) {
      config.hold = (config.hold || []).filter((k) => k !== key)
      const going = held.filter((x) => x.key === key)
      for (const x of going) held.splice(held.indexOf(x), 1)
      for (const x of going) x.go()
    },
    /** Queue a call for a runner's long poll on `path`. */
    call(path, request) {
      config.takes = config.takes || {}
      ;(config.takes[path] = config.takes[path] || []).push(request)
      for (const poll of [...polls]) if (poll.bare === path) poll.go()
    },
    /** Change the server's answer for a route from now on. */
    answer(key, value) {
      config.routes[key] = value
      for (const poll of [...polls]) if (key === `GET ${poll.bare}`) poll.go()
    },
    frame,
    emit: dispatch,
    /** The calls of one command, or of `api` with one method and path prefix. */
    api: (method, prefix) => calls.filter((c) => c.cmd === "api" && c.args.method === method && c.args.path.startsWith(prefix)),
    streams: () => [...streams.values()].map((s) => s.path),
    shell,
    /** The terminals opened so far: [{ id, target, open }]. */
    terminals: () => [...terminals].map(([id, t]) => ({ id, ...t })),
    /** What was typed into a terminal, joined. */
    typed: () => calls.filter((c) => c.cmd === "terminal_input").map((c) => c.args.data).join(""),
  }
})()
