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
//
// Nothing here talks to a network: the page's policy allows it none, and this keeps it so.
;(function () {
  const config = window.__mockConfig || {}
  const listeners = new Map() // event name -> [callback]
  const streams = new Map() // stream id -> path
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
      case "model_image":
        return ""
      case "terminal_word":
        return "lembas"
      default:
        return null
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
  }
})()
