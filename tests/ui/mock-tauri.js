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
//   streams  { "/chats/c1/messages/m1/stream": [[event, data], ...] } -- the frames a followed
//            reply sends as soon as it is opened. More can be sent later with `__mock.frame()`.
//   terminal [[kind, data], ...] -- what every terminal's socket sends as soon as it is opened
//            (`control` frames as the server's JSON, `output` as text, sent base64 as Rust does).
//            More with `__mock.shell(kind, data)`; `{ refuse: {status, detail} }` makes
//            `terminal_open` fail.
//
// Nothing here talks to a network: the page's policy allows it none, and this keeps it so.
;(function () {
  const config = window.__mockConfig || {}
  const listeners = new Map() // event name -> [callback]
  const streams = new Map() // stream id -> path
  const terminals = new Map() // terminal id -> { target, open }
  let nextTerminal = 0
  let nextStream = 0
  const calls = []

  function dispatch(name, payload) {
    for (const cb of listeners.get(name) || []) cb({ event: name, payload })
  }

  function route(method, path) {
    const routes = config.routes || {}
    const bare = path.split("?")[0]
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

  function frame(path, event, data) {
    for (const [id, p] of streams) if (p === path) dispatch("stream", { id, event, data })
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
        streams.set(id, args.path)
        const frames = (config.streams || {})[args.path] || []
        setTimeout(() => {
          for (const [event, data] of frames) dispatch("stream", { id, event, data })
        }, 0)
        return id
      }
      case "stream_close":
        streams.delete(args.id)
        return null
      case "terminal_open": {
        const t = config.terminal || []
        if (t.refuse) return Promise.reject(t.refuse)
        const id = ++nextTerminal
        terminals.set(id, { target: { chat: args.chat, device: args.device, directory: args.directory }, open: true })
        setTimeout(() => {
          for (const [kind, data] of t) shell(kind, data, id)
        }, 0)
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
    frame,
    emit: dispatch,
    /** The calls of one command, or of `api` with one method and path prefix. */
    api: (method, prefix) => calls.filter((c) => c.cmd === "api" && c.args.method === method && c.args.path.startsWith(prefix)),
    streams: () => [...streams.values()],
    shell,
    /** The terminals opened so far: [{ id, target, open }]. */
    terminals: () => [...terminals].map(([id, t]) => ({ id, ...t })),
    /** What was typed into a terminal, joined. */
    typed: () => calls.filter((c) => c.cmd === "terminal_input").map((c) => c.args.data).join(""),
  }
})()
