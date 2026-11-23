#!/usr/bin/env node
// The page under a headless browser, against a mocked bridge (tests/ui/mock-tauri.js): what the
// person sees for a given answer of the server's /api/v2, and what the page sends back.
//
//     node tests/ui/run.mjs [name-filter]
//
// Needs Playwright (`playwright` or `playwright-core`, from NODE_PATH or a node_modules beside
// the repository) and a Chromium: Playwright's own, or the one in $CHROMIUM (/usr/bin/chromium
// is tried when Playwright has none). With $ENGINE=webkit it is Playwright's WebKit instead:
// nearer the engine the app has on Linux and macOS, for the tests that turn on what an engine does. Nothing is built and no server is started: the page's
// files are handed to the browser from ui/ as they are in the repository. With $SHOTS set to a
// directory, some tests leave a screenshot there.
//
// The shapes are the server's (`api/v2/serialise.py`, its fixtures in tests/fixtures/api_v2),
// with made-up names. Where the server's fixture differs from what its code sends, the test
// says so and follows the code.

import { createRequire } from "node:module"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, extname } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))
// The page's files: the repository's, or another copy of them ($UI_DIR) to see what a test says of it.
const UI = process.env.UI_DIR || join(HERE, "..", "..", "ui")
const ORIGIN = "http://app.test"
const require = createRequire(join(process.cwd(), "noop.js"))
const RUNNER = "http://runner.test"
// The policy the runner's files are served under: Rust's own (src-tauri/src/python.rs `POLICY`),
// read out of the source, so the frame is tested under exactly what the app sends.
const RUNNER_POLICY = /pub const POLICY: &str = "([^"]+)";/.exec(readFileSync(join(HERE, "..", "..", "src-tauri", "src", "python.rs"), "utf8"))[1]
// A page of an answer: served to its sealed frame as Rust serves it -- the server's rebuilt
// document (fixture page.json) under Rust's own policy for such a page (sealed.rs `PAGE_POLICY`),
// read out of the source. A script is added to the document here, which the server's never has:
// what the frame and the policy must hold to is that it does not run.
const SEALED = "http://sealed.test"
const PAGE_POLICY = /pub const PAGE_POLICY: &str = "([^"]+)";/.exec(readFileSync(join(HERE, "..", "..", "src-tauri", "src", "sealed.rs"), "utf8"))[1]
// The sealed viewers of a PDF and of a 3D model: the server's own page, scripts and PDF.js as
// the app carries them (src-tauri/viewers/, pinned by scripts/fetch-vendor.sh), put together as
// Rust does (`sealed::viewer`) and served under Rust's own policy for a sealed page (`POLICY`).
const SEALED_POLICY = /pub const POLICY: &str = "([^"]+)";/.exec(readFileSync(join(HERE, "..", "..", "src-tauri", "src", "sealed.rs"), "utf8"))[1]
const viewerFile = (name) => readFileSync(join(HERE, "..", "..", "src-tauri", "viewers", name), "utf8")
const viewerPage = (kind) => viewerFile("shell.html").replace("/*SCRIPT*/", () => viewerFile(kind === "pdf" ? "sealed-pdf.js" : "sealed-model.js").replaceAll("</script", "<\\/script"))
// Where the tests serve what the viewer draws and plays (`media_open` in the mock), and what:
// a one-pixel PNG, an SVG that would run a script were it ever a document, a tenth of a second of
// silence.
const MEDIA = "http://media.test"
const MEDIA_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const MEDIA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="document.title='an svg ran'"><script>document.title = "an svg ran"</script><rect width="40" height="20" fill="#888"/></svg>`
const MEDIA_WAV = (() => {
  const rate = 8000
  const data = Buffer.alloc(rate / 10)
  const head = Buffer.alloc(44)
  head.write("RIFF", 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write("WAVEfmt ", 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate, 28)
  head.writeUInt16LE(1, 32)
  head.writeUInt16LE(8, 34)
  head.write("data", 36)
  head.writeUInt32LE(data.length, 40)
  data.fill(128)
  return Buffer.concat([head, data])
})()
const RUNNER_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".zip": "application/zip", ".json": "application/json" }

function playwright() {
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return require(name)
    } catch {}
    try {
      return createRequire(import.meta.url)(name)
    } catch {}
  }
  console.error("tests/ui: Playwright is not installed (npm install playwright-core, and put it on NODE_PATH)")
  process.exit(2)
}

async function launch() {
  const engine = process.env.ENGINE || "chromium"
  if (engine !== "chromium") return playwright()[engine].launch()
  const { chromium } = playwright()
  const paths = [process.env.CHROMIUM, "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean)
  if (!process.env.CHROMIUM) {
    try {
      return await chromium.launch()
    } catch {}
  }
  for (const executablePath of paths) if (existsSync(executablePath)) return chromium.launch({ executablePath })
  throw new Error("tests/ui: no Chromium found (set CHROMIUM)")
}

/** One of the server's /api/v2 contract fixtures, as copied by scripts/fetch-fixtures.sh. */
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", `${name}.json`), "utf8"))

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".mjs": "text/javascript", ".json": "application/json" }

// --- The server, as the tests' table -----------------------------------------------------------

const STAMP = "2026-01-02T03:04:05+00:00"

function status(over = {}) {
  return {
    version: "1.0.0-test",
    server: "https://ai.example",
    discovery: { name: "Example", app: "https://ai.example/api/v2", version: "2.0.0" },
    refused: null,
    checked: true,
    account: { name: "Ada Example", email: "ada@example.org" },
    signing_in: false,
    linked: true,
    agent: { state: "running", detail: null },
    agent_wanted: true,
    update: null,
    remote: { enabled: true, roots: ["/home/dev/project"] },
    theme: "moria",
    host: "workbench",
    notify: false,
    ...over,
  }
}

const SUB = (offered, named_only = false) => ({ offered, named_only })

/** The models as `/api/v2/models` lists them; `subagents` per model as the server works it out. */
function models({ qwen = SUB(true), solo = SUB(true, true), plain = SUB(false) } = {}) {
  const base = { vision: false, tools: true, efforts: ["low", "medium", "high"], thinking_switch: false, levels: ["low", "medium", "high"], effort: "medium", control: "slider", context: 131072, image: null }
  return {
    models: [
      { ...base, id: "qwen", name: "Qwen", parallel: 2, default: true, subagents: qwen },
      { ...base, id: "solo", name: "Solo", parallel: 1, default: false, subagents: solo },
      { ...base, id: "plain", name: "Plain", parallel: 1, default: false, subagents: plain },
    ],
    subagents_cap: 8,
  }
}

function chatRow(over = {}) {
  return {
    id: "chat1",
    kind: "chat",
    title: "Waybread",
    model: "qwen",
    folder_id: null,
    pinned: false,
    archived: false,
    temporary: false,
    unread: false,
    running: false,
    mode: "",
    effort: "medium",
    device: null,
    device_session_id: null,
    parent_chat_id: null,
    agents: { min: 1, max: 4 },
    subagents: { offered: true, named_only: false, cap: 8 },
    created_at: STAMP,
    updated_at: STAMP,
    ...over,
  }
}

function agentChat(over = {}) {
  return chatRow({
    id: "chat2",
    kind: "agent",
    title: "Tidy the build",
    running: true,
    mode: "edit",
    device: { token_id: "token1", directory: "/home/dev/project" },
    device_session_id: "ses_01",
    // An agent chat's team runs on its device: the server offers no setting (team_run.may_have_team).
    subagents: { offered: false, named_only: false, cap: 8 },
    ...over,
  })
}

const userMessage = (id, text) => ({ id, role: "user", created_at: STAMP, complete: true, stopped: false, error: null, queued: false, machine: false, origin: "", model: null, attachments: [], text })

/**
 * A device's bash approval as `services/device_link.py:_permission` builds it and
 * `api/v2/serialise.py:interruption` sends it: the title is the fixed "Run a command", the command
 * is in `detail`, and it is `editable`. (The server's fixture `event_ask.json` puts the command in
 * the title; its code does not.)
 */
function deviceBashCard(over = {}) {
  return {
    id: "card7",
    kind: "approval",
    why: "",
    dismissable: false,
    expires_in: 1800,
    items: [
      {
        index: 0,
        key: "0",
        kind: "approval",
        tool: "bash",
        title: "Run a command",
        header: "",
        detail: "ls -la build",
        reason: "Edit mode asks before anything that runs a command.",
        purpose: "See what is in the build directory",
        options: [],
        multiple: false,
        free_text: true,
        editable: true,
        plan: null,
        mode_choice: false,
        job: "",
      },
    ],
    ...over,
  }
}

function baseRoutes(over = {}) {
  return {
    "GET /me": { id: "u1", name: "Ada Example", email: "ada@example.org", theme: "moria", language: "en", permissions: {} },
    "GET /models": models(),
    "GET /devices": { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: true }] },
    "GET /chats": { chats: [chatRow(), agentChat()], more: false },
    "GET /schedules": { schedules: [] },
    ...over,
  }
}

// --- The browser --------------------------------------------------------------------------------

let browser
// Every context a test opens, closed after the test whether it passed or not: a failed test used
// to leave its pages alive, their timers running, for the rest of the run.
const opened = new Set()

async function page(config, { width = 1280, height = 860, clock = false, wait = "#shell:not([hidden])", lang = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height } })
  opened.add(context)
  context.on("close", () => opened.delete(context))
  const p = await context.newPage()
  // The page's own timers, moved on by the test (`p.clock.fastForward`) rather than waited for.
  if (clock) await p.clock.install()
  const errors = []
  p.on("pageerror", (e) => (errors.push(String(e)), process.env.DEBUG_UI && console.log("pageerror", String(e.stack || e))))
  // The `python` tool's runner, on an origin of its own as in the app: the frame's three files
  // from src-tauri/python/ under the policy Rust serves them with, and Pyodide -- the stand-in
  // (tests/ui/pyodide-stub.mjs), or a real verified release from $PYODIDE_DIR.
  await context.route(`${RUNNER}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    const headers = { "Content-Security-Policy": RUNNER_POLICY, "X-Content-Type-Options": "nosniff" }
    const own = ["/runner.html", "/runner.js", "/worker.js"].includes(path) ? join(HERE, "..", "..", "src-tauri", "python", path.slice(1)) : null
    const m = /^\/pyodide\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(path)
    const real = m && process.env.PYODIDE_DIR && m[1] === "real" ? join(process.env.PYODIDE_DIR, m[2]) : null
    const stub = m && m[1] === "0.0.0-test" && m[2] === "pyodide.mjs" ? join(HERE, "pyodide-stub.mjs") : null
    const file = own || real || stub
    if (!file || !existsSync(file)) return route.fulfill({ status: 404, headers, body: "" })
    return route.fulfill({ status: 200, headers, contentType: RUNNER_TYPES[extname(file)] || "application/octet-stream", body: readFileSync(file) })
  })
  await context.route(`${SEALED}/**`, (route) => {
    const viewer = /^\/viewer\/(pdf|model3d)$/.exec(new URL(route.request().url()).pathname)
    if (viewer) return route.fulfill({ status: 200, headers: { "Content-Security-Policy": SEALED_POLICY, "X-Content-Type-Options": "nosniff" }, contentType: "text/html; charset=utf-8", body: viewerPage(viewer[1]) })
    const html = `${fixture("page").html}<script>document.title = "a script ran"; document.body.append("a script ran")</script>`
    return route.fulfill({ status: 200, headers: { "Content-Security-Policy": PAGE_POLICY, "X-Content-Type-Options": "nosniff" }, contentType: "text/html; charset=utf-8", body: html })
  })
  // What the viewer draws and plays, as Rust's media scheme would serve it: by the kind and the
  // path the page asked `media_open` for. A name with "broken" in it is not served at all.
  await context.route(`${MEDIA}/**`, (route) => {
    const [, kind, name] = new URL(route.request().url()).pathname.split("/")
    // An address Rust has given up (the mock's `mediaStale`), and a file that is not there.
    if (kind === "stale" || decodeURIComponent(name || "").includes("broken")) return route.fulfill({ status: 404, body: "" })
    // A picture of a size of its own (640 x 480), for where the room a picture takes is the question.
    if (kind === "image" && (name || "").includes("big")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: POS_BIG })
    if (kind === "image") return route.fulfill({ status: 200, contentType: "image/png", body: MEDIA_PNG })
    if (kind === "svg") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: MEDIA_SVG })
    return route.fulfill({ status: 200, contentType: "audio/wav", body: MEDIA_WAV })
  })
  await context.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    const file = join(UI, path === "/" ? "index.html" : decodeURIComponent(path))
    if (!file.startsWith(UI) || !existsSync(file)) return route.fulfill({ status: 404, body: "" })
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || "application/octet-stream", body: readFileSync(file) })
  })
  await p.addInitScript((c) => {
    window.__mockConfig = c
  }, config)
  // Another language than the account's: chosen as Settings would keep it, before the page loads.
  if (lang) await p.addInitScript((code) => localStorage.setItem("lembas.language", code), lang)
  await p.addInitScript({ path: join(HERE, "mock-tauri.js") })
  // Every menu the page opens, in every test, is looked at as it appears: a row's label and its
  // hint never touch (8 px between them at least) and neither runs out of the menu, which is
  // inside the window. What is wrong is kept for the run loop, which fails the test for it.
  await p.addInitScript(() => {
    window.__menuProblems = []
    const look = (menu) => {
      const box = menu.getBoundingClientRect()
      if (box.left < -0.5 || box.right > innerWidth + 0.5) window.__menuProblems.push(`a menu outside the window (${Math.round(box.left)}..${Math.round(box.right)} of ${innerWidth})`)
      for (const item of menu.querySelectorAll(".menu__item")) {
        const hint = item.querySelector(".menu__hint")
        if (!hint) continue
        const label = hint.previousElementSibling
        const [l, h] = [label.getBoundingClientRect(), hint.getBoundingClientRect()]
        const said = `"${label.textContent}" / "${hint.textContent}"`
        if (h.left - l.right < 8) window.__menuProblems.push(`a menu row's label and hint touch (${Math.round(h.left - l.right)} px): ${said}`)
        if (l.left < box.left - 0.5 || h.right > box.right + 0.5 || h.width < 8 || l.width < 8) window.__menuProblems.push(`a menu row's label or hint outside its menu, or gone: ${said}`)
        if (getComputedStyle(hint).fontSize === getComputedStyle(label).fontSize && getComputedStyle(hint).color === getComputedStyle(label).color) window.__menuProblems.push(`a menu row's hint looks like its label: ${said}`)
      }
    }
    new MutationObserver((changes) => {
      for (const c of changes) for (const n of c.addedNodes) if (n.nodeType === 1 && n.classList.contains("menu")) queueMicrotask(() => n.isConnected && look(n))
    }).observe(document, { childList: true, subtree: true })
  })
  await p.goto(`${ORIGIN}/index.html`)
  await p.waitForSelector(wait)
  p.errors = errors
  return p
}

async function openChatRow(p, id) {
  await p.click(`.chatrow[data-id="${id}"]`)
  await p.waitForSelector(`#messages .msg`)
}

// --- The tests ----------------------------------------------------------------------------------

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const STREAM2 = "/chats/chat2/messages/m2/stream"

function agentChatOpen(frames, over = {}) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /chats/chat2": { chat: agentChat(), messages: [userMessage("m1", "What is in build?")], more: false, live: "m2" },
      "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null },
      "POST /chats/chat2/interactions/card8": { answered: true, remembered: false, not_remembered: [] },
      "GET /models?chat=chat2": models(),
      "POST /chats/chat2/interactions/card7": { answered: true, remembered: false, not_remembered: [] },
      ...over,
    }),
    streams: { [STREAM2]: frames },
  }
}

test("A1: an agent chat's device bash approval shows as a card, the command editable, and Allow answers it", async () => {
  const card = deviceBashCard()
  const p = await page(
    agentChatOpen([
      ["steps", { steps: [], tail: { thinking: false, text: "", label: "" } }],
      ["status", { text: "Waiting for you to allow bash…" }],
      ["ask", { cards: [card] }],
    ]),
  )
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards:not([hidden]) .ask")
  assert.equal(await p.textContent(".msg.is-live .msg__status"), "Waiting for you to allow bash…")
  const cardBox = await p.locator("#cards .ask").boundingBox()
  const view = p.viewportSize()
  assert.ok(cardBox && cardBox.height > 40, "the card has a size")
  assert.ok(cardBox.y >= 0 && cardBox.y + 20 <= view.height, `the card is on the screen (y=${cardBox.y})`)
  assert.ok(await p.locator("#cards .ask").isVisible(), "the card is visible")
  // The command is the item's `detail`, in the box to correct it; the title is not the command.
  assert.equal(await p.inputValue("#cards .ask__edit"), "ls -la build")
  const text = await p.textContent("#cards .ask")
  assert.match(text, /bash/)
  assert.match(text, /See what is in the build directory/, "the model's purpose is said")
  assert.match(text, /Edit mode asks before anything that runs a command\./, "the server's reason is said")
  if (process.env.SHOTS) await p.screenshot({ path: join(process.env.SHOTS, "a1-card.png") })
  await p.click("#cards .ask__actions .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/").length === 1)
  const [post] = await p.evaluate(() => window.__mock.api("POST", "/chats/chat2/interactions/"))
  assert.equal(post.args.path, "/chats/chat2/interactions/card7")
  assert.deepEqual(post.args.body, { verdict: "allow", choices: {}, texts: {} }, "an untouched command is not sent as an edit")
  await p.waitForSelector("#cards", { state: "hidden" })
  assert.deepEqual(p.errors, [])
})

test("A1: a corrected command is sent as the item's text; Deny sends deny", async () => {
  const p = await page(agentChatOpen([["ask", { cards: [deviceBashCard()] }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask__edit")
  await p.fill("#cards .ask__edit", "ls -la build/out")
  await p.click("#cards .ask__actions .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/").length === 1)
  const [post] = await p.evaluate(() => window.__mock.api("POST", "/chats/chat2/interactions/"))
  assert.deepEqual(post.args.body, { verdict: "allow", choices: {}, texts: { 0: "ls -la build/out" } })
  // The next one, refused.
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [c] }), [STREAM2, deviceBashCard({ id: "card8" })])
  await p.waitForSelector("#cards .ask__edit")
  await p.click("#cards .ask__actions .btn >> text=Deny")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/card8").length === 1)
  const [deny] = await p.evaluate(() => window.__mock.api("POST", "/chats/chat2/interactions/card8"))
  assert.deepEqual(deny.args.body, { verdict: "deny", choices: {}, texts: {} })
  assert.deepEqual(p.errors, [])
})

test("A1: a card that arrives while the person is typing keeps what they typed and is not drawn again by an unchanged frame", async () => {
  const card = deviceBashCard()
  const p = await page(agentChatOpen([["ask", { cards: [card] }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask__edit")
  await p.fill("#cards .ask__edit", "ls build")
  // The server sends the frame again when anything in it changes -- here only the countdown.
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [{ ...c, expires_in: 1790 }] }), [STREAM2, card])
  await p.evaluate(([path]) => window.__mock.frame(path, "status", { text: "Waiting for you to allow bash…" }), [STREAM2])
  assert.equal(await p.inputValue("#cards .ask__edit"), "ls build")
  assert.equal(await p.locator("#cards .ask").count(), 1)
  // A second card joins the first without wiping it; the answered one goes.
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [c, { ...c, id: "card8", items: [{ ...c.items[0], detail: "make clean" }] }] }), [STREAM2, card])
  assert.equal(await p.locator("#cards .ask").count(), 2)
  assert.equal(await p.inputValue("#cards .ask >> nth=0 >> .ask__edit"), "ls build")
  await p.evaluate(([path]) => window.__mock.frame(path, "ask", { cards: [] }), [STREAM2])
  await p.waitForSelector("#cards", { state: "hidden" })
  assert.deepEqual(p.errors, [])
})

test("A1: reopening a chat whose reply waits shows the card from the stream's first pass", async () => {
  const p = await page(agentChatOpen([["status", { text: "Waiting for you to allow bash…" }], ["ask", { cards: [deviceBashCard()] }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask")
  // Away to another chat and back: the stream is opened again and its first pass carries the card.
  await p.click('.chatrow[data-id="chat1"]').catch(() => {})
  await p.waitForFunction(() => !document.querySelector("#cards .ask"))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards:not([hidden]) .ask")
  assert.equal(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "stream_open" && c.args.path.includes("/messages/")).length), 2)
  assert.deepEqual(p.errors, [])
})

test("A1: a card at 390 px wide is on the screen and its buttons can be reached", async () => {
  const p = await page(agentChatOpen([["ask", { cards: [deviceBashCard()] }]]), { width: 390, height: 844 })
  await p.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
  await p.waitForSelector("#cards:not([hidden]) .ask")
  const allow = await p.locator("#cards .ask__actions .btn--primary").boundingBox()
  assert.ok(allow && allow.y + allow.height <= 844 && allow.x >= 0 && allow.x + allow.width <= 390, `Allow is on the screen: ${JSON.stringify(allow)}`)
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), "nothing scrolls sideways")
  assert.deepEqual(p.errors, [])
})

// --- A5: the Subagents setting ----------------------------------------------------------------
//
// The server decides (`services/team_run.py:offered`, `services/subagents.py:view`): subagents
// enabled on the instance, the person's permission, a model that calls tools, and some model that
// could serve one -- the chat's own serving two requests at once, or another off its one-model
// server (`named_only`: then the setting says a subagent needs a model named in the chat). It says
// so per model in `/models` (a new chat) and per chat in `/chats/{id}` (`subagents`). The web page
// reads the same function (`api/pages.py:_team_context`). The app shows what it is told.

async function newChatOn(p, kind, modelName) {
  await p.click("#new-chat-btn")
  await p.click(`.kind__tab >> text=${kind}`)
  if (modelName) {
    await p.click(".cchip--model")
    await p.locator(".menu .menu__item", { hasText: modelName }).click()
  }
}

async function subagentsChip(p) {
  // The chip comes after the others (an open chat's waits for the server's word).
  await p.waitForTimeout(150)
  return p.locator("#chat-settings .cchip--subagents")
}

async function openSlider(p) {
  await p.click("#chat-settings .cchip--subagents")
  await p.waitForSelector(".range2")
  return {
    min: await p.getAttribute(".range2__input--min", "max"),
    text: await p.textContent(".pop__body"),
  }
}

const OWN = "This model serves one request at a time: subagents need another model, on another server, named in the chat."

function a5(routes = {}) {
  return { status: status(), routes: baseRoutes(routes), streams: {} }
}

test("A5: a new chat on a model serving two at once offers Subagents, Min and Max to the server's cap", async () => {
  const p = await page(a5())
  await newChatOn(p, "Chat")
  const chip = await subagentsChip(p)
  assert.equal(await chip.count(), 1, "the chip is there")
  const s = await openSlider(p)
  assert.equal(s.min, "8", "up to the server's cap")
  assert.ok(!s.text.includes(OWN), "no one-request note")
  assert.deepEqual(p.errors, [])
})

test("A5: a new chat on a one-request model the server still offers: Subagents with the note", async () => {
  const p = await page(a5())
  await newChatOn(p, "Chat", "Solo")
  const chip = await subagentsChip(p)
  assert.equal(await chip.count(), 1)
  const s = await openSlider(p)
  assert.ok(s.text.includes(OWN), "the one-request note")
  assert.deepEqual(p.errors, [])
})

test("A5: subagents off on the instance (offered false for every model): no Subagents", async () => {
  const off = SUB(false)
  const p = await page(a5({ "GET /models": models({ qwen: off, solo: off, plain: off }) }))
  await newChatOn(p, "Chat")
  assert.equal(await (await subagentsChip(p)).count(), 0)
  await newChatOn(p, "Chat", "Solo")
  assert.equal(await (await subagentsChip(p)).count(), 0)
  assert.deepEqual(p.errors, [])
})

test("A5: subagents switched on while the app stays open: the next new chat offers them", async () => {
  const off = SUB(false)
  const p = await page(a5({ "GET /models": models({ qwen: off, solo: off, plain: off }) }))
  await newChatOn(p, "Chat")
  assert.equal(await (await subagentsChip(p)).count(), 0, "off at sign-in")
  // The administrator switches subagents on; the app read /models at sign-in.
  await p.evaluate((m) => (window.__mockConfig.routes["GET /models"] = m), models())
  await p.waitForTimeout(5200)
  await p.click("#new-chat-btn")
  await p.waitForSelector("#chat-settings .cchip--subagents")
  assert.deepEqual(p.errors, [])
})

test("A5: an open chat follows its own `subagents`: offered, offered with the note, not offered", async () => {
  for (const [said, chip, note] of [
    [{ offered: true, named_only: false, cap: 8 }, 1, false],
    [{ offered: true, named_only: true, cap: 8 }, 1, true],
    [{ offered: false, named_only: false, cap: 8 }, 0, false],
  ]) {
    const p = await page(
      a5({
        "GET /chats/chat1": { chat: chatRow({ subagents: said }), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null },
        "GET /models?chat=chat1": models(),
      }),
    )
    await openChatRow(p, "chat1")
    const c = await subagentsChip(p)
    assert.equal(await c.count(), chip, `chip for ${JSON.stringify(said)}`)
    if (chip) assert.equal((await openSlider(p)).text.includes(OWN), note)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- B3: the Terminal panel -------------------------------------------------------------------
//
// The server's two sockets for an app (`api/v2/terminal.py`): an agent chat's
// (`/chats/{chat}/terminal/ws`) and one before the chat exists, on the device and folder chosen
// (`/devices/{device}/terminal/ws?directory=`), which the chat's first message takes over.
// `GET /devices` says per device whether it opens a terminal. The socket is Rust's: the page asks
// `terminal_open` and gets the frames as `terminal` events (mock-tauri.js plays the server).

const READY = ["control", { t: "ready", label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false }]

function b3(over = {}, terminal = [READY, ["output", "dev@workbench:~/project$ "]]) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /chats/chat2": { chat: agentChat({ running: false }), messages: [userMessage("m1", "What is in build?")], more: false, live: null },
      "GET /models?chat=chat2": models(),
      "POST /chats": { chat: agentChat({ running: false }), message: userMessage("m9", "Build it"), reply: null },
      ...over,
    }),
    streams: {},
    terminal,
  }
}

async function screenText(p) {
  return p.evaluate(() => document.querySelector("#terminal .xterm-rows")?.textContent || "")
}

test("B3: a new agent chat offers the Terminal once its folder is chosen, and opens a shell there before the first message", async () => {
  const p = await page(b3())
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#chat-tools [data-terminal-toggle]")
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 0, "nothing is opened until asked")
  await p.click("#chat-tools [data-terminal-toggle]")
  await p.waitForSelector("#terminal:not([hidden]) .xterm")
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  const [shell] = await p.evaluate(() => window.__mock.terminals())
  assert.deepEqual(shell.target, { chat: null, device: "token1", directory: "/home/dev/project" })
  await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("dev@workbench"))
  assert.equal(await p.textContent("#terminal-message"), "Connected.")
  assert.equal(await p.textContent("#terminal-title"), "workbench")
  assert.equal(await p.getAttribute("#chat-tools [data-terminal-toggle]", "aria-pressed"), "true")
  // Keys go up through the bridge, never a socket of the page's own.
  await p.click("#terminal .xterm")
  await p.keyboard.type("ls")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.typed().includes("ls\r"))
  assert.equal(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "terminal_open").length), 1)
  if (process.env.SHOTS) await p.screenshot({ path: join(process.env.SHOTS, "b3-new-1280.png") })
  // The first message makes the chat, which takes the shell over: the same socket goes on.
  await p.click("#composer-text")
  await p.fill("#composer-text", "Build it")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  const [made] = await p.evaluate(() => window.__mock.api("POST", "/chats"))
  assert.equal(made.args.body.device, "token1")
  assert.equal(made.args.body.directory, "/home/dev/project")
  await p.waitForSelector('#chat-tools [data-terminal-toggle][aria-pressed="true"]')
  assert.ok(await p.isVisible("#terminal"), "the panel stays open")
  const shells = await p.evaluate(() => window.__mock.terminals())
  assert.equal(shells.length, 1, "no second shell: the chat took the first one over")
  assert.ok(shells[0].open, "and its socket is still open")
  assert.deepEqual(p.errors, [])
})

test("B3: an open agent chat opens its own shell from the header; Send to chat fills the composer and sends nothing", async () => {
  const p = await page(b3())
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.terminals()))[0].target, { chat: "chat2", device: null, directory: null })
  await p.evaluate(() => window.__mock.shell("output", "\r\ntotal 4\r\n-rw-r--r-- 1 dev dev 12 build.log\r\n"))
  await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("build.log"))
  await p.fill("#composer-text", "Look at this:")
  await p.click("#terminal-send")
  const text = await p.inputValue("#composer-text")
  assert.ok(text.startsWith("Look at this:\n\n```\n"), `after what was typed, as a block: ${JSON.stringify(text.slice(0, 40))}`)
  assert.match(text, /build\.log/)
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/chats/chat2/messages").length), 0, "nothing is sent")
  // Closing the panel keeps the shell; opening it again does not open another.
  await p.click("#terminal-close")
  assert.ok(await p.isHidden("#terminal"))
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForSelector("#terminal:not([hidden])")
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 1)
  // The server ends it: said, and no new shell in its place.
  await p.evaluate(() => window.__mock.shell("control", { t: "closed", message: "The shell exited." }))
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "The shell exited.")
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 1)
  assert.deepEqual(p.errors, [])
})

test("B3: a shell that ends while its panel is being shown again is not replaced by a new one", async () => {
  const p = await page(b3())
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  await p.click("#terminal-close")
  // Shown again, and the shell ends before the panel has drawn its first frame.
  await p.evaluate(() => {
    document.querySelector("#chat-tools [data-terminal-toggle]").click()
    window.__mock.shell("control", { t: "closed", message: "The shell exited." })
  })
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await p.waitForTimeout(200)
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 1, "no new shell in its place")
  assert.equal(await p.textContent("#terminal-message"), "The shell exited.")
  assert.deepEqual(p.errors, [])
})

test("B3: the terminal and the activity panel take turns in the panel column", async () => {
  const p = await page(b3({ "GET /chats/chat2/activity": { activity: {} } }))
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForSelector("#terminal:not([hidden])")
  assert.equal(await p.getAttribute("#shell", "data-terminal"), "true")
  await p.click("#activity-open")
  await p.waitForSelector("#activity:not([hidden])")
  assert.ok(await p.isHidden("#terminal"), "the terminal gave way")
  assert.equal(await p.getAttribute("#shell", "data-terminal"), "false")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForSelector("#terminal:not([hidden])")
  assert.ok(await p.isHidden("#activity"), "and the activity panel to it")
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 1, "the shell lived on behind it")
})

test("B3: no Terminal where the device opens none, for a chat on the server, or before a folder", async () => {
  const off = { "GET /devices": { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: false }] } }
  let p = await page(b3(off))
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#chat-settings .cchip")
  assert.equal(await p.locator("#chat-tools [data-terminal-toggle]").count(), 0, "the device opens no terminal")
  await openChatRow(p, "chat2")
  assert.equal(await p.locator("#chat-tools [data-terminal-toggle]").count(), 0)
  await p.context().close()
  p = await page(b3({}))
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Chat")
  await p.waitForSelector("#chat-settings .cchip")
  assert.equal(await p.locator("#chat-tools [data-terminal-toggle]").count(), 0, "a chat on the server has no shell")
  await p.context().close()
  p = await page({ ...b3({}), status: status({ remote: { enabled: true, roots: [] } }) })
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#chat-settings .cchip")
  assert.equal(await p.locator("#chat-tools [data-terminal-toggle]").count(), 0, "no folder yet")
  assert.deepEqual(p.errors, [])
})

test("B3: a refused sign-in and an older server are said in words", async () => {
  let p = await page(b3({}, [["end", { code: 4401, reason: "not allowed", status: null, error: null }]]))
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => /Sign in again/.test(document.querySelector("#terminal-message").textContent))
  assert.ok(await p.evaluate(() => document.querySelector("#terminal-message").classList.contains("is-error")))
  await p.context().close()
  p = await page(b3({}, [["end", { code: null, reason: "", status: 404, error: null }]]))
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => /needs a newer LLeMbas server/.test(document.querySelector("#terminal-message").textContent))
  assert.deepEqual(p.errors, [])
})

test("B3: at 390 px the terminal is a sheet over the chat, inside the window", async () => {
  const p = await page(b3(), { width: 390, height: 844 })
  await p.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
  await p.waitForSelector('#chat-tools [data-terminal-toggle]')
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("dev@workbench"))
  const box = await p.locator("#terminal").boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, `inside: ${JSON.stringify(box)}`)
  const send = await p.locator("#terminal-send").boundingBox()
  assert.ok(send.x + send.width <= 390 && send.y + send.height <= 844, `Send is reachable: ${JSON.stringify(send)}`)
  const close = await p.locator("#terminal-close").boundingBox()
  assert.ok(close.x + close.width <= 390, "Close is reachable")
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), "nothing scrolls sideways")
  if (process.env.SHOTS) await p.screenshot({ path: join(process.env.SHOTS, "b3-chat-390.png") })
  // Send to chat: the sheet steps aside, and the message box has the block.
  await p.click("#terminal-send")
  assert.ok(await p.isHidden("#terminal"))
  assert.match(await p.inputValue("#composer-text"), /dev@workbench/)
  assert.deepEqual(p.errors, [])
})

test("B3: at 1280 px the terminal sits beside the chat, which keeps its column", async () => {
  const p = await page(b3())
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("dev@workbench"))
  const term = await p.locator("#terminal").boundingBox()
  const main = await p.locator("#main").boundingBox()
  assert.ok(term.x >= main.x + main.width - 1, "beside, not over")
  assert.ok(main.width >= 400, `the chat keeps room: ${main.width}`)
  assert.ok(term.width >= 380, `the terminal has its width: ${term.width}`)
  if (process.env.SHOTS) await p.screenshot({ path: join(process.env.SHOTS, "b3-chat-1280.png") })
  assert.deepEqual(p.errors, [])
})

// --- B1: the progress line ---------------------------------------------------------------------
//
// Harness spec 3.4.0 (harness/progress.md in the LLeMbas CLI): one `progress` object, drawn by
// every client as `{{text}} · {{elapsed}}`. tests/ui/conformance/progress.json is a copy of the
// spec's conformance/progress.json (3.4.0); every case must come out word for word.

test("B1: every conformance case of the spec draws the same text and line", async () => {
  const { cases } = JSON.parse(readFileSync(join(HERE, "conformance", "progress.json"), "utf8"))
  const p = await page(b3())
  const got = await p.evaluate(async (cs) => {
    const m = await import("/js/progress.js")
    return cs.map((c) => ({ text: m.progressText(c.progress, c.now), line: m.progressLine(c.progress, c.now) }))
  }, cases)
  cases.forEach((c, i) => assert.deepEqual(got[i], c.expect, c.about))
  assert.deepEqual(p.errors, [])
})

test("B1: the display rules of spec 3.7.0: every conformance case's title, duration, change, facts, end line and drawn", async () => {
  const { cases } = JSON.parse(readFileSync(join(HERE, "conformance", "display.json"), "utf8"))
  const p = await page(b3())
  const got = await p.evaluate(async (cs) => {
    const m = await import("/js/display.js")
    return cs.map((c) => {
      switch (c.show) {
        case "title":
          return { title: m.callTitle(c.args) }
        case "duration":
          return { duration: m.callDuration(c.state, c.ms) }
        case "change": {
          const n = m.diffCounts(c.diff)
          return { ...n, text: m.changeText(n, true) }
        }
        case "facts":
          return { facts: m.callFacts(c, true) }
        case "end":
          return { line: m.endLine(c.progress, c.now) }
        case "drawn":
          return { drawn: m.drawn(c.block) }
        default:
          return { unknown: c.show }
      }
    })
  }, cases)
  assert.ok(cases.length > 50, "the spec's cases are there")
  cases.forEach((c, i) => assert.deepEqual(got[i], c.expect, `${c.show}: ${c.about}`))
  // The page's texts are the spec's own objects, not a copy.
  const same = await p.evaluate(async () => {
    const spec = await import("/js/spec.js")
    return [spec.SPEC_VERSION, spec.PROGRESS.phases.length, Object.keys(spec.DISPLAY.actions).sort().join()]
  })
  assert.deepEqual(same, [readFileSync(join(HERE, "conformance", "SOURCE"), "utf8").trim().split(" ").pop(), 13, "approval,plan,question"])
  assert.deepEqual(p.errors, [])
})

test("B1: a reply being written draws the stream's progress, its clock moving, and the status text without one", async () => {
  const p = await page(agentChatOpen([["status", { text: "Writing…" }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live .msg__status")
  // The stream's own first frame goes out a moment after it is opened, and a frame sent before
  // that waits behind it: read at once, the line was now and then still the reply's first
  // "Writing…" (the test failed so on a loaded machine, and passed when run again).
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  // An older server sends no progress at all: its status text, as before.
  await p.evaluate((path) => window.__mock.frame(path, "status", { text: "Running bake --slow" }), STREAM2)
  assert.equal(await p.textContent(".msg.is-live .msg__status"), "Running bake --slow")
  // The server's status frame (event_status.json), its clock set 65 s back from now.
  const status = fixture("event_status")
  await p.evaluate(([path, f]) => {
    window.__mock.frame(path, "status", { ...f, progress: { ...f.progress, since: Date.now() - 65000 } })
  }, [STREAM2, status])
  const line = () => p.textContent(".msg.is-live .msg__status")
  assert.equal(await line(), "Running bash: bake --slow · 1m 05s")
  assert.equal(await p.getAttribute(".msg.is-live .msg__status", "data-phase"), "running_tool")
  await p.waitForFunction(() => document.querySelector(".msg.is-live .msg__status").textContent.endsWith("1m 06s"), null, { timeout: 2500 })
  // A data-only frame with progress (the ask frame carries it too): the line follows.
  await p.evaluate((path) => window.__mock.frame(path, "ask", { cards: [], progress: { phase: "waiting_for_person", since: Date.now(), what: "approval", tool: "bash" } }), STREAM2)
  assert.equal(await line(), "Waiting for you: allow bash? · 0s")
  // Nothing running (event_status_idle.json: no text, `progress: null`): the plain words again.
  await p.evaluate(([path, f]) => window.__mock.frame(path, "status", f), [STREAM2, fixture("event_status_idle")])
  assert.equal(await line(), "Writing…")
  // Waiting for a person's answer (event_status_person.json): the phase, not the text.
  await p.evaluate(([path, f]) => window.__mock.frame(path, "status", { ...f, progress: { ...f.progress, since: Date.now() } }), [STREAM2, fixture("event_status_person")])
  assert.equal(await line(), "Waiting for you: a question · 0s")
  // Stopped and failed have no clock.
  await p.evaluate(([path, f]) => window.__mock.frame(path, "status", f), [STREAM2, fixture("event_status_stopped")])
  assert.equal(await line(), "Stopped: by you")
  assert.deepEqual(p.errors, [])
})

// --- C4: subagents (spec 3.4.0) ---------------------------------------------------------------
//
// The server's /api/v2 (its fixtures, copied into tests/ui/fixtures): GET /chats/{chat}/tree ->
// {tree, room, live}, the stream's `tree` frame, a subagent's transcript and findings, POST
// .../stop; an agent chat's device away -> the kept tree (`live` false) and 409 for the rest;
// /models?kind=agent&device= for a new agent chat's Subagents; `subagent` on an approval item.

const ACTIVITY = { activity: { version: "v1", summary: { active: 0 }, agents: [], context: null, outputs: [], team: null, plan: null } }

function c4(over = {}) {
  return b3({
    "GET /chats/chat2/activity": ACTIVITY,
    "GET /chats/chat2/tree": fixture("tree"),
    "GET /chats/chat2/subagents/s2/transcript": fixture("subagent_transcript"),
    "GET /chats/chat2/subagents/s2/findings": fixture("subagent_findings"),
    "POST /chats/chat2/subagents/s2/stop": { stopped: ["s2"] },
    ...over,
  })
}

async function openTree(p) {
  await openChatRow(p, "chat2")
  await p.click("#activity-open")
  await p.waitForSelector("#activity .subagents .subagent")
}

const rows = (p) => p.evaluate(() => [...document.querySelectorAll("#activity .subagents__list > .subagent")].map((r) => [r.dataset.id, r.style.getPropertyValue("--depth")]))

test("C4: the activity panel draws the server's tree: nested by parent, slots, the ended ones apart", async () => {
  const p = await page(c4())
  await openTree(p)
  assert.deepEqual(await rows(p), [["lead", "0"], ["s1", "1"], ["s2", "2"]])
  const routes = await p.textContent('#activity .subagent[data-id="s2"]')
  assert.match(routes, /routes/)
  assert.match(routes, /writes the routes/)
  assert.match(routes, /Running read: src\/api\.py/)
  assert.match(routes, /6%/, "context: floor(9100 × 100 / 131072)")
  assert.match(routes, /edit \+ execute/)
  assert.match(routes, /messages: 1/)
  assert.match(routes, /routes → area: Routes are in\./, "the last room message to or from it")
  assert.match(await p.textContent('#activity .subagent[data-id="lead"]'), /the main agent/)
  assert.match(await p.textContent("#activity .subagents"), /3 of 4/)
  assert.match(await p.textContent("#activity .subagents"), /They run on the computer this chat runs on\./)
  // The ended one, folded apart, with how it ended, and no stop square.
  await p.click("#activity .subagents__ended > summary")
  const scout = await p.textContent('#activity .subagents__ended .subagent[data-id="s3"]')
  assert.match(scout, /done/)
  assert.equal(await p.locator('#activity .subagent[data-id="s3"] button.agent__stop').count(), 0)
  assert.equal(await p.locator('#activity .subagent[data-id="lead"] button.agent__stop').count(), 0, "the main agent is not stopped from here")
  if (process.env.SHOTS) await p.screenshot({ path: join(process.env.SHOTS, "c4-tree-1280.png") })
  assert.deepEqual(p.errors, [])
})

test("C4: a subagent's conversation and findings open read-only; Stop asks, then stops it", async () => {
  const p = await page(c4())
  await openTree(p)
  await p.click('#activity .subagent[data-id="s2"] > summary')
  await p.click('#activity .subagent[data-id="s2"] .subagent__buttons .btn >> text=Open its conversation')
  await p.waitForSelector("#activity .convo .convo__turn")
  const convo = await p.textContent("#activity-body")
  assert.match(convo, /Write the routes\./)
  assert.match(convo, /Reading the API first\./)
  assert.match(convo, /src\/api\.py/)
  assert.equal(await p.locator("#activity-body textarea, #activity-body input").count(), 0, "nothing to type into")
  await p.click("#activity-back")
  await p.click('#activity .subagent[data-id="s2"] .subagent__buttons .btn >> text=Findings')
  await p.waitForSelector("#activity .findings")
  assert.match(await p.textContent("#activity .findings"), /Login is POST \/session\./)
  await p.click("#activity-back")
  await p.click('#activity .subagent[data-id="s2"] button.agent__stop')
  await p.waitForSelector("dialog[open]")
  assert.match(await p.textContent("dialog[open]"), /Stop routes and the subagents under it\?/)
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/subagents/s2/stop").length === 1)
  assert.deepEqual(p.errors, [])
})

test("C4: the stream's tree frame redraws the panel; with the device away the kept tree shows and the rest says why", async () => {
  const away = { ...fixture("tree"), live: false }
  const p = await page(c4({ "GET /chats/chat2/tree": away, "GET /chats/chat2/subagents/s2/transcript": { __error: { status: 409, detail: "That is kept on the computer this chat runs on, which is not linked right now." } } }))
  await openTree(p)
  assert.match(await p.textContent("#activity .subagents"), /This device is not linked right now\./)
  await p.click('#activity .subagent[data-id="s2"] > summary')
  await p.click('#activity .subagent[data-id="s2"] .subagent__buttons .btn >> text=Open its conversation')
  await p.waitForSelector("#activity-body .is-error")
  assert.match(await p.textContent("#activity-body"), /not linked right now/)
  await p.click("#activity-back")
  // A reply streams; its `tree` frame (event_tree.json) is the tree now.
  await p.evaluate(() => window.__mock.frame("/chats/chat2/messages/m2/stream", "tree", null))
  await p.context().close()
  const live = await page({ ...c4(), routes: { ...c4().routes, "GET /chats/chat2": { chat: agentChat(), messages: [userMessage("m1", "Go")], more: false, live: "m2" } }, streams: { [STREAM2]: [] } })
  await openTree(live)
  await live.evaluate(([path, f]) => window.__mock.frame(path, "tree", f), [STREAM2, fixture("event_tree")])
  await live.waitForFunction(() => !!document.querySelector('#activity .subagent[data-id="s2"]') && /parser/.test(document.querySelector('#activity .subagent[data-id="s2"]').textContent))
  assert.match(await live.textContent('#activity .subagent[data-id="s2"]'), /reviews the parser/)
  assert.match(await live.textContent('#activity .subagent[data-id="s2"]'), /manual \+ write/)
  assert.deepEqual(live.errors, [])
})

test("C4: an approval a subagent asks for names it", async () => {
  const card = fixture("event_ask").cards.find((c) => c.id === "card4")
  const p = await page(agentChatOpen([["ask", { cards: [card] }]], { "POST /chats/chat2/interactions/card4": { answered: true } }))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask__subagent")
  assert.equal(await p.textContent("#cards .ask__subagent"), "Subagent parser (s1), reviews the parser, asks:")
  assert.equal(await p.inputValue("#cards .ask__edit"), "git push", "the command, correctable, as for the main agent's")
  assert.deepEqual(p.errors, [])
})

test("C4: Subagents for a new agent chat as /models?kind=agent says for this device; for an open one as the chat says", async () => {
  const facts = fixture("models_agent")
  const newAgent = async (models) => {
    const p = await page(c4({ "GET /models?kind=agent&device=token1": models }))
    await p.click("#new-chat-btn")
    await p.click(".kind__tab >> text=Agent")
    await p.waitForSelector("#chat-settings .cchip")
    await p.waitForTimeout(200)
    return p
  }
  let p = await newAgent(facts)
  assert.equal(await p.locator("#chat-settings .cchip--subagents").count(), 1, "offered, and the device runs them")
  await p.click("#chat-settings .cchip--subagents")
  await p.waitForSelector(".range2")
  assert.equal(await p.getAttribute(".range2__input--min", "max"), "32", "the server's cap")
  await p.context().close()
  p = await newAgent({ ...facts, agent_subagents: { offered: true, device_runs: false } })
  assert.equal(await p.locator("#chat-settings .cchip--subagents").count(), 0, "this computer's CLI cannot run them")
  await p.context().close()
  p = await newAgent({ ...facts, agent_subagents: { offered: false, device_runs: true } })
  assert.equal(await p.locator("#chat-settings .cchip--subagents").count(), 0, "not offered")
  await p.context().close()
  p = await newAgent({ __error: { status: 400, detail: "older server" } })
  assert.equal(await p.locator("#chat-settings .cchip--subagents").count(), 0, "a server before 3.4.0: none, as before")
  await p.context().close()
  // An open agent chat: its own `subagents` (chat_agent.json offers them).
  const chat = fixture("chat_agent")
  p = await page(c4({ "GET /chats/chat2": { chat: { ...agentChat({ running: false }), subagents: chat.subagents, agents: chat.agents }, messages: [userMessage("m1", "Go")], more: false, live: null } }))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#chat-settings .cchip--subagents")
  assert.deepEqual(p.errors, [])
})

test("C4: the tree at 390 px stays inside the window", async () => {
  const p = await page(c4(), { width: 390, height: 844 })
  await p.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
  await p.waitForSelector("#activity-open")
  await p.click("#activity-open")
  await p.waitForSelector("#activity .subagents .subagent")
  await p.click('#activity .subagent[data-id="s2"] > summary')
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), "nothing scrolls sideways")
  const panel = await p.evaluate(() => { const b = document.querySelector("#activity-body"); return b.scrollWidth <= b.clientWidth })
  assert.ok(panel, "the panel does not scroll sideways")
  if (process.env.SHOTS) await p.screenshot({ path: join(process.env.SHOTS, "c4-tree-390.png") })
  assert.deepEqual(p.errors, [])
})

// --- D: parity (beta.9) ------------------------------------------------------------------------

const shot = (p, name) => (process.env.SHOTS ? p.screenshot({ path: join(process.env.SHOTS, `${name}.png`) }) : null)
const noSideways = (p, width) => p.evaluate((w) => document.documentElement.scrollWidth <= w, width)

function archivedRoutes(over = {}) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /chats?archived=true&limit=50": {
        chats: [
          chatRow({ id: "old1", title: "Lembas for the road, a recipe with a title long enough to be cut short", archived: true }),
          agentChat({ id: "old2", title: "Old refactor", archived: true, running: false }),
        ],
        more: false,
      },
      "PATCH /chats/old1": { chat: chatRow({ id: "old1", title: "Lembas for the road", archived: false }) },
      "GET /chats/old2": { chat: agentChat({ id: "old2", title: "Old refactor", archived: true, running: false }), messages: [userMessage("m9", "Tidy it")], more: false, live: null },
      "PATCH /chats/old2": { chat: agentChat({ id: "old2", title: "Old refactor", archived: false, running: false }) },
      ...over,
    }),
    streams: {},
  }
}

test("D2: Archived lists the archived chats; Restore chat takes one back and the sidebar is read again", async () => {
  const p = await page(archivedRoutes())
  await p.click("#nav-archived")
  await p.waitForSelector("#page-archived:not([hidden]) .arow")
  assert.equal(await p.locator("#page-archived .arow").count(), 2)
  assert.match(await p.textContent('.arow[data-id="old2"]'), /project/, "an agent chat names its folder")
  await shot(p, "d2-archived-1280")
  const before = await p.evaluate(() => window.__mock.api("GET", "/chats?limit").length)
  await p.click('.arow[data-id="old1"] .arow__unarchive')
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/old1").length === 1)
  const [call] = await p.evaluate(() => window.__mock.api("PATCH", "/chats/old1"))
  assert.deepEqual(call.args.body, { archived: false })
  await p.waitForFunction(() => !document.querySelector('.arow[data-id="old1"]'))
  await p.waitForFunction((n) => window.__mock.api("GET", "/chats?limit").length > n, before)
  assert.deepEqual(p.errors, [])
})

test("D2: an archived chat opens from the page and says so in its header; Restore chat there too", async () => {
  const p = await page(archivedRoutes())
  await p.click("#nav-archived")
  await p.waitForSelector('.arow[data-id="old2"] .arow__open')
  await p.click('.arow[data-id="old2"] .arow__open')
  await p.waitForSelector("#main:not([hidden]) #messages .msg")
  await p.click("#chat-tools .head__unarchive")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/old2").length === 1)
  await p.waitForSelector("#chat-tools .head__unarchive", { state: "detached" })
  assert.deepEqual(p.errors, [])
})

test("D2: at 390 px the archived page stays inside the window, its buttons reachable", async () => {
  const p = await page(archivedRoutes(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("nav-archived").click())
  await p.waitForSelector("#page-archived:not([hidden]) .arow")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  const b = await p.locator('.arow[data-id="old1"] .arow__unarchive').boundingBox()
  assert.ok(b && b.x + b.width <= 390, `Unarchive is on the screen: ${JSON.stringify(b)}`)
  await shot(p, "d2-archived-390")
  assert.deepEqual(p.errors, [])
})

// D4: a new agent chat on another linked computer. `GET /devices` lists this one (its host is the
// app's own) and another; folders on the other come from its agent chats in the sidebar, or typed.

const STUDIO = { id: "token9", name: "studio", host: "studio", platform: "linux", terminal: true }

function d4(over = {}) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /devices": { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: true }, STUDIO] },
      "GET /chats": { chats: [chatRow(), agentChat(), agentChat({ id: "chat7", title: "Site tweaks", running: false, device: { token_id: "token9", directory: "/srv/site" } })], more: false },
      "POST /chats": { chat: agentChat({ id: "chat8", running: false, device: { token_id: "token9", directory: "/srv/site" } }), message: userMessage("m9", "Check the logs"), reply: null },
      ...over,
    }),
    streams: {},
    terminal: [READY, ["output", "dev@studio:/srv/site$ "]],
  }
}

/** The bar's three chips, opened from the summary chip where the bar is folded (narrow). */
async function targetChips(p) {
  if ((await p.isVisible("#target-sum")) && (await p.getAttribute("#target-sum", "aria-expanded")) !== "true") await p.click("#target-sum")
  await p.waitForSelector("#target-chips .cchip--device", { state: "visible" })
}

async function pickDevice(p, name) {
  await targetChips(p)
  await p.click("#target-chips .cchip--device")
  await p.locator(".menu .menu__item", { hasText: name }).first().click()
}

test("D4: a new agent chat defaults to this computer and can be sent to another linked one, in a folder it knows", async () => {
  const p = await page(d4())
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#target-chips .cchip--device")
  assert.match(await p.textContent("#target-chips .cchip--device"), /This computer/)
  await pickDevice(p, "studio")
  await p.waitForFunction(() => /studio/.test(document.querySelector("#target-chips .cchip--device")?.textContent || ""))
  assert.match(await p.textContent("#new-chat .hello__sub"), /studio/, "the greeting names the computer")
  assert.match(await p.textContent("#target-chips"), /site/, "the folder its agent chats work in")
  assert.ok(await p.isHidden("#link-notice"), "this computer's agent is not in the way")
  await shot(p, "d4-device-1280")
  // The Terminal opens on that computer, in that folder, before the first message.
  await p.click("#chat-tools [data-terminal-toggle]")
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  const [shell] = await p.evaluate(() => window.__mock.terminals())
  assert.deepEqual(shell.target, { chat: null, device: "token9", directory: "/srv/site" })
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  const [made] = await p.evaluate(() => window.__mock.api("POST", "/chats"))
  assert.equal(made.args.body.kind, "agent")
  assert.equal(made.args.body.device, "token9")
  assert.equal(made.args.body.directory, "/srv/site")
  assert.deepEqual(p.errors, [])
})

test("D4: on a computer with no known folder the path is typed; back to this computer gives its own folders", async () => {
  const p = await page(d4({ "GET /chats": { chats: [chatRow(), agentChat()], more: false } }))
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await pickDevice(p, "studio")
  await p.waitForSelector("#target-chips .cchip.is-warn")
  await p.fill("#composer-text", "Hello")
  await p.click("#send")
  await p.waitForSelector("#thread-note:not([hidden])")
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/chats").length), 0, "nothing sent without a folder")
  await p.click("#target-chips .cchip.is-warn")
  await p.waitForSelector("dialog[open] .dialog__input")
  await p.fill("dialog[open] .dialog__input", "/home/dev/other")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => /other/.test(document.querySelector("#target-chips").textContent))
  await pickDevice(p, "This computer")
  await p.waitForFunction(() => /project/.test(document.querySelector("#target-chips").textContent))
  assert.deepEqual(p.errors, [])
})

test("D4: the computer menu's rows say a name and, apart from it, what the name does not: no host twice, a gap between the two, a long name cut before its hint, at 1280 and 390 px", async () => {
  for (const [width, height] of [[1280, 860], [390, 844]]) {
    const cfg = d4({
      "GET /devices": { devices: [
        { id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: true },
        { id: "token8", name: "mill", host: "Mill", platform: "linux-x64", terminal: true },
        { id: "token9", name: "The studio", host: "studio", platform: "linux", terminal: true },
        { id: "token7", name: LONG_HOST, host: `${LONG_HOST}.example.org`, platform: "linux-x64", terminal: true },
      ] },
    })
    const p = await page(cfg, { width, height })
    await p.evaluate(() => document.getElementById("new-chat-btn").click())
    await targetChips(p)
    await p.click("#target-chips .cchip--device")
    await p.waitForSelector(".menu .menu__item")
    const rows = await p.$$eval(".menu .menu__item", (l) => l.map((x) => { const two = x.querySelector(".menu__label--two"); return two ? [two.children[0].textContent, two.children[1].textContent] : [x.querySelector(".menu__label").textContent, ""] }))
    assert.deepEqual(rows, [["This computer", "workbench"], ["mill", "linux-x64"], ["The studio", "studio · linux"], [LONG_HOST, `${LONG_HOST}.example.org · linux-x64`]], `${width}`)
    // Side by side on one line, the hint quieter and to the right, both inside the menu, the menu inside the window.
    const boxes = await p.$$eval(".menu .menu__label--two", (l) => l.map((two) => { const m = two.closest(".menu").getBoundingClientRect(); const [a, b] = [...two.children].map((c) => c.getBoundingClientRect()); return { gap: b.left - a.right, in: a.left >= m.left && b.right <= m.right + 0.5 && m.right <= innerWidth + 0.5 && m.left >= 0, line: Math.abs(a.bottom - b.bottom) < 6, cut: [...two.children].map((c) => c.scrollWidth > c.clientWidth), widths: [a.width, b.width] } }))
    assert.ok(boxes.every((b) => b.gap >= 8 && b.in && b.line && b.widths.every((w) => w > 24)), `${width}: ${JSON.stringify(boxes)}`)
    // Each right edge of a hint on one line (a shared track's end).
    assert.equal(new Set(await p.$$eval(".menu .menu__hint", (l) => l.map((x) => Math.round(x.getBoundingClientRect().right)))).size, 1, `${width}: the hints end on one line`)
    await shot(p, `d4-device-menu-${width}`)
    await p.keyboard.press("Escape")
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("D4: a folder's path beside its name is cut in its middle, never at its end: the last name stays whole at 1280 and 390 px", async () => {
  const deep = "/srv/projects/customers/a-long-standing-one/websites/the-lembas-recipe-and-its-variants/site"
  for (const [width, height] of [[1280, 860], [390, 844]]) {
    const cfg = d4()
    cfg.status = status({ remote: { enabled: true, roots: [deep, "/home/dev/project"], terminal: true } })
    const p = await page(cfg, { width, height })
    await p.evaluate(() => document.getElementById("new-chat-btn").click())
    await targetChips(p)
    await p.click("#target-chips .cchip--folder")
    await p.waitForSelector(".menu .menu__hint--path")
    const rows = await p.$$eval(".menu .menu__hint--path", (l) => l.map((x) => { const [head, tail] = x.children; const m = x.closest(".menu").getBoundingClientRect(); const r = x.getBoundingClientRect(); return { title: x.title, said: x.textContent, tail: tail.textContent, tailWhole: tail.scrollWidth <= tail.clientWidth && tail.getBoundingClientRect().right <= x.getBoundingClientRect().right + 0.5, headCut: head.scrollWidth > head.clientWidth + 1, in: r.right <= m.right + 0.5 && r.left >= m.left } }))
    const long = rows.find((r) => r.title === deep)
    assert.deepEqual([long.said, long.tail, long.tailWhole, long.headCut, long.in], [deep, "/site", true, true, true], `${width}: ${JSON.stringify(long)}`)
    const short = rows.find((r) => r.title === "/home/dev/project")
    assert.deepEqual([short.tail, short.tailWhole, short.in], ["/project", true, true], `${width}: a path that fits is whole`)
    await shot(p, `d4-folder-menu-${width}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("D4: a menu by the keyboard: arrows, Home and End move, Tab and Escape close it with the focus back on its button, a window that changes size closes it", async () => {
  const p = await page(d4())
  await p.evaluate(() => document.getElementById("new-chat-btn").click())
  await targetChips(p)
  const open = async () => { await p.focus("#target-chips .cchip--mode"); await p.keyboard.press("Enter"); await p.waitForSelector(".menu .menu__item") }
  const focused = () => p.evaluate(() => document.activeElement?.textContent.replace("✓", "").trim() || "")
  await open()
  const words = await p.$$eval(".menu .menu__item", (l) => l.map((x) => x.textContent.replace("✓", "").trim()))
  assert.equal(await focused(), words[0])
  await p.keyboard.press("End")
  assert.equal(await focused(), words[words.length - 1])
  await p.keyboard.press("ArrowDown")
  assert.equal(await focused(), words[0], "round again")
  await p.keyboard.press("Home")
  await p.keyboard.press("Tab")
  assert.equal(await p.locator(".menu").count(), 0, "Tab closes it")
  assert.ok(await p.evaluate(() => document.activeElement?.classList.contains("cchip--mode")), "the focus is back on the chip")
  await open()
  await p.evaluate(() => document.activeElement.blur())
  await p.keyboard.press("Escape")
  assert.equal(await p.locator(".menu").count(), 0, "Escape closes it wherever the focus is")
  await open()
  await p.setViewportSize({ width: 1000, height: 700 })
  await p.waitForSelector(".menu", { state: "detached" })
  assert.deepEqual(p.errors, [])
})

test("D4: with no other computer linked the bar still says the computer, its menu only this one; at 390 px the bar is one chip that opens the three", async () => {
  let p = await page(b3())
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#target-chips .cchip--device")
  assert.match(await p.textContent("#target-chips .cchip--device"), /This computer/)
  await p.click("#target-chips .cchip--device")
  assert.equal(await p.locator(".menu .menu__item").count(), 1, "nothing else to choose")
  await p.context().close()
  p = await page(d4(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("new-chat-btn").click())
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#target-sum", { state: "visible" })
  assert.ok(await p.isHidden("#target-chips"), "folded: the three are behind the summary")
  await pickDevice(p, "studio")
  await p.waitForFunction(() => /studio/.test(document.querySelector("#target-chips .cchip--device")?.textContent || ""))
  assert.match(await p.textContent("#target-sum"), /studio.*site.*Edit/, "the summary says all three")
  assert.equal(await p.getAttribute("#target-sum", "aria-expanded"), "false", "choosing closes the column")
  assert.ok(await p.isHidden("#target-chips"))
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "d4-device-390")
  assert.deepEqual(p.errors, [])
})

// E5: the language and the theme. The server's /me (fixture me.json) offers its themes and takes
// one on PATCH /me; its language is the app's unless Settings chose this computer's or another.

const ME = fixture("me")
const meAs = (over = {}) => ({ ...ME, account: { id: "u1", name: "Ada Example", email: "ada@example.org" }, permissions: {}, ...over })

async function openSettings(p) {
  await p.click("#settings-btn")
  await p.waitForSelector("#set-look")
}

test("E5: the theme is the account's, as /me offers them; chosen, PATCH /me saves it and it is drawn at once", async () => {
  const p = await page({ status: status(), routes: baseRoutes({ "GET /me": meAs({ language: "en" }), "PATCH /me": meAs({ language: "en", theme: "moria" }) }), streams: {} })
  await p.waitForFunction(() => document.documentElement.dataset.theme === "shire")
  await openSettings(p)
  assert.equal(await p.inputValue("#set-theme"), "shire")
  assert.deepEqual(await p.$$eval("#set-theme option", (o) => o.map((x) => x.textContent)), ["Moria — dark", "Shire — light"])
  await p.selectOption("#set-theme", "moria")
  await p.waitForFunction(() => document.documentElement.dataset.theme === "moria")
  const [saved] = await p.evaluate(() => window.__mock.api("PATCH", "/me"))
  assert.deepEqual(saved.args.body, { theme: "moria" })
  const painted = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "set_theme").map((c) => c.args.name))
  assert.equal(painted.at(-1), "moria", "the window is painted in it too")
  assert.equal(await p.inputValue("#set-theme"), "moria")
  assert.deepEqual(p.errors, [])
})

test("E5: a theme the server refuses is said, and the look stays", async () => {
  const p = await page({ status: status(), routes: baseRoutes({ "GET /me": meAs({ language: "en" }), "PATCH /me": { __error: { status: 400, detail: "That theme is not offered." } } }), streams: {} })
  await openSettings(p)
  await p.selectOption("#set-theme", "moria")
  await p.waitForSelector("#set-look [role=alert]")
  assert.match(await p.textContent("#set-look [role=alert]"), /not offered/)
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "shire")
  assert.equal(await p.inputValue("#set-theme"), "shire")
  assert.deepEqual(p.errors, [])
})

test("E5: a server that cannot be told: the theme chosen is kept in the app, over the account's", async () => {
  const p = await page({ status: status(), routes: baseRoutes({ "GET /me": { id: "u1", name: "Ada Example", email: "ada@example.org", theme: "shire", language: "en", permissions: {} } }), streams: {} })
  await p.waitForFunction(() => document.documentElement.dataset.theme === "shire")
  await openSettings(p)
  assert.equal(await p.inputValue("#set-theme"), "")
  assert.match(await p.textContent("#set-theme option[value='']"), /account.*Shire/)
  await p.selectOption("#set-theme", "moria")
  await p.waitForFunction(() => document.documentElement.dataset.theme === "moria")
  assert.equal(await p.evaluate(() => window.__mock.api("PATCH", "/me").length), 0, "nothing sent")
  await p.reload()
  await p.waitForSelector("#shell:not([hidden])")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "set_theme"))
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "moria")
  await openSettings(p)
  await p.selectOption("#set-theme", "")
  await p.waitForFunction(() => document.documentElement.dataset.theme === "shire")
  assert.deepEqual(p.errors, [])
})

test("E5: the account's language is the app's; this computer's or another, chosen, opens the window again in it, the shells let go first", async () => {
  const p = await page({ ...b3(), routes: { ...b3().routes, "GET /me": meAs({ language: "de", theme: "moria" }) } })
  // The account says German: the window opens again in it, once.
  await p.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 15000 })
  await p.waitForSelector("#shell:not([hidden])")
  assert.equal((await p.textContent("#settings-btn .navrow__label")).trim(), "Einstellungen")
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  // What the page let go of before it loaded again, kept across the load.
  await p.evaluate(() => addEventListener("beforeunload", () => localStorage.setItem("test.calls", JSON.stringify(window.__mock.calls.map((c) => c.cmd)))))
  await openSettings(p)
  assert.equal(await p.inputValue("#set-language"), "")
  assert.match(await p.textContent("#set-language option[value='']"), /Deutsch/)
  await Promise.all([p.waitForEvent("load"), p.selectOption("#set-language", "system")])
  await p.waitForSelector("#shell:not([hidden])")
  assert.equal(await p.evaluate(() => document.documentElement.lang), "en")
  const before = await p.evaluate(() => JSON.parse(localStorage.getItem("test.calls") || "[]"))
  assert.ok(before.includes("terminal_close"), "the shell was let go")
  await p.waitForTimeout(300)
  assert.equal(await p.evaluate(() => document.documentElement.lang), "en", "the account's German does not take it back")
  await openSettings(p)
  assert.equal(await p.inputValue("#set-language"), "system")
  await Promise.all([p.waitForEvent("load"), p.selectOption("#set-language", "fr")])
  await p.waitForSelector("#shell:not([hidden])")
  assert.equal(await p.evaluate(() => document.documentElement.lang), "fr")
  assert.deepEqual(p.errors, [])
})

test("E5: at 390 px the Appearance group stays inside the window", async () => {
  const p = await page({ status: status(), routes: baseRoutes(), streams: {} }, { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("settings-btn").click())
  await p.waitForSelector("#set-look")
  await p.evaluate(() => document.getElementById("set-look").scrollIntoView())
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  const box = await p.locator("#set-theme").boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "the theme's choice is inside")
  await shot(p, "e5-look-390")
  await p.setViewportSize({ width: 1280, height: 860 })
  await shot(p, "e5-look-1280")
  assert.deepEqual(p.errors, [])
})

// F8: pinned chats and chat folders (fixture folders.json: Waybread, and Recipes inside it, folded).

function f8(over = {}) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /folders": fixture("folders"),
      "GET /chats": {
        chats: [
          chatRow({ id: "chat1", title: "Waybread", pinned: true }),
          agentChat({ id: "chat2", title: "Tidy the build", folder_id: "fold1" }),
          chatRow({ id: "chat3", title: "Seed cake", folder_id: "fold2" }),
          chatRow({ id: "chat4", title: "Loose ends" }),
        ],
        more: false,
      },
      "PATCH /folders/fold2": { folder: { ...fixture("folders").folders[1], collapsed: false } },
      "PATCH /chats/chat4": { chat: chatRow({ id: "chat4", title: "Loose ends", pinned: true }) },
      "POST /folders": fixture("folder"),
      "DELETE /folders/fold1": null,
      ...over,
    }),
    streams: {},
  }
}

const sideText = (p) => p.$$eval("#chat-list > li", (lis) => lis.map((li) => li.textContent.replace(/\s+/g, " ").trim()))

test("F8: the sidebar: pinned chats first, then the folders, nested and folded as kept, then the rest", async () => {
  const p = await page(f8())
  await p.waitForSelector("#chat-list .folderrow")
  const items = await sideText(p)
  assert.equal(items[0], "Pinned chats")
  assert.match(items[1], /Waybread/)
  assert.match(items[2], /Waybread\s*2/, "the folder counts the chats inside, its folders' too")
  assert.match(items[3], /Tidy the build/)
  assert.match(items[4], /Recipes/)
  assert.ok(!items.some((x) => /Seed cake/.test(x)), "a folded folder's chats are not shown")
  assert.ok(items.some((x) => /Loose ends/.test(x)))
  assert.equal(await p.getAttribute('.folderrow[data-folder="fold2"]', "aria-expanded"), "false")
  await p.click('.folderrow[data-folder="fold2"]')
  await p.waitForSelector('.chatrow[data-id="chat3"]')
  const [folded] = await p.evaluate(() => window.__mock.api("PATCH", "/folders/fold2"))
  assert.deepEqual(folded.args.body, { collapsed: false })
  await shot(p, "f8-folders-1280")
  // Searching: every match, flat.
  await p.fill("#side-search", "seed")
  assert.deepEqual((await sideText(p)).slice(1), ["Seed cake"])
  assert.deepEqual(p.errors, [])
})

test("F8: a chat's menu pins it and moves it into a folder, or a new one", async () => {
  const p = await page(f8())
  await p.waitForSelector('.chatrow[data-id="chat4"]')
  await p.click('.chatrow[data-id="chat4"]', { button: "right" })
  await p.click(".menu .menu__item >> text=Pin chat")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat4").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat4")))[0].args.body, { pinned: true })
  await p.click('.chatrow[data-id="chat4"]', { button: "right" })
  await p.click(".menu .menu__item >> text=Move to folder…")
  const labels = await p.$$eval(".menu .menu__item .menu__label", (l) => l.map((x) => x.textContent.trim()))
  assert.deepEqual(labels, ["No folder", "Waybread", "Recipes", "New folder…"])
  await p.click(".menu .menu__item >> text=Recipes")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat4").length === 2)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat4")))[1].args.body, { folder_id: "fold2" })
  // A new one: named, made, and the chat moved into it.
  await p.click('.chatrow[data-id="chat4"]', { button: "right" })
  await p.click(".menu .menu__item >> text=Move to folder…")
  await p.click(".menu .menu__item >> text=New folder…")
  await p.fill("dialog[open] .dialog__input", "Lembas")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat4").length === 3)
  const made = await p.evaluate(() => window.__mock.api("POST", "/folders"))
  assert.deepEqual(made[0].args.body, { name: "Lembas" })
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat4")))[2].args.body, { folder_id: "fold1" })
  assert.deepEqual(p.errors, [])
})

test("F8: a folder's menu renames it and deletes it, its chats kept; a refusal is said", async () => {
  const p = await page(f8({ "PATCH /folders/fold1": { __error: { status: 403, detail: "You may not manage folders." } } }))
  await p.waitForSelector('.folderrow[data-folder="fold1"]')
  await p.click('.folderrow[data-folder="fold1"]', { button: "right" })
  await p.click(".menu .menu__item >> text=Rename folder")
  await p.fill("dialog[open] .dialog__input", "Bread")
  await p.click("dialog[open] .btn--primary")
  await p.waitForSelector("#thread-note:not([hidden])")
  assert.match(await p.textContent("#thread-note"), /may not manage folders/)
  await p.click('.list__folder:has([data-folder="fold1"]) .folderrow__more')
  await p.click(".menu .menu__item >> text=Delete folder")
  assert.match(await p.textContent("dialog[open]"), /Their chats stay/)
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("DELETE", "/folders/fold1").length === 1)
  assert.equal(await p.evaluate(() => window.__mock.api("DELETE", "/chats").length), 0, "no chat deleted")
  assert.deepEqual(p.errors, [])
})

test("F8: at 390 px the folders stay inside the sidebar", async () => {
  const p = await page(f8(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("side-toggle").click())
  await p.waitForSelector('.folderrow[data-folder="fold1"]')
  await p.waitForTimeout(400) // the sidebar slides in
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "f8-folders-390")
  assert.deepEqual(p.errors, [])
})

// G8: search inside (GET /search, fixture search.json) and the memory page (memories.json).

function g8(over = {}) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /search": fixture("search"),
      "GET /memories": fixture("memories"),
      "POST /memories": { memory: { ...fixture("memory").memory, id: "mem2", content: "Walks to Bree on Sundays." } },
      "PATCH /memories/mem1": { memory: { ...fixture("memory").memory, content: "Prefers lembas cold." } },
      "DELETE /memories/mem1": null,
      "GET /files/content": { name: "bread.md", path: "/home/frodo/bread.md", text: "# Lembas recipe", kind: "markdown" },
      ...over,
    }),
    streams: {},
  }
}

test("G8: the palette finds words inside chats, files and memory through the server, the matches marked as text", async () => {
  const p = await page(g8())
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "lembas")
  await p.waitForSelector(".palette__snippet")
  const [q] = await p.evaluate(() => window.__mock.api("GET", "/search"))
  assert.match(q.args.path, /^\/search\?q=lembas&in=all&limit=8$/)
  const hits = await p.$$eval(".palette__item:has(.palette__snippet)", (l) => l.map((x) => ({ title: x.querySelector(".palette__title").textContent, mark: x.querySelector("mark")?.textContent, hint: x.querySelector(".palette__hint").textContent })))
  assert.deepEqual(hits.map((x) => x.hint), ["Chats", "Files", "Memory"])
  assert.equal(hits[0].title, "Waybread")
  assert.equal(hits[0].mark, "lembas")
  assert.equal(hits[2].mark, "lembas")
  await shot(p, "g8-search-1280")
  // A memory opens the memory page at it.
  await p.click(".palette__item:has(.palette__hint:text('Memory'))")
  await p.waitForSelector('#page-memory:not([hidden]) .mrow.is-marked[data-id="mem1"]')
  assert.deepEqual(p.errors, [])
})

test("G8: a chat found inside opens; a server without search finds nothing more, and says nothing", async () => {
  let p = await page(g8())
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "lembas")
  await p.waitForSelector(".palette__snippet")
  await p.click(".palette__item:has(.palette__hint:text('Chats'))")
  await p.waitForFunction(() => window.__mock.api("GET", "/chats/chat1").length > 0)
  await p.context().close()
  p = await page(g8({ "GET /search": { __error: { status: 404, detail: "Not Found" } } }))
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "lembas")
  await p.waitForFunction(() => window.__mock.api("GET", "/search").length === 1)
  await p.waitForTimeout(100)
  assert.equal(await p.locator(".palette__snippet").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("G8: the memory page adds, changes and removes what the models remember", async () => {
  const p = await page(g8())
  await p.click("#nav-memory")
  await p.waitForSelector('.mrow[data-id="mem1"]')
  assert.match(await p.textContent('.mrow[data-id="mem1"]'), /Prefers lembas warm\./)
  await p.fill("#memory-new", "Walks to Bree on Sundays.")
  await p.click(".mnew button[type=submit]")
  await p.waitForSelector('.mrow[data-id="mem2"]')
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/memories")))[0].args.body, { content: "Walks to Bree on Sundays." })
  assert.equal(await p.inputValue("#memory-new"), "")
  await p.click('.mrow[data-id="mem1"] .btn >> text=Edit')
  await p.fill(".mrow.is-editing textarea", "Prefers lembas cold.")
  await p.click(".mrow.is-editing .btn--primary")
  await p.waitForFunction(() => /cold/.test(document.querySelector('.mrow[data-id="mem1"]').textContent))
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/memories/mem1")))[0].args.body, { content: "Prefers lembas cold." })
  await p.click('.mrow[data-id="mem1"] .tool')
  await p.click(".menu .menu__item >> text=Remove")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => !document.querySelector('.mrow[data-id="mem1"]'))
  assert.deepEqual(p.errors, [])
})

test("G8: at 390 px the memory page and the palette's hits stay inside the window", async () => {
  const p = await page(g8(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("nav-memory").click())
  await p.waitForSelector('.mrow[data-id="mem1"]')
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "g8-memory-390")
  await p.setViewportSize({ width: 1280, height: 860 })
  await shot(p, "g8-memory-1280")
  await p.setViewportSize({ width: 390, height: 844 })
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "lembas")
  await p.waitForSelector(".palette__snippet")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "g8-search-390")
  assert.deepEqual(p.errors, [])
})

// H8: the library's writes (files_listing.json) and a chat's tools and skills (scope.json).

function h8(over = {}, commands = {}) {
  const listing = fixture("files_listing")
  return {
    status: status(),
    routes: baseRoutes({
      "GET /files": listing,
      "GET /files?path=%2Fhome%2Ffrodo%2Frecipes": { path: "/home/frodo/recipes", parent: "/home/frodo", entries: [] },
      "POST /files/mkdir": listing,
      "POST /files/rename": listing,
      "DELETE /files": null,
      "GET /chats/chat1/scope": fixture("scope"),
      "POST /chats/chat1/scope": { scope: { ...fixture("scope").scope, families: [{ gate: "notes", label: "Notes", on: false }, { gate: "web", label: "Web search", on: false }] } },
      "POST /chats/chat1/allow/clear": { scope: { ...fixture("scope").scope, allow: [] } },
      ...over,
    }),
    commands: { library_upload: { listing, sent: 1, failed: [] }, ...commands },
    streams: {},
  }
}

async function serverPane(p) {
  await p.click("#nav-files")
  await p.click('#files-tabs [data-tab="server"]')
  await p.waitForSelector('#server-list .frow[data-path="/home/frodo/lembas.md"]')
}

test("H8: the server's files: upload, a new folder, rename and delete, each read again from the server", async () => {
  const p = await page(h8())
  await serverPane(p)
  // Upload into the home the server answered with, through Rust's dialog.
  await p.click("#server-upload")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "library_upload"))
  assert.equal((await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "library_upload").args.dir)), "/home/frodo")
  await p.waitForFunction(() => window.__mock.api("GET", "/files?path=%2F").length === 2)
  // A new folder inside a folder, from its row's menu.
  await p.click('#server-list .frow[data-path="/home/frodo/recipes"] .frow__more')
  await p.click(".menu .menu__item >> text=New folder")
  await p.fill("dialog[open] .dialog__input", "Breads")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/mkdir").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/files/mkdir")))[0].args.body, { path: "/home/frodo/recipes", name: "Breads" })
  // Rename a file.
  await p.click('#server-list .frow[data-path="/home/frodo/lembas.md"] .frow__more')
  await p.click(".menu .menu__item >> text=Rename")
  await p.fill("dialog[open] .dialog__input", "waybread.md")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/rename").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/files/rename")))[0].args.body, { path: "/home/frodo/lembas.md", name: "waybread.md" })
  // Delete: to the trash, after asking.
  await p.click('#server-list .frow[data-path="/home/frodo/lembas.md"] .frow__more')
  await p.click(".menu .menu__item >> text=Delete")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("DELETE", "/files?path=%2Fhome%2Ffrodo%2Flembas.md").length === 1)
  await p.waitForSelector("#server-status:not([hidden])")
  assert.equal(await p.textContent("#server-status"), "Moved to the trash.")
  await shot(p, "h8-files-1280")
  assert.deepEqual(p.errors, [])
})

test("H8: a refusal or a file the server did not take is said in the pane", async () => {
  const p = await page(h8({ "POST /files/rename": { __error: { status: 400, detail: "That did not work: read-only" } } }, { library_upload: { listing: null, sent: 0, failed: [{ name: "big.iso", error: "This file is too large to send." }] } }))
  await serverPane(p)
  await p.click("#server-upload")
  await p.waitForSelector("#server-status.is-error")
  assert.equal(await p.textContent("#server-status"), "big.iso: This file is too large to send.")
  await p.click('#server-list .frow[data-path="/home/frodo/lembas.md"] .frow__more')
  await p.click(".menu .menu__item >> text=Rename")
  await p.fill("dialog[open] .dialog__input", "x.md")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => document.getElementById("server-status").textContent.includes("read-only"))
  assert.deepEqual(p.errors, [])
})

test("H8: a chat's tools and skills switch here only; the allowed commands can be forgotten", async () => {
  const p = await page(h8())
  await p.waitForSelector('.chatrow[data-id="chat1"]')
  await p.click('.chatrow[data-id="chat1"]', { button: "right" })
  await p.click(".menu .menu__item >> text=Tools and skills…")
  await p.waitForSelector('.scope [data-key="family:notes"]')
  const rows = await p.$$eval(".scope .scope__row", (l) => l.map((x) => [x.textContent, x.querySelector("input").checked]))
  assert.deepEqual(rows, [["Notes", true], ["Web search", false], ["baking", true]])
  assert.equal(await p.getAttribute('.scope .scope__row:has([data-key="skill:baking"])', "title"), "Bake waybread.")
  await p.click('.scope [data-key="family:notes"]')
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/scope").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/chats/chat1/scope")))[0].args.body, { kind: "family", name: "notes", on: false })
  await p.waitForFunction(() => document.querySelector('.scope [data-key="family:notes"]') && !document.querySelector('.scope [data-key="family:notes"]').checked && !document.querySelector('.scope [data-key="family:notes"]').disabled)
  assert.match(await p.textContent(".scope__allow"), /bash:ls \*/)
  await shot(p, "h8-scope-1280")
  await p.click(".scope .btn >> text=Ask me about these again")
  await p.waitForFunction(() => !document.querySelector(".scope__allow"))
  assert.deepEqual(p.errors, [])
})

test("H8: at 390 px the server's pane and the switches stay inside the window", async () => {
  const p = await page(h8(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("nav-files").click())
  await p.click('#files-tabs [data-tab="server"]')
  await p.waitForSelector('#server-list .frow[data-path="/home/frodo/lembas.md"]')
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "h8-files-390")
  assert.deepEqual(p.errors, [])
})

// N8: Files › Server for an administrator (owner, on 1.0.0-beta.7: "shows nothing", then it loaded
// late). The pane drew nothing at all while the listing was on its way -- no word that it was being
// read, and a refusal or a broken answer only as late as Rust's 60 s read timeout. An answer that
// came after Read again was appended beside the new one. The answer below is what the server's own
// test client gives an administrator for `GET /api/v2/files?path=/` (2.0.0-beta.9: `fs.start` is `/`
// for an organisation's owner), with a mount and files at the root as on a lived-in instance.

const ADMIN_ROOT = {
  path: "/",
  parent: null,
  entries: [
    { name: "home", path: "/home", kind: "dir", size: 0, mime: "", updated_at: STAMP },
    { name: "shared", path: "/shared", kind: "mount", size: 0, mime: "", updated_at: STAMP },
    { name: "skills", path: "/skills", kind: "dir", size: 0, mime: "", updated_at: STAMP },
    { name: "retry_util.py", path: "/retry_util.py", kind: "file", size: 1917, mime: "text/x-python", updated_at: STAMP },
    { name: "test.py", path: "/test.py", kind: "file", size: 210, mime: "text/x-python", updated_at: STAMP },
  ],
}
const ROOT_KEY = "GET /files?path=%2F"

function n8(over = {}, hold = []) {
  return {
    status: status(),
    routes: baseRoutes({
      [ROOT_KEY]: ADMIN_ROOT,
      "GET /files?path=%2Fhome": { path: "/home", parent: "/", entries: [{ name: "ada", path: "/home/ada", kind: "dir", size: 0, mime: "", updated_at: STAMP }] },
      ...over,
    }),
    hold,
    streams: {},
  }
}

async function openServerTab(p) {
  await p.evaluate(() => document.getElementById("nav-files").click())
  await p.click('#files-tabs [data-tab="server"]')
}

const serverRows = (p) => p.$$eval("#server-list .frow[data-path]", (l) => l.map((x) => x.dataset.path))

test("N8: the administrator's / is drawn: folders, the mount and the files at the root; Loading… while it is read", async () => {
  const p = await page(n8({}, [ROOT_KEY]))
  await openServerTab(p)
  await p.waitForSelector("#server-list .fnote.is-loading")
  assert.equal((await p.textContent("#server-list .fnote.is-loading")).trim(), "Loading…")
  assert.ok(await p.isVisible("#server-list .fnote.is-loading"), "the pane is not empty while it waits")
  await p.evaluate((k) => window.__mock.release(k), ROOT_KEY)
  await p.waitForSelector('#server-list .frow[data-path="/test.py"]')
  assert.deepEqual(await serverRows(p), ["/home", "/shared", "/skills", "/retry_util.py", "/test.py"])
  assert.equal(await p.locator("#server-list .is-loading").count(), 0)
  // The mount opens like a folder; a folder's children come under it.
  await p.click('#server-list .frow[data-path="/home"] .frow__open')
  await p.waitForSelector('#server-list .frow[data-path="/home/ada"]')
  assert.ok(await p.isVisible('#server-list .frow[data-path="/home/ada"]'))
  await shot(p, "n8-admin-root-1280")
  assert.deepEqual(p.errors, [])
})

test("N8: an answer that has not come in 8 s says so and offers Try again; the late answer is still drawn", async () => {
  const p = await page(n8({}, [ROOT_KEY]), { clock: true })
  await openServerTab(p)
  await p.waitForSelector("#server-list .fnote.is-loading")
  assert.equal(await p.locator("#server-list .fnote__retry").count(), 0)
  await p.clock.fastForward(9000)
  await p.waitForSelector("#server-list .fnote.is-loading .fnote__retry")
  assert.match(await p.textContent("#server-list .fnote.is-loading"), /The server has not answered in 8 seconds\./)
  await p.evaluate((k) => window.__mock.release(k), ROOT_KEY)
  await p.waitForSelector('#server-list .frow[data-path="/test.py"]')
  assert.equal(await p.locator("#server-list .fnote").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("N8: a refusal is said in the pane with Try again, which reads the folder afresh", async () => {
  const p = await page(n8({ [ROOT_KEY]: { __error: { status: 403, detail: "This token was not given the app scope." } } }))
  await openServerTab(p)
  await p.waitForSelector("#server-list .fnote.is-error")
  assert.match(await p.textContent("#server-list .fnote.is-error"), /This token was not given the app scope\./)
  assert.equal(await p.getAttribute("#server-list .fnote.is-error", "role"), "alert")
  await p.evaluate(([k, v]) => window.__mock.answer(k, v), [ROOT_KEY, ADMIN_ROOT])
  await p.click("#server-list .fnote__retry")
  await p.waitForSelector('#server-list .frow[data-path="/home"]')
  assert.equal(await p.locator("#server-list .is-error").count(), 0)
  assert.equal((await p.evaluate((k) => window.__mock.api("GET", "/files?path=%2F").length)), 2)
  assert.deepEqual(p.errors, [])
})

test("N8: an answer that is not a listing is said, never an empty pane", async () => {
  for (const broken of [null, { path: "/" }, { detail: "Not Found" }]) {
    const p = await page(n8({ [ROOT_KEY]: broken }))
    await openServerTab(p)
    await p.waitForSelector("#server-list .fnote.is-error")
    assert.match(await p.textContent("#server-list .fnote.is-error"), /The server's answer could not be read\./)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("N8: Read again while the first answer is on its way draws the listing once", async () => {
  const p = await page(n8({}, [ROOT_KEY]))
  await openServerTab(p)
  await p.waitForSelector("#server-list .fnote.is-loading")
  await p.click("#server-refresh")
  await p.waitForFunction((k) => window.__mock.api("GET", "/files?path=%2F").length === 2)
  await p.evaluate((k) => window.__mock.release(k), ROOT_KEY)
  await p.waitForSelector('#server-list .frow[data-path="/test.py"]')
  await p.waitForTimeout(50)
  assert.deepEqual(await serverRows(p), ["/home", "/shared", "/skills", "/retry_util.py", "/test.py"])
  assert.deepEqual(p.errors, [])
})

test("N8: at 390 px the waiting and the refusal stay inside the window, Try again reachable", async () => {
  const p = await page(n8({ [ROOT_KEY]: { __error: { status: 0, detail: "Could not reach the server: connection timed out after a long wait at the very far end of the network" } } }), { width: 390, height: 844 })
  await openServerTab(p)
  await p.waitForSelector("#server-list .fnote__retry")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  const box = await p.locator("#server-list .fnote__retry").boundingBox()
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 28, `Try again is on the screen: ${JSON.stringify(box)}`)
  await shot(p, "n8-refused-390")
  assert.deepEqual(p.errors, [])
})

// I8: voice (/v1/audio, through Rust) and drawing a picture (/v1/images, through Rust).

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

function i8({ stt = true, tts = true, images = true, scopes = ["app", "models"] } = {}, commands = {}) {
  const reply = { id: "m6", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: null, steps: [{ kind: "text", markdown: "Lembas is **baked** in leaves.\n\n```\nsecret\n```" }] }
  return {
    status: status(),
    routes: baseRoutes({
      "GET /me": { id: "u1", name: "Ada Example", email: "ada@example.org", theme: "moria", language: "en", permissions: {}, services: { stt, tts, images, search: false, fetch: false }, scopes },
      "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?"), reply], more: false, live: null },
    }),
    commands: { transcribe: { text: "baked in leaves", source: "", fallback: false }, speak: { url: "data:audio/mpeg;base64,SUQz", source: "", fallback: false }, draw: [PNG, "https://elsewhere.example/x.png"], ...commands },
    streams: {},
  }
}

// A microphone and a recorder that record two bytes: the page's own, the browser's untouched.
async function fakeMicrophone(p) {
  await p.evaluate(() => {
    const track = { stop() {} }
    // The test's page is not a secure context, so it has no mediaDevices of its own.
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true })
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track] })
    window.MediaRecorder = class extends EventTarget {
      static isTypeSupported(x) {
        return x === "audio/webm;codecs=opus"
      }
      constructor(stream, options) {
        super()
        this.mimeType = options?.mimeType || ""
        this.state = "inactive"
      }
      start() {
        this.state = "recording"
      }
      stop() {
        this.state = "inactive"
        const data = new Event("dataavailable")
        data.data = new Blob([new Uint8Array([1, 2])], { type: this.mimeType })
        this.dispatchEvent(data)
        this.dispatchEvent(new Event("stop"))
      }
    }
    HTMLMediaElement.prototype.play = async function () {}
  })
}

test("I8: Dictate records, asks Rust for the microphone first, and puts the words where the cursor is", async () => {
  const p = await page(i8())
  await p.waitForSelector("#dictate:not([hidden])")
  await fakeMicrophone(p)
  await p.fill("#composer-text", "Lembas is")
  await p.click("#dictate")
  await p.waitForSelector('#dictate.is-recording[aria-pressed="true"]')
  const order = await p.evaluate(() => window.__mock.calls.map((c) => c.cmd).filter((c) => c === "voice_arm"))
  assert.deepEqual(order, ["voice_arm"])
  await shot(p, "i8-dictate-1280")
  await p.click("#dictate")
  await p.waitForFunction(() => document.getElementById("composer-text").value === "Lembas is baked in leaves")
  assert.equal(await p.getAttribute("#dictate", "aria-pressed"), "false")
  assert.ok(await p.evaluate(() => window.__mock.calls.some((c) => c.cmd === "transcribe")))
  assert.deepEqual(p.errors, [])
})

// Speech says which chat it is for: Rust sends `x-chat` as `chat_id` and `x-model` as `chat_model`
// (server.rs, tested there), and the server answers with that chat's connection's own speech model.

async function dictateOnce(p, n = 1) {
  await p.click("#dictate")
  await p.waitForSelector('#dictate.is-recording[aria-pressed="true"]')
  await p.click("#dictate")
  await p.waitForFunction((n) => window.__mock.calls.filter((c) => c.cmd === "transcribe").length === n && !document.getElementById("dictate").disabled, n)
}

test("I8: Dictate in an open chat sends chat_id: the chat's id, and no model", async () => {
  const p = await page(i8())
  await fakeMicrophone(p)
  await p.click('.chatrow[data-id="chat1"]')
  await p.waitForSelector('.msg--assistant[data-id="m6"]')
  await dictateOnce(p)
  const call = await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "transcribe"))
  assert.deepEqual(call.headers, { "x-type": "audio/webm;codecs=opus", "x-chat": "chat1" })
  assert.equal(await p.inputValue("#composer-text"), "baked in leaves")
  assert.deepEqual(p.errors, [])
})

test("I8: Dictate in a new chat sends chat_model: the ref of the model the chat will start on", async () => {
  // The models as the server serialises them (its fixture), each with its ref.
  const config = i8()
  config.routes["GET /models"] = fixture("models")
  const p = await page(config)
  await p.waitForSelector("#dictate:not([hidden])")
  await p.waitForFunction(() => window.__mock.api("GET", "/models").length >= 1)
  await fakeMicrophone(p)
  await dictateOnce(p)
  const call = await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "transcribe"))
  assert.deepEqual(call.headers, { "x-type": "audio/webm;codecs=opus", "x-model": "local%2Fqwen" })
  assert.deepEqual(p.errors, [])
})

test("I8: Read aloud sends chat_id, and the default answering for the chat's own is said once, as a note", async () => {
  const by = { source: "stt/whisper-1", fallback: true }
  const p = await page(i8({}, { transcribe: { text: "baked", ...by }, speak: { url: "data:audio/mpeg;base64,SUQz", source: "tts/tts-1", fallback: true } }))
  await fakeMicrophone(p)
  await p.click('.chatrow[data-id="chat1"]')
  await p.waitForSelector('.msg--assistant[data-id="m6"] .msg__speak')
  await p.click('.msg--assistant[data-id="m6"] .msg__speak')
  await p.waitForSelector('.msg__speak[aria-pressed="true"]:not(.is-busy)')
  assert.deepEqual(await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "speak").args), { text: "Lembas is baked in leaves.", chat: "chat1" })
  await p.waitForSelector("#thread-note.is-info:not([hidden])")
  assert.equal(await p.textContent("#thread-note"), "Read by tts/tts-1: this chat's own speech model did not answer.")
  await dictateOnce(p)
  await p.waitForFunction(() => document.getElementById("thread-note").textContent === "Transcribed by stt/whisper-1: this chat's own speech model did not answer.")
  assert.equal(await p.evaluate(() => document.getElementById("thread-note").classList.contains("is-error")), false)
  await shot(p, "i8-fallback-note-1280")
  // Said once for this chat: the next recording there is written down without the note again.
  await p.evaluate(() => {
    const box = document.getElementById("thread-note")
    box.textContent = ""
    box.hidden = true
  })
  await dictateOnce(p, 2)
  assert.equal(await p.textContent("#thread-note"), "")
  assert.deepEqual(p.errors, [])
})

test("I8: no Dictate, Read aloud or Draw where the server has none of them, or the token lacks models", async () => {
  let p = await page(i8({ stt: false, tts: false, images: false }))
  await p.click('.chatrow[data-id="chat1"]')
  await p.waitForSelector('.msg--assistant[data-id="m6"]')
  assert.equal(await p.isHidden("#dictate"), true)
  assert.equal(await p.locator(".msg__speak").count(), 0)
  await p.keyboard.press("Control+k")
  assert.equal(await p.locator(".palette__item >> text=Draw a picture").count(), 0)
  await p.context().close()
  p = await page(i8({ scopes: ["app"] }))
  await p.waitForSelector("#composer")
  await p.waitForFunction(() => window.__mock.api("GET", "/me").length === 1)
  assert.equal(await p.isHidden("#dictate"), true)
  assert.deepEqual(p.errors, [])
})

test("I8: Read aloud speaks a reply's words without its markdown or code, and stops when pressed again", async () => {
  const p = await page(i8())
  await fakeMicrophone(p)
  await p.click('.chatrow[data-id="chat1"]')
  await p.waitForSelector('.msg--assistant[data-id="m6"] .msg__speak')
  await p.click('.msg--assistant[data-id="m6"] .msg__speak')
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "speak"))
  assert.deepEqual((await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "speak").args)), { text: "Lembas is baked in leaves.", chat: "chat1" })
  await p.waitForSelector('.msg__speak[aria-pressed="true"]:not(.is-busy)')
  await p.click('.msg--assistant[data-id="m6"] .msg__speak')
  await p.waitForSelector('.msg__speak[aria-pressed="false"]')
  assert.deepEqual(p.errors, [])
})

test("I8: Draw a picture shows only the server's own pictures, as Rust read them", async () => {
  const p = await page(i8())
  await p.waitForFunction(() => window.__mock.api("GET", "/me").length === 1)
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "draw")
  await p.click(".palette__item >> text=Draw a picture")
  await p.fill(".draw__prompt", "A lembas loaf on a leaf")
  await p.selectOption(".draw__size", "1344x768")
  await p.click(".draw button[type=submit]")
  await p.waitForSelector(".draw__pic img")
  assert.deepEqual((await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "draw").args)), { prompt: "A lembas loaf on a leaf", size: "1344x768" })
  const srcs = await p.$$eval(".draw__pic img", (l) => l.map((x) => x.getAttribute("src")))
  assert.deepEqual(srcs, [PNG])
  await shot(p, "i8-draw-1280")
  assert.deepEqual(p.errors, [])
})

test("I8: at 390 px the composer with Dictate and the drawing dialog stay inside the window", async () => {
  const p = await page(i8(), { width: 390, height: 844 })
  await p.waitForSelector("#dictate:not([hidden])")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "i8-composer-390")
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "draw")
  await p.click(".palette__item >> text=Draw a picture")
  await p.fill(".draw__prompt", "A lembas loaf")
  await p.click(".draw button[type=submit]")
  await p.waitForSelector(".draw__pic img")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "i8-draw-390")
  assert.deepEqual(p.errors, [])
})

// J8: a notification clicked (Rust: notification_action) opens the chat or the scheduled task.

test("J8: a scheduled run's notification opens its task, and a chat's opens the chat", async () => {
  const p = await page({
    status: status(),
    routes: baseRoutes({
      "GET /schedules": { schedules: fixture("event_schedules").schedules },
      "GET /schedules/sched1": fixture("schedule"),
      "GET /schedules/sched1/runs": { runs: [fixture("schedule_run").run || fixture("schedule_run")], more: false },
      "GET /schedules/models": { models: [], instance: [], mine: [] },
      "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null },
    }),
    streams: {},
  })
  await p.waitForSelector("#composer")
  await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched1", run: "run1" }))
  await p.waitForSelector("#page-scheduled:not([hidden])")
  await p.waitForFunction(() => window.__mock.api("GET", "/schedules/sched1").length >= 1)
  await p.waitForFunction(() => /Waybread check/.test(document.getElementById("scheduled-title").textContent))
  await p.evaluate(() => window.__mock.emit("open-chat", "chat1"))
  await p.waitForFunction(() => window.__mock.api("GET", "/chats/chat1").filter((x) => x.args.path === "/chats/chat1").length === 1)
  assert.deepEqual(p.errors, [])
})

// K8: the release the server recommends (GET /apps), in Settings › About.

async function aboutWith(version, apps) {
  const p = await page({ status: status({ version }), routes: baseRoutes({ "GET /apps": apps }), streams: {} })
  await p.click("#settings-btn")
  await p.waitForFunction(() => window.__mock.api("GET", "/apps").length === 1)
  await p.waitForTimeout(100)
  return p
}

test("K8: a newer release the server recommends is offered in About, with its release page", async () => {
  const p = await aboutWith("1.0.0", fixture("apps_stable"))
  await p.waitForSelector("#set-about >> text=Your server recommends LLeMbas Desktop 1.0.1")
  await p.click("#set-about .btn >> text=Open the release page")
  const opened = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "open_external").map((c) => c.args.url))
  assert.deepEqual(opened, ["https://github.com/LLeMbas/LLeMbas-Desktop/releases/tag/v1.0.1"])
  await shot(p, "k8-about-1280")
  assert.deepEqual(p.errors, [])
})

test("K8: nothing is offered that is not newer, a beta to a stable install, or a page elsewhere", async () => {
  const beta = { apps: { desktop: { version: "1.1.0-beta.2", tag: "v1.1.0-beta.2", channel: "beta", page: "https://github.com/LLeMbas/LLeMbas-Desktop/releases/tag/v1.1.0-beta.2" } } }
  for (const [mine, apps, shown] of [
    ["1.0.1", fixture("apps_stable"), false],
    ["1.0.0", beta, false],
    ["1.0.0-beta.6", beta, true],
    ["1.0.0", { apps: { desktop: { version: "1.0.2", page: "https://elsewhere.example/releases/tag/v1.0.2" } } }, false],
    ["1.0.0", { __error: { status: 404, detail: "Not Found" } }, false],
  ]) {
    const p = await aboutWith(mine, apps)
    assert.equal(await p.locator("#set-about >> text=Your server recommends").count(), shown ? 1 : 0, `${mine} ← ${JSON.stringify(apps).slice(0, 60)}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// L8: where a scheduled task runs (runs_on, fixture schedule_on_device.json; /devices `scheduled`).

function l8(devices) {
  const on = fixture("schedule_on_device")
  const id = on.schedule.id
  return {
    status: status({ host: "workbench" }),
    routes: baseRoutes({
      "GET /devices": { devices },
      "GET /schedules": { schedules: [on.schedule] },
      [`GET /schedules/${id}`]: on,
      [`GET /schedules/${id}/runs`]: { runs: [on.schedule.last_run], more: false },
      "GET /schedules/models": { models: [], instance: [], mine: [] },
      "POST /schedules/compile": { ok: true, reason: "", title: "Build check", instruction: "Check the build.", target: "chat", rule: { at: { times: ["07:30"] } }, description: "Every day at 07:30", next_runs: [], timezone: "UTC" },
      "POST /schedules": { schedule: { ...on.schedule, id: "sched9" } },
      "GET /schedules/sched9": { schedule: { ...on.schedule, id: "sched9" } },
      "GET /schedules/sched9/runs": { runs: [], more: false },
    }),
    streams: {},
  }
}

const bagEnd = (over = {}) => ({ id: "tok1", name: "bag-end", host: "bag-end", platform: "linux", terminal: true, scheduled: true, max_mode: "", ...over })

async function openTask(p) {
  await p.waitForSelector("#composer")
  await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" }))
  await p.waitForSelector("#sched-type-said")
}

test("L8: a task on a linked computer says the computer, the folder and mode; a run waits for it", async () => {
  const p = await page(l8([bagEnd()]))
  await openTask(p)
  assert.equal(await p.textContent("#sched-type-said"), "Agentic")
  assert.match(await p.textContent("#sched-computer-said"), /bag-end/)
  const where = await p.textContent("#sched-folder-said")
  assert.match(where, /\/home\/frodo\/waybread/)
  assert.match(where, /Edit — asks before commands · approvals wait 30 min/)
  assert.match(await p.textContent(".fact:has(.fact__label:text-is('Model'))"), /The folder's usual model/, "no model of its own: its folder's")
  assert.equal(await p.locator(".fact.is-warning").count(), 0)
  assert.match(await p.textContent(".run[data-id='run5']"), /Waiting for the computer/)
  assert.match(await p.textContent(".run[data-id='run5']"), /Waiting for bag-end to be linked\./)
  await shot(p, "l8-task-1280")
  assert.deepEqual(p.errors, [])
})

test("L8: a computer away, or not accepting scheduled work, is said on the task", async () => {
  for (const [devices, words] of [
    [[], /Away now/],
    [[bagEnd({ scheduled: false })], /does not accept scheduled work/],
  ]) {
    const p = await page(l8(devices))
    await openTask(p)
    assert.match(await p.textContent(".fact.is-warning"), words)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("L8: a new task can run on this computer, in a folder and mode; one not accepting cannot be chosen", async () => {
  const p = await page(l8([bagEnd({ scheduled: false }), bagEnd({ id: "token1", name: "workbench", host: "workbench" })]))
  await p.waitForSelector("#composer")
  await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" }))
  await p.waitForSelector("#page-scheduled:not([hidden])")
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "New scheduled")
  await p.keyboard.press("Enter")
  // The type first: Chat until Agentic is chosen, which starts on the computer that accepts.
  assert.ok(await p.isChecked("#sched-type-chat"))
  await p.check("#sched-type-agentic")
  await p.fill("#sched-words", "every day at 7:30 check the build")
  await p.click(".sched--new button[type=submit]")
  await p.waitForSelector("#sched-device")
  const options = await p.$$eval("#sched-device option", (l) => l.map((o) => [o.textContent, o.disabled, o.selected]))
  assert.deepEqual(options, [["bag-end — does not accept scheduled work", true, false], ["This computer (workbench)", false, true]])
  assert.equal(await p.inputValue("#sched-cwd"), "/home/dev/project")
  await p.selectOption("#sched-runmode", "auto")
  await p.fill("#sched-wait", "45")
  await shot(p, "l8-form-1280")
  await p.click("#sched-save")
  await p.waitForFunction(() => window.__mock.api("POST", "/schedules").some((c) => c.args.path === "/schedules"))
  const body = (await p.evaluate(() => window.__mock.api("POST", "/schedules").find((c) => c.args.path === "/schedules"))).args.body
  assert.deepEqual(body.runs_on, { device: "token1", cwd: "/home/dev/project", mode: "auto", approval_wait_minutes: 45 })
  assert.deepEqual(p.errors, [])
})

test("L8: at 390 px the form with a computer chosen stays inside the window", async () => {
  const p = await page(l8([bagEnd()]), { width: 390, height: 844 })
  await p.waitForSelector("#composer")
  await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" }))
  await p.waitForSelector("#sched-type-said")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "l8-task-390")
  await p.click("#sched-edit")
  await p.waitForSelector("#sched-cwd")
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "l8-form-390")
  assert.deepEqual(p.errors, [])
})

// M8: a picture as the reply (force_tool "image_generate" on POST /chats and /messages).

test("M8: Draw a picture asks for a picture with the next message only, in a new chat and an open one", async () => {
  const cfg = i8()
  Object.assign(cfg.routes, {
    "POST /chats": { chat: chatRow({ id: "chat7" }), message: userMessage("m1", "a lembas loaf"), reply: null },
    "POST /chats/chat7/messages": { message: userMessage("m2", "and another"), reply: null },
  })
  const p = await page(cfg)
  await p.waitForFunction(() => window.__mock.api("GET", "/me").length === 1)
  await p.click(".kind__tab >> text=Chat")
  await p.click(".cchip--picture")
  assert.equal(await p.getAttribute(".cchip--picture", "aria-pressed"), "true")
  await shot(p, "m8-picture-1280")
  await p.fill("#composer-text", "a lembas loaf")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  assert.equal((await p.evaluate(() => window.__mock.api("POST", "/chats")))[0].args.body.force_tool, "image_generate")
  await p.waitForSelector('.cchip--picture[aria-pressed="false"]')
  await p.fill("#composer-text", "and another")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat7/messages").length === 1)
  assert.equal((await p.evaluate(() => window.__mock.api("POST", "/chats/chat7/messages")))[0].args.body.force_tool, undefined)
  assert.deepEqual(p.errors, [])
})

test("M8: no picture switch where the server cannot draw, or in an agent chat", async () => {
  const p = await page(i8({ images: false }))
  await p.waitForFunction(() => window.__mock.api("GET", "/me").length === 1)
  await p.click(".kind__tab >> text=Chat")
  assert.equal(await p.locator(".cchip--picture").count(), 0)
  await p.context().close()
  const q = await page(i8())
  await q.waitForFunction(() => window.__mock.api("GET", "/me").length === 1)
  await q.click(".kind__tab >> text=Agent")
  assert.equal(await q.locator(".cchip--picture").count(), 0)
  assert.deepEqual(q.errors, [])
})

// FX: the Files page as the web's explorer -- crumbs, the folder tree, the list in columns, the
// chosen file's details and preview, using the window's width; narrower, the details and then the
// tree give way, and nothing is ever cut off or scrolls the page sideways.

const LONG = "a-very-long-file-name-that-somebody-chose-for-the-lembas-recipe-and-its-variants.md"
function fx() {
  const cfg = n8({
    "GET /files?path=%2Fhome": { path: "/home", parent: "/", entries: [{ name: "ada", path: "/home/ada", kind: "dir", size: 0, mime: "", updated_at: STAMP }, { name: LONG, path: `/home/${LONG}`, kind: "file", size: 123456, mime: "text/markdown", updated_at: STAMP }] },
    "GET /files/content": { path: "/test.py", name: "test.py", size: 210, mime: "text/x-python", kind: "code", language: "python", sha: "x", text: "print('lembas')\n" },
  })
  cfg.commands = {
    local_list: { root: "/home/dev/project", path: "", more: false, entries: [{ name: "src", path: "src", kind: "dir", size: 0, modified: 1767323045 }, { name: "README.md", path: "README.md", kind: "file", size: 2048, modified: 1767323045 }] },
    local_read: { root: "/home/dev/project", path: "README.md", name: "README.md", size: 2048, text: "# Project\n", withheld: null },
  }
  return cfg
}

test("FX: wide, the server's files are a tree, a list in columns and the chosen file's details with a preview", async () => {
  const p = await page(fx(), { width: 1600, height: 900 })
  await openServerTab(p)
  await p.waitForSelector('#server-list .frow[data-path="/test.py"]')
  // The tree: the top, then its folders; the top is where we are.
  await p.waitForSelector('#server-tree li[data-path="/home"]')
  assert.equal(await p.textContent("#server-tree .ftree__root"), "All files")
  assert.equal(await p.getAttribute("#server-tree .ftree__root", "aria-current"), "true")
  assert.deepEqual(await p.$$eval("#server-tree li[data-path]", (l) => l.map((x) => x.dataset.path)), ["/home", "/shared", "/skills"])
  // The columns, and the kinds' words.
  assert.deepEqual(await p.$$eval("#server-list .frow--head [role=columnheader]", (l) => l.map((x) => x.textContent)), ["", "Name", "Type", "Size", "Changed", "Actions"])
  assert.equal(await p.textContent('#server-list .frow[data-path="/shared"] .frow__type'), "mount")
  assert.equal(await p.textContent('#server-list .frow[data-path="/home"] .frow__type'), "folder")
  assert.equal(await p.textContent('#server-list .frow[data-path="/test.py"] .frow__type'), "py")
  assert.equal(await p.textContent('#server-list .frow[data-path="/test.py"] .frow__size'), "210 B")
  // Every row's cells on the same tracks: the size column's left edge is one x for every row.
  const xs = await p.$$eval("#server-list .frow .frow__size", (l) => [...new Set(l.map((x) => Math.round(x.getBoundingClientRect().right)))])
  assert.equal(xs.length, 1, `sizes end on one line: ${xs}`)
  // A file chosen: its details and the start of it.
  assert.match(await p.textContent("#server-details"), /Choose a file to see it here\./)
  await p.click('#server-list .frow[data-path="/test.py"] .frow__open')
  await p.waitForSelector("#server-details .fdetails__text")
  assert.equal(await p.textContent("#server-details .fdetails__name"), "test.py")
  assert.equal(await p.textContent("#server-details .fdetails__text"), "print('lembas')\n")
  assert.ok(await p.$eval('#server-list .frow[data-path="/test.py"]', (x) => x.classList.contains("is-chosen")))
  assert.ok(await p.isHidden("#viewer"), "choosing is not opening")
  await shot(p, "fx-server-1600")
  // Open in the viewer from the details, and with a double click.
  await p.click("#server-details .btn--primary")
  await p.waitForSelector("#viewer:not([hidden])")
  assert.equal(await p.textContent("#viewer-name"), "test.py")
  assert.deepEqual(p.errors, [])
})

test("FX: a folder is listed from the list, the tree or the crumbs; the crumbs say where", async () => {
  const p = await page(fx(), { width: 1280, height: 860 })
  await openServerTab(p)
  await p.waitForSelector('#server-list .frow[data-path="/home"]')
  await p.click('#server-list .frow[data-path="/home"] .frow__open')
  await p.waitForSelector(`#server-list .frow[data-path="/home/${LONG}"]`)
  assert.deepEqual(await p.$$eval("#server-crumbs > *:not(.crumbs__sep)", (l) => l.map((x) => x.textContent)), ["All files", "home"])
  assert.equal(await p.getAttribute('#server-tree .ftree__row[data-path="/home"]', "aria-current"), "true")
  // A long name gives, the rest of its row stays on its tracks and inside the list.
  const row = await p.$eval(`#server-list .frow[data-path="/home/${LONG}"]`, (r) => {
    const list = document.getElementById("server-list").getBoundingClientRect()
    const more = r.querySelector(".frow__when").getBoundingClientRect()
    return { right: more.right, list: list.right, label: r.querySelector(".frow__label").scrollWidth > r.querySelector(".frow__label").clientWidth }
  })
  assert.ok(row.right <= row.list && row.label, `the long name is cut with an ellipsis, the date inside: ${JSON.stringify(row)}`)
  await p.click("#server-crumbs .crumbs__link")
  await p.waitForSelector('#server-list .frow[data-path="/test.py"]')
  await p.click('#server-tree .ftree__row[data-path="/home"]')
  await p.waitForSelector(`#server-list .frow[data-path="/home/${LONG}"]`)
  await p.waitForSelector('#server-tree li[data-path="/home/ada"]')
  await shot(p, "fx-server-1280")
  assert.deepEqual(p.errors, [])
})

test("FX: this computer's folder in the same shape, its dates from the system's", async () => {
  const p = await page(fx(), { width: 1600, height: 900 })
  await p.evaluate(() => document.getElementById("nav-files").click())
  await p.waitForSelector('#local-list .frow[data-path="README.md"]')
  assert.equal(await p.textContent("#local-tree .ftree__root"), "project")
  assert.equal(await p.textContent("#local-crumbs .crumbs__here"), "project")
  assert.notEqual((await p.textContent('#local-list .frow[data-path="README.md"] .frow__when')).trim(), "")
  await p.click('#local-list .frow[data-path="README.md"] .frow__open')
  await p.waitForSelector("#local-details .fdetails__text")
  assert.equal(await p.textContent("#local-details .fdetails__text"), "# Project\n")
  await shot(p, "fx-local-1600")
  assert.deepEqual(p.errors, [])
})

test("FX: at every width nothing scrolls sideways and nothing is cut off; narrower, a file opens in the viewer", async () => {
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844]]) {
    const p = await page(fx(), { width, height })
    await openServerTab(p)
    await p.waitForSelector('#server-list .frow[data-path="/home"]')
    await p.click('#server-list .frow[data-path="/home"] .frow__open')
    await p.waitForSelector(`#server-list .frow[data-path="/home/${LONG}"]`)
    assert.ok(await noSideways(p, width), `${width}: nothing scrolls sideways`)
    // Every visible control of the bar and the rows is inside the window.
    const out = await p.$$eval("#pane-server button, #pane-server .frow__size", (l, w) => l.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > w + 1) }).map((b) => b.className || b.id), width)
    assert.deepEqual(out, [], `${width}: controls inside the window`)
    // The panes give way by the room the page has (60rem, 40rem of it), not the window's width.
    const room = await p.$eval("#pane-server", (x) => x.getBoundingClientRect().width)
    const details = await p.isVisible("#server-details")
    assert.equal(details, room > 960, `${width}: the details pane at ${room} px`)
    assert.equal(await p.isVisible("#server-tree"), room > 640, `${width}: the tree at ${room} px`)
    // The name's track never closes: every name shows at least a few letters.
    const names = await p.$$eval("#server-list .frow__label", (l) => Math.min(...l.map((x) => x.getBoundingClientRect().width)))
    assert.ok(names >= 24, `${width}: names keep room (${names} px)`)
    await shot(p, `fx-server-${width}`)
    await p.click("#server-crumbs .crumbs__link")
    await p.waitForSelector('#server-list .frow[data-path="/test.py"]')
    await p.click('#server-list .frow[data-path="/test.py"] .frow__open')
    if (details) await p.waitForSelector("#server-details .fdetails__text")
    else await p.waitForSelector("#viewer:not([hidden])")
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// CI2: the chat's input overhauled -- the chat's settings (mode, model, effort, subagents) in the
// header's top right beside Terminal, the activity panel, tools and skills and the menu; the
// composer keeps the message's own: text, attach, Dictate, Draw a picture, Send/Stop. Nothing is
// cut off or out of reach at any width: where the settings do not fit they fold behind Chat
// settings, which opens them as a wrapped row of their own.

const LONG_MODEL = "Qwen3.8 Coder 480B A35B Instruct, long context, tools and vision"
function ci2(kind) {
  const cfg = i8()
  const m = models()
  m.models[0] = { ...m.models[0], name: LONG_MODEL }
  m.models[1] = { ...m.models[1], name: "Another model with a long name, served elsewhere" }
  Object.assign(cfg.routes, {
    "GET /models": m,
    "GET /models?chat=chat1": m,
    "GET /models?chat=chat2": m,
    "GET /chats/chat2": { chat: agentChat({ subagents: { offered: true, named_only: false, cap: 8 } }), messages: [userMessage("m1", "What is in build?")], more: false, live: null },
    "GET /chats/chat2/tree": { tree: [], live: true },
  })
  return cfg
}

/** Every visible button of the header and the composer inside the window, none of zero width. */
async function reachable(p, width) {
  return p.$$eval(
    "#chat-head button, #chat-target button, #composer button",
    (l, w) =>
      l
        .filter((b) => b.offsetParent !== null && getComputedStyle(b).visibility !== "hidden")
        .filter((b) => {
          const r = b.getBoundingClientRect()
          // A button inside a container that clips it (overflow) is cut off too.
          let clip = { left: 0, right: w }
          for (let el = b.parentElement; el; el = el.parentElement) {
            const cs = getComputedStyle(el)
            if (cs.overflowX !== "visible") {
              const c = el.getBoundingClientRect()
              clip = { left: Math.max(clip.left, c.left), right: Math.min(clip.right, c.right) }
            }
          }
          return r.width < 8 || r.left < clip.left - 1 || r.right > clip.right + 1
        })
        .map((b) => b.className || b.id),
    width,
  )
}

/** Pairs of the header's controls (and where the chat works) drawn over each other. */
async function overlapping(p) {
  return p.$$eval("#chat-head button, #chat-head .place", (l) => {
    const shown = l.filter((b) => b.offsetParent !== null && b.getBoundingClientRect().width > 0)
    const out = []
    for (let i = 0; i < shown.length; i++)
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i].getBoundingClientRect()
        const b = shown[j].getBoundingClientRect()
        if (shown[i].contains(shown[j]) || shown[j].contains(shown[i])) continue
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${shown[i].className} / ${shown[j].className}`)
      }
    return out
  })
}

test("CI2: the composer holds the message's own controls; the chat's settings are in its header", async () => {
  const p = await page(ci2(), { width: 1600, height: 900 })
  await openChatRow(p, "chat1")
  await p.waitForSelector("#chat-settings .cchip--model")
  await p.waitForSelector("#chat-settings .cchip--subagents")
  assert.equal(await p.locator("#composer .cchip--model, #composer .cchip--subagents").count(), 0, "no settings in the composer")
  assert.equal(await p.locator("#composer-chips .cchip--picture").count(), 1, "Draw a picture stays with the message")
  assert.ok(await p.isVisible("#chat-tools #activity-open"))
  assert.ok(await p.isVisible("#chat-tools #scope-open"))
  assert.ok(await p.isHidden("#chat-fold"), "everything fits: nothing folded")
  // Tools and skills opens from the header.
  await p.click("#scope-open")
  await p.waitForSelector(".scope")
  await shot(p, "ci2-chat-1600")
  assert.deepEqual(p.errors, [])
})

test("CI2: at 1920, 1280, 1024, 800 and 390 px every control is reachable, with long model names and every chip on", async () => {
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844]]) {
    for (const id of ["chat1", "chat2"]) {
      const p = await page(ci2(), { width, height })
      await p.evaluate((x) => document.querySelector(`.chatrow[data-id="${x}"]`).click(), id)
      await p.waitForSelector("#messages .msg")
      await p.waitForSelector("#chat-settings .cchip--subagents", { state: "attached" })
      await p.waitForTimeout(100)
      assert.ok(await noSideways(p, width), `${width} ${id}: nothing sideways`)
      assert.deepEqual(await reachable(p, width), [], `${width} ${id}: every control inside`)
      assert.deepEqual(await overlapping(p), [], `${width} ${id}: nothing drawn over another`)
      const folded = await p.isVisible("#chat-fold")
      if (folded) {
        await p.click("#chat-fold")
        await p.waitForSelector("#chat-settings .cchip--model", { state: "visible" })
        assert.deepEqual(await reachable(p, width), [], `${width} ${id}: unfolded, every setting inside`)
        assert.deepEqual(await overlapping(p), [], `${width} ${id}: unfolded, nothing drawn over another`)
      }
      // Every setting is there and can be used: the model's menu opens.
      const names = await p.$$eval("#chat-settings .cchip", (l) => l.map((x) => x.className))
      assert.ok(names.some((n) => n.includes("cchip--model")) && names.some((n) => n.includes("cchip--subagents")), `${width} ${id}: ${names}`)
      if (id === "chat2") assert.ok(await p.isVisible("#chat-tools [data-terminal-toggle]"), `${width}: the Terminal`)
      await p.click("#chat-settings .cchip--model")
      await p.waitForSelector(".menu")
      assert.match(await p.textContent(".menu"), /Another model/)
      await p.keyboard.press("Escape")
      await shot(p, `ci2-${id}-${width}${folded ? "-unfolded" : ""}`)
      assert.deepEqual(p.errors, [])
      await p.context().close()
    }
  }
})

test("CI2: a new agent chat's settings are in the header; where it works is the bar above the composer, which holds only the message", async () => {
  for (const width of [1280, 390]) {
    const p = await page(ci2(), { width, height: 844 })
    await p.waitForSelector("#chat-settings .cchip--model", { state: "attached" })
    await p.click(".kind__tab >> text=Agent")
    await p.waitForSelector("#target-chips .cchip", { state: "attached" })
    assert.equal(await p.locator("#composer .cchip").count(), 0, "nothing but the message in an agent chat's composer")
    assert.equal(await p.locator("#chat-place .cchip, #chat-settings .cchip--mode").count(), 0, "computer, folder and mode are not in the header")
    assert.ok(await noSideways(p, width))
    assert.deepEqual(await reachable(p, width), [], `${width}: every control inside`)
    assert.deepEqual(await overlapping(p), [], `${width}: nothing drawn over another`)
    if (await p.isVisible("#chat-fold")) await p.click("#chat-fold")
    assert.deepEqual(await overlapping(p), [], `${width}: unfolded, nothing drawn over another`)
    assert.deepEqual(await reachable(p, width), [], `${width}: unfolded, every control inside`)
    await shot(p, `ci2-new-agent-${width}`)
    // A chat on the server has no such bar.
    await p.click(".kind__tab >> text=Chat")
    await p.waitForSelector("#chat-target", { state: "hidden" })
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- T1: the agent target bar and the composer, by construction ---------------------------------

const LONG_HOST = "a-workstation-with-a-remarkably-long-name-in-the-far-wing"
const LONG_DIR = "/srv/projects/the-lembas-recipe-and-all-of-its-variants-through-the-ages"

function t1() {
  const cfg = ci2()
  cfg.terminal = [READY]
  Object.assign(cfg.routes, {
    "GET /devices": { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: true }, { id: "token9", name: LONG_HOST, host: LONG_HOST, platform: "linux", terminal: true }] },
    "GET /chats": { chats: [chatRow(), agentChat(), agentChat({ id: "chat9", title: "The site", device: { token_id: "token9", directory: LONG_DIR } })], more: false },
    "GET /models?kind=agent&device=token9": { ...models(), agent_subagents: { offered: true, device_runs: true }, subagents_cap: 8 },
  })
  return cfg
}

/** Whether every one of `selector` is whole inside the window and inside whatever clips it. */
const inside = (p, selector, width) =>
  p.$$eval(
    selector,
    (l, w) =>
      l.filter((b) => b.offsetParent !== null).every((b) => {
        const r = b.getBoundingClientRect()
        return r.width >= 8 && r.left >= -1 && r.right <= w + 1
      }),
    width,
  )

test("T1: at 1920, 1280, 1024, 800 and 390 px the bar's computer, folder and mode are reachable with a long name and a long path, and each opens its menu", async () => {
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844]]) {
    const p = await page(t1(), { width, height })
    await p.evaluate(() => document.getElementById("new-chat-btn").click())
    await p.click(".kind__tab >> text=Agent")
    await pickDevice(p, LONG_HOST)
    await p.waitForFunction(() => /remarkably/.test(document.querySelector("#target-chips .cchip--device")?.textContent || ""))
    await p.waitForSelector("#chat-settings .cchip--subagents", { state: "attached" })
    const folded = await p.isVisible("#target-sum")
    assert.equal(folded, width === 390, `${width}: folded only where the column is narrow`)
    if (folded) {
      // One chip that says all three, the mode never pushed out by a long name.
      const words = await p.$$eval("#target-sum .target__word", (l) => l.map((x) => [x.textContent, x.getBoundingClientRect().width > 8]))
      assert.equal(words.length, 3)
      assert.ok(words.every(([, seen]) => seen), `${width}: ${JSON.stringify(words)}`)
      assert.equal(words[2][0], "Edit")
    }
    if (folded) {
      // The summary is across the bar; pressing it opens the three, pressing it again closes them.
      const [sum, bar] = await p.evaluate(() => ["target-sum", "chat-target"].map((id) => { const el = document.getElementById(id); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { left: r.left, right: r.right, pl: parseFloat(cs.paddingLeft), pr: parseFloat(cs.paddingRight) } }))
      assert.ok(Math.abs(sum.left - (bar.left + bar.pl)) < 1 && Math.abs(sum.right - (bar.right - bar.pr)) < 1, `${width}: the summary is the bar's width`)
      await p.click("#target-sum")
      await p.waitForSelector("#target-chips .cchip--device", { state: "visible" })
      await p.click("#target-sum")
      await p.waitForSelector("#target-chips", { state: "hidden" })
    }
    await targetChips(p)
    // One family: the same height, on one line where they are side by side.
    const boxes = await p.$$eval("#target-chips .cchip", (l) => l.map((x) => { const r = x.getBoundingClientRect(); const v = x.querySelector(".cchip__label").getBoundingClientRect(); const n = x.querySelector(".target__name"); return { h: r.height, top: r.top, left: r.left, right: r.right, value: v.left, name: n.offsetParent ? n.textContent : "", cls: x.className } }))
    assert.equal(boxes.length, 3, `${width}: computer, folder, mode`)
    assert.equal(new Set(boxes.map((b) => b.h)).size, 1, `${width}: one height`)
    if (!folded) {
      assert.equal(new Set(boxes.map((b) => b.top)).size, 1, `${width}: one line`)
      assert.ok(boxes.every((b) => !b.name), `${width}: no labels in front on the line`)
      // The names give at a chip's width; the mode is its words' width and never gives.
      const rem = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
      assert.ok(boxes[0].right - boxes[0].left <= 12 * rem + 1 && boxes[1].right - boxes[1].left <= 16 * rem + 1, `${width}: the names are at most a chip wide`)
    } else {
      // A column: each the bar's width, its label in front, labels and values on shared tracks.
      assert.deepEqual(boxes.map((b) => b.name), ["Computer", "Folder", "Mode"], `${width}: each says what it is`)
      assert.equal(new Set(boxes.map((b) => Math.round(b.left))).size, 1, `${width}: one left edge`)
      assert.equal(new Set(boxes.map((b) => Math.round(b.right))).size, 1, `${width}: one width`)
      assert.equal(new Set(boxes.map((b) => Math.round(b.value))).size, 1, `${width}: the values start on one line`)
      // A long name gives inside its chip: nothing of it runs past the chip, its chevron in place.
      const inside = await p.$$eval("#target-chips .cchip", (l) => l.every((x) => { const r = x.getBoundingClientRect(); return [...x.children].every((c) => { const k = c.getBoundingClientRect(); return k.left >= r.left - 0.5 && k.right <= r.right + 0.5 }) }))
      assert.ok(inside, `${width}: every part of a chip inside it`)
    }
    assert.ok(await p.$eval("#target-chips .cchip--mode .cchip__label", (x) => x.scrollWidth <= x.clientWidth + 1), `${width}: the mode is never cut`)
    // Each chip is the thing a press at its centre lands on.
    const hit = await p.$$eval("#target-chips .cchip", (l) => l.every((x) => { const r = x.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".cchip") === x }))
    assert.ok(hit, `${width}: a press at a chip's centre lands on it`)
    assert.ok(await noSideways(p, width), `${width}: nothing sideways`)
    assert.deepEqual(await reachable(p, width), [], `${width}: every control inside`)
    assert.ok(await inside(p, "#chat-target button", width), `${width}: the bar inside the window`)
    // The bar sits directly above the composer card, within its column.
    const [bar, card] = await p.evaluate(() => ["chat-target", "composer"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }))
    assert.ok(bar.bottom <= card.top && card.top - bar.bottom < 16, `${width}: directly above`)
    assert.ok(bar.left >= card.left - 1 && bar.right <= card.right + 1, `${width}: within the composer's column`)
    for (const [cls, word] of [["device", /This computer/], ["folder", /Type a folder/], ["mode", /Plan/]]) {
      await p.click(`#target-chips .cchip--${cls}`)
      await p.waitForSelector(".menu")
      assert.match(await p.textContent(".menu"), word, `${width}: the ${cls} menu`)
      const m = await p.evaluate(() => { const r = document.querySelector(".menu").getBoundingClientRect(); return (r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5) || [r.left, r.right, r.top, r.bottom, innerWidth, innerHeight] })
      assert.ok(m === true, `${width}: the ${cls} menu inside the window ${JSON.stringify(m)}`)
      // The bar is at the foot of the window: its menus open upward.
      const up = await p.evaluate((c) => document.querySelector(".menu").getBoundingClientRect().bottom <= document.querySelector(`#target-chips .cchip--${c}`).getBoundingClientRect().top + 1, cls)
      assert.ok(up, `${width}: the ${cls} menu opens upward`)
      await p.keyboard.press("Escape")
    }
    await shot(p, `t1-target-${width}`)
    // The mode chosen there is the one the chat starts in.
    await targetChips(p)
    await p.click("#target-chips .cchip--mode")
    await p.locator(".menu .menu__item", { hasText: "Plan" }).click()
    await p.fill("#composer-text", "Look around")
    await p.click("#send")
    await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
    const [made] = await p.evaluate(() => window.__mock.api("POST", "/chats"))
    assert.deepEqual([made.args.body.device, made.args.body.directory, made.args.body.mode], ["token9", LONG_DIR, "plan"])
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("T1: the composer's chips wrap and never scroll: with a file, Draw a picture, Dictate, Stop and Send nothing is hidden at any width", async () => {
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844]]) {
    const p = await page(ci2(), { width, height })
    await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
    await p.waitForSelector("#composer-chips .cchip--picture")
    const style = await p.$eval("#composer-chips", (el) => { const cs = getComputedStyle(el); return [cs.overflowX, cs.flexWrap] })
    assert.deepEqual(style, ["visible", "wrap"], "no scroller")
    await p.fill("#composer-text", "A long message, ".repeat(30))
    assert.ok(await noSideways(p, width), `${width}: nothing sideways`)
    assert.deepEqual(await reachable(p, width), [], `${width}: every control inside`)
    assert.ok(await inside(p, "#composer button", width), `${width}: the composer's buttons inside the window`)
    const fits = await p.$eval("#composer-chips", (el) => el.scrollWidth <= el.clientWidth + 1)
    assert.ok(fits, `${width}: the chips' line holds them`)
    await shot(p, `t1-composer-${width}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- P2: the chat screen against the web -- cards, tool calls, the end of a reply, the rest ------
//
// What each card offers is display.md §5 (spec 3.7.0), under the spec's words; what is sent is the
// body `POST /api/v2/chats/{chat}/interactions/{card}` documents (verdict, reason, choices, texts,
// asks). A tool call is drawn from its `block` as `api/v2/serialise.py:tool_call` sends it.

const answersTo = (p, card) => p.evaluate((c) => window.__mock.api("POST", `/chats/chat2/interactions/${c}`).map((x) => x.args.body), card)
const actionWords = (p) => p.$$eval("#cards .ask > .ask__actions .btn", (l) => l.filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()))

function p2(cards, over = {}) {
  const routes = {}
  for (const id of ["q1", "q2", "q3", "pl1", "pl2", "ph1", "card7", "card8"]) routes[`POST /chats/chat2/interactions/${id}`] = { answered: true, remembered: false, not_remembered: [] }
  return agentChatOpen([["ask", { cards }]], { ...routes, ...over })
}

const item = (over = {}) => ({ index: 0, key: "0", kind: "question", tool: "", title: "Which database?", header: "Database", detail: "", reason: "", purpose: "", options: [], multiple: false, free_text: true, editable: false, plan: null, mode_choice: false, job: "", ...over })
const OPTIONS = [
  { label: "SQLite", description: "One file, no server.", recommended: false },
  { label: "Postgres", description: "A server of its own.", recommended: true },
  { label: "None", description: "", recommended: false },
]

test("P2: an approval offers Allow once, Always allow, Deny, and Deny, and say why -- the reason goes with the refusal", async () => {
  const p = await page(p2([deviceBashCard()]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask__edit")
  assert.deepEqual(await actionWords(p), ["Allow once", "Always allow", "Deny", "Deny, and say why"])
  await p.click("#cards .btn >> text=Deny, and say why")
  await p.waitForSelector("#cards .ask__reason-input")
  assert.deepEqual(await actionWords(p), [], "the first row gives way to the reason")
  assert.equal(await p.evaluate(() => document.activeElement.className), "ask__reason-input")
  // Cancel: back to the four, nothing sent.
  await p.click("#cards .ask__explain .btn >> text=Cancel")
  assert.equal((await actionWords(p)).length, 4)
  assert.deepEqual(await answersTo(p, "card7"), [])
  await p.click("#cards .btn >> text=Deny, and say why")
  await p.fill("#cards .ask__reason-input", "Not there: look in dist instead")
  await shot(p, "p2-deny-reason")
  await p.click("#cards .ask__explain .btn--danger")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/card7").length === 1)
  assert.deepEqual(await answersTo(p, "card7"), [{ verdict: "deny", choices: {}, texts: {}, reason: "Not there: look in dist instead" }])
  await p.waitForSelector("#cards", { state: "hidden" })
  // Always allow.
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [c] }), [STREAM2, deviceBashCard({ id: "card8" })])
  await p.click("#cards .btn >> text=Always allow")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/card8").length === 1)
  assert.equal((await answersTo(p, "card8"))[0].verdict, "allow_always")
  assert.deepEqual(p.errors, [])
})

test("P2: a question: the recommended option first, Something else typed, and a question asked back", async () => {
  const card = { id: "q1", kind: "question", why: "The schema is open.", dismissable: true, expires_in: null, items: [item({ options: OPTIONS })] }
  const p = await page(p2([card]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .opt")
  assert.deepEqual(await p.$$eval("#cards .opt .opt__label", (l) => l.map((x) => x.textContent)), ["Postgres", "SQLite", "None", "Something else", "Ask it something back"])
  assert.match(await p.textContent("#cards .ask"), /It says: The schema is open\./)
  assert.deepEqual(await actionWords(p), ["Answer", "Dismiss"])
  // One answer: an option, then a typed one takes its place.
  await p.click("#cards button.opt >> text=SQLite")
  assert.equal(await p.getAttribute("#cards button.opt:has-text('SQLite')", "aria-pressed"), "true")
  await p.fill("#cards .opt--typed >> nth=0 >> input", "DuckDB")
  assert.equal(await p.getAttribute("#cards button.opt:has-text('SQLite')", "aria-pressed"), "false", "one answer: the typed one")
  await shot(p, "p2-question")
  await p.click("#cards .ask__actions .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/q1").length === 1)
  assert.deepEqual(await answersTo(p, "q1"), [{ verdict: "", choices: {}, texts: { 0: "DuckDB" } }])
  // Several: picked options and typed words together carry the server's mark for "something else".
  const many = { ...card, id: "q2", dismissable: false, items: [item({ options: OPTIONS, multiple: true }), item({ index: 1, key: "1", title: "Which cache?", header: "Cache", options: [] })] }
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [c] }), [STREAM2, many])
  await p.waitForSelector("#cards .ask[data-card='q2']")
  assert.deepEqual(await actionWords(p), ["Send answers"])
  await p.click("#cards button.opt >> text=SQLite")
  await p.click("#cards button.opt >> text=None")
  await p.fill("#cards .ask__item >> nth=0 >> .opt--typed >> nth=0 >> input", "and a flat file")
  await p.fill("#cards .ask__item >> nth=1 >> .opt--typed >> nth=1 >> input", "Is a cache needed at all?")
  await p.click("#cards .ask__actions .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/q2").length === 1)
  assert.deepEqual(await answersTo(p, "q2"), [{ verdict: "", choices: { 0: ["SQLite", "None", "__other__"] }, texts: { 0: "and a flat file" }, asks: { 1: "Is a cache needed at all?" } }])
  // Dismiss, where the card may be put aside.
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [c] }), [STREAM2, { ...card, id: "q3" }])
  await p.waitForSelector("#cards .ask[data-card='q3']")
  await p.click("#cards .btn >> text=Dismiss")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/q3").length === 1)
  assert.equal((await answersTo(p, "q3"))[0].verdict, "deny")
  assert.deepEqual(p.errors, [])
})

test("P2: a plan: approved into Edit or Manual where the device offers the choice, revised with what to change, or dismissed", async () => {
  const plan = { title: "Tidy the build", phases: [{ title: "Clean", tasks: [{ text: "Remove dist", status: "pending" }, { text: "Run the tests", status: "pending" }] }] }
  const card = { id: "pl1", kind: "plan", why: "", dismissable: true, expires_in: null, items: [item({ kind: "plan", title: "The plan", header: "", free_text: false, plan, mode_choice: true })] }
  const p = await page(p2([card]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask--plan")
  assert.match(await p.textContent("#cards .ask"), /Remove dist/)
  assert.deepEqual(await actionWords(p), ["Approve, continue in Edit", "Approve, continue in Manual", "Revise", "Dismiss"])
  await shot(p, "p2-plan")
  await p.click("#cards .btn >> text=Approve, continue in Manual")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/pl1").length === 1)
  assert.deepEqual(await answersTo(p, "pl1"), [{ verdict: "allow", choices: { 0: ["manual"] }, texts: {} }])
  // A chat's own plan (no mode to choose), as text: Approve, and Revise sends it back with words.
  const own = { ...card, id: "pl2", items: [item({ kind: "plan", title: "The plan", header: "", free_text: false, plan: null, detail: "1. Remove **dist**\n2. Run the tests", mode_choice: false })] }
  await p.evaluate(([path, c]) => window.__mock.frame(path, "ask", { cards: [c] }), [STREAM2, own])
  await p.waitForSelector("#cards .ask[data-card='pl2']")
  assert.deepEqual(await actionWords(p), ["Approve", "Revise", "Dismiss"])
  assert.equal(await p.textContent("#cards .ask__plan strong"), "dist", "a plan sent as text is drawn as markdown")
  assert.match(await p.textContent("#cards .ask"), /Approving ends Plan mode/)
  await p.click("#cards .btn >> text=Revise")
  await p.fill("#cards .ask__reason-input", "Keep dist/assets")
  await p.click("#cards .ask__explain .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/pl2").length === 1)
  assert.deepEqual(await answersTo(p, "pl2"), [{ verdict: "deny", choices: {}, texts: {}, reason: "Keep dist/assets" }])
  assert.deepEqual(p.errors, [])
})

test("P2: something to do on the phone is said, and can be declined; every card's buttons are reachable at 390 px", async () => {
  const phone = { id: "ph1", kind: "phone_action", why: "", dismissable: true, expires_in: null, items: [item({ kind: "phone_action", title: "Open the timetable", header: "", free_text: false })] }
  let p = await page(p2([phone]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards .ask--phone_action")
  assert.match(await p.textContent("#cards .ask"), /Open the timetable.*Confirm it on your phone/s)
  assert.deepEqual(await actionWords(p), ["Decline"])
  await p.click("#cards .btn >> text=Decline")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/interactions/ph1").length === 1)
  assert.equal((await answersTo(p, "ph1"))[0].verdict, "deny")
  await p.context().close()
  const plan = { id: "pl1", kind: "plan", why: "", dismissable: true, expires_in: null, items: [item({ kind: "plan", title: "The plan", header: "", free_text: false, plan: { title: "Tidy", phases: [{ title: "Clean", tasks: [{ text: "Remove dist", status: "pending" }] }] }, mode_choice: true })] }
  const question = { id: "q1", kind: "question", why: "", dismissable: true, expires_in: null, items: [item({ options: OPTIONS })] }
  for (const [name, card] of [["approval", deviceBashCard()], ["plan", plan], ["question", question]]) {
    p = await page(p2([card]), { width: 390, height: 844 })
    await p.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
    await p.waitForSelector("#cards .ask")
    const out = await p.$$eval("#cards .ask button, #cards .ask input, #cards .ask textarea", (l) => l.filter((b) => b.offsetParent !== null).filter((b) => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 0.5 || r.width < 24 }).map((b) => b.textContent || b.className))
    assert.deepEqual(out, [], `${name}: inside the window`)
    const heights = await p.$$eval("#cards .ask > .ask__actions .btn", (l) => [...new Set(l.map((b) => Math.round(b.getBoundingClientRect().height)))])
    assert.equal(heights.length, 1, `${name}: the buttons are one height (${heights})`)
    assert.ok(await noSideways(p, 390), `${name}: nothing sideways`)
    if (name === "approval") {
      await p.click("#cards .btn >> text=Deny, and say why")
      const box = await p.locator("#cards .ask__reason-input").boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 390, "the reason's box inside")
    }
    await shot(p, `p2-card-${name}-390`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

const DIFF = "--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,4 @@\n # Lembas\n-One bite.\n+One small bite\n+is enough.\n keeps\n"
const call = (over = {}) => ({ id: "t1", name: "bash", status: "ok", args: { command: "bun test\n--bail" }, text: "12 pass", block: { kind: "shell", title: "bun test", chips: [], added: 0, removed: 0 }, ...over })
const CALLS = [
  call({ exit: 0 }),
  call({ id: "t2", name: "edit", args: { path: "README.md" }, text: "", diff: DIFF, block: { kind: "edit", title: "README.md", chips: ["+2 −1"], added: 2, removed: 1 } }),
  call({ id: "t3", status: "error", exit: 2, error: "exit status 2\nmake: *** [all] Error 2", args: { command: "make" }, text: "", block: { kind: "shell", title: "make", chips: ["exit 2"], added: 0, removed: 0 } }),
  call({ id: "t4", name: "grep", args: { pattern: "TODO", path: "src" }, text: "", hits: 1400, block: { kind: "search", title: "TODO", chips: ["1400 hits"], added: 0, removed: 0 } }),
  call({ id: "t5", name: "todo_write", args: {}, text: "", block: { kind: "hidden", title: "", chips: [], added: 0, removed: 0 } }),
  call({ id: "t6", name: "read", status: "running", args: { path: "src/app.ts" }, text: "", block: { kind: "read", title: "src/app.ts", chips: [], added: 0, removed: 0 } }),
  call({ id: "t7", name: "bash", status: "denied", error: "Not there: look in dist instead", args: { command: "rm -rf build" }, text: "", block: { kind: "shell", title: "rm -rf build", chips: [], added: 0, removed: 0 } }),
  call({ id: "t8", name: "mcp_weather", args: { city: "Bree" }, text: "rain", duration_ms: 8449, block: { kind: "tool", title: "", label: "Weather", chips: [], added: 0, removed: 0 } }),
]
const reply = (over = {}) => ({ id: "m2", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: { total_tokens: 12480, tok_s: 12.5, elapsed_ms: 8400 }, steps: [{ index: 0, kind: "tools", open: false, calls: CALLS }, { index: 1, kind: "text", open: true, markdown: "Done." }], ...over })
const callRows = (p, scope = "#messages") => p.$$eval(`${scope} .call`, (l) => l.map((c) => ({ id: c.dataset.key.split(".").pop(), state: c.dataset.state, kind: c.dataset.kind, name: c.querySelector(".call__name").textContent, title: c.querySelector(".call__title").textContent, facts: [...c.querySelectorAll(".call__fact")].map((f) => f.textContent), open: c.open, mark: c.querySelector(".call__state").getAttribute("aria-label") })))

function p2calls(over = {}, routes = {}) {
  return {
    status: status(),
    routes: baseRoutes({ "GET /chats/chat2": { chat: agentChat(), messages: [userMessage("m1", "Tidy the build"), reply(over)], more: false, live: null }, "GET /models?chat=chat2": models(), ...routes }),
    streams: {},
  }
}

test("P2: a tool call is drawn from the server's block: what it is called, its title, state, the facts and how long it took", async () => {
  const p = await page(p2calls(), { width: 1280, height: 1000 })
  await openChatRow(p, "chat2")
  await p.waitForSelector("#messages .call")
  const rows = await callRows(p)
  assert.deepEqual(rows.map((r) => r.id), ["t1", "t2", "t3", "t4", "t6", "t7", "t8"], "a hidden tool is not drawn as a call")
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.deepEqual([by.t1.state, by.t1.name, by.t1.title, by.t1.facts], ["done", "bash", "bun test", []], "exit 0 is no fact")
  assert.deepEqual([by.t2.kind, by.t2.title, by.t2.facts, by.t2.open], ["edit", "README.md", ["+2 −1"], true], "an edit: +added −removed, its change shown")
  assert.deepEqual([by.t3.state, by.t3.facts, by.t3.mark], ["failed", ["exit 2"], "Failed"])
  assert.equal(await p.textContent(".call[data-key$='t3'] .call__why"), "exit status 2", "the first line of the error")
  assert.deepEqual(by.t4.facts, ["1,400 hits"], "a count in the page's number format")
  assert.equal(by.t6.state, "failed", "a call still running in a finished reply never got its result")
  assert.deepEqual([by.t7.state, by.t7.facts, by.t7.mark], ["denied", ["Denied"], "Denied"])
  assert.deepEqual([by.t8.name, by.t8.title, by.t8.facts], ["Weather", "", ["8.4s"]], "the server's label, and the duration where it is kept")
  // The change, a line a row, coloured by what it does.
  assert.deepEqual(await p.$$eval(".call[data-key$='t2'] .diff__line", (l) => l.map((x) => x.className.replace("diff__line", "").trim())), ["is-meta", "is-meta", "is-hunk", "", "is-del", "is-add", "is-add", ""])
  // The four states are told apart by the mark itself.
  const marks = await p.$$eval("#messages .call__state", (l) => [...new Set(l.map((x) => x.className))])
  assert.equal(marks.length, 3, `done, failed and denied look different: ${marks}`)
  assert.match(await p.textContent(".msg--assistant .msg__metrics"), /12,480 tokens/)
  await shot(p, "p2-calls-1280")
  assert.deepEqual(p.errors, [])
  await p.context().close()
  // At 390 px every row stays inside the reply, the title giving way.
  const n = await page(p2calls(), { width: 390, height: 844 })
  await n.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
  await n.waitForSelector("#messages .call")
  const out = await n.$$eval("#messages .call__head > *", (l) => l.filter((x) => x.offsetParent !== null).filter((x) => { const r = x.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < 0 }).length)
  assert.equal(out, 0, "nothing past the window")
  assert.ok(await noSideways(n, 390))
  await shot(n, "p2-calls-390")
  assert.deepEqual(n.errors, [])
})

test("P2: while a reply is written a call runs, then is done; what the person opened stays open as the steps come again", async () => {
  const running = [{ index: 0, kind: "tools", open: true, calls: [call({ status: "running", text: "" })] }]
  const p = await page(agentChatOpen([["steps", { steps: running, tail: { thinking: false, text: "", label: "" } }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live .call")
  let [row] = await callRows(p, ".msg.is-live")
  assert.deepEqual([row.state, row.mark, row.open], ["running", "Running", false])
  await p.click(".msg.is-live .call__head")
  await p.evaluate(([path, c]) => window.__mock.frame(path, "steps", { steps: [{ index: 0, kind: "tools", open: true, calls: [c] }], tail: { thinking: false, text: "", label: "" } }), [STREAM2, call({ exit: 0, duration_ms: 412 })])
  await p.waitForSelector(".msg.is-live .call.is-done")
  ;[row] = await callRows(p, ".msg.is-live")
  assert.deepEqual([row.state, row.facts, row.open], ["done", ["0.4s"], true])
  assert.deepEqual(p.errors, [])
})

test("P2: the server's own fixtures: its steps and the call running in its tail, a failed and a stopped reply's last line, and a call that may only be allowed once", async () => {
  // While it is written: event_steps.json's finished call, event_tail.json's running one.
  let p = await page(agentChatOpen([["steps", fixture("event_steps")], ["tail", fixture("event_tail")]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live .msg__running .call.is-running")
  const done = fixture("event_steps").steps.find((x) => x.kind === "tools").calls[0]
  const runs = fixture("event_tail").calls[0]
  let rows = await callRows(p, ".msg.is-live")
  assert.deepEqual(rows.map((r) => [r.state, r.name, r.title, r.facts]), [["done", done.block.label, done.block.title, [done.block.duration]], ["running", runs.block.label, runs.block.title, []]], "the server's label, title and duration; no exit 0; nothing timed while it runs")
  // Opened by the person, it stays open as the tail comes again; gone from the tail, it is gone.
  await p.click(".msg.is-live .msg__running .call__head")
  await p.evaluate(([path, f]) => window.__mock.frame(path, "tail", f), [STREAM2, fixture("event_tail")])
  assert.ok(await p.$eval(".msg.is-live .msg__running .call", (x) => x.open))
  await p.evaluate(([path, f]) => window.__mock.frame(path, "tail", { ...f, calls: [] }), [STREAM2, fixture("event_tail")])
  await p.waitForSelector(".msg.is-live .msg__running", { state: "hidden" })
  assert.deepEqual(p.errors, [])
  await p.context().close()
  // Stored: message_failed.json and message_stopped.json, their `end` as the line that stays.
  const failed = fixture("message_failed")
  const stopped = { ...fixture("message_stopped"), id: "msg6" }
  p = await page({ status: status(), routes: baseRoutes({ "GET /chats/chat2": { chat: agentChat(), messages: [userMessage("m1", "Tidy the build"), failed, stopped], more: false, live: null }, "GET /models?chat=chat2": models() }), streams: {} })
  await openChatRow(p, "chat2")
  await p.waitForSelector("#messages .msg__end")
  assert.deepEqual(await p.$$eval("#messages .msg__end", (l) => l.map((x) => x.textContent)), [failed.end.text, stopped.end.text])
  rows = await callRows(p)
  const calls = failed.steps.find((x) => x.kind === "tools").calls
  assert.deepEqual(rows.map((r) => r.state), calls.map((c) => c.block.state))
  const slow = calls.findIndex((c) => c.block.duration)
  assert.ok(rows[slow].facts.includes(calls[slow].block.duration), `the server's duration as it wrote it: ${rows[slow].facts}`)
  assert.deepEqual(p.errors, [])
  await p.context().close()
  // event_ask.json: `always` says whether Always allow is offered; absent offers it (the first P2 test).
  const cards = fixture("event_ask").cards.filter((c) => c.kind === "approval")
  assert.ok(cards.length && cards.every((c) => c.items[0].always === true))
  for (const always of [true, false]) {
    const card = { ...cards[0], items: cards[0].items.map((i) => ({ ...i, always })) }
    p = await page(agentChatOpen([["ask", { cards: [card] }]]))
    await openChatRow(p, "chat2")
    await p.waitForSelector("#cards .ask")
    assert.deepEqual(await actionWords(p), always ? ["Allow once", "Always allow", "Deny", "Deny, and say why"] : ["Allow once", "Deny", "Deny, and say why"])
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("P2: how a reply that did not finish ended stays on it: Stopped, with the reason where one is known, or Failed with the error", async () => {
  // From what is stored: stopped, and failed with a long error -- its first line, once.
  let p = await page(p2calls({ stopped: true, steps: [{ index: 0, kind: "text", open: true, markdown: "Half an ans" }] }))
  await openChatRow(p, "chat2")
  assert.equal(await p.textContent(".msg--assistant .msg__end"), "Stopped")
  await p.context().close()
  p = await page(p2calls({ error: "502 Bad Gateway\nupstream said no", steps: [] }))
  await openChatRow(p, "chat2")
  assert.equal(await p.textContent(".msg--assistant .msg__end.is-failed"), "Failed: 502 Bad Gateway")
  assert.equal(await p.locator(".msg--assistant .msg__note.is-error").count(), 0, "the raw error is not printed beside it")
  // The whole of it is behind Details, closed.
  assert.equal(await p.$eval(".msg--assistant .msg__error", (x) => x.open), false)
  assert.equal(await p.textContent(".msg--assistant .msg__error pre"), "502 Bad Gateway\nupstream said no")
  await p.context().close()
  // Live: the stream's last progress says why, and the line stays when the reply is done.
  p = await page(agentChatOpen([["status", { text: "Writing…" }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live")
  await p.evaluate(([path, f, m]) => {
    window.__mock.frame(path, "status", f)
    window.__mock.frame(path, "done", { message: m, chat: null, next: false })
  }, [STREAM2, fixture("event_status_stopped"), reply({ stopped: true, steps: [{ index: 0, kind: "text", open: true, markdown: "Half" }] })])
  await p.waitForSelector(".msg--assistant:not(.is-live) .msg__end")
  assert.equal(await p.textContent(".msg--assistant .msg__end"), "Stopped: by you")
  assert.deepEqual(p.errors, [])
})

test("CP1: Copy says that it copied: the button under a message shows a tick and is named Copied for a moment, a code block's says Copied", async () => {
  const cfg = agentChatOpen([["status", { text: "Writing…" }]], {
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?"), reply({ id: "m6", steps: [{ index: 0, kind: "text", open: true, markdown: "With **care**.\n\n```sh\nbake --slowly\n```" }] })], more: false, live: null },
    "GET /models?chat=chat1": models(),
  })
  const p = await page(cfg)
  await p.evaluate(() => {
    window.__copied = []
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => (window.__copied.push(text), Promise.resolve()) } })
  })
  await openChatRow(p, "chat1")
  const copy = p.locator('.msg--assistant[data-id="m6"] .msg__act[aria-label="Copy"]')
  await copy.click()
  const said = p.locator('.msg--assistant[data-id="m6"] .msg__act.is-copied')
  await said.waitFor()
  assert.equal(await said.getAttribute("aria-label"), "Copied")
  assert.equal(await said.getAttribute("title"), "Copied")
  // A second click while it still says so copies again and does not lose the button's own name.
  await said.click()
  assert.equal((await p.evaluate(() => window.__copied)).length, 2)
  await p.waitForSelector('.msg--assistant[data-id="m6"] .msg__act[aria-label="Copy"]:not(.is-copied)', { timeout: 5000 })
  // A code block's button is a word, and the word changes.
  await p.click('.msg--assistant[data-id="m6"] .md-copy')
  await p.waitForFunction(() => document.querySelector('.msg--assistant[data-id="m6"] .md-copy')?.textContent === "Copied")
  assert.match((await p.evaluate(() => window.__copied)).at(-1), /bake --slowly/)
  await p.waitForFunction(() => document.querySelector('.msg--assistant[data-id="m6"] .md-copy')?.textContent === "Copy", null, { timeout: 5000 })
})

test("P2: the rest of the chat screen works: edit a message, regenerate, stop, a queued message, earlier messages, attach, the chat's menu", async () => {
  const cfg = agentChatOpen([["status", { text: "Writing…" }]], {
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?"), reply({ id: "m6", steps: [{ index: 0, kind: "text", open: true, markdown: "With **care**." }] })], more: true, live: null },
    "GET /models?chat=chat1": models(),
    "GET /chats/chat1/messages?before=m5": { messages: [userMessage("m3", "An earlier question")], more: false },
    "POST /chats/chat1/messages/m5/edit": { ok: true },
    "POST /chats/chat1/messages/m6/regenerate": { ok: true },
    "POST /chats/chat1/messages": { message: { ...userMessage("m7", "And how long does it keep?"), queued: true }, reply: null },
    "POST /chats/chat2/messages": { message: { ...userMessage("m8", "Also the docs"), queued: true }, reply: null },
    "POST /chats/chat2/messages/m2/stop": { stopped: true },
    "PATCH /chats/chat1": { chat: chatRow({ title: "Waybread, properly" }) },
    "DELETE /chats/chat1": { deleted: true },
  })
  cfg.commands = { attach_pick: [{ name: "recipe.md", size: 2048, attachment: { id: "att1", name: "recipe.md", size: 2048, image: false } }] }
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  // Earlier messages are put above, and the button goes when there are no more.
  await p.click(".thread__earlier")
  await p.waitForFunction(() => document.querySelector("#messages .msg")?.dataset.id === "m3")
  assert.equal(await p.locator(".thread__earlier").count(), 0)
  // Edit: the box holds the text; saving posts it.
  await p.hover(".msg--user[data-id='m5']")
  await p.click(".msg--user[data-id='m5'] .msg__act >> nth=0")
  assert.equal(await p.inputValue(".msg__edit"), "How is lembas made?")
  await p.fill(".msg__edit", "How was lembas made?")
  await p.click(".msg__editbar .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages/m5/edit").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/chats/chat1/messages/m5/edit")))[0].args.body, { text: "How was lembas made?" })
  // Regenerate, on the last reply only.
  await p.waitForSelector(".msg--assistant[data-id='m6'] .msg__regen")
  await p.click(".msg--assistant[data-id='m6'] .msg__regen")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages/m6/regenerate").length === 1)
  // Attach: the file Rust sent is a tile, and goes with the message.
  await p.waitForSelector("#messages .msg")
  await p.click("#attach")
  await p.waitForSelector("#composer-files .tile.is-ready")
  assert.match(await p.textContent("#composer-files"), /recipe\.md/)
  await p.fill("#composer-text", "And how long does it keep?")
  await p.keyboard.press("Enter")
  const sentTo = (chat) => p.evaluate((c) => window.__mock.api("POST", `/chats/${c}/messages`).filter((x) => x.args.path === `/chats/${c}/messages`), chat)
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").some((x) => x.args.path === "/chats/chat1/messages"))
  assert.deepEqual((await sentTo("chat1"))[0].args.body, { text: "And how long does it keep?", attachments: ["att1"] })
  assert.ok(await p.isHidden("#composer-files"), "the files went with the message")
  assert.equal(await p.inputValue("#composer-text"), "")
  // The chat's menu: rename, and delete after asking.
  await p.click("#chat-tools .tool[aria-label='More']")
  await p.click(".menu__item >> text=Rename")
  await p.fill("dialog[open] .dialog__input", "Waybread, properly")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => document.getElementById("chat-title").textContent === "Waybread, properly")
  await p.click("#chat-tools .tool[aria-label='More']")
  await p.click(".menu__item >> text=Delete chat")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("DELETE", "/chats/chat1").length === 1)
  // A reply being written: Stop asks the server; a message typed meanwhile waits behind it.
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live")
  assert.ok(await p.isVisible("#stop"))
  assert.ok(await p.isHidden("#send"), "Stop takes Send's place until something is typed")
  await p.fill("#composer-text", "Also the docs")
  assert.ok(await p.isVisible("#send"))
  await p.click("#send")
  await p.waitForSelector(".msg--user.is-queued")
  assert.match(await p.textContent(".msg--user.is-queued"), /Waiting for the reply before it/)
  await p.evaluate((path) => window.__mock.frame(path, "steered", { ids: ["m8"] }), STREAM2)
  await p.waitForSelector(".msg--user[data-id='m8']:not(.is-queued)")
  await p.click("#stop")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/messages/m2/stop").length === 1)
  assert.deepEqual(p.errors, [])
})

test("P2: files pasted into the box and dropped on the window become tiles and go with the message; one taken off is deleted on the server", async () => {
  const cfg = agentChatOpen([], {
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null },
    "GET /models?chat=chat1": models(),
    "POST /chats/chat1/messages": { message: userMessage("m7", "Here"), reply: null },
    "DELETE /attachments/att2": null,
  })
  cfg.commands = {
    attach_bytes: { id: "att1", name: "shot.png", size: 68, image: true },
    attach_dropped: [{ name: "notes.md", size: 900, attachment: { id: "att2", name: "notes.md", size: 900, image: false } }, { name: "build", size: 0, reason: "folder" }],
  }
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  // Pasted: a picture's bytes, sent through Rust with its name; its own thumbnail at once.
  await p.focus("#composer-text")
  await p.evaluate((png) => {
    const bytes = Uint8Array.from(atob(png.split(",")[1]), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], "shot.png", { type: "image/png" }))
    document.getElementById("composer-text").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  }, PNG)
  await p.waitForSelector("#composer-files .tile.is-ready.has-thumb")
  const sent = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "attach_bytes").length)
  assert.equal(sent, 1)
  // Dropped: Rust holds the paths; the page shows what became of each -- a folder is said, not sent.
  await p.evaluate(() => window.__mock.emit("drag", true))
  assert.equal(await p.getAttribute("#composer", "data-drag"), "true")
  await p.evaluate(() => window.__mock.emit("drop", ["notes.md", "build"]))
  await p.waitForSelector("#composer-files .tile.is-failed")
  assert.equal(await p.getAttribute("#composer", "data-drag"), "false")
  assert.match(await p.getAttribute("#composer-files .tile.is-failed", "title"), /This is a folder/)
  assert.equal(await p.locator("#composer-files .tile.is-ready").count(), 2)
  // One taken off before sending is deleted on the server; the rest go with the message.
  await p.click("#composer-files .tile.is-ready:has-text('notes.md') .file__remove")
  await p.waitForFunction(() => window.__mock.api("DELETE", "/attachments/att2").length === 1)
  await p.fill("#composer-text", "Here")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/chats/chat1/messages")))[0].args.body, { text: "Here", attachments: ["att1"] })
  assert.deepEqual(p.errors, [])
})

test("P2: a model that only thinks or does not: the header says Thinking, and its menu switches it", async () => {
  const m = models()
  m.models[0] = { ...m.models[0], efforts: [], thinking_switch: true, levels: ["off", "default"], effort: "default", control: "switch" }
  const cfg = agentChatOpen([], {
    "GET /models": m,
    "GET /models?chat=chat1": m,
    "GET /chats/chat1": { chat: chatRow({ effort: "default" }), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null },
    "PATCH /chats/chat1": { chat: chatRow({ effort: "off" }) },
  })
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  await p.waitForSelector("#chat-settings .cchip--model")
  const chip = p.locator("#chat-settings .cchip", { hasText: "Thinking" })
  assert.equal((await chip.textContent()).trim(), "Thinking")
  await chip.click()
  assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => [x.textContent.replace(/✓/, "").trim(), x.getAttribute("aria-checked")])), [["off", "false"], ["Think before answeringdefault", "true"]])
  await p.click(".menu .menu__item >> nth=0")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat1").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat1")))[0].args.body, { effort: "off" })
  await p.waitForFunction(() => /Thinking: off/.test(document.getElementById("chat-settings").textContent))
  assert.deepEqual(p.errors, [])
})

test("P2: a reply is finished at `done`; the name a model gives the chat afterwards arrives on the same stream and is drawn", async () => {
  // The server's own frames (event_done_title_pending.json, event_title.json), for this chat.
  const done = fixture("event_done_title_pending")
  const named = fixture("event_title")
  assert.equal(done.chat.title_pending, true)
  const p = await page(agentChatOpen([["status", { text: "Writing…" }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live")
  await p.evaluate(([path, f]) => window.__mock.frame(path, "done", f), [STREAM2, { ...done, message: { ...done.message, id: "m2" }, chat: { ...done.chat, id: "chat2" }, next: null }])
  await p.waitForSelector(".msg--assistant:not(.is-live)")
  assert.equal(await p.textContent("#chat-title"), done.chat.title)
  assert.ok(await p.isHidden("#stop"), "finished: nothing waits for the name")
  const lists = await p.evaluate(() => window.__mock.api("GET", "/chats").filter((x) => x.args.path.startsWith("/chats?") || x.args.path === "/chats").length)
  await p.evaluate(([path, f]) => {
    window.__mock.frame(path, "title", f)
    window.__mock.frame(path, "close", {})
  }, [STREAM2, { chat: { ...named.chat, id: "chat2" } }])
  await p.waitForFunction((title) => document.getElementById("chat-title").textContent === title, named.chat.title)
  assert.notEqual(named.chat.title, done.chat.title)
  await p.waitForFunction((n) => window.__mock.api("GET", "/chats").filter((x) => x.args.path.startsWith("/chats?") || x.args.path === "/chats").length > n, lists)
  assert.deepEqual(p.errors, [])
})

test("P2: a reply whose stream keeps ending without `done` is not read and followed for ever: after a few times it says so, with Read again", async () => {
  // The chat says a reply is being written; its stream closes as soon as it is opened.
  const p = await page(agentChatOpen([["end", null]]))
  await p.click('.chatrow[data-id="chat2"]')
  await p.waitForSelector(".msg.is-live .btn")
  assert.match(await p.textContent(".msg.is-live"), /The connection to the reply was lost/)
  const opens = () => p.evaluate((path) => window.__mock.calls.filter((c) => c.cmd === "stream_open" && c.args.path === path).length, STREAM2)
  const n = await opens()
  assert.ok(n >= 2 && n <= 4, `followed a few times, then no more (${n})`)
  await p.waitForTimeout(400)
  assert.equal(await opens(), n, "it stays stopped")
  assert.deepEqual(p.errors, [])
})

test("P2: a long reply whose stream is closed cleanly now and then (a proxy's time limit) is followed again every time, never declared lost", async () => {
  const p = await page(agentChatOpen([["status", { text: "Writing…" }]]), { clock: true })
  await p.click('.chatrow[data-id="chat2"]')
  const opens = () => p.evaluate((path) => window.__mock.calls.filter((c) => c.cmd === "stream_open" && c.args.path === path).length, STREAM2)
  await runUntil(p, () => !!document.querySelector(".msg.is-live"))
  for (let round = 1; round <= 5; round++) {
    // Frames came, time passed, then the stream was closed without `done`.
    await p.clock.runFor(6000)
    await p.evaluate((path) => window.__mock.frame(path, "end", null), STREAM2)
    await runUntil(p, () => !!document.querySelector(".msg.is-live") && !document.querySelector(".msg.is-live .btn"), 50, 40)
    for (let i = 0; i < 20 && (await opens()) < round + 1; i++) await p.clock.runFor(50)
    assert.equal(await opens(), round + 1, `followed again after close ${round}`)
  }
  assert.ok(!/connection to the reply was lost/.test(await p.textContent("#messages")), "still being followed")
  assert.deepEqual(p.errors, [])
})

// --- S3: the composer's `/` and `@` menus -----------------------------------------------------------
//
// The server's menu routes, by its own fixtures (tests/ui/fixtures, pinned by
// scripts/fetch-fixtures.sh): GET /devices/{id}/commands (device_commands.json), GET
// /devices/{id}/files (device_files.json), GET /mentions (mentions.json, mentions_url.json) and
// POST /attachments/from (attachment_from.json). The names in them are the server's; where a
// test needs a longer list or an awkward name, it adds rows of the same shape.

const MENTIONS = { items: [{ kind: "file", path: "/notes/recipes/lembas recipe #2.md", name: "lembas recipe #2.md", detail: "/notes/recipes/lembas recipe #2.md" }, ...fixture("mentions").items.filter((x) => x.kind === "attachment").map((x) => ({ ...x, id: "att7", name: "oven.png" }))] }
const DEVICE_FILES = { ...fixture("device_files"), files: [{ path: "src/app main.ts", kind: "file", name: "app main.ts" }, { path: "src/tui", kind: "dir", name: "tui" }], device: "workbench" }
const DEVICE_COMMANDS = { ...fixture("device_commands"), commands: [{ name: "review", description: "Review the working tree", hint: "", kind: "custom" }, { name: "commit", description: "Commit with a message", hint: "<message>", kind: "skill" }, ...fixture("device_commands").commands.filter((c) => c.name === "compact")], device: "workbench" }

function s3(over = {}) {
  const cfg = i8()
  Object.assign(cfg.routes, {
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?"), reply({ id: "m6", steps: [{ index: 0, kind: "text", open: true, markdown: "With care." }] })], more: false, live: null },
    "GET /chats/chat2": { chat: agentChat(), messages: [userMessage("m1", "What is in build?"), reply({ steps: [{ index: 0, kind: "text", open: true, markdown: "Files." }] })], more: false, live: null },
    "GET /models?chat=chat1": models(),
    "GET /models?chat=chat2": models(),
    "GET /chats/chat2/tree": { tree: [], live: true },
    "GET /mentions": MENTIONS,
    "GET /devices/token1/files": DEVICE_FILES,
    "GET /devices/token1/commands": DEVICE_COMMANDS,
    "POST /attachments/from": { attachment: { ...fixture("attachment_from").attachment, id: "att9", name: "oven.png" } },
    "POST /chats/chat1/messages": { message: userMessage("m7", "sent"), reply: null },
    "POST /chats/chat2/messages": { message: userMessage("m8", "sent"), reply: null },
    "PATCH /chats/chat1": { chat: chatRow({ title: "Waybread, properly" }) },
    "PATCH /chats/chat2": { chat: agentChat({ mode: "plan" }) },
    "POST /chats/chat1/compact": { messages: [], more: false },
    "POST /chats/chat1/continue": { message: userMessage("m9", "Continue."), reply: null },
    ...over,
  })
  return cfg
}

const menuRows = (p) => p.$$eval("#composer-menu .cmenu__group, #composer-menu .cmenu__option .cmenu__name", (l) => l.map((x) => (x.classList.contains("cmenu__group") ? `# ${x.textContent}` : x.textContent)))
const selected = (p) => p.$eval("#composer-menu .cmenu__option[aria-selected='true'] .cmenu__name", (x) => x.textContent)
const typed = (p) => p.inputValue("#composer-text")
const messagesTo = (p, chat) => p.evaluate((c) => window.__mock.api("POST", `/chats/${c}/messages`).filter((x) => x.args.path === `/chats/${c}/messages`).map((x) => x.args.body), chat)

test("S3: / at the start lists the app's commands, filtered as it is typed; arrows, Tab completes, Enter runs, Esc closes", async () => {
  const p = await page(s3())
  await openChatRow(p, "chat1")
  await p.click("#composer-text")
  await p.keyboard.type("/")
  await p.waitForSelector("#composer-menu:not([hidden])")
  const all = await menuRows(p)
  assert.equal(all[0], "# Commands")
  for (const name of ["/help", "/usage", "/compact", "/title the new title", "/theme moria | shire", "/image what to draw", "/new", "/temp", "/continue", "/stop", "/scheduled"]) assert.ok(all.includes(name), `${name} in ${all}`)
  assert.ok(!all.some((x) => x.startsWith("/mode")), "no /mode in a chat on the server")
  assert.ok(!all.some((x) => x.startsWith("/terminal")), "no /terminal where there is none")
  assert.equal(await p.textContent("#composer-menu .cmenu__keys"), "↑↓ choose · Tab complete · Enter run · Esc dismiss")
  await p.keyboard.type("t")
  assert.deepEqual(await menuRows(p), ["# Commands", "/title the new title", "/theme moria | shire", "/temp"])
  assert.equal(await selected(p), "/title the new title")
  await p.keyboard.press("ArrowDown")
  assert.equal(await selected(p), "/theme moria | shire")
  await p.keyboard.press("ArrowUp")
  await p.keyboard.press("ArrowUp")
  assert.equal(await selected(p), "/temp", "the arrows wrap")
  await p.keyboard.press("ArrowDown")
  // Tab writes the name and leaves the caret after it; the menu goes while the argument is typed.
  await p.keyboard.press("Tab")
  assert.equal(await typed(p), "/title ")
  assert.ok(await p.isHidden("#composer-menu"))
  await p.keyboard.type("Waybread, properly")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat1").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat1")))[0].args.body, { title: "Waybread, properly" })
  assert.equal(await typed(p), "", "a command is never left in the box")
  assert.deepEqual(await messagesTo(p, "chat1"), [], "and never sent as a message")
  await p.waitForFunction(() => /Renamed/.test(document.getElementById("thread-note").textContent))
  // Esc closes the menu and leaves what was typed.
  await p.keyboard.type("/he")
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.keyboard.press("Escape")
  assert.ok(await p.isHidden("#composer-menu"))
  assert.equal(await typed(p), "/he")
  // Enter on a row runs it: /help is a sheet of the commands and the keys.
  await p.fill("#composer-text", "")
  await p.keyboard.type("/help")
  await p.keyboard.press("Enter")
  await p.waitForSelector("dialog[open] .sheet")
  assert.match(await p.textContent("dialog[open]"), /\/compact.*Keyboard.*Ctrl \+ K/s)
  await shot(p, "s3-help")
  await p.keyboard.press("Escape")
  assert.equal(await p.locator("dialog[open]").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("S3: a slash that is not a command is sent as written: //, an unknown name, a path; a command works from the Send button too", async () => {
  const p = await page(s3())
  await openChatRow(p, "chat1")
  await p.click("#composer-text")
  await p.keyboard.type("//not a command")
  assert.ok(await p.isHidden("#composer-menu").catch(() => true), "// opens nothing")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 1)
  await p.keyboard.type("/nosuch thing")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 2)
  await p.keyboard.type("/nos")
  await p.waitForSelector("#composer-menu:not([hidden])")
  assert.match(await p.textContent("#composer-menu"), /No command called “nos”\. It will be sent as a message\./)
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 3)
  await p.keyboard.type("look in /usr/lib and a/b")
  assert.ok(await p.isHidden("#composer-menu"), "a slash inside a sentence is a path")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 4)
  assert.deepEqual((await messagesTo(p, "chat1")).map((b) => b.text), ["//not a command", "/nosuch thing", "/nos", "look in /usr/lib and a/b"])
  // /mode is no command in a chat on the server: sent as the message it is.
  await p.keyboard.type("/mode plan")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 5)
  // The Send button with a command typed runs it.
  await p.fill("#composer-text", "/continue")
  await p.keyboard.press("Escape")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/continue").length === 1)
  assert.equal((await messagesTo(p, "chat1")).length, 5)
  assert.deepEqual(p.errors, [])
})

test("S3: the commands do what the app's own controls do: effort, mode, compact, image, temp, stop, theme, the panels", async () => {
  const cfg = s3({ "PATCH /chats/chat1": { chat: chatRow({ effort: "high" }) } })
  cfg.routes["GET /me"] = { ...meAs(), ...cfg.routes["GET /me"], themes: ME.themes }
  cfg.routes["PATCH /me"] = { ...cfg.routes["GET /me"], theme: "shire" }
  cfg.streams = { [STREAM2]: [["status", { text: "Writing…" }]] }
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  const run = async (text) => {
    await p.fill("#composer-text", text)
    await p.focus("#composer-text")
    await p.keyboard.press("Enter")
  }
  const said = () => p.textContent("#thread-note")
  // /effort: the model's levels; a wrong one is said; a right one is saved.
  await run("/effort")
  await p.waitForFunction(() => /Effort is/.test(document.getElementById("thread-note").textContent))
  await run("/effort enormous")
  await p.waitForFunction(() => /is not a level this model offers/.test(document.getElementById("thread-note").textContent))
  await run("/effort high")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat1").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat1")))[0].args.body, { effort: "high" })
  // /compact asks first.
  await run("/compact")
  await p.waitForSelector("dialog[open]")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/compact").length === 1)
  // /image: the next reply is a picture.
  await p.waitForSelector("#messages .msg")
  await run("/image")
  await p.waitForFunction(() => /Say what to draw/.test(document.getElementById("thread-note").textContent))
  await run("/image a red bicycle in the rain")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/messages").length === 1)
  assert.deepEqual((await messagesTo(p, "chat1"))[0], { text: "a red bicycle in the rain", force_tool: "image_generate" })
  // /usage and /activity: the activity panel; /sidebar: the sidebar.
  await run("/usage")
  await p.waitForSelector("#activity:not([hidden])")
  await run("/activity")
  await p.waitForSelector("#activity", { state: "hidden" })
  await run("/sidebar")
  await p.waitForFunction(() => document.getElementById("shell").dataset.side === "false")
  await run("/sidebar")
  // /theme: the account's, through PATCH /me.
  await run("/theme shire")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/me").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/me")))[0].args.body, { theme: "shire" })
  // /stop with nothing written says so; /scheduled opens the page.
  await run("/stop")
  assert.match(await said(), /Nothing is being written/)
  // An agent chat: /mode, /terminal, /stop.
  await openChatRow(p, "chat2")
  await run("/mode")
  await p.waitForFunction(() => /Modes: manual, edit, auto, plan/.test(document.getElementById("thread-note").textContent))
  await run("/mode sideways")
  await p.waitForFunction(() => /is not a mode/.test(document.getElementById("thread-note").textContent))
  await run("/mode plan")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat2").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat2")))[0].args.body, { mode: "plan" })
  await run("/terminal")
  await p.waitForSelector("#terminal:not([hidden])")
  await run("/terminal")
  await p.waitForSelector("#terminal", { state: "hidden" })
  // /temp: a new chat on the server that keeps nothing; /new: a new one.
  await run("/temp")
  await p.waitForSelector("#new-chat:not([hidden])")
  assert.equal(await p.textContent("#chat-title"), "Temporary chat")
  await p.evaluate(() => window.__mock.answer("POST /chats", { chat: { id: "chatT", kind: "chat", title: "", model: "qwen", temporary: true }, message: null, reply: null }))
  await p.fill("#composer-text", "Just between us")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").some((x) => x.args.path === "/chats"))
  const made = (await p.evaluate(() => window.__mock.api("POST", "/chats").filter((x) => x.args.path === "/chats")))[0].args.body
  assert.equal(made.temporary, true)
  assert.equal(made.kind, undefined, "a temporary chat is a chat on the server")
  await run("/scheduled")
  await p.waitForSelector("#page-scheduled:not([hidden])")
  assert.deepEqual(p.errors, [])
})

test("S3: on an agent chat the device's commands follow the app's, and one chosen is sent as the literal message", async () => {
  const p = await page(s3())
  await openChatRow(p, "chat2")
  await p.click("#composer-text")
  await p.keyboard.type("/")
  await p.waitForFunction(() => /review/.test(document.getElementById("composer-menu")?.textContent || ""))
  const rows = await menuRows(p)
  const at = rows.indexOf("# workbench")
  assert.ok(at > 0, `the device's group, named: ${rows}`)
  assert.deepEqual(rows.slice(at), ["# workbench", "/review", "/commit <message>"], "a name the app has stays the app's: one /compact")
  assert.ok(rows.includes("/mode manual | edit | auto | plan") && rows.includes("/terminal"))
  const [asked] = await p.evaluate(() => window.__mock.api("GET", "/devices/token1/commands"))
  assert.equal(asked.args.path, "/devices/token1/commands?chat=chat2&cwd=%2Fhome%2Fdev%2Fproject")
  // Chosen with Enter: sent as `/review`, as the device's terminal would take it.
  await p.keyboard.type("rev")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/messages").length === 1)
  assert.deepEqual((await messagesTo(p, "chat2"))[0], { text: "/review" })
  // One that takes something after its name is completed, never sent bare.
  await p.keyboard.type("/comm")
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.keyboard.press("Enter")
  assert.equal(await typed(p), "/commit ")
  await p.keyboard.type("Tidy the build")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/messages").length === 2)
  assert.equal((await messagesTo(p, "chat2"))[1].text, "/commit Tidy the build")
  // A new agent chat asks the device too, for the folder chosen.
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.click("#composer-text")
  await p.keyboard.type("/")
  await p.waitForFunction(() => window.__mock.api("GET", "/devices/token1/commands").some((x) => x.args.path.includes("chat=&cwd=%2Fhome%2Fdev%2Fproject")))
  assert.deepEqual(p.errors, [])
})

test("S3: @ after white space lists what can be mentioned; a device's file goes in as its escaped path, an attachment as a chip", async () => {
  const p = await page(s3(), { clock: true })
  await openChatRow(p, "chat2")
  await p.click("#composer-text")
  await p.keyboard.type("mail ada@example.org")
  await p.clock.fastForward(400)
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/mentions").length), 0, "an address is not a mention")
  await p.keyboard.type(" see @a")
  // Debounced: nothing is asked for a keystroke that another follows at once.
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/mentions").length), 0)
  await p.keyboard.type("pp")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  const reads = await p.evaluate(() => [window.__mock.api("GET", "/mentions"), window.__mock.api("GET", "/devices/token1/files")].map((l) => l.map((x) => x.args.path)))
  assert.deepEqual(reads, [["/mentions?q=app&chat=chat2"], ["/devices/token1/files?q=app&chat=chat2&cwd=%2Fhome%2Fdev%2Fproject"]], "one lookup, for what was typed last")
  assert.deepEqual(await menuRows(p), ["# On the device · workbench", "app main.ts", "tui", "# Files", "lembas recipe #2.md", "# Already in this chat", "oven.png"], "the device's files first")
  assert.equal(await p.textContent("#composer-menu .cmenu__keys"), "↑↓ choose · Enter mention · Esc dismiss")
  await shot(p, "s3-mentions-agent")
  // The device's file: its path, a space and # escaped as the CLI reads them; nothing attached.
  await p.keyboard.press("Enter")
  assert.equal(await typed(p), "mail ada@example.org see @src/app\\ main.ts ")
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/attachments/from").length), 0)
  // What is already in this chat: attached again, the usual chip.
  await p.keyboard.type("@ov")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.keyboard.press("ArrowUp")
  assert.equal(await selected(p), "oven.png")
  assert.equal(await p.textContent("#composer-menu .cmenu__keys"), "↑↓ choose · Enter attach · Esc dismiss")
  await p.keyboard.press("Enter")
  await p.waitForSelector("#composer-files .tile.is-ready")
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/attachments/from")))[0].args.body, { chat: "chat2", attachment: "att7" })
  assert.match(await typed(p), /@oven\.png $/)
  // A server file in an agent chat is attached: the device cannot read the server's tree.
  await p.keyboard.type("@lem")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.click("#composer-menu .cmenu__option:has-text('lembas recipe')")
  await p.waitForFunction(() => window.__mock.api("POST", "/attachments/from").length === 2)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/attachments/from")))[1].args.body, { chat: "chat2", path: "/notes/recipes/lembas recipe #2.md" })
  await p.keyboard.type("done")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat2/messages").length === 1)
  assert.deepEqual((await messagesTo(p, "chat2"))[0].attachments, ["att9", "att9"], "the chips go with the message")
  assert.deepEqual(p.errors, [])
})

test("S3: in a chat on the server a file is mentioned by its path or attached as a copy; an address is a page to read; an older server offers what it can", async () => {
  const p = await page(s3(), { clock: true })
  await openChatRow(p, "chat1")
  await p.click("#composer-text")
  await p.keyboard.type("@lem")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  assert.deepEqual(await menuRows(p), ["# Files", "lembas recipe #2.md", "# Already in this chat", "oven.png"])
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/devices/").length), 0, "no device is asked in a chat on the server")
  assert.equal(await p.textContent("#composer-menu .cmenu__keys"), "↑↓ choose · Enter mention · Shift+Enter attach · Esc dismiss")
  // Enter: the path, for the model to read under the chat's access.
  await p.keyboard.press("Enter")
  assert.equal(await typed(p), "@/notes/recipes/lembas\\ recipe\\ \\#2.md ")
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/attachments/from").length), 0)
  // Shift+Enter, or the row's own button: a copy attached.
  await p.keyboard.type("@lem")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.keyboard.press("Shift+Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/attachments/from").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/attachments/from")))[0].args.body, { chat: "chat1", path: "/notes/recipes/lembas recipe #2.md" })
  await p.keyboard.type("@lem")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.click("#composer-menu .cmenu__also[data-also]")
  await p.waitForFunction(() => window.__mock.api("POST", "/attachments/from").length === 2)
  // An address: a page to read, fetched by the server and attached.
  await p.fill("#composer-text", "")
  await p.keyboard.type("@https://example.org/lembas")
  await p.clock.fastForward(400)
  await p.waitForFunction(() => /Fetch this page/.test(document.getElementById("composer-menu")?.textContent || ""))
  assert.equal((await menuRows(p))[0], "# A page to read")
  assert.equal(await p.textContent("#composer-menu .cmenu__note"), "https://example.org/lembas")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => window.__mock.api("POST", "/attachments/from").length === 3)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/attachments/from")))[2].args.body, { chat: "chat1", url: "https://example.org/lembas" })
  // Every lookup stays on the app's door: no address or fragment in a path Rust would refuse.
  const paths = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "api").map((c) => c.args.path))
  assert.ok(paths.every((x) => x.startsWith("/") && !x.includes("://") && !x.includes("#") && !x.includes(" ")), "paths Rust's door takes")
  // A refusal is said on the file's tile, not lost.
  await p.evaluate(() => window.__mock.answer("POST /attachments/from", { __error: { status: 413, detail: "That file is too large to attach." } }))
  await p.fill("#composer-text", "")
  await p.keyboard.type("@ov")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden])")
  await p.keyboard.press("ArrowUp")
  await p.keyboard.press("Enter")
  await p.waitForSelector("#composer-files .tile.is-failed")
  assert.match(await p.getAttribute("#composer-files .tile.is-failed", "title"), /too large/)
  await p.context().close()
  // A server from before the routes: nothing to mention, said; the address is still offered.
  const cfg = s3()
  for (const k of ["GET /mentions", "GET /devices/token1/files", "GET /devices/token1/commands"]) delete cfg.routes[k]
  const o = await page(cfg, { clock: true })
  await openChatRow(o, "chat2")
  await o.click("#composer-text")
  await o.keyboard.type("@x")
  await o.clock.fastForward(400)
  await o.waitForSelector("#composer-menu:not([hidden])")
  assert.match(await o.textContent("#composer-menu"), /Nothing matches “x”\./)
  // A device that could not answer says so in its place (the server's `error`), and the rest shows.
  await o.evaluate(() => {
    window.__mock.answer("GET /devices/token1/files", { files: [], error: "The device did not answer in time.", device: "workbench" })
  })
  await o.evaluate((found) => window.__mock.answer("GET /mentions", found), fixture("mentions_url"))
  await o.keyboard.type("y")
  await o.clock.fastForward(400)
  await o.waitForFunction(() => /did not answer in time/.test(document.getElementById("composer-menu")?.textContent || ""))
  assert.deepEqual(await menuRows(o), ["# On the device", "# A page to read", "Fetch this page"])
  assert.equal(await o.textContent("#composer-menu .cmenu__option .cmenu__note"), fixture("mentions_url").items[0].url)
  await o.keyboard.press("Escape")
  await o.fill("#composer-text", "")
  await o.keyboard.type("/")
  await o.waitForSelector("#composer-menu:not([hidden])")
  assert.ok((await menuRows(o)).includes("/help"), "the app's own commands need no route")
  assert.deepEqual(o.errors, [])
  assert.deepEqual(p.errors, [])
})

test("S3: the server's own fixtures are drawn as they are: its device's commands and files, its mentions, and the attachment it answers", async () => {
  const p = await page(s3({ "GET /mentions": fixture("mentions"), "GET /devices/token1/files": fixture("device_files"), "GET /devices/token1/commands": fixture("device_commands"), "POST /attachments/from": fixture("attachment_from") }), { clock: true })
  await openChatRow(p, "chat2")
  await p.click("#composer-text")
  await p.keyboard.type("/")
  await p.waitForFunction(() => /review/.test(document.getElementById("composer-menu")?.textContent || ""))
  const rows = await menuRows(p)
  assert.deepEqual(rows.slice(rows.indexOf("# workstation")), ["# workstation", "/review [base]"], "named as the server names the device; its /compact is the app's")
  await p.fill("#composer-text", "")
  await p.keyboard.type("@")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden]) .cmenu__option")
  assert.deepEqual(await menuRows(p), ["# On the device · workstation", "README.md", "loader", "# Files", "bread.md", "# Already in this chat", "recipe.pdf"])
  await p.keyboard.press("ArrowUp")
  await p.keyboard.press("Enter")
  await p.waitForSelector("#composer-files .tile.is-ready")
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/attachments/from")))[0].args.body, { attachment: "att1", chat: "chat2" })
  assert.match(await p.textContent("#composer-files .tile.is-ready"), /bread\.md/, "the tile is the attachment the server answered")
  assert.deepEqual(p.errors, [])
})

test("S3: another computer's commands are never offered while this one's are being read; a name that is not a command's is dropped; a device's command is sent, never run as the app's", async () => {
  const there = agentChat({ id: "chat9", title: "On the laptop", device: { token_id: "token9", directory: "/home/dev/site" } })
  const cfg = s3({
    "GET /chats": { chats: [chatRow(), agentChat(), there], more: false },
    "GET /chats/chat9": { chat: there, messages: [userMessage("m1", "Hello")], more: false, live: null },
    "GET /models?chat=chat9": models(),
    "GET /devices": { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: true }, { id: "token9", name: "laptop", host: "laptop", platform: "linux", terminal: true }] },
    "GET /devices/token9/commands": { commands: [{ name: "deploy", description: "Ship it", hint: "", kind: "custom" }, { name: "deploy now; rm", description: "", hint: "", kind: "custom" }, { name: "/usage", description: "the device's own", hint: "", kind: "builtin" }], device: "laptop" },
    "POST /chats/chat9/messages": { message: userMessage("m9", "sent"), reply: null },
  })
  cfg.hold = ["GET /devices/token9/commands"]
  const p = await page(cfg)
  await openChatRow(p, "chat2")
  await p.click("#composer-text")
  await p.keyboard.type("/")
  await p.waitForFunction(() => /review/.test(document.getElementById("composer-menu")?.textContent || ""))
  await p.keyboard.press("Escape")
  await p.fill("#composer-text", "")
  // The other computer's chat: its commands are still on their way.
  await openChatRow(p, "chat9")
  await p.click("#composer-text")
  await p.keyboard.type("/")
  await p.waitForSelector("#composer-menu:not([hidden]) .cmenu__option")
  assert.ok(!(await menuRows(p)).some((r) => /review|commit|workbench/.test(r)), `nothing of the computer before: ${await menuRows(p)}`)
  await p.evaluate(() => window.__mock.release("GET /devices/token9/commands"))
  await p.waitForFunction(() => /deploy/.test(document.getElementById("composer-menu")?.textContent || ""))
  const rows = await menuRows(p)
  assert.deepEqual(rows.slice(rows.indexOf("# laptop")), ["# laptop", "/deploy"], "a name with a space is not a command; /usage is the app's own")
  // Chosen, it is sent to the chat as the message it is.
  await p.locator("#composer-menu .cmenu__option", { hasText: "/deploy" }).click()
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat9/messages").length === 1)
  assert.deepEqual(await messagesTo(p, "chat9"), [{ text: "/deploy" }])
  assert.deepEqual(p.errors, [])
})

test("S3: while a newer @ lookup is on its way nothing of the list before can be chosen, and Enter does not send half a mention", async () => {
  const p = await page(s3(), { clock: true })
  await openChatRow(p, "chat1")
  await p.click("#composer-text")
  await p.keyboard.type("@lem")
  await p.clock.fastForward(400)
  await p.waitForSelector("#composer-menu:not([hidden]) .cmenu__option")
  // One more letter: the answer for it is held back (a slow server).
  await p.evaluate(() => (window.__mockConfig.hold = ["GET /mentions"]))
  await p.keyboard.type("b")
  assert.equal(await p.getAttribute("#composer-menu .cmenu__list", "aria-busy"), "true")
  await p.keyboard.press("Enter")
  await p.keyboard.press("Tab")
  await p.clock.fastForward(400)
  assert.equal(await typed(p), "@lemb", "nothing was put in from the list before")
  assert.deepEqual(await messagesTo(p, "chat1"), [], "and nothing was sent")
  assert.equal(await p.locator("#composer-files .tile").count(), 0)
  // The answer comes: the list is its own, and can be chosen from again.
  await p.evaluate(() => window.__mock.release("GET /mentions"))
  await p.waitForFunction(() => !document.querySelector("#composer-menu .cmenu__list").hasAttribute("aria-busy"))
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => document.getElementById("composer-text").value !== "@lemb")
  assert.deepEqual(p.errors, [])
})

test("S3: the menu is the composer's own width, directly above it, at 1920, 1280, 1024, 800 and 390 px; long names give way", async () => {
  const long = { items: [{ kind: "file", path: `/notes/${LONG}`, name: LONG, detail: `/notes/a/very/deep/folder/of/recipes/and/their/variants/${LONG}` }, ...MENTIONS.items] }
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844]]) {
    const p = await page(s3({ "GET /mentions": long }), { width, height })
    await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
    await p.waitForSelector("#messages .msg")
    for (const text of ["/", "@lem"]) {
      await p.fill("#composer-text", "")
      await p.click("#composer-text")
      await p.keyboard.type(text)
      await p.waitForSelector("#composer-menu:not([hidden]) .cmenu__option")
      const [m, c] = await p.evaluate(() => ["composer-menu", "composer"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }))
      assert.ok(Math.abs(m.left - c.left) < 2 && Math.abs(m.right - c.right) < 2, `${width} ${text}: the card's width`)
      assert.ok(m.bottom <= c.top && c.top - m.bottom < 16, `${width} ${text}: directly above the card`)
      assert.ok(m.top >= 0 && m.left >= 0 && m.right <= width, `${width} ${text}: inside the window`)
      const cut = await p.$$eval("#composer-menu .cmenu__option > *", (l) => { const box = document.getElementById("composer-menu").getBoundingClientRect(); return l.filter((x) => { const r = x.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5 }).length })
      assert.equal(cut, 0, `${width} ${text}: every row inside the menu`)
      // The rows share their tracks: every name starts on one line.
      const lefts = await p.$$eval("#composer-menu .cmenu__name", (l) => [...new Set(l.map((x) => Math.round(x.getBoundingClientRect().left)))])
      assert.equal(lefts.length, 1, `${width} ${text}: names on one line (${lefts})`)
      assert.ok(await noSideways(p, width), `${width} ${text}: nothing sideways`)
      await shot(p, `s3-menu-${text === "/" ? "slash" : "at"}-${width}`)
      await p.keyboard.press("Escape")
    }
    // The last row can be reached with the keys: it scrolls into the list's view.
    await p.fill("#composer-text", "")
    await p.keyboard.type("/")
    await p.keyboard.press("ArrowUp")
    const seen = await p.evaluate(() => { const o = document.querySelector("#composer-menu .cmenu__option[aria-selected='true']").getBoundingClientRect(); const l = document.querySelector("#composer-menu .cmenu__list").getBoundingClientRect(); return o.top >= l.top - 1 && o.bottom <= l.bottom + 1 })
    assert.ok(seen, `${width}: the chosen row is in view`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- T3: the terminal -- typed ahead, ended, reconnected, switched off ------------------------------
//
// The server's own fixtures (tests/ui/fixtures): GET /terminals (terminals.json), the socket's
// ready frame with the shell's `id` and `resumed` (terminal_ready.json), its refusal at the limit
// with the open `shells` (terminal_refused.json), and GET /devices with `terminal_reason` and
// `terminal_hint` (devices.json); a shell is ended with POST /terminals/{id}/end. The `closed`
// frame's `reason` is the server's own: exited, idle, shutdown, revoked, error, ended.

const SHELLS = { shells: [{ id: "sh1", device: "workbench", directory: "/home/dev/project", seconds: 754, chat: "chat2", watched: true }, { id: "sh2", device: "workbench", directory: "/home/dev/other", seconds: 4000, chat: "", watched: false }] }
/** Under a fake clock: move it on in steps (every timer runs) until the page says `fn` holds. */
async function runUntil(p, fn, step = 100, most = 100) {
  for (let i = 0; i < most; i++) {
    if (await p.evaluate(fn)) return
    await p.clock.runFor(step)
    await p.waitForTimeout(10)
  }
  assert.fail(`not within ${step * most} ms of the page's clock: ${fn}`)
}
const termSays = (p) => p.textContent("#terminal-message")
const openPanel = async (p) => {
  await openChatRow(p, "chat2")
  await p.click("#chat-tools [data-terminal-toggle]")
}

test("T3: what is typed while the shell is still being opened is kept and sent in order, not dropped", async () => {
  // The bridge answers with the shell's id at once and opens the socket behind it (2.5 s here):
  // keys typed meanwhile go to the bridge in order, which holds them for the socket.
  const cfg = b3()
  cfg.terminalDelay = 2500
  const p = await page(cfg)
  await openPanel(p)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connecting…")
  await p.waitForSelector("#terminal .xterm-helper-textarea", { state: "attached" })
  await p.focus("#terminal .xterm-helper-textarea")
  await p.keyboard.type("ls -la")
  await p.waitForFunction(() => window.__mock.typed() === "ls -la")
  assert.equal(await termSays(p), "Connecting…", "typed ahead of the shell")
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  await p.keyboard.type("\n")
  await p.waitForFunction(() => window.__mock.typed() === "ls -la\r")
  // The size the panel has is told once the socket is there.
  assert.ok(await p.evaluate(() => window.__mock.calls.some((c) => c.cmd === "terminal_resize")), "its size too")
  assert.deepEqual(p.errors, [])
})

test("T3: what is typed while a lost connection comes back goes to the shell that was running, never to a new one; a shell that answers and drops is not asked every second", async () => {
  const ready = (over) => [["control", { t: "ready", label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false, ...over }]]
  const lose = () => p.evaluate(() => window.__mock.shell("end", { code: null, reason: "", status: null, error: "The connection broke off: reset" }))
  const type = async (text) => {
    await p.focus("#terminal .xterm-helper-textarea")
    await p.keyboard.type(text)
    await p.clock.runFor(50)
  }
  const p = await page(b3(), { clock: true })
  await openPanel(p)
  await runUntil(p, () => document.querySelector("#terminal-message").textContent === "Connected.")
  await type("rm -rf build/ol")
  assert.equal(await p.evaluate(() => window.__mock.typed()), "rm -rf build/ol")
  // The connection goes; while the next one is opening (3 s) the rest of the line is typed.
  await p.evaluate((frames) => Object.assign(window.__mockConfig, { terminal: frames, terminalDelay: 3000 }), ready({ id: "sh2", resumed: false }))
  await lose()
  await runUntil(p, () => window.__mock.terminals().length === 2)
  await runUntil(p, () => document.querySelector("#terminal-message").textContent === "Connecting…")
  await type("d\n")
  await runUntil(p, () => /^Connected again\. This is a new shell/.test(document.querySelector("#terminal-message").textContent), 500, 20)
  assert.match(await termSays(p), /What was typed while it was reconnecting was not sent\.$/)
  assert.equal(await p.evaluate(() => window.__mock.typed()), "rm -rf build/ol", "the end of the line did not reach the new shell")
  // Typed now, it is the new shell's.
  await type("ls\n")
  assert.equal(await p.evaluate(() => window.__mock.typed()), "rm -rf build/ol" + "ls\r")
  // Lost again at once: it answered but did not stay, so the wait is the next longer one, not 1 s again.
  await p.evaluate((frames) => Object.assign(window.__mockConfig, { terminal: frames }), ready({ id: "sh2", resumed: true }))
  await lose()
  await p.waitForFunction(() => /Reconnecting in 2 s…/.test(document.querySelector("#terminal-message").textContent))
  await runUntil(p, () => window.__mock.terminals().length === 3)
  await runUntil(p, () => document.querySelector("#terminal-message").textContent === "Connecting…")
  await type("pwd\n")
  assert.equal(await p.evaluate(() => window.__mock.typed()), "rm -rf build/ol" + "ls\r", "held until the server says which shell")
  // The same shell answers: what was typed meanwhile is its own.
  await runUntil(p, () => document.querySelector("#terminal-message").textContent === "Connected again, to the same shell.", 500, 20)
  assert.equal(await p.evaluate(() => window.__mock.typed()), "rm -rf build/ol" + "ls\r" + "pwd\r")
  // It stayed (10 s): the next loss starts from 1 s again.
  await p.clock.runFor(10500)
  await lose()
  await p.waitForFunction(() => /Reconnecting in 1 s…/.test(document.querySelector("#terminal-message").textContent))
  assert.deepEqual(p.errors, [])
})

test("T3: End shell asks, then ends this panel's shell on the server and offers a new one", async () => {
  const p = await page(b3({ "GET /terminals": SHELLS, "POST /terminals/sh1/end": null }))
  await openPanel(p)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  assert.ok(await p.isVisible("#terminal-end"), "End shell, once there is a shell")
  assert.ok(await p.isHidden("#terminal-again"))
  await p.click("#terminal-end")
  await p.waitForSelector("dialog[open]")
  assert.match(await p.textContent("dialog[open]"), /What is running in it stops/)
  // Cancel: nothing ended.
  await p.click("dialog[open] .btn >> text=Cancel")
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/terminals/").length), 0)
  await p.click("#terminal-end")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("POST", "/terminals/sh1/end").length === 1)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "The shell was ended.")
  assert.ok(await p.isHidden("#terminal-end"))
  assert.equal(await p.textContent("#terminal-again"), "New shell")
  await p.click("#terminal-again")
  await p.waitForFunction(() => window.__mock.terminals().length === 2)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  // Where the shell's ready frame names it, that id is the one ended.
  await p.evaluate(() => window.__mock.shell("control", { t: "ready", id: "sh9", label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false }))
  await p.evaluate(() => window.__mock.answer("POST /terminals/sh9/end", null))
  await p.click("#terminal-end")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("POST", "/terminals/sh9/end").length === 1)
  await p.context().close()
  // A server without the routes: said, and the shell stays.
  const o = await page(b3())
  await openPanel(o)
  await o.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  await o.click("#terminal-end")
  await o.click("dialog[open] .btn--danger")
  await o.waitForFunction(() => /needs a newer LLeMbas server/.test(document.querySelector("#terminal-message").textContent))
  assert.ok(await o.evaluate(() => window.__mock.terminals()[0].open), "the shell is still open")
  assert.deepEqual(o.errors, [])
  assert.deepEqual(p.errors, [])
})

test("T3: at the limit of open shells the ones open are listed, each with End; ended, a new one can be opened", async () => {
  // The refusal carries the open shells (the server's `error` frame at the limit).
  const said = "You already have as many terminals open as you may (3). End one first."
  const refusal = [["control", { t: "error", message: said, shells: SHELLS.shells }], ["end", { code: 1000, reason: "", status: null, error: null }]]
  const p = await page(b3({ "GET /terminals": SHELLS, "POST /terminals/sh2/end": null }, refusal))
  await openPanel(p)
  await p.waitForSelector("#terminal-shells:not([hidden]) .termpanel__shell")
  assert.equal(await termSays(p), said)
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/terminals").length), 0, "the list came with the refusal")
  const rows = await p.$$eval("#terminal-shells .termpanel__shell", (l) => l.map((x) => [x.dataset.id, ...[...x.querySelectorAll("span")].map((y) => y.textContent)]))
  assert.deepEqual(rows, [["sh1", "workbench", "/home/dev/project", "12m 34s"], ["sh2", "workbench", "/home/dev/other", "1h 06m"]])
  assert.equal(await p.textContent("#terminal-again"), "Reconnect")
  await shot(p, "t3-limit")
  // End one: the list is read again from the server and is shorter.
  await p.evaluate(() => window.__mock.answer("GET /terminals", { shells: [{ id: "sh1", device: "workbench", directory: "/home/dev/project", seconds: 760, chat: "chat2", watched: true }] }))
  await p.click("#terminal-shells .termpanel__shell[data-id='sh2'] .btn")
  await p.waitForFunction(() => window.__mock.api("POST", "/terminals/sh2/end").length === 1)
  await p.waitForFunction(() => document.querySelectorAll("#terminal-shells .termpanel__shell").length === 1)
  // Reconnect, now that there is room: a shell, and the list goes.
  await p.evaluate(() => (window.__mockConfig.terminal = [["control", { t: "ready", label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false }]]))
  await p.click("#terminal-again")
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  assert.ok(await p.isHidden("#terminal-shells"))
  assert.ok(await p.isHidden("#terminal-again"))
  assert.deepEqual(p.errors, [])
})

test("T3: the server's own fixtures: its ready frame names the shell that End shell ends; its refusal lists the shells it carries; its reason for no terminal is said", async () => {
  const ready = fixture("terminal_ready")
  let p = await page(b3({ [`POST /terminals/${ready.id}/end`]: null }, [["control", ready]]))
  await openPanel(p)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected.")
  assert.equal(await p.textContent("#terminal-where"), ready.dir)
  assert.ok(await p.isVisible("#terminal-prev"), "it marks its commands (`osc`)")
  await p.click("#terminal-end")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction((id) => window.__mock.api("POST", `/terminals/${id}/end`).length === 1, ready.id)
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/terminals").length), 0, "the id came with the ready frame")
  await p.context().close()
  const refused = fixture("terminal_refused")
  p = await page(b3({}, [["control", refused], ["end", { code: 1000, reason: "", status: null, error: null }]]))
  await openPanel(p)
  await p.waitForSelector("#terminal-shells:not([hidden]) .termpanel__shell")
  assert.equal(await termSays(p), refused.message)
  assert.deepEqual(await p.$$eval("#terminal-shells .termpanel__shell", (l) => l.map((x) => [x.dataset.id, ...[...x.querySelectorAll("span")].map((y) => y.textContent)])), refused.shells.map((x) => [x.id, x.device, x.directory, "12m 34s"]))
  await p.context().close()
  // GET /devices as the server answers it: a computer that opens no terminal says why, in the server's sentence.
  const devices = fixture("devices")
  const off = devices.devices.find((d) => !d.terminal)
  const there = agentChat({ id: "chat9", title: "On the laptop", device: { token_id: off.id, directory: "/home/dev/site" } })
  p = await page(b3({ "GET /devices": devices, "GET /chats": { chats: [chatRow(), there], more: false }, "GET /chats/chat9": { chat: there, messages: [userMessage("m1", "Hello")], more: false, live: null }, "GET /models?chat=chat9": models() }))
  await openChatRow(p, "chat9")
  await p.waitForSelector("#chat-tools [data-terminal-off]")
  await p.click("#chat-tools [data-terminal-off]")
  await p.waitForSelector(".pop")
  assert.ok((await p.textContent(".pop")).includes(off.terminal_hint), "the server's own sentence")
  assert.equal(await p.locator(".pop .btn--primary").count(), 0, "another computer's switch is not this app's to open")
  assert.deepEqual(p.errors, [])
})

test("T3: a lost connection is tried again by itself, each time after longer, and says the shell is new; one that exited is not", async () => {
  const p = await page(b3(), { clock: true })
  await openPanel(p)
  await runUntil(p, () => document.querySelector("#terminal-message").textContent === "Connected.")
  // The socket goes without a word (the server restarting): counted down, then opened again.
  await p.evaluate(() => window.__mock.shell("end", { code: null, reason: "", status: null, error: "The connection broke off: reset" }))
  await p.waitForFunction(() => /Reconnecting in 1 s…/.test(document.querySelector("#terminal-message").textContent))
  assert.match(await termSays(p), /^The connection broke off: reset /)
  assert.equal(await p.textContent("#terminal-again"), "Reconnect now")
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 1)
  // It fails again (the server is still down): the next wait is longer.
  await p.evaluate(() => (window.__mockConfig.terminal = [["end", { code: null, reason: "", status: null, error: "Could not reach the server: refused" }]]))
  await p.clock.runFor(1100)
  await p.waitForFunction(() => window.__mock.terminals().length === 2)
  await p.waitForFunction(() => /Reconnecting in 2 s…/.test(document.querySelector("#terminal-message").textContent))
  await p.clock.runFor(1000)
  assert.match(await termSays(p), /Reconnecting in 1 s…/, "counted down")
  // The server is back: a shell, said as possibly new, the old output still on the screen.
  await p.evaluate(() => (window.__mockConfig.terminal = [["control", { t: "ready", label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false }], ["output", "dev@workbench:~/project$ "]]))
  await p.clock.runFor(1100)
  await p.waitForFunction(() => window.__mock.terminals().length === 3)
  await p.waitForFunction(() => /^Connected again\. If the server or the computer restarted meanwhile, this is a new shell\.$/.test(document.querySelector("#terminal-message").textContent))
  // (A server that says so settles it: `resumed` true is the shell that was running.)
  await p.evaluate(() => (window.__mockConfig.terminal = [["control", { t: "ready", id: "sh1", resumed: true, label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false }]]))
  await p.evaluate(() => window.__mock.shell("end", { code: null, reason: "", status: null, error: "The connection broke off: reset" }))
  await p.clock.runFor(1100)
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "Connected again, to the same shell.")
  await p.evaluate(() => (window.__mockConfig.terminal = [["control", { t: "ready", id: "sh3", resumed: false, label: "workbench", dir: "/home/dev/project", cols: 80, rows: 24, shared: false, osc: false }]]))
  assert.ok(await p.isHidden("#terminal-again"))
  assert.match(await screenText(p), /reconnected/)
  // The link to the computer drops (the server says so): reconnected, and the shell is new.
  await p.evaluate(() => window.__mock.shell("control", { t: "closed", reason: "error", message: "The connection to the computer was lost." }))
  await p.waitForFunction(() => /The connection to the computer was lost\. Reconnecting in 1 s…/.test(document.querySelector("#terminal-message").textContent))
  // Reconnect now does not wait.
  await p.click("#terminal-again")
  await p.waitForFunction(() => window.__mock.terminals().length === 5)
  await p.waitForFunction(() => /This is a new shell: the one before ended with the connection\./.test(document.querySelector("#terminal-message").textContent))
  // The shell exited: said, and nothing is opened by itself -- New shell is the person's to press.
  await p.evaluate(() => window.__mock.shell("control", { t: "closed", reason: "exited", message: "The shell exited." }))
  await p.waitForFunction(() => document.querySelector("#terminal-message").textContent === "The shell exited.")
  await p.clock.runFor(60000)
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 5, "no shell opened by itself")
  assert.equal(await p.textContent("#terminal-again"), "New shell")
  // After every try has failed it stops, and waits for Reconnect.
  await p.click("#terminal-again")
  await p.waitForFunction(() => window.__mock.terminals().length === 6)
  await p.evaluate(() => (window.__mockConfig.terminal = [["end", { code: null, reason: "", status: null, error: "Could not reach the server: refused" }]]))
  await p.evaluate(() => window.__mock.shell("end", { code: null, reason: "", status: null, error: "The connection broke off: reset" }))
  await runUntil(p, () => /It did not come back/.test(document.querySelector("#terminal-message").textContent), 1000, 120)
  await p.waitForFunction(() => /It did not come back\. Reconnect when it is there again\./.test(document.querySelector("#terminal-message").textContent))
  assert.equal(await p.textContent("#terminal-again"), "Reconnect")
  const tried = await p.evaluate(() => window.__mock.terminals().length)
  assert.equal(tried, 6 + 6, "six tries, 1 2 4 8 15 30 s apart, and no more")
  await p.clock.runFor(120000)
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), tried)
  // Another chat: the old shell's reconnecting is not carried over.
  assert.deepEqual(p.errors, [])
})

test("T3: where the computer opens no terminal the button is there, dimmed, and says why and how; it comes alive when the computer links", async () => {
  const off = { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: false, terminal_reason: "device", terminal_hint: "workbench does not open terminals. Switch it on there: in LLeMbas Desktop's settings, or with the LLeMbas CLI's remote.terminal setting." }] }
  const p = await page(b3({ "GET /devices": off }), { clock: true })
  await openChatRow(p, "chat2")
  await p.waitForSelector("#chat-tools [data-terminal-off]")
  assert.equal(await p.locator("#chat-tools [data-terminal-toggle]").count(), 0)
  assert.match(await p.getAttribute("#chat-tools [data-terminal-off]", "class"), /is-off/)
  assert.match(await p.getAttribute("#chat-tools [data-terminal-off]", "title"), /switched off for this computer/)
  await p.click("#chat-tools [data-terminal-off]")
  await p.waitForSelector(".pop")
  assert.match(await p.textContent(".pop"), /The terminal is switched off for this computer\..*Switch it on in Settings, under Project folders: Let the server open a terminal here\./s)
  assert.ok(await p.isHidden("#terminal"), "nothing is opened")
  await shot(p, "t3-terminal-off")
  // Open Settings leads to the switch.
  await p.click(".pop .btn--primary")
  await p.waitForSelector("#settings:not([hidden]) #set-folders #set-terminal")
  await p.click("#settings-close")
  // Switched on meanwhile: read again within a few seconds, and the button opens a shell.
  await p.evaluate(() => window.__mock.answer("GET /devices", { devices: [{ id: "token1", name: "workbench", host: "workbench", platform: "linux", terminal: true }] }))
  await p.clock.runFor(5200)
  await p.waitForSelector("#chat-tools [data-terminal-toggle]")
  assert.equal(await p.locator("#chat-tools [data-terminal-off]").count(), 0)
  await p.click("#chat-tools [data-terminal-toggle]")
  // (Settings has been open: its own switch must not stand in the panel's way -- it once had the panel's id.)
  await runUntil(p, () => window.__mock.terminals().length === 1)
  assert.ok(await p.isVisible("#terminal.termpanel"), "the panel, not Settings' switch")
  await p.context().close()
  // Another computer, not linked right now; then linked, with the server's own reason for no terminal.
  const elsewhere = agentChat({ id: "chat9", title: "The site", device: { token_id: "token9", directory: "/srv/site" } })
  const o = await page(b3({ "GET /chats": { chats: [chatRow(), elsewhere], more: false }, "GET /chats/chat9": { chat: elsewhere, messages: [userMessage("m1", "Hello")], more: false, live: null }, "GET /models?chat=chat9": models(), "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null }, "GET /models?chat=chat1": models() }), { clock: true })
  await openChatRow(o, "chat9")
  await o.waitForSelector("#chat-tools [data-terminal-off]")
  assert.match(await o.getAttribute("#chat-tools [data-terminal-off]", "title"), /That computer is not linked to the server right now\./)
  await o.evaluate(() => window.__mock.answer("GET /devices", { devices: [{ id: "token9", name: "studio", host: "studio", platform: "linux", terminal: false, terminal_reason: "instance", terminal_hint: "The terminal is switched off on this instance." }] }))
  await o.clock.runFor(5200)
  await o.waitForFunction(() => /The terminal is switched off on this instance\./.test(document.querySelector("#chat-tools [data-terminal-off]")?.title || ""))
  await o.click("#chat-tools [data-terminal-off]")
  await o.waitForSelector(".pop")
  assert.equal(await o.locator(".pop .btn--primary").count(), 0, "not this computer's to switch")
  // A chat on the server has no Terminal at all, and nothing is polled for it.
  await openChatRow(o, "chat1")
  const asked = await o.evaluate(() => window.__mock.api("GET", "/devices").length)
  await o.clock.runFor(20000)
  assert.equal(await o.evaluate(() => window.__mock.api("GET", "/devices").length), asked)
  assert.equal(await o.locator("#chat-tools [data-terminal-off], #chat-tools [data-terminal-toggle]").count(), 0)
  assert.deepEqual(o.errors, [])
  assert.deepEqual(p.errors, [])
})

test("T3: the panel fits at 1920, 1280, 1024, 800, 390 px and the window's smallest (360 x 480): every control reachable, the screen inside its box, the shell told its size", async () => {
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844], [360, 480]]) {
    const refusal = [["control", { t: "ready", label: "workbench", dir: LONG_DIR, cols: 80, rows: 24, shared: false, osc: true }], ["output", "dev@workbench:~/project$ "]]
    const p = await page(b3({ "GET /terminals": SHELLS }, refusal), { width, height })
    await p.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
    await p.waitForSelector("#chat-tools [data-terminal-toggle]")
    await p.click("#chat-tools [data-terminal-toggle]")
    await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("dev@workbench"))
    // Every state's controls at once: the marks' arrows, End, the lost line with Reconnect now, the list.
    await p.evaluate((shells) => window.__mock.shell("control", { t: "error", message: "You already have as many terminals open as you may (3). End one first.", shells }), SHELLS.shells)
    await p.waitForSelector("#terminal-shells:not([hidden]) .termpanel__shell")
    // xterm fits itself to its box a frame after the box changes (a ResizeObserver).
    await p.waitForTimeout(250)
    const panel = await p.locator("#terminal").boundingBox()
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 0.5 && panel.y + panel.height <= height + 0.5, `${width}: the panel inside the window ${JSON.stringify(panel)}`)
    const out = await p.$$eval("#terminal button, #terminal .termpanel__message, #terminal .termpanel__shell > *", (l) => {
      const box = document.getElementById("terminal").getBoundingClientRect()
      return l.filter((b) => b.offsetParent !== null).filter((b) => { const r = b.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5 || r.width < 8 }).map((b) => b.id || b.className)
    })
    assert.deepEqual(out, [], `${width}: every control inside the panel`)
    // The open shells' rows are whole inside their list (two rows need no scrolling), End on each.
    const rowsCut = await p.evaluate(() => { const box = document.getElementById("terminal-shells").getBoundingClientRect(); return [...document.querySelectorAll("#terminal-shells .termpanel__shell .btn")].filter((b) => { const r = b.getBoundingClientRect(); return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 }).length })
    assert.equal(rowsCut, 0, `${width}: the list shows its rows whole`)
    // Inside the box's padding, to the last row and column: nothing of the shell is cut off.
    const screen = await p.evaluate(() => {
      const el = document.getElementById("terminal-screen")
      const s = el.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(el).paddingLeft)
      const x = document.querySelector("#terminal .xterm-screen").getBoundingClientRect()
      return { fits: x.left >= s.left + pad - 0.5 && x.right <= s.right - pad + 0.5 && x.bottom <= s.bottom - pad + 0.5, rows: s.height, box: [s.right - pad, s.bottom - pad, x.right, x.bottom] }
    })
    assert.ok(screen.fits, `${width}: xterm's screen inside its box ${JSON.stringify(screen.box)}`)
    assert.ok(screen.rows > 100, `${width}: the shell keeps room to read (${screen.rows}px)`)
    const sizes = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "terminal_resize").map((c) => [c.args.cols, c.args.rows]))
    assert.ok(sizes.length && sizes.every(([c, r]) => c >= 10 && r >= 4), `${width}: a size was sent (${JSON.stringify(sizes.at(-1))})`)
    assert.ok(await noSideways(p, width), `${width}: nothing sideways`)
    await shot(p, `t3-panel-${width}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- PY: the `python` tool, run in this window for the chat it shows ----------------------------------
//
// The server's protocol (`api/v2/python.py`, `services/pages.py`): announce / withdraw / take /
// answer under /chats/{chat}/page/, `python` in `GET /me`; its own fixtures (python_state.json,
// python_call.json, python_result.json) are held in the last-but-one test. The frame, its worker and the policy they are
// served under are the app's real ones (src-tauri/python/, python.rs `POLICY`); Pyodide is the
// stand-in unless $PYODIDE_DIR names a real, verified release (see the last test).

const PY_ME = { enabled: true, version: "0.0.0-test", files: [{ name: "pyodide.mjs", sha256: "0".repeat(64), size: 1 }] }
const TAKE1 = "/chats/chat1/page/take"
const pyCall = (over = {}) => ({ call_id: "call1", code: 'print hello', files: [], save: [], limits: { seconds: 30, memory: 256, output_chars: 20000 }, ...over })

function py({ me = PY_ME, python = { url: `${RUNNER}/runner.html?v=0.0.0-test`, version: "0.0.0-test" }, calls = [], routes = {} } = {}) {
  const cfg = i8()
  cfg.routes["GET /me"] = { ...cfg.routes["GET /me"], python: me }
  Object.assign(cfg.routes, {
    "GET /models?chat=chat1": models(),
    "GET /models?chat=chat2": models(),
    "GET /chats/chat2": { chat: agentChat(), messages: [userMessage("m1", "What is in build?")], more: false, live: null },
    "POST /chats/chat1/page/announce": null,
    "POST /chats/chat1/page/withdraw": null,
    "POST /chats/chat1/page/answer": null,
    ...routes,
  })
  cfg.python = python
  cfg.takes = { [TAKE1]: calls }
  cfg.takeDelay = 40
  return cfg
}

const pagePosts = (p, what) => p.evaluate((w) => window.__mock.api("POST", `/chats/chat1/page/${w}`).map((x) => x.args.body), what)
const answered = async (p, n = 1) => {
  await p.waitForFunction((k) => window.__mock.api("POST", "/chats/chat1/page/answer").length >= k, n)
  return pagePosts(p, "answer")
}

test("PY: a chat on the server shown in the window is announced as its page, a call is run in the runner's frame, and its result answered", async () => {
  const p = await page(py({ calls: [pyCall({ code: "print hello\nprint from python\n= 42" })] }))
  await openChatRow(p, "chat1")
  const [said] = await answered(p)
  const [announced] = await pagePosts(p, "announce")
  assert.match(announced.page_id, /^[0-9a-f]{24}$/, "a page id of the server's shape")
  assert.equal((await p.textContent("#chat-python .place--python")).trim(), "Python runs in this window")
  assert.deepEqual(said, { page_id: announced.page_id, call_id: "call1", result: { stdout: "hello\nfrom python", result: "42", error: "", files: [] } })
  // The poll named this page, and carries on after the call.
  const takes = await p.evaluate(() => window.__mock.api("GET", "/chats/chat1/page/take").map((x) => x.args.path))
  assert.ok(takes.length >= 2 && takes.every((x) => x === `/chats/chat1/page/take?page=${announced.page_id}`), `${takes[0]}`)
  // The runner is a frame of another origin, hidden: nothing of the app is within its reach.
  const frame = p.frames().find((f) => f.url().startsWith(RUNNER))
  assert.ok(frame, "the runner's frame")
  assert.equal(await frame.evaluate(() => { try { return typeof window.parent.__TAURI__ } catch { return "blocked" } }), "blocked", "the frame cannot read the app's page")
  // (That the frame has no bridge of its own is Tauri's doing -- the capability names only the
  // app's page -- and cannot be shown here: this harness puts its stand-in bridge in every frame.)
  // Its policy refuses every request but to its own files (asked without CORS, so that a refusal
  // is the policy's and nothing else's): the app's page answers such a request from anywhere else.
  const ask = () => fetch("http://app.test/index.html", { mode: "no-cors" }).then(() => "reached", () => "refused")
  assert.equal(await p.evaluate(ask), "reached")
  assert.equal(await frame.evaluate(ask), "refused", "no request but to its own files")
  assert.equal(await frame.evaluate(() => fetch("worker.js").then((r) => r.status, () => "refused")), 200)
  assert.ok(await p.isHidden("#python-runner"))
  assert.equal(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length), 1)
  // Leaving the chat withdraws the page; an agent chat's code runs on its computer: not announced.
  await openChatRow(p, "chat2")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/page/withdraw").length === 1)
  assert.deepEqual(await pagePosts(p, "withdraw"), [{ page_id: announced.page_id }])
  await p.waitForTimeout(200)
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/chats/chat2/page/").length), 0)
  assert.equal(await p.locator("#chat-python").count(), 0, "an agent chat's Python is its computer's: nothing is said here")
  // Back: a page of its own again, with a new id -- and a new frame: the one that ran a call was thrown away on leaving.
  await openChatRow(p, "chat1")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/page/announce").length === 2)
  const again = await pagePosts(p, "announce")
  assert.notEqual(again[1].page_id, again[0].page_id)
  assert.equal(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length), 2)
  assert.equal(await p.locator("iframe.pyrunner").count(), 1)
  assert.deepEqual(p.errors, [])
})

test("PY: a call's files go in and the ones it saves come back; an error, a long output and a call past its time are answered as the web's runner answers them", async () => {
  const b64 = (text) => Buffer.from(text).toString("base64")
  const calls = [
    pyCall({ call_id: "files", code: "read /data/in.txt\nwrite /out/result.txt baked\nwrite /out/unasked.txt x", files: [{ path: "/data/in.txt", content_b64: b64("flour and water") }], save: ["/out/result.txt", "/out/never.txt"] }),
    pyCall({ call_id: "error", code: "print before\nraise NameError: name 'lembas' is not defined" }),
    pyCall({ call_id: "long", code: `print ${"x".repeat(500)}`, limits: { seconds: 30, memory: 256, output_chars: 100 } }),
    pyCall({ call_id: "slow", code: "forever", limits: { seconds: 1, memory: 256, output_chars: 20000 } }),
    pyCall({ call_id: "after", code: "print still here" }),
  ]
  const p = await page(py({ calls }))
  await openChatRow(p, "chat1")
  const said = await answered(p, 5)
  const by = Object.fromEntries(said.map((x) => [x.call_id, x.result]))
  assert.deepEqual(by.files, { stdout: "flour and water", result: null, error: "", files: [{ path: "/out/result.txt", content_b64: b64("baked") }] }, "only what it was asked to save, and only what was written")
  assert.deepEqual(by.error, { stdout: "before", result: null, error: "NameError: name 'lembas' is not defined", files: [] })
  assert.equal(by.long.stdout.length, 100, "cut to the call's output limit")
  assert.deepEqual(by.slow, { stdout: "", result: null, error: "Stopped after 1 seconds.", files: [] }, "ended with its worker")
  assert.deepEqual(by.after, { stdout: "still here", result: null, error: "", files: [] }, "the next call has a worker of its own")
  assert.deepEqual(said.map((x) => x.call_id), ["files", "error", "long", "slow", "after"], "one at a time, in order")
  assert.deepEqual(p.errors, [])
})

test("PY: announced again every 20 s; a page the server forgot announces itself again and waits; Python off, or switched off meanwhile, announces nothing", async () => {
  const p = await page(py(), { clock: true })
  await openChatRow(p, "chat1")
  await runUntil(p, () => window.__mock.api("POST", "/chats/chat1/page/announce").length === 1)
  await p.clock.runFor(20500)
  await runUntil(p, () => window.__mock.api("POST", "/chats/chat1/page/announce").length === 2)
  // The server restarted: it answers 410 to a page it does not know.
  await p.evaluate(() => window.__mock.answer("GET /chats/chat1/page/take", { __error: { status: 410, detail: "" } }))
  await runUntil(p, () => window.__mock.api("POST", "/chats/chat1/page/announce").length === 3, 100, 60)
  const before = await p.evaluate(() => window.__mock.api("GET", "/chats/chat1/page/take").length)
  await p.clock.runFor(1500)
  const during = await p.evaluate(() => window.__mock.api("GET", "/chats/chat1/page/take").length)
  assert.ok(during - before <= 1, `it waits before asking again, not a loop as fast as the bridge (${during - before})`)
  // Switched off on the server meanwhile: 409, and the page stops asking and announcing.
  await p.evaluate(() => {
    window.__mock.answer("GET /chats/chat1/page/take", { __error: { status: 409, detail: "Python is not switched on here." } })
    window.__mock.answer("POST /chats/chat1/page/announce", { __error: { status: 409, detail: "Python is not switched on here." } })
  })
  await p.clock.runFor(5000)
  const stopped = await p.evaluate(() => [window.__mock.api("GET", "/chats/chat1/page/take").length, window.__mock.api("POST", "/chats/chat1/page/announce").length])
  await p.clock.runFor(60000)
  assert.deepEqual(await p.evaluate(() => [window.__mock.api("GET", "/chats/chat1/page/take").length, window.__mock.api("POST", "/chats/chat1/page/announce").length]), stopped)
  await p.context().close()
  // Off on the server (`/me`), and a server from before the routes (no `python` at all).
  for (const me of [{ enabled: false, version: "", files: [] }, null]) {
    const o = await page(py({ me }))
    await openChatRow(o, "chat1")
    await o.waitForTimeout(300)
    assert.equal(await o.evaluate(() => window.__mock.api("POST", "/chats/chat1/page/").length + window.__mock.api("GET", "/chats/chat1/page/").length), 0)
    assert.equal(await o.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length), 0, "nothing is fetched")
    assert.equal(await o.locator("#python-runner").count(), 0)
    assert.deepEqual(o.errors, [])
    await o.context().close()
  }
  assert.deepEqual(p.errors, [])
})

test("PY: a poll answered with nothing at once is not asked again at once: the pause grows, and a call still gets through", async () => {
  // A bridge that does not hold the poll (`takeHold: 0`): without a pause this is a loop as fast as it answers.
  const cfg = py()
  cfg.takeHold = 0
  const p = await page(cfg, { clock: true })
  await openChatRow(p, "chat1")
  const takes = () => p.evaluate(() => window.__mock.api("GET", "/chats/chat1/page/take").length)
  await runUntil(p, () => window.__mock.api("GET", "/chats/chat1/page/take").length >= 1)
  const first = await takes()
  await p.clock.runFor(16000)
  const asked = (await takes()) - first
  assert.ok(asked >= 2 && asked <= 5, `1 s, 2 s, 4 s, 8 s apart, not hundreds (${asked})`)
  await p.evaluate(() => window.__mock.call("/chats/chat1/page/take", { call_id: "call7", code: "print late", files: [], save: [], limits: { seconds: 30, memory: 256, output_chars: 20000 } }))
  await runUntil(p, () => window.__mock.api("POST", "/chats/chat1/page/answer").length === 1, 500, 80)
  assert.equal((await pagePosts(p, "answer"))[0].call_id, "call7")
  assert.deepEqual(p.errors, [])
})

test("PY: where the chat's Python runs is said beside the title at 1280, 800 and 390 px without pushing anything out of the header", async () => {
  for (const [width, height] of [[1280, 860], [800, 700], [390, 844]]) {
    const p = await page(py(), { width, height })
    await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
    await p.waitForSelector("#chat-python .place--python")
    const [pill, head] = await p.evaluate(() => ["#chat-python .place--python", "#chat-head"].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }))
    assert.ok(pill.left >= head.left && pill.right <= head.right + 0.5 && pill.width >= 24, `${width}: inside the header ${JSON.stringify(pill)}`)
    assert.ok(await noSideways(p, width), `${width}: nothing sideways`)
    assert.deepEqual(await reachable(p, width), [], `${width}: every control of the header reachable`)
    await shot(p, `py-header-${width}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("PY: the window is announced as the chat's page only once its runner is there: not while the files are fetched, not when they could not be -- tried again later, and nothing alarming shown", async () => {
  // The files could not be fetched or did not verify (Rust's words): nothing is announced, so
  // the server asks another page of the chat meanwhile; nothing is taken either.
  const cfg = py({ python: { __error: { status: 0, detail: "pyodide.asm.wasm is not the file the server's list names: it was not kept." } }, calls: [pyCall()] })
  const p = await page(cfg, { clock: true })
  await openChatRow(p, "chat1")
  await runUntil(p, () => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length === 1)
  await p.clock.runFor(1500)
  assert.deepEqual(await pagePosts(p, "announce"), [])
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/chats/chat1/page/take").length), 0)
  assert.equal(await p.locator("#python-runner").count(), 0, "no frame without verified files")
  assert.equal(await p.locator(".is-error:visible, .notice:visible").count(), 0, "nothing alarming")
  // Said quietly beside the title; a press says why (Rust's words) and offers to try at once.
  assert.equal((await p.textContent("#chat-python button.place--python.is-warn")).trim(), "Python cannot run in this window")
  await p.click("#chat-python button.place--python")
  await p.waitForSelector(".pop")
  assert.match(await p.textContent(".pop"), /pyodide\.asm\.wasm is not the file the server's list names/)
  const before = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length)
  await p.click(".pop .btn--primary")
  await runUntil(p, () => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length >= 2, 20, 20)
  assert.equal(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length), before + 1, "Try again tries at once, not when the wait is over")
  assert.equal(await p.locator(".pop").count(), 0)
  // Tried again after a pause that grows (2 s, 4 s): still failing, still silent.
  await p.clock.runFor(7000)
  const tried = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length)
  assert.ok(tried >= 3 && tried <= 5, `tried again, not in a loop (${tried})`)
  assert.deepEqual(await pagePosts(p, "announce"), [])
  // Put right, but slow (the first download): announced only when the runner says it is there.
  await p.evaluate((url) => Object.assign(window.__mockConfig, { python: { url, version: "0.0.0-test" }, pythonDelay: 3000 }), `${RUNNER}/runner.html?v=0.0.0-test`)
  await runUntil(p, () => window.__mock.calls.filter((c) => c.cmd === "python_prepare").length > 0 && !!document.getElementById("python-runner"), 500, 40)
  await runUntil(p, () => window.__mock.api("POST", "/chats/chat1/page/announce").length === 1, 200, 60)
  assert.equal((await p.textContent("#chat-python .place--python")).trim(), "Python runs in this window")
  assert.equal(await p.locator("#chat-python button").count(), 0, "said, not a control")
  // The call that waited is run.
  await runUntil(p, () => window.__mock.api("POST", "/chats/chat1/page/answer").length === 1, 200, 60)
  assert.equal((await pagePosts(p, "answer"))[0].result.stdout, "hello")
  assert.deepEqual(p.errors, [])
})

test("PY: one chat's Python never meets another's: the frame that ran a call is thrown away when the window becomes another chat's page, and an answer is held to the call's limits", async () => {
  const other = chatRow({ id: "chat3", title: "Another chat" })
  const cfg = py({
    calls: [pyCall({ call_id: "a1", files: [{ path: "/data/secret.txt", content_b64: Buffer.from("alpha").toString("base64") }], code: "read /data/secret.txt\nwrite /data/left.txt behind\nwrite /out.txt " + "x".repeat(50) + "\n= " + "v".repeat(50), save: ["/out.txt"], limits: { seconds: 30, memory: 256, output_chars: 20 } })],
    routes: {
      "GET /chats": { chats: [chatRow(), other], more: false },
      "GET /chats/chat3": { chat: other, messages: [userMessage("m1", "Hello")], more: false, live: null },
      "GET /models?chat=chat3": models(),
      "POST /chats/chat3/page/announce": null,
      "POST /chats/chat3/page/withdraw": null,
      "POST /chats/chat3/page/answer": null,
    },
  })
  cfg.takes["/chats/chat3/page/take"] = [pyCall({ call_id: "b1", code: "read /data/secret.txt\nread /data/left.txt\nprint end" })]
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  const [first] = await answered(p)
  // Chat 1's call read its own file; what it printed and its value are cut to its limit; only the file it asked to save comes back.
  assert.equal(first.result.stdout, "alpha")
  assert.equal(first.result.result, "v".repeat(20))
  assert.deepEqual(first.result.files.map((f) => f.path), ["/out.txt"])
  const frameOf = () => p.evaluate(() => document.getElementById("python-runner")?.src || "")
  assert.ok(await frameOf())
  await p.evaluate(() => (document.getElementById("python-runner").dataset.was = "chat1"))
  // The window becomes chat 3's page: a new frame, a new worker -- nothing of chat 1's is there.
  await openChatRow(p, "chat3")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat3/page/answer").length === 1)
  const second = (await p.evaluate(() => window.__mock.api("POST", "/chats/chat3/page/answer")))[0].args.body
  assert.equal(second.call_id, "b1")
  assert.ok(!/alpha|behind/.test(second.result.stdout), `chat 1's file and what it wrote are not chat 3's to read: ${JSON.stringify(second.result.stdout)}`)
  assert.match(second.result.stdout, /end$/)
  assert.equal(await p.evaluate(() => document.getElementById("python-runner")?.dataset.was || ""), "", "a frame of its own")
  assert.equal(await p.locator("iframe.pyrunner").count(), 1, "the one before is gone")
  assert.deepEqual(p.errors, [])
})

test("PY: the server's own fixtures: the call it hands a page is run, and what is answered has the shape of its result", async () => {
  const call = fixture("python_call")
  const expected = fixture("python_result")
  // The stand-in does not speak Python: the fixture's call is taken as it is -- its id, files,
  // save and limits -- with lines the stand-in runs in place of its code.
  const p = await page(py({ me: { ...fixture("python_state"), version: "0.0.0-test" }, calls: [{ ...call, code: `read ${call.files[0].path}\nwrite ${call.save[0]} ok` }] }))
  await openChatRow(p, "chat1")
  const [said] = await answered(p)
  assert.equal(said.call_id, call.call_id)
  assert.deepEqual(Object.keys(said.result).sort(), Object.keys(expected).sort(), "stdout, result, error, files")
  assert.deepEqual(said.result.files, expected.files, "the file it was asked to save, as the server's fixture has it")
  assert.equal(said.result.stdout.trimEnd(), Buffer.from(call.files[0].content_b64, "base64").toString().trimEnd(), "the file it was handed, read")
  assert.deepEqual([said.result.result, said.result.error], [expected.result, expected.error])
  assert.deepEqual(p.errors, [])
})

test("PY: with a real Pyodide release ($PYODIDE_DIR) Python itself runs in the frame under the app's policy -- its output, its value, files, an error, the time limit, and no network", async () => {
  if (!process.env.PYODIDE_DIR) {
    console.log("     (skipped: set PYODIDE_DIR to a directory holding the server's pinned Pyodide files)")
    return
  }
  const b64 = (text) => Buffer.from(text).toString("base64")
  const calls = [
    pyCall({ call_id: "sum", code: "import sys\nprint('hello from', sys.version_info.major)\nsum(range(10))" }),
    pyCall({ call_id: "files", code: "text = open('/data/in.txt').read()\nimport os\nos.makedirs('/out', exist_ok=True)\nopen('/out/result.txt', 'w').write(text.upper())\nlen(text)", files: [{ path: "/data/in.txt", content_b64: b64("flour and water") }], save: ["/out/result.txt"] }),
    pyCall({ call_id: "error", code: "print('before')\nlembas" }),
    // Asked without CORS, of a page that answers anyone: only the frame's policy can refuse it.
    pyCall({ call_id: "net", code: "import js\nfrom pyodide.ffi import to_js\nasync def ask(url):\n    try:\n        await js.fetch(url, to_js({'mode': 'no-cors'}, dict_converter=js.Object.fromEntries))\n        return 'reached'\n    except Exception:\n        return 'refused'\nprint(await ask('http://app.test/index.html'), await ask('worker.js'))" }),
    pyCall({ call_id: "slow", code: "while True:\n    pass", limits: { seconds: 2, memory: 256, output_chars: 20000 } }),
    pyCall({ call_id: "after", code: "import json\njson.dumps({'still': 'here'})" }),
  ]
  const p = await page(py({ python: { url: `${RUNNER}/runner.html?v=real`, version: "real" }, calls }))
  await openChatRow(p, "chat1")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats/chat1/page/answer").length >= 6, null, { timeout: 120000 })
  const by = Object.fromEntries((await pagePosts(p, "answer")).map((x) => [x.call_id, x.result]))
  assert.deepEqual(by.sum, { stdout: "hello from 3", result: "45", error: "", files: [] })
  assert.deepEqual(by.files, { stdout: "", result: "15", error: "", files: [{ path: "/out/result.txt", content_b64: b64("FLOUR AND WATER") }] })
  assert.equal(by.error.stdout, "before")
  assert.match(by.error.error, /NameError: name 'lembas' is not defined/)
  assert.equal(by.net.stdout, "refused reached", "the code reaches the runner's own files and nothing else")
  assert.deepEqual(by.slow, { stdout: "", result: null, error: "Stopped after 2 seconds.", files: [] })
  assert.equal(by.after.result, '{"still": "here"}')
  // (Pyodide itself loaded and ran under that policy: it needs nothing the policy refuses.)
  assert.deepEqual(p.errors, [])
})

// --- V4: the visual pass -- what was found wrong, held where it was put right -----------------------

test("V4: the title bar keeps every item on its own track at every width, down to the window's smallest (360 px)", async () => {
  for (const width of [1920, 1280, 1024, 800, 768, 600, 480, 390, 360]) {
    const p = await page(b3(), { width, height: 600 })
    const bar = await p.evaluate(() => {
      const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }
      return { min: box("minimize"), max: box("maximize"), close: box("close"), menu: box("menu"), agent: box("agent"), side: box("side-toggle"), bar: document.querySelector(".bar").getBoundingClientRect().right, scroll: document.documentElement.scrollWidth }
    })
    assert.ok(bar.scroll <= width, `${width}: the window does not scroll sideways (${bar.scroll})`)
    assert.ok(Math.abs(bar.close.right - width) < 1, `${width}: Close at the window's edge (${bar.close.right})`)
    // The three window buttons: one size, side by side, in their order.
    assert.ok(Math.abs(bar.min.width - bar.max.width) < 0.5 && Math.abs(bar.max.width - bar.close.width) < 0.5 && bar.min.width >= 32, `${width}: one size (${bar.min.width}, ${bar.max.width}, ${bar.close.width})`)
    assert.ok(Math.abs(bar.min.right - bar.max.left) < 0.5 && Math.abs(bar.max.right - bar.close.left) < 0.5, `${width}: side by side`)
    assert.ok(bar.menu.right <= bar.min.left + 0.5 && bar.agent.right <= bar.menu.left + 0.5 && bar.menu.width >= 32, `${width}: the agent, the menu, then the window's buttons`)
    assert.ok(bar.side.left >= 0 && bar.side.width >= 32)
    await shot(p, `v4-bar-${width}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("V4: at 390 px a scheduled task's name is whole in its header, its buttons under it; the composer's own chip is not cut where there is room", async () => {
  const p = await page(gallery("moria"), { width: 390, height: 844 })
  await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" }))
  await p.waitForSelector("#scheduled-body .fact")
  const title = await p.$eval("#scheduled-title", (x) => [x.textContent, x.scrollWidth <= x.clientWidth + 1])
  assert.ok(/Nightly tests/.test(title[0]) && title[1], `the title is whole: ${title}`)
  assert.deepEqual(await controlsOut(p, 390), [])
  await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
  await p.waitForSelector("#composer-chips .cchip--picture")
  assert.ok(await p.$eval("#composer-chips .cchip--picture .cchip__label", (x) => x.scrollWidth <= x.clientWidth + 1), "Draw a picture, whole")
  // Send is at the card's edge with Dictate beside it: a hidden Stop leaves no gap behind.
  const [send, card] = await p.evaluate(() => ["send", "composer"].map((id) => document.getElementById(id).getBoundingClientRect().right))
  const pad = await p.$eval("#composer", (x) => parseFloat(getComputedStyle(x).paddingRight) + parseFloat(getComputedStyle(x).borderRightWidth))
  assert.ok(Math.abs(card - pad - send) < 1, `Send at the card's inner edge (${card - pad - send})`)
  assert.deepEqual(p.errors, [])
})

test("V4: a scheduled task's status in the list and a run's note use the room their row has: neither is cut where it fits, and the rows share their lines", async () => {
  for (const [width, height] of [[1920, 1080], [1280, 860], [1024, 768], [800, 700]]) {
    const p = await page(gallery("moria"), { width, height })
    await p.evaluate(() => document.getElementById("nav-scheduled").click())
    await p.waitForSelector("#scheduled-body .task .schip")
    const chips = await p.$$eval("#scheduled-body .task .schip", (l) => l.map((x) => ({ said: x.textContent, whole: x.scrollWidth <= x.clientWidth, in: x.getBoundingClientRect().right <= x.closest(".task").getBoundingClientRect().right })))
    assert.ok(chips.length && chips.every((c) => c.whole && c.in), `${width}: ${JSON.stringify(chips)}`)
    // The row's parts beside each other, none over another.
    const parts = await p.$$eval("#scheduled-body .task__open > *", (l) => l.filter((x) => x.offsetParent !== null).map((x) => { const r = x.getBoundingClientRect(); return [r.left, r.right] }))
    assert.ok(parts.every(([left], i) => i === 0 || left >= parts[i - 1][1] + 8), `${width}: ${JSON.stringify(parts)}`)
    assert.deepEqual(await controlsOut(p, width), [], `${width}: the list's controls`)
    await shot(p, `v4-scheduled-row-${width}`)
    await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" }))
    await p.waitForSelector("#scheduled-body .run")
    const notes = await p.$$eval("#scheduled-body .run__error", (l) => l.map((x) => ({ said: x.textContent, whole: x.scrollWidth <= x.clientWidth && x.scrollHeight <= x.clientHeight + 1, lines: Math.round(x.getBoundingClientRect().height / parseFloat(getComputedStyle(x).lineHeight)), in: x.getBoundingClientRect().right <= x.closest(".runs").getBoundingClientRect().right + 0.5 })))
    await shot(p, `v4-scheduled-runs-${width}`)
    // On one line or two, whole (this note is a long one); never past the list, never more than two lines.
    assert.ok(notes.length && notes.every((c) => c.in && c.lines <= 2 && (c.whole || width < 1024)), `${width}: ${JSON.stringify(notes)}`)
    assert.ok(await noSideways(p, width))
    await shot(p, `v4-scheduled-runs-${width}`)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- R1: Reports, and a page a model wrote ---------------------------------------------------------
//
// The server's own fixtures: reports.json, report.json, report_reply.json, event_reports.json
// (the `reports` frame the app hands on), page.json (the rebuilt static document, served to the
// sealed frame by this harness as Rust serves it), step_text_page.json, chat_html_pages.json.

const REPORT = fixture("report").report
// The conversation a report continues, as the server serialises it (chat_report.json: `controls`
// rename and delete, and `report`, the one it continues).
const reportChat = () => ({ ...fixture("chat_report"), id: fixture("report_reply").chat })
function r1(over = {}) {
  const chat = reportChat()
  return {
    status: status(),
    routes: baseRoutes({
      "GET /reports": fixture("reports"),
      [`GET /reports/${REPORT.id}`]: fixture("report"),
      [`POST /reports/${REPORT.id}/read`]: null,
      [`POST /reports/${REPORT.id}/reply`]: fixture("report_reply"),
      [`DELETE /reports/${REPORT.id}`]: null,
      [`GET /schedules/${REPORT.schedule.id}`]: fixture("schedule"),
      [`GET /schedules/${REPORT.schedule.id}/runs`]: { runs: [], more: false },
      "GET /schedules/models": { models: [], instance: [], mine: [] },
      [`DELETE /chats/${chat.id}`]: null,
      [`PATCH /chats/${chat.id}`]: { chat: { ...chat, title: "Cakes, again" } },
      [`GET /chats/${chat.id}`]: { chat, messages: [{ ...userMessage("m1", "Here is the report this conversation continues."), machine: true }, { ...reply({ id: "m2", steps: [{ index: 0, kind: "text", open: true, markdown: "Two of the twelve cakes have lost their leaves." }] }) }], more: false, live: null },
      [`GET /models?chat=${chat.id}`]: models(),
      [`POST /chats/${chat.id}/messages`]: { message: userMessage("m3", "Which two?"), reply: null },
      ...over,
    }),
    streams: {},
  }
}
const pageOpens = (p) => p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "page_open").map((c) => c.args))
/** The sealed frame inside a page's box: its attributes, and what its document shows. */
async function sealedFrame(p, scope = "") {
  const el = await p.waitForSelector(`${scope} .hpage__frame`)
  const frame = await el.contentFrame()
  await frame.waitForLoadState()
  // What is drawn (a script's own text is not): had the added script run, "a script ran" would be drawn and the title changed.
  return { sandbox: await el.getAttribute("sandbox"), src: await el.getAttribute("src"), text: await frame.locator("body").innerText(), title: await frame.title() }
}

test("R1: Reports in the sidebar with its unread count; a report is read as a page, with the page a model wrote in a sealed frame that runs nothing; read, it is marked so", async () => {
  const p = await page(r1())
  await p.waitForSelector("#nav-reports:not([hidden]) #reports-count:not([hidden])")
  assert.equal(await p.textContent("#reports-count"), "1")
  await p.click("#nav-reports")
  await p.waitForSelector("#reports-body .rrow")
  assert.equal(await p.getAttribute("#nav-reports", "aria-current"), "true")
  const row = await p.$eval("#reports-body .rrow", (x) => ({ unread: x.classList.contains("is-unread"), title: x.querySelector(".rrow__title").textContent, summary: x.querySelector(".rrow__summary").textContent, from: x.querySelector(".rrow__from").textContent, important: !!x.querySelector(".schip") }))
  assert.deepEqual(row, { unread: true, title: REPORT.title, summary: REPORT.summary, from: REPORT.schedule.title, important: true })
  await shot(p, "r1-reports-1280")
  await p.click("#reports-body .rrow__open")
  await p.waitForSelector("#reports-body .report .hpage")
  assert.match(await p.textContent("#reports-title"), new RegExp(`Reports.*${REPORT.title}`))
  assert.equal(await p.textContent("#reports-body .report__body h2"), "What")
  // The page: asked of the server by Rust (the report, the digest, the theme's colours), its
  // source never drawn here; a frame with an empty sandbox, and the script in it did not run.
  assert.ok(!(await p.textContent("#reports-body .report__body")).includes("<p>"), "the fence's source is not shown as the answer")
  const frame = await sealedFrame(p, "#reports-body")
  assert.equal(frame.sandbox, "", "sandbox, allowing nothing")
  assert.equal(frame.src, `${SEALED}/r/${REPORT.id}/${REPORT.pages[0].digest}`)
  assert.match(frame.text, /10 wrapped, 2 not/)
  assert.ok(!/a script ran/.test(frame.text) && frame.title !== "a script ran", "nothing in the page runs")
  const [asked] = await pageOpens(p)
  assert.deepEqual([asked.kind, asked.owner, asked.digest], ["r", REPORT.id, REPORT.pages[0].digest])
  assert.ok(Object.keys(asked.colours).length >= 3 && Object.values(asked.colours).every((c) => /^#[0-9a-f]{6}$/i.test(c)), `the theme's colours, plainly colours: ${JSON.stringify(asked.colours)}`)
  assert.equal(await p.textContent("#reports-body .hpage__title"), REPORT.pages[0].title)
  // Read here: said to the server. The count is the server's to say: it stays until its frame
  // comes (not counted down here, which would race it), then goes.
  await p.waitForFunction((id) => window.__mock.api("POST", `/reports/${id}/read`).length === 1, REPORT.id)
  assert.equal(await p.textContent("#reports-count"), "1")
  await p.evaluate(() => window.__mock.emit("reports", { unread: 0, newest: null }))
  await p.waitForSelector("#reports-count", { state: "hidden" })
  assert.deepEqual(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "set_open_report").map((c) => c.args.report).slice(-1)), [REPORT.id], "Rust knows which report is being read")
  await shot(p, "r1-report-1280")
  // Open larger: the same document in a dialog; Escape closes it.
  await p.click("#reports-body .hpage__larger")
  await p.waitForSelector("dialog.hpage-dialog[open] .hpage__frame")
  assert.equal(await p.getAttribute("dialog.hpage-dialog .hpage__frame", "sandbox"), "")
  const big = await p.$eval("dialog.hpage-dialog .hpage__frame", (x) => { const f = x.getBoundingClientRect(); return [f.height > innerHeight * 0.7, f.width > innerWidth * 0.5, f.bottom <= innerHeight, f.right <= innerWidth] })
  assert.deepEqual(big, [true, true, true, true], "larger, and inside the window")
  await shot(p, "r1-larger-1280")
  await p.keyboard.press("Escape")
  await p.waitForSelector("dialog.hpage-dialog", { state: "detached" })
  // The schedule it came from is a press away.
  await p.click("#report-schedule")
  await p.waitForSelector("#page-scheduled:not([hidden])")
  assert.deepEqual(p.errors, [])
})

test("R1: Reply opens the report's conversation as a chat that is in no list: its header says the report with the way back, the sidebar stays on Reports, and the server's opening line is not shown as the person's", async () => {
  const p = await page(r1())
  await p.waitForSelector("#nav-reports:not([hidden])")
  await p.evaluate((id) => window.__mock.emit("open-report", id), REPORT.id)
  await p.waitForSelector("#report-reply")
  await p.click("#report-reply")
  const chat = fixture("report_reply").chat
  await p.waitForSelector("#messages .msg--assistant")
  assert.equal(await p.textContent("#chat-title"), `Report: ${REPORT.title}`)
  assert.equal(await p.getAttribute("#nav-reports", "aria-current"), "true", "the sidebar is still on Reports")
  assert.equal(await p.locator(`.chatrow[data-id="${chat}"]`).count(), 0, "in no list of chats")
  assert.equal(await p.locator("#messages .msg--user").count(), 0, "the line the server wrote in the person's place is not shown")
  assert.match(await p.textContent("#messages .msg--assistant"), /Two of the twelve cakes/)
  // Written into like any chat.
  await p.fill("#composer-text", "Which two?")
  await p.keyboard.press("Enter")
  await p.waitForFunction((c) => window.__mock.api("POST", `/chats/${c}/messages`).length === 1, chat)
  assert.equal(await p.getAttribute("#nav-reports", "aria-current"), "true")
  await shot(p, "r1-reply-1280")
  // Its menu has what makes sense for it: no pinning, moving or archiving of a chat that is in no list.
  await p.click('#chat-tools [aria-label="More"]')
  await p.waitForSelector(".menu .menu__item")
  assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => x.textContent.trim())), ["Rename…", "Open in the web interface", "Delete chat"])
  await p.locator(".menu .menu__item", { hasText: "Open in the web interface" }).click()
  assert.deepEqual(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "open_external").map((c) => c.args.url)), [`https://ai.example/reports/${REPORT.id}`], "the report's page, on the web")
  // Renamed, the chat keeps the report in its header.
  await p.click('#chat-tools [aria-label="More"]')
  await p.locator(".menu .menu__item", { hasText: "Rename…" }).click()
  await p.fill("dialog[open] input", "Cakes, again")
  await p.keyboard.press("Enter")
  await p.waitForFunction((c) => window.__mock.api("PATCH", `/chats/${c}`).length === 1, chat)
  assert.equal(await p.textContent("#chat-title"), `Report: ${REPORT.title}`)
  // Back to Reports: the report it continues.
  await p.click("#chat-report-back")
  await p.waitForSelector("#reports-body .report")
  assert.match(await p.textContent("#reports-title"), new RegExp(REPORT.title))
  // Delete asks first; then the list.
  await p.click("#report-delete")
  await p.waitForSelector("dialog[open] .btn--danger")
  assert.match(await p.textContent("dialog[open]"), /The conversation that continued it goes with it/)
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction((id) => window.__mock.api("DELETE", `/reports/${id}`).length === 1, REPORT.id)
  await p.waitForSelector("#reports-body .rlist, #reports-body .arch__empty")
  assert.deepEqual(p.errors, [])
})

test("R1: a report's conversation: only its very first line is the server's and hidden -- also among earlier messages -- its header is the server's word for the report, and deleting it leads back to the report", async () => {
  const chat = reportChat()
  assert.deepEqual([chat.controls, chat.report], [["rename", "delete"], { id: REPORT.id, title: REPORT.title }])
  const seed = { ...userMessage("m1", "Here is the report this conversation continues."), machine: true }
  const woke = { ...userMessage("m4", "A background job finished: the oven is hot."), machine: true }
  const said = (id, text) => reply({ id, steps: [{ index: 0, kind: "text", open: true, markdown: text }] })
  const p = await page(r1({
    // The newest page, and the one before it that reaches the start.
    [`GET /chats/${chat.id}`]: { chat, messages: [userMessage("m3", "Which two?"), woke, said("m5", "The third and the ninth.")], more: true, live: null },
    [`GET /chats/${chat.id}/messages?before=m3`]: { messages: [seed, said("m2", "Two of the twelve cakes have lost their leaves.")], more: false },
  }))
  await p.waitForSelector("#nav-reports:not([hidden])")
  // Opened by its id alone (after a restart, nothing remembered here): the header is still the report's.
  await p.evaluate((c) => window.__mock.emit("open-chat", c), chat.id)
  await p.waitForSelector("#messages .msg--assistant")
  assert.equal(await p.textContent("#chat-title"), `Report: ${REPORT.title}`, "from the chat's own `report`")
  // A machine line later in the conversation is shown as the machine's; only the seed is hidden.
  assert.deepEqual(await p.$$eval("#messages .msg--user", (l) => l.map((x) => [x.dataset.id, x.classList.contains("is-machine")])), [["m3", false], ["m4", true]])
  await p.click("#messages .thread__earlier")
  await p.waitForSelector('.msg[data-id="m2"]')
  assert.deepEqual(await p.$$eval("#messages .msg", (l) => l.map((x) => x.dataset.id)), ["m2", "m3", "m4", "m5"], "the seed is not among the earlier messages either")
  // Deleted (asked first): back to the report it continued.
  await p.click('#chat-tools [aria-label="More"]')
  await p.locator(".menu .menu__item", { hasText: "Delete chat" }).click()
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction((c) => window.__mock.api("DELETE", `/chats/${c}`).length === 1, chat.id)
  await p.waitForSelector("#reports-body .report")
  assert.match(await p.textContent("#reports-title"), new RegExp(REPORT.title))
  // A report whose task is gone (report_orphan.json: `schedule: null`, its name kept in
  // `schedule_title`): the name as text, no link; one deleted since is found out when asked
  // for, and said in the link's place.
  const orphan = fixture("report_orphan")
  await p.evaluate((r) => window.__mock.answer(`GET /reports/${r.report.id}`, r), orphan)
  await p.evaluate((id) => window.__mock.emit("open-report", id), REPORT.id)
  await p.waitForSelector("#report-schedule-gone")
  assert.equal(await p.textContent("#report-schedule-gone"), orphan.report.schedule_title)
  assert.equal(await p.locator("#report-schedule").count(), 0)
  await p.evaluate(() => document.getElementById("reports-back").click())
  await p.waitForSelector("#reports-body .rrow")
  await p.evaluate((r) => { window.__mock.answer(`GET /reports/${r.id}`, { report: r }); window.__mock.answer(`GET /schedules/${r.schedule.id}`, { __error: { status: 404, detail: "Not found" } }) }, REPORT)
  await p.click("#reports-body .rrow__open")
  await p.waitForSelector("#report-schedule")
  await p.click("#report-schedule")
  await p.waitForSelector("#report-schedule-gone")
  assert.ok(await p.isVisible("#reports-body .report"), "still on the report, not on a page that is not there")
  assert.equal(await p.locator("#report-schedule").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("R1: the server's reports frame moves the count and the open list; a server without reports has no Reports row; at 390 px the list and a report stay inside the window", async () => {
  let p = await page(r1({ "GET /reports": { reports: [], unread: 0 } }))
  await p.waitForSelector("#nav-reports:not([hidden])")
  assert.ok(await p.isHidden("#reports-count"))
  await p.click("#nav-reports")
  await p.waitForSelector("#reports-body .arch__empty")
  assert.match(await p.textContent("#reports-body"), /No reports yet\. A scheduled task files one when it has something to tell you\./)
  // A report is filed: the frame (event_reports.json), as the app hands it on.
  await p.evaluate((f) => { window.__mock.answer("GET /reports", f.list); window.__mock.emit("reports", f.frame) }, { list: fixture("reports"), frame: fixture("event_reports") })
  await p.waitForSelector("#reports-count:not([hidden])")
  assert.equal(await p.textContent("#reports-count"), String(fixture("event_reports").unread))
  await p.waitForSelector("#reports-body .rrow.is-unread")
  assert.deepEqual(p.errors, [])
  await p.context().close()
  // An older server: it is asked once signed in, answers 404, and there is no row; a server that
  // refuses (401) or fails is not one that has reports either.
  for (const refusal of [null, { __error: { status: 401, detail: "Not signed in." } }, { __error: { status: 500, detail: "Internal error" } }]) {
    p = await page({ status: status(), routes: baseRoutes(refusal ? { "GET /reports": refusal } : {}), streams: {} })
    await p.waitForFunction(() => window.__mock.api("GET", "/reports?unread=1").length === 1)
    await p.waitForTimeout(100)
    assert.ok(await p.isHidden("#nav-reports"), `no Reports row (${refusal?.__error.status || 404})`)
    assert.ok(!(await p.evaluate(() => window.__mock.calls.findIndex((c) => c.cmd === "api" && c.args.path === "/me") > window.__mock.calls.findIndex((c) => c.cmd === "api" && c.args.path === "/reports?unread=1"))), "asked once signed in, after /me")
    await p.context().close()
  }
  // Signed out and in as another account: nothing of the first one's reports is left.
  p = await page(r1())
  await p.waitForSelector("#nav-reports:not([hidden]) #reports-count:not([hidden])")
  await p.click("#nav-reports")
  await p.waitForSelector("#reports-body .rrow")
  await p.evaluate((st) => { window.__mockConfig.status = st; window.__mock.answer("GET /reports", { __error: { status: 404, detail: "Not found" } }); window.__mock.emit("status", st) }, status({ account: null, linked: false }))
  await p.waitForSelector("#setup:not([hidden])")
  assert.equal(await p.locator("#reports-body .rrow").count(), 0, "the list is gone with the account")
  assert.ok(await p.isHidden("#nav-reports"))
  await p.evaluate((st) => { window.__mockConfig.status = st; window.__mock.emit("status", st) }, status())
  await p.waitForSelector("#shell:not([hidden])")
  await p.waitForFunction(() => window.__mock.api("GET", "/reports?unread=1").length >= 2)
  await p.waitForTimeout(100)
  assert.ok(await p.isHidden("#nav-reports"), "the next account's server has none")
  assert.equal(await p.locator("#reports-body .rrow").count(), 0)
  await p.context().close()
  // Narrow.
  p = await page(r1(), { width: 390, height: 844 })
  await p.evaluate((id) => window.__mock.emit("open-report", id), REPORT.id)
  await p.waitForSelector("#reports-body .report .hpage__frame")
  assert.ok(await noSideways(p, 390))
  assert.deepEqual(await controlsOut(p, 390), [])
  assert.ok(await p.$eval("#reports-body .report__title", (x) => x.textContent.length > 10 && x.scrollWidth <= x.clientWidth + 1), "the report's title is whole on the page")
  const box = await p.$eval("#reports-body .hpage", (x) => { const r = x.getBoundingClientRect(); return [r.left >= 0, r.right <= innerWidth, Math.round(r.height)] })
  assert.ok(box[0] && box[1], "the page's box inside the window")
  await shot(p, "r1-report-390")
  await p.evaluate(() => document.getElementById("reports-back").click())
  await p.waitForSelector("#reports-body .rrow")
  assert.ok(await noSideways(p, 390))
  assert.deepEqual(await controlsOut(p, 390), [])
  await shot(p, "r1-reports-390")
  assert.deepEqual(p.errors, [])
})

test("H1: a page a model wrote into a reply is a sealed frame in its place once the reply is finished, only its title while it is written; without the server's word a fence is the code block it is", async () => {
  const step = fixture("step_text_page")
  const message = reply({ id: "m2", steps: [step] })
  const p = await page(agentChatOpen([["steps", { steps: [step], tail: { thinking: "", text: "And then:\n\n```html-view Still coming\n<p>half", label: "" } }]], {
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How many?"), { ...message, id: "m6" }, reply({ id: "m7", steps: [{ index: 0, kind: "text", open: true, markdown: step.markdown }] })], more: false, live: null },
    "GET /models?chat=chat1": models(),
  }))
  // Finished (chat1): the frame; the same Markdown without `pages` (the feature is off) is a code block.
  await openChatRow(p, "chat1")
  await p.waitForSelector('.msg[data-id="m6"] .hpage')
  const frame = await sealedFrame(p, '.msg[data-id="m6"]')
  assert.equal(frame.sandbox, "")
  assert.equal(frame.src, `${SEALED}/m/m6/${step.pages[0].digest}`)
  assert.match(frame.text, /10 wrapped, 2 not/)
  assert.ok(!/a script ran/.test(frame.text), "nothing in the page runs")
  assert.equal(await p.textContent('.msg[data-id="m6"] .hpage__title'), step.pages[0].title)
  assert.match(await p.textContent('.msg[data-id="m6"] .step--text'), /Two are unwrapped\./, "the answer's own words stay")
  assert.equal(await p.locator('.msg[data-id="m7"] .hpage').count(), 0)
  assert.match(await p.textContent('.msg[data-id="m7"] .md-code pre'), /<p>10 wrapped, 2 not<\/p>/, "as text, in a code block")
  // One known height, the page scrolling inside it.
  const [h, vh, rem] = await p.evaluate(() => [document.querySelector('.msg[data-id="m6"] .hpage__body').getBoundingClientRect().height, innerHeight, parseFloat(getComputedStyle(document.documentElement).fontSize)])
  assert.ok(Math.abs(h - Math.min(28 * rem, 0.7 * vh)) < 1.5, `min(28rem, 70vh): ${h}`)
  const fills = await p.$eval('.msg[data-id="m6"] .hpage__frame', (x) => { const f = x.getBoundingClientRect(); const b = x.parentElement.getBoundingClientRect(); return [Math.abs(f.top - b.top) < 1, Math.abs(f.height - b.height) < 1.5, Math.abs(f.width - b.width) < 1] })
  assert.deepEqual(fills, [true, true, true], "the frame is the whole of its box")
  await shot(p, "h1-page-1280")
  // Being written (chat2): the closed page and the one still open are both only their titles.
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live .hpage.is-writing")
  assert.deepEqual(await p.$$eval(".msg.is-live .hpage.is-writing .hpage__title", (l) => l.map((x) => x.textContent)), [step.pages[0].title, "Still coming"])
  assert.equal(await p.locator(".msg.is-live iframe").count(), 0)
  assert.ok(!(await p.textContent(".msg.is-live")).includes("<p>"), "no source of a page while it is written")
  assert.equal((await pageOpens(p)).filter((a) => a.owner === "m2").length, 0, "nothing is asked for a reply still being written")
  // Done: the frame.
  await p.evaluate(([path, m]) => window.__mock.frame(path, "done", { message: m, chat: null, next: null }), [STREAM2, message])
  await p.waitForSelector('.msg[data-id="m2"]:not(.is-live) .hpage__frame')
  assert.deepEqual(p.errors, [])
})

test("H1: each page is its own fence's, wherever the fence is: two in one reply, one inside a list item and one after it; where the server and the page count differently, none is drawn as another's", async () => {
  const d = (n) => String(n).repeat(32)
  const two = "First:\n\n```html-view One\n<p>1</p>\n```\n\nthen:\n\n~~~~html-view Two\n<p>2</p>\n```\nstill two\n~~~~\n"
  const nested = "Steps:\n\n- the first step\n\n  ```html-view In the list\n  <p>a</p>\n  ```\n\n- the second\n\n> quoted:\n>\n> ```html-view In the quote\n> <p>b</p>\n> ```\n\nAnd:\n\n```html-view At the end\n<p>c</p>\n```\n"
  const text = (id, markdown, pages) => reply({ id, steps: [{ index: 0, kind: "text", open: true, markdown, pages, text: "" }] })
  const p = await page(agentChatOpen([], {
    "GET /chats/chat1": { chat: chatRow(), messages: [
      userMessage("m5", "Pages"),
      text("two", two, [{ title: "One", digest: d(1) }, { title: "Two", digest: d(2) }]),
      text("nest", nested, [{ title: "In the list", digest: d(3) }, { title: "In the quote", digest: d(4) }, { title: "At the end", digest: d(5) }]),
      // The server names two pages where this page finds three fences: nothing is matched by guess.
      text("odd", nested, [{ title: "In the list", digest: d(3) }, { title: "At the end", digest: d(5) }]),
    ], more: false, live: null },
    "GET /models?chat=chat1": models(),
  }), { width: 1280, height: 3000 })
  await openChatRow(p, "chat1")
  await p.waitForSelector('.msg[data-id="nest"] .hpage')
  const pagesOf = (id) => p.$$eval(`.msg[data-id="${id}"] .hpage`, (l) => l.map((x) => [x.querySelector(".hpage__title").textContent, x.dataset.digest, x.parentElement.closest("li, blockquote")?.tagName || ""]))
  assert.deepEqual(await pagesOf("two"), [["One", d(1), ""], ["Two", d(2), ""]])
  assert.deepEqual(await pagesOf("nest"), [["In the list", d(3), "LI"], ["In the quote", d(4), "BLOCKQUOTE"], ["At the end", d(5), ""]], "each where its fence is, with its own title and digest")
  assert.ok(!(await p.textContent('.msg[data-id="nest"]')).includes("<p>"), "no page's source is drawn")
  assert.equal((await p.textContent('.msg[data-id="two"]')).includes("still two"), false, "a shorter run of backticks inside a longer fence is the page's own text")
  assert.deepEqual(await pagesOf("odd"), [], "counts differ: no fence is given a page")
  assert.equal(await p.locator('.msg[data-id="odd"] .md-code').count(), 3, "each stays the code block it is")
  // A document the app itself will not show (Rust's 422): said so, without Try again.
  await p.evaluate(() => (window.__mockConfig.pages = { __error: { status: 422, detail: "This page could not be shown safely." } }))
  await p.evaluate(() => window.__mock.emit("open-chat", "chat1"))
  await p.waitForSelector('.msg[data-id="two"] .hpage__note.is-error')
  assert.equal(await p.textContent('.msg[data-id="two"] .hpage__body'), "This page could not be shown safely.")
  assert.equal(await p.locator('.msg[data-id="two"] .hpage__body .btn').count(), 0)
  assert.ok(await p.evaluate(() => window.__mock.calls.some((c) => c.cmd === "pages_clear")), "what was held is let go when a chat is read again")
  // The server has no such page (404: written without pages offered, or gone): the fence is the
  // code block it is, in the page's place.
  await p.evaluate(() => (window.__mockConfig.pages = { __error: { status: 404, detail: "Not found" } }))
  await p.evaluate(() => window.__mock.emit("open-chat", "chat1"))
  await p.waitForSelector('.msg[data-id="two"] .md-code')
  await p.waitForFunction(() => document.querySelectorAll('.msg[data-id="two"] .hpage').length === 0)
  assert.deepEqual(await p.$$eval('.msg[data-id="two"] .md-code pre', (l) => l.map((x) => x.textContent.trim().split("\n")[0])), ["<p>1</p>", "<p>2</p>"])
  // A fence with a space before the word, or another word, is no page -- for the server and here alike.
  assert.equal(await p.evaluate(async () => { const { markdown } = await import("./js/markdown.js"); let n = 0; const count = (src) => { n = 0; markdown(src, { list: [{ title: "x", digest: "0".repeat(32) }], mount: () => (n++, document.createElement("i")) }); return n }; return [count("```html-view A\n<p>a</p>\n```"), count("``` html-view A\n<p>a</p>\n```"), count("```html-views A\n<p>a</p>\n```"), count("```HTML-VIEW A\n<p>a</p>\n```"), count("```html-view\n<p>a</p>\n```"), count("```html-view A\n<p>a</p>")].join("") }), "100010", "only the exact word straight after the backticks, and only a closed fence")
  assert.deepEqual(p.errors, [])
})

test("H1: a long chat's pages are held by need: frames only near the window, made when their place comes into view and taken away when it is far; one that cannot be had says so, with Try again", async () => {
  const step = fixture("step_text_page")
  const many = Array.from({ length: 30 }, (_, i) => reply({ id: `p${i}`, steps: [{ ...step, pages: [{ title: `Page ${i}`, digest: `d${i}` }] }] }))
  const p = await page(agentChatOpen([], { "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "Thirty pages"), ...many], more: false, live: null }, "GET /models?chat=chat1": models() }))
  await openChatRow(p, "chat1")
  await p.waitForSelector("#messages .hpage__frame")
  assert.equal(await p.locator("#messages .hpage").count(), 30)
  await p.waitForTimeout(300)
  const near = await p.locator("#messages .hpage__frame").count()
  assert.ok(near >= 1 && near <= 8, `only those near the window (${near} of 30)`)
  const first = (await pageOpens(p)).map((a) => a.owner)
  assert.ok(first.length <= 8 && first.includes("p29"), `the newest, at the end, is among them: ${first}`)
  // To the start: the first ones are made, the last ones let go.
  await p.evaluate(() => document.querySelector('.msg[data-id="p0"]').scrollIntoView())
  await p.waitForSelector('.msg[data-id="p0"] .hpage__frame')
  await p.waitForFunction(() => !document.querySelector('.msg[data-id="p29"] .hpage__frame'))
  assert.ok((await p.locator("#messages .hpage__frame").count()) <= 8)
  // Back: asked for again.
  await p.evaluate(() => document.querySelector('.msg[data-id="p29"]').scrollIntoView())
  await p.waitForSelector('.msg[data-id="p29"] .hpage__frame')
  assert.equal((await pageOpens(p)).filter((a) => a.owner === "p29").length, 2, "asked of Rust again, which holds it or fetches it")
  // It cannot be had just now (the server did not answer): said in its place, with Try again.
  await p.evaluate(() => (window.__mockConfig.pages = { __error: { status: 502, detail: "The server did not answer." } }))
  await p.evaluate(() => document.querySelector('.msg[data-id="p15"]').scrollIntoView({ block: "center" }))
  await p.waitForSelector('.msg[data-id="p15"] .hpage__note.is-error')
  assert.match(await p.textContent('.msg[data-id="p15"] .hpage__body'), /This page could not be shown: The server did not answer\./)
  await p.evaluate(() => (window.__mockConfig.pages = {}))
  await p.click('.msg[data-id="p15"] .hpage__body .btn')
  await p.waitForSelector('.msg[data-id="p15"] .hpage__frame')
  assert.deepEqual(p.errors, [])
})

test("H1: the chat's switch for pages in answers is shown only where the server offers it, and a press switches it", async () => {
  const offered = fixture("chat_html_pages")
  const cfg = agentChatOpen([], { "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null }, "GET /models?chat=chat1": models(), "GET /chats/chat1/html-pages": offered, "POST /chats/chat1/html-pages": { offered: true, on: true } })
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  await p.waitForSelector("#chat-settings .cchip--pages")
  assert.equal((await p.textContent("#chat-settings .cchip--pages")).trim(), "Pages in answers: off")
  await p.evaluate(() => window.__mock.answer("GET /chats/chat1/html-pages", { offered: true, on: true }))
  await p.click("#chat-settings .cchip--pages")
  await p.waitForFunction(() => /Pages in answers: on/.test(document.getElementById("chat-settings").textContent))
  assert.deepEqual((await p.evaluate(() => window.__mock.api("POST", "/chats/chat1/html-pages")))[0].args.body, { on: true })
  assert.deepEqual(await reachable(p, 1280), [], "every control of the header reachable")
  // Not offered (the instance's switch, the model's flag, an agent chat), or an older server: no switch.
  await p.evaluate(() => window.__mock.answer("GET /chats/chat1/html-pages", { offered: false, on: false }))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#chat-settings .cchip--model")
  await p.waitForTimeout(150)
  assert.equal(await p.locator("#chat-settings .cchip--pages").count(), 0, "an agent chat")
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/chats/chat2/html-pages").length), 0, "not even asked")
  await openChatRow(p, "chat1")
  await p.waitForSelector("#chat-settings .cchip--model")
  await p.waitForTimeout(150)
  assert.equal(await p.locator("#chat-settings .cchip--pages").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("R1: Scheduled as the server has it now: Notify when with the person's own condition, a run that changed nothing, a run's line with the report it filed", async () => {
  const one = fixture("schedule")
  const id = one.schedule.id
  const run = fixture("schedule_run").run
  const cfg = r1({
    "GET /schedules": { schedules: [one.schedule] },
    [`GET /schedules/${id}`]: one,
    [`GET /schedules/${id}/runs`]: { runs: [run, { ...run, id: "run0", status: "unchanged", report: null, note: "The page has not changed.", message_id: null, preview: "", report_path: null }], more: false },
    "GET /schedules/models": { models: [], instance: [], mine: [] },
    "POST /schedules/preview": { rule: one.schedule.rule, description: one.schedule.description, next_runs: one.schedule.next_runs, timezone: "UTC" },
    [`PATCH /schedules/${id}`]: one,
  })
  const p = await page(cfg)
  await p.evaluate((x) => window.__mock.emit("open-schedule", { schedule: x, run: "" }), id)
  await p.waitForSelector("#scheduled-body .run")
  // `when` with no words of the person's: the server's default is what is said.
  assert.equal(await p.textContent("#sched-notify-said"), one.schedule.notify_default)
  const rows = await p.$$eval("#scheduled-body .run", (l) => l.map((x) => ({ status: x.querySelector(".schip").textContent, note: x.querySelector(".run__error")?.textContent || "", report: !!x.querySelector(".run__report-open") })))
  assert.deepEqual(rows, [{ status: "Done", note: run.note, report: true }, { status: "Unchanged", note: "The page has not changed.", report: false }])
  assert.deepEqual(await controlsOut(p, 1280), [])
  await shot(p, "r1-runs-1280")
  // The form: Every run / When… / Never; the condition is a field of its own, there for When….
  await p.locator("#scheduled-tools .btn", { hasText: "Edit" }).click()
  await p.waitForSelector("#sched-notify")
  assert.deepEqual(await p.$$eval("#sched-notify option", (l) => l.map((x) => [x.value, x.textContent, x.selected])), [["always", "Every run", false], ["when", "When…", true], ["never", "Never", false]])
  assert.equal(await p.getAttribute("#sched-notify-when", "placeholder"), one.schedule.notify_default)
  await p.fill("#sched-notify-when", "a cake is unwrapped")
  // The two fields' parts on shared lines (label, control, hint).
  const tops = await p.$$eval("#sched-notify, #sched-notify-when", (l) => l.map((x) => Math.round(x.getBoundingClientRect().top)))
  await shot(p, "r1-form-1280")
  await p.selectOption("#sched-notify", "never")
  assert.ok(await p.isHidden("#sched-notify-when"))
  await p.selectOption("#sched-notify", "when")
  assert.ok(await p.isVisible("#sched-notify-when"))
  await p.locator("#scheduled-body .btn--primary", { hasText: /Save/ }).click()
  await p.waitForFunction((x) => window.__mock.api("PATCH", `/schedules/${x}`).length === 1, id)
  const sent = (await p.evaluate((x) => window.__mock.api("PATCH", `/schedules/${x}`), id))[0].args.body
  assert.deepEqual([sent.notify, sent.notify_when], ["when", "a cake is unwrapped"])
  // A run's report is opened in Reports.
  await p.waitForSelector("#scheduled-body .run__report-open")
  await p.click("#scheduled-body .run__report-open")
  await p.waitForSelector("#reports-body .report")
  assert.equal(await p.getAttribute("#nav-reports", "aria-current"), "true")
  assert.ok(tops.length === 2 && tops[0] === tops[1], `the choice and its condition are on one line: ${tops}`)
  assert.deepEqual(p.errors, [])
})

// Every screen, at the five widths, in both looks. What must hold on all of them is asserted --
// the window never scrolls sideways, every control is inside the window and not cut off by what
// holds it, no two controls of a row are drawn over each other -- and with $SHOTS each is left
// as a picture, which is how the rest of the visual pass was done: by looking.

function gallery(theme) {
  const cfg = { status: status({ theme }), routes: {}, streams: {}, commands: {}, terminal: [READY, ["output", "dev@workbench:~/project$ ls\r\nbuild  src  README.md\r\ndev@workbench:~/project$ "]] }
  for (const part of [r1(), fx(), g8(), c4(), archivedRoutes(), i8(), p2calls(), l8([bagEnd()])]) {
    Object.assign(cfg.routes, part.routes)
    Object.assign(cfg.commands, part.commands || {})
  }
  const m = models()
  m.models[0] = { ...m.models[0], name: LONG_MODEL }
  Object.assign(cfg.routes, {
    "GET /me": { ...meAs({ theme, language: "en" }), services: { stt: true, tts: true, images: true, search: false, fetch: false }, scopes: ["app", "models"] },
    "GET /models": m,
    "GET /models?chat=chat1": m,
    "GET /models?chat=chat2": m,
    "GET /devices": { devices: [bagEnd({ id: "token1", name: "workbench", host: "workbench" }), { id: "token9", name: LONG_HOST, host: LONG_HOST, platform: "linux", terminal: true, scheduled: true, max_mode: "" }] },
    "GET /chats": { chats: [chatRow({ pinned: true }), agentChat(), agentChat({ id: "chat9", title: "A chat whose title is long enough that the sidebar has to cut it short", device: { token_id: "token9", directory: LONG_DIR } })], more: false },
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made? ".repeat(6)), reply({ id: "m6", steps: [{ index: 0, kind: "thinking", open: false, text: "Flour, water, care.", label: "2 s" }, { index: 1, kind: "text", open: true, markdown: "With **care**:\n\n1. Flour\n2. Water\n\n```python\nprint('lembas')\n```\n\n| Day | Loaves |\n|---|---|\n| One | 12 |" }] })], more: true, live: null },
    "GET /chats/chat2": { chat: agentChat({ subagents: { offered: true, named_only: false, cap: 8 } }), messages: [userMessage("m1", "Tidy the build"), reply({ stopped: true })], more: false, live: null },
    "GET /chats/chat2/activity": ACTIVITY,
  })
  return cfg
}

/** Open a chat from the sidebar, also where the sidebar is a drawer that is put away. */
async function openRow(p, id) {
  await p.evaluate((x) => document.querySelector(`.chatrow[data-id="${x}"]`).click(), id)
  await p.waitForSelector(`#messages .msg`)
}

const SCREENS = [
  ["chat", async (p) => openRow(p, "chat1")],
  ["agent-chat", async (p) => openRow(p, "chat2")],
  ["new-agent", async (p) => { await p.evaluate(() => document.getElementById("new-chat-btn").click()); await p.click(".kind__tab >> nth=0"); await p.waitForSelector("#target-chips .cchip", { state: "attached" }) }],
  ["new-chat", async (p) => { await p.evaluate(() => document.getElementById("new-chat-btn").click()); await p.click(".kind__tab >> nth=1"); await p.waitForSelector("#composer-chips .cchip--picture") }],
  ["slash-menu", async (p) => { await openRow(p, "chat2"); await p.click("#composer-text"); await p.keyboard.type("/"); await p.waitForSelector("#composer-menu:not([hidden])") }],
  ["files-local", async (p) => { await p.evaluate(() => document.getElementById("nav-files").click()); await p.waitForSelector("#local-list .frow") }],
  ["files-server", async (p) => { await openServerTab(p); await p.waitForSelector('#server-list .frow[data-path="/home"]') }],
  ["scheduled", async (p) => { await p.evaluate(() => document.getElementById("nav-scheduled").click()); await p.waitForSelector("#scheduled-body .task, #scheduled-body button") }],
  ["scheduled-task", async (p) => { await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" })); await p.waitForSelector("#scheduled-body .fact") }],
  ["reports", async (p) => { await p.evaluate(() => document.getElementById("nav-reports").click()); await p.waitForSelector("#reports-body .rrow") }],
  ["report", async (p) => { await p.evaluate((id) => window.__mock.emit("open-report", id), REPORT.id); await p.waitForSelector("#reports-body .report .hpage__frame") }],
  ["memory", async (p) => { await p.evaluate(() => document.getElementById("nav-memory").click()); await p.waitForSelector("#memory-body .memory, #memory-body textarea, #memory-body button") }],
  ["archived", async (p) => { await p.evaluate(() => document.getElementById("nav-archived").click()); await p.waitForSelector("#archived-body .chatrow, #archived-body button") }],
  ["settings", async (p) => { await p.evaluate(() => document.getElementById("settings-btn").click()); await p.waitForSelector("#set-look") }],
  ["settings-agent", async (p) => { await p.evaluate(() => document.getElementById("settings-btn").click()); await p.waitForSelector("#set-agent"); await p.evaluate(() => document.getElementById("set-agent").scrollIntoView()) }],
  ["settings-about", async (p) => { await p.evaluate(() => document.getElementById("settings-btn").click()); await p.waitForSelector("#set-about"); await p.evaluate(() => document.getElementById("set-about").scrollIntoView()) }],
  ["activity", async (p) => { await openRow(p, "chat2"); await p.evaluate(() => document.getElementById("activity-open").click()); await p.waitForSelector("#activity:not([hidden]) .activity__body > *") }],
  ["terminal", async (p) => { await openRow(p, "chat2"); await p.evaluate(() => document.querySelector("#chat-tools [data-terminal-toggle]").click()); await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("README.md")) }],
  ["palette", async (p) => { await p.keyboard.press("Control+k"); await p.waitForSelector("dialog[open] .palette__input") }],
]

/** Every visible control of the page that is outside the window, or cut off by a box that clips it. */
const controlsOut = (p, width) =>
  p.$$eval(
    "button, input:not([type=hidden]), select, textarea, a[href]",
    (l, w) =>
      l
        .filter((b) => b.offsetParent !== null && getComputedStyle(b).visibility !== "hidden" && !b.closest("[hidden], .xterm, .cm-editor"))
        .filter((b) => {
          const r = b.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return false
          let clip = { left: 0, right: w }
          for (let el = b.parentElement; el; el = el.parentElement) {
            const cs = getComputedStyle(el)
            // A box that scrolls sideways on purpose (a table, a code block, the settings' tabs) is a scroller, not a cut.
            if (cs.overflowX === "auto" || cs.overflowX === "scroll") return false
            if (cs.overflowX !== "visible") {
              const c = el.getBoundingClientRect()
              clip = { left: Math.max(clip.left, c.left), right: Math.min(clip.right, c.right) }
            }
          }
          return r.left < clip.left - 1 || r.right > clip.right + 1
        })
        .map((b) => `${b.tagName.toLowerCase()}#${b.id}.${String(b.className).replace(/\s+/g, ".")} "${(b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 30)}"`),
    width,
  )

test("V4: every screen at 1920, 1280, 1024, 800 and 390 px, dark and light: nothing scrolls sideways and no control is outside the window or cut off", async () => {
  const problems = []
  // $GALLERY narrows the round while a screen is being worked on, and can ask for another
  // language than English (the words are longer in most): "shire", "390", "shire:390", "sk", "de:390".
  const only = (process.env.GALLERY || "").split(":")
  const lang = only.find((o) => /^[a-z]{2}$/.test(o)) || ""
  const themes = ["moria", "shire"].filter((x) => !only.some((o) => /^[a-z]{3,}$/.test(o)) || only.includes(x))
  const sizes = [[1920, 1080], [1280, 860], [1024, 768], [800, 700], [390, 844]].filter(([w]) => !only.some((o) => /^\d+$/.test(o)) || only.includes(String(w)))
  for (const theme of themes) {
    for (const [width, height] of sizes) {
      // One window per look and width, taken from screen to screen as a person would go: a page
      // load for each of them made the round too slow to run with the rest.
      const p = await page(gallery(theme), { width, height, lang })
      // A screen that does not come up is a finding, said at once, not after half a minute.
      p.setDefaultTimeout(8000)
      for (const [name, open] of SCREENS) {
        try {
          // Back to a new chat with nothing open over it.
          await p.keyboard.press("Escape")
          await p.evaluate(() => {
            for (const id of ["terminal-close", "activity-close", "viewer-close"]) if (!document.getElementById(id).closest("aside").hidden) document.getElementById(id).click()
            document.querySelector("dialog[open]")?.close()
            document.getElementById("new-chat-btn").click()
            document.getElementById("composer-text").value = ""
            document.getElementById("composer-text").dispatchEvent(new Event("input"))
          })
          await open(p)
          await p.waitForTimeout(120)
          if (!(await noSideways(p, width))) problems.push(`${name} ${width} ${theme}: scrolls sideways (${await p.evaluate(() => document.documentElement.scrollWidth)})`)
          const out = await controlsOut(p, width)
          if (out.length) problems.push(`${name} ${width} ${theme}: ${out.slice(0, 4).join(", ")}`)
          await shot(p, `v4-${name}-${theme}-${width}${lang ? `-${lang}` : ""}`)
        } catch (err) {
          problems.push(`${name} ${width} ${theme}: ${String(err.message || err).split("\n").slice(0, process.env.GALLERY ? 12 : 1).join(" / ")}`)
        }
      }
      if (p.errors.length) problems.push(`${width} ${theme}: ${p.errors[0]}`)
      await p.context().close()
    }
  }
  // The sign-in page: looking for a server, a server found, a refusal.
  for (const theme of themes) {
    for (const [width, height] of sizes) {
      for (const [name, st] of [["found", { account: null, linked: false }], ["refused", { account: null, linked: false, discovery: null, refused: "This is not a LLeMbas server: it answered with a page, not with its description." }], ["waiting", { account: null, linked: false, signing_in: true }]]) {
        const p = await page({ status: status({ theme, ...st }), routes: {}, streams: {} }, { width, height, lang, wait: "#setup:not([hidden]) #setup-body > *" })
        if (!(await noSideways(p, width))) problems.push(`sign-in ${name} ${width} ${theme}: scrolls sideways`)
        const out = await controlsOut(p, width)
        if (out.length) problems.push(`sign-in ${name} ${width} ${theme}: ${out.join(", ")}`)
        await shot(p, `v4-signin-${name}-${theme}-${width}${lang ? `-${lang}` : ""}`)
        await p.context().close()
      }
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join("\n")}`)
})

// --- W1: the thread while a reply is written -----------------------------------------------------
//
// Following the reply is a state the person's scrolling sets, not the distance to the end after a
// frame was drawn: a frame adds more than any such distance. The thread's scroll anchoring is off
// (app.css), so what holds here holds without it -- the app's own engine on Linux has none.

const W1_PARAS = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ${"lembas ".repeat(40)}`).join("\n\n")
const W1_CALL = () => fixture("event_steps").steps.find((x) => x.kind === "tools").calls[0]
const W1_THOUGHT = { index: 0, kind: "thinking", open: false, text: "Thought. ".repeat(200), label: "for 3 seconds" }

/** A long chat with a reply being written: twelve long questions before it, `frames` as the stream opens. */
function w1Chat(frames = [["status", { text: "Writing…" }]], over = {}) {
  const history = Array.from({ length: 12 }, (_, i) => userMessage(`h${i}`, `Question ${i}\n\n${"word ".repeat(120)}`))
  return agentChatOpen(frames, { "GET /chats/chat2": { chat: agentChat(), messages: [...history, userMessage("m1", "What is in build?")], more: false, live: "m2" }, ...over })
}

/** The thread after the page has drawn: where it stands, and how far from its end. */
async function w1At(p) {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const at = await p.evaluate(() => {
    const th = document.getElementById("thread")
    return { top: th.scrollTop, gap: th.scrollHeight - th.scrollTop - th.clientHeight, height: th.scrollHeight }
  })
  if (process.env.W1_TRACE) console.log(`     at ${at.top} of ${at.height}, ${at.gap} px from the end`)
  return at
}

// With $W1_TRACE set, every check of where the thread stands is printed and a failed one does
// not stop the test: how the thread moved from start to end, then the failure.
const w1Missed = []
function w1Ok(ok, what) {
  if (!process.env.W1_TRACE) return assert.ok(ok, what)
  console.log(`     ${ok ? "ok  " : "NOT "} ${what}`)
  if (!ok) w1Missed.push(what)
}
function w1End(p) {
  assert.deepEqual(w1Missed.splice(0), [], "where the thread stood")
  assert.deepEqual(p.errors, [])
}

const w1Send = (p, event, data) => p.evaluate(([path, e, d]) => window.__mock.frame(path, e, d), [STREAM2, event, data])

/** The person's own wheel over the thread, and the page having heard of it. */
async function w1Wheel(p, dy) {
  const box = await p.locator("#thread").boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const from = await p.evaluate(() => document.getElementById("thread").scrollTop)
  await p.mouse.wheel(0, dy)
  await p.waitForFunction((was) => document.getElementById("thread").scrollTop !== was, from)
  // An engine may take the wheel's way in steps over some frames: until it has come to rest.
  await p.evaluate(async () => {
    const th = document.getElementById("thread")
    const frame = () => new Promise((r) => requestAnimationFrame(r))
    for (let still = 0, at = th.scrollTop; still < 12; at = th.scrollTop) {
      await frame()
      still = th.scrollTop === at ? still + 1 : 0
    }
  })
  await w1At(p)
}

test("W1: at its end, the thread follows a long reply through reasoning, tool calls, a card and done", async () => {
  const p = await page(w1Chat())
  await openChatRow(p, "chat2")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  // Where the engine has scroll anchoring at all (Playwright's WebKit has not), it is off.
  const anchoring = await p.evaluate(() => getComputedStyle(document.getElementById("thread")).overflowAnchor)
  w1Ok(anchoring === undefined || anchoring === "none", `no engine's scroll anchoring is relied on (${anchoring})`)
  const followed = async (what) => {
    const at = await w1At(p)
    w1Ok(at.gap <= 1, `${what}: the thread is at its end (${at.gap} px from it, at ${at.top})`)
    return at
  }
  const first = await followed("opened")
  w1Ok(first.top > 1000, "the chat is long enough to scroll")
  const steps = []
  await w1Send(p, "tail", { thinking: "Let me think. ".repeat(60), text: "", label: "1s" })
  await followed("reasoning")
  steps.push(W1_THOUGHT)
  // Every frame adds more than the 80 px that used to count as "near the end".
  for (let i = 1; i <= 5; i++) {
    await w1Send(p, "tail", { thinking: "", text: W1_PARAS(i * 2), label: "" })
    await followed(`text ${i}`)
  }
  steps.push({ index: 1, kind: "text", open: false, markdown: W1_PARAS(10) })
  await w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: "", label: "", calls: [fixture("event_tail").calls[0]] } })
  await followed("a call running")
  steps.push({ index: 2, kind: "tools", open: false, calls: [W1_CALL(), { ...W1_CALL(), id: "c2" }, { ...W1_CALL(), id: "c3" }] })
  await w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: W1_PARAS(3), label: "", calls: [] } })
  const grown = await followed("calls finished")
  w1Ok(grown.height > first.height + 1500, "the reply grew by far more than a screen")
  // The dock grows by a card: the thread is shorter, and still at its end.
  await w1Send(p, "ask", { cards: [deviceBashCard()] })
  await p.waitForSelector("#cards:not([hidden]) .ask")
  await followed("a card in the dock")
  await w1Send(p, "ask", { cards: [] })
  // A block the person opens at the end grows the thread without any frame.
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(3), label: "", calls: [fixture("event_tail").calls[0]] })
  await followed("a call running at the end")
  await p.click(".msg.is-live .msg__running summary")
  await p.waitForSelector(".msg.is-live .msg__running details[open]")
  await followed("a block opened")
  steps.push({ index: 3, kind: "text", open: false, markdown: W1_PARAS(3) })
  await w1Send(p, "done", { message: { ...fixture("event_done").message, id: "m2", steps }, chat: { id: "chat2", title: "Tidy the build" } })
  await p.waitForSelector(".msg.is-live", { state: "detached" })
  await followed("done")
  await w1Send(p, "title", { chat: { id: "chat2", title: "The build, tidied" } })
  await followed("named")
  w1End(p)
})

test("W1: scrolled up, the thread stays exactly there through frames, tool calls, done and a new title; back at the end it follows again", async () => {
  const p = await page(w1Chat())
  await openChatRow(p, "chat2")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(6), label: "" })
  w1Ok((await w1At(p)).gap <= 1, "followed to begin with")
  await w1Wheel(p, -400)
  const up = await w1At(p)
  w1Ok(up.gap > 300, `the person scrolled up (${up.gap} px from the end)`)
  const stays = async (what, where = up) => {
    const at = await w1At(p)
    w1Ok(Math.abs(at.top - where.top) <= 1, `${what}: the thread stayed (${where.top} -> ${at.top})`)
    return at
  }
  const steps = [W1_THOUGHT]
  for (let i = 7; i <= 9; i++) {
    await w1Send(p, "tail", { thinking: "", text: W1_PARAS(i), label: "" })
    await stays(`text ${i}`)
  }
  // The reasoning that was open text above folds into one closed row: the reply is drawn anew.
  steps.push({ index: 1, kind: "text", open: false, markdown: W1_PARAS(9) })
  await w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: "", label: "", calls: [fixture("event_tail").calls[0]] } })
  await stays("a call running")
  steps.push({ index: 2, kind: "tools", open: false, calls: [W1_CALL(), { ...W1_CALL(), id: "c2" }] })
  await w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: "", label: "", calls: [] } })
  await stays("calls finished")
  await w1Send(p, "status", { text: "Running bake --slow" })
  await w1Send(p, "ask", { cards: [deviceBashCard()] })
  await p.waitForSelector("#cards:not([hidden]) .ask")
  await stays("a card in the dock")
  await w1Send(p, "ask", { cards: [] })
  await stays("the card gone")
  // A message typed meanwhile, over several lines: the box is measured at every key.
  await p.fill("#composer-text", "one\ntwo\nthree\nfour")
  await stays("typing")
  await p.fill("#composer-text", "")
  await stays("typing undone")
  // A short way up is as good as a long one: a few pixels from the end is not the end.
  await w1Wheel(p, 5000)
  w1Ok((await w1At(p)).gap <= 1, "the person scrolled back to the end")
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(4), label: "" })
  w1Ok((await w1At(p)).gap <= 1, "at the end again, the reply is followed again")
  await w1Wheel(p, -30)
  const near = await w1At(p)
  w1Ok(near.gap > 2 && near.gap < 80, `a small step up (${near.gap} px from the end)`)
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(8), label: "" })
  await stays("a small step up is not dragged down", near)
  await w1Wheel(p, -600)
  const again = await w1At(p)
  steps.push({ index: 3, kind: "text", open: false, markdown: W1_PARAS(8) })
  await w1Send(p, "done", { message: { ...fixture("event_done").message, id: "m2", steps }, chat: { id: "chat2", title: "Tidy the build" } })
  await p.waitForSelector(".msg.is-live", { state: "detached" })
  await stays("done", again)
  await w1Send(p, "title", { chat: { id: "chat2", title: "The build, tidied" } })
  await p.waitForFunction(() => document.getElementById("chat-title").textContent === "The build, tidied")
  await stays("named", again)
  w1End(p)
})

test("W1: a chat opened while its reply is written lands at the end of what is written; read again, it stays where it was", async () => {
  // The stream's first frame brings everything written so far: far more than a screen.
  const sofar = ["steps", { steps: [W1_THOUGHT, { index: 1, kind: "text", open: false, markdown: W1_PARAS(12) }, { index: 2, kind: "tools", open: false, calls: [W1_CALL()] }], tail: { thinking: "", text: W1_PARAS(2), label: "", calls: [] } }]
  const p = await page(w1Chat([sofar, ["status", { text: "Writing…" }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live .msg__steps .step--tools")
  const opened = await w1At(p)
  w1Ok(opened.gap <= 1, `opened at the end of the reply so far (${opened.gap} px from it)`)
  w1Ok(opened.top > 2500, "with the reply's text drawn")
  // Another page and back, the reply written on meanwhile: still at its end.
  await p.click("#settings-btn")
  await p.waitForSelector("#settings:not([hidden])")
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(6), label: "" })
  await p.click("#settings-close")
  await p.waitForSelector("#main:not([hidden])")
  w1Ok((await w1At(p)).gap <= 1, "back from another page, at the end of what was written meanwhile")
  // The stream ends without `done` (a proxy's limit on a long reply): the chat is read again,
  // slowly. Nothing is cleared meanwhile, and the thread is where it was -- at the end here.
  const endStream = async () => {
    await p.evaluate(() => {
      document.querySelector(".msg.is-live").dataset.old = "true"
      window.__mockConfig.hold = ["GET /chats/chat2"]
    })
    await w1Send(p, "end", null)
    await p.waitForFunction(() => window.__mock.api("GET", "/chats/chat2").length > 1)
  }
  const readAgain = async () => {
    await p.evaluate(() => window.__mock.release("GET /chats/chat2"))
    await p.waitForSelector(".msg.is-live:not([data-old]) .msg__steps .step--tools")
  }
  await endStream()
  const held = await w1At(p)
  assert.equal(await p.locator(".thread__loading").count(), 0, "the thread is not cleared while it is read again")
  w1Ok(held.gap <= 1 && held.top > 2500, `still at the end while it is read (${held.top})`)
  await readAgain()
  const read = await w1At(p)
  w1Ok(read.gap <= 1 && read.top > 2500, `at the end once it is read again (${read.top}, ${read.gap} px from the end)`)
  // The same, scrolled up: exactly where the person was, while it is read and after.
  await w1Wheel(p, -700)
  const up = await w1At(p)
  await endStream()
  const waiting = await w1At(p)
  w1Ok(Math.abs(waiting.top - up.top) <= 1, `scrolled up: not moved while it is read again (${up.top} -> ${waiting.top})`)
  await readAgain()
  const after = await w1At(p)
  w1Ok(Math.abs(after.top - up.top) <= 1, `scrolled up: not moved once it is read again (${up.top} -> ${after.top})`)
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(9), label: "" })
  w1Ok(Math.abs((await w1At(p)).top - up.top) <= 1, "nor by the frames that follow")
  w1End(p)
})


test("W1: the first reply of a new chat is followed from a thread shorter than the window, through what shrinks it, to its end", async () => {
  const cfg = i8()
  const P = "/chats/chat7/messages/m2/stream"
  Object.assign(cfg.routes, {
    "POST /chats": { chat: chatRow({ id: "chat7", title: "" }), message: userMessage("m1", "a lembas loaf"), reply: { id: "m2" } },
    "GET /chats/chat7": { chat: chatRow({ id: "chat7", title: "" }), messages: [userMessage("m1", "a lembas loaf")], more: false, live: "m2" },
  })
  cfg.streams = { [P]: [["status", { text: "Writing…" }]] }
  const p = await page(cfg)
  await p.waitForFunction(() => window.__mock.api("GET", "/me").length === 1)
  await p.click(".kind__tab >> text=Chat")
  await p.fill("#composer-text", "a lembas loaf")
  await p.keyboard.press("Enter")
  await p.waitForFunction((path) => window.__mock.started(path), P)
  const send = (event, data) => p.evaluate(([path, e, d]) => window.__mock.frame(path, e, d), [P, event, data])
  const followed = async (what) => {
    const at = await w1At(p)
    w1Ok(at.gap <= 1, `${what}: the thread is at its end (${at.gap} px from it, at ${at.top})`)
    return at
  }
  const start = await followed("sent")
  assert.equal(start.top, 0, "one short message: nothing to scroll yet")
  // The first part outgrows the window in one frame.
  await send("tail", { thinking: "", text: W1_PARAS(10), label: "", calls: [fixture("event_tail").calls[0]] })
  w1Ok((await followed("the first part")).top > 500, "taller than the window now")
  // What was drawn is drawn shorter (the part became one closed row): the thread is short
  // again and stands at its top, which is also its end.
  await send("steps", { steps: [{ index: 0, kind: "tools", open: false, calls: [W1_CALL()] }], tail: { thinking: "", text: "", label: "", calls: [] } })
  assert.equal((await followed("drawn shorter")).top, 0, "short again")
  // Then the text, a screen and more at a time: followed all the same.
  for (let i = 1; i <= 3; i++) {
    await send("tail", { thinking: "", text: W1_PARAS(i * 6), label: "" })
    await followed(`text ${i}`)
  }
  const steps = [W1_THOUGHT, { index: 0, kind: "tools", open: false, calls: [W1_CALL()] }, { index: 1, kind: "text", open: false, markdown: W1_PARAS(18) }]
  await send("steps", { steps, tail: { thinking: "", text: "", label: "", calls: [] } })
  const written = await followed("the steps")
  w1Ok(written.top > 1000, "a long reply")
  await send("done", { message: { ...fixture("event_done").message, id: "m2", steps }, chat: { id: "chat7", title: "" } })
  await p.waitForSelector(".msg.is-live", { state: "detached" })
  await followed("done")
  // The chat's name from a model, a moment after the reply.
  await send("title", { chat: { id: "chat7", title: "A lembas loaf" } })
  await p.waitForFunction(() => document.getElementById("chat-title").textContent === "A lembas loaf")
  w1Ok((await followed("named")).top > 1000, "still at the reply's end, not at its beginning")
  w1End(p)
})

test("W1: the moment a reply is finished the thread is still at its end: a finished reply far shorter than the written one, and a chat read again for the next", async () => {
  const p = await page(w1Chat())
  await openChatRow(p, "chat2")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  const followed = async (what) => {
    const at = await w1At(p)
    w1Ok(at.gap <= 1, `${what}: the thread is at its end (${at.gap} px from it, at ${at.top})`)
    return at
  }
  const before = await followed("opened")
  // Written: screens of text, and a call running.
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(30), label: "", calls: [fixture("event_tail").calls[0]] })
  const written = await followed("written")
  w1Ok(written.height > before.height + 2000, "the reply being written is long")
  // Finished far shorter than it was written. The last prompt is not what the person is shown.
  const steps = [W1_THOUGHT, { index: 0, kind: "tools", open: false, calls: [W1_CALL()] }, { index: 1, kind: "text", open: false, markdown: W1_PARAS(7) }]
  const message = { ...fixture("event_done").message, id: "m2", steps }
  // A message was queued behind the reply (`next`): the chat is read again, slowly.
  await p.evaluate(([m, q]) => {
    const was = window.__mockConfig.routes["GET /chats/chat2"]
    window.__mock.answer("GET /chats/chat2", { ...was, messages: [...was.messages, m, q], live: "m4" })
    window.__mockConfig.hold = ["GET /chats/chat2"]
  }, [message, userMessage("m3", "and wrap it")])
  await w1Send(p, "done", { message, chat: { id: "chat2", title: "Tidy the build" }, next: true })
  await p.waitForSelector('.msg--assistant[data-id="m2"]:not(.is-live)')
  const done = await followed("done")
  w1Ok(done.height < written.height - 1000, "the finished reply is far shorter than the written one")
  const prompt = await p.locator('.msg--user[data-id="m1"]').boundingBox()
  const reply = await p.locator('.msg--assistant[data-id="m2"] .msg__foot').boundingBox()
  const view = await p.locator("#thread").boundingBox()
  w1Ok(reply.y + reply.height <= view.y + view.height + 1 && reply.y > view.y, "the reply's last line is in the window")
  w1Ok(prompt.y < view.y, "the last prompt is above the window, not what the thread went back to")
  assert.equal(await p.locator(".thread__loading").count(), 0, "not cleared while it is read again")
  await p.evaluate(() => window.__mock.release("GET /chats/chat2"))
  await p.waitForSelector('.msg.is-live[data-id="m4"]')
  await followed("read again, the next reply begun")
  assert.equal(await p.locator('.msg--user[data-id="m3"]').count(), 1, "the queued message is in the thread")
  w1End(p)
})

// --- DP: a folder on a linked computer, chosen from the computer's own listing -------------------
//
// The server's fixtures device_directories*.json (`GET /devices/{id}/directories?path=`): the
// places, one directory with three in it -- one with a remembered model, one the computer will
// not open a session in -- and the answers without a listing (`code`).

const DIRS = "/devices/token9/directories?path="
const PROJECT = "/home/user/project"

/** A directory of the fixture's shape: `path`, with `over` what differs. */
function dirAt(path, over = {}) {
  const base = fixture("device_directories")
  return { ...base, device: "token9", path, name: path.split("/").pop(), parent: path.slice(0, path.lastIndexOf("/")), model: null, entries: [], ...over }
}

function dp(over = {}) {
  const refused = fixture("device_directories").entries.find((e) => !e.accepted)
  return d4({
    "GET /chats": { chats: [chatRow(), agentChat()], more: false },
    [`GET ${DIRS}`]: { ...fixture("device_directories_places"), device: "token9" },
    [`GET ${DIRS}${encodeURIComponent(PROJECT)}`]: { ...fixture("device_directories"), device: "token9" },
    [`GET ${DIRS}${encodeURIComponent("/home/user")}`]: dirAt("/home/user", { parent: "", entries: [{ path: PROJECT, name: "project", accepted: true, reason: "", model: { id: "qwen", name: "Qwen" } }] }),
    [`GET ${DIRS}${encodeURIComponent(`${PROJECT}/server`)}`]: dirAt(`${PROJECT}/server`, { model: { id: "gpt-oss", name: "gpt-oss" } }),
    [`GET ${DIRS}${encodeURIComponent(`${PROJECT}/vendor`)}`]: dirAt(`${PROJECT}/vendor`, { accepted: false, reason: refused.reason }),
    "POST /chats": { chat: agentChat({ id: "chat8", running: false, device: { token_id: "token9", directory: `${PROJECT}/server` } }), message: userMessage("m9", "Check the logs"), reply: null },
    ...over,
  })
}

/** A new agent chat on the other computer, its folder dialog open. */
async function openPicker(p) {
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await pickDevice(p, "studio")
  await p.waitForSelector("#target-chips .cchip--folder.is-warn")
  await p.click("#target-chips .cchip--folder")
  await p.waitForSelector("dialog[open] .dirs__list:not([aria-busy]) .dirs__row")
}

const dirRows = (p) => p.$$eval("dialog[open] .dirs__row", (l) => l.map((b) => [b.querySelector(".dirs__label").textContent, b.querySelector(".dirs__hint").textContent]))
const dirWhere = (p, path) => p.waitForFunction((want) => document.querySelector("dialog[open] .dirs__path")?.textContent === want && !document.querySelector("dialog[open] .dirs__list[aria-busy]"), path)
const focused = (p) => p.evaluate(() => document.activeElement?.querySelector?.(".dirs__label")?.textContent || document.activeElement?.className || "")

test("DP: a folder on another computer is walked with the keys from its places, the model last used beside a folder; the one stood in is chosen, and Escape gives the focus back", async () => {
  const p = await page(dp())
  await openPicker(p)
  assert.equal(await p.textContent("dialog[open] .dirs__path"), "Places on this device")
  assert.deepEqual(await dirRows(p), [["user", ""], ["project", "Qwen"]], "the places, a remembered model beside its folder")
  assert.equal(await focused(p), "user", "the first folder has the focus")
  assert.ok(await p.isDisabled("#dirs-use"), "nothing to use before a folder is stood in or typed")
  // Every row on the same tracks: the names start on one line, the quieter words end on one.
  const edges = await p.$$eval("dialog[open] .dirs__row", (l) => l.map((b) => [Math.round(b.querySelector(".dirs__name").getBoundingClientRect().left), Math.round(b.querySelector(".dirs__hint").getBoundingClientRect().right)]))
  assert.equal(new Set(edges.map((e) => e.join())).size, 1, `rows share their tracks: ${JSON.stringify(edges)}`)
  await p.keyboard.press("ArrowDown")
  assert.equal(await focused(p), "project")
  await p.keyboard.press("Enter")
  await dirWhere(p, PROJECT)
  assert.deepEqual(await dirRows(p), [["Up a level", ""], ["docs", ""], ["server", "gpt-oss"], ["vendor", "Not trusted on the device"]])
  assert.match(await p.textContent("dialog[open] .dirs__model"), /Last used here: Qwen\./)
  assert.equal(await focused(p), "docs", "the first folder, not the way up")
  await shot(p, "dp-picker-1280")
  await p.keyboard.press("End")
  assert.equal(await focused(p), "vendor")
  await p.keyboard.press("ArrowUp")
  await p.keyboard.press("ArrowRight")
  await dirWhere(p, `${PROJECT}/server`)
  assert.match(await p.textContent("dialog[open] .dirs__list"), /No directories here\./)
  await p.keyboard.press("Backspace")
  await dirWhere(p, PROJECT)
  assert.equal(await focused(p), "server", "back up, on the folder just left")
  await p.keyboard.press("ArrowLeft")
  await dirWhere(p, "/home/user")
  assert.equal(await focused(p), "project")
  await p.keyboard.press("Enter")
  await dirWhere(p, PROJECT)
  await p.keyboard.press("ArrowDown")
  await p.keyboard.press("Enter")
  await dirWhere(p, `${PROJECT}/server`)
  // The list is one stop for Tab; the next is the path, where Enter uses the folder stood in.
  await p.keyboard.press("Tab")
  assert.match(await focused(p), /dirs__typed/)
  assert.equal(await p.inputValue("dialog[open] .dirs__typed"), `${PROJECT}/server`)
  await p.keyboard.press("Enter")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  await p.waitForFunction(() => /server/.test(document.querySelector("#target-chips .cchip--folder")?.textContent || ""))
  assert.ok(await p.evaluate(() => document.activeElement?.classList.contains("cchip--folder")), "the focus is on the folder's chip")
  // Again, from the chip's menu (recent folders, Browse…, Type a folder…): Escape closes it and
  // the focus is back on the chip; the folder stays.
  await p.click("#target-chips .cchip--folder")
  assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => x.textContent)), ["Browse…", "Type a folder…"])
  await p.locator(".menu .menu__item", { hasText: "Browse…" }).click()
  await dirWhere(p, `${PROJECT}/server`)
  await p.keyboard.press("Escape")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  assert.ok(await p.evaluate(() => document.activeElement?.classList.contains("cchip--folder")), "Escape: the focus is back on the chip")
  assert.match(await p.textContent("#target-chips .cchip--folder"), /server/)
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  const [made] = await p.evaluate(() => window.__mock.api("POST", "/chats"))
  assert.equal(made.args.body.directory, `${PROJECT}/server`)
  assert.equal(made.args.body.device, "token9")
  assert.deepEqual(p.errors, [])
})

test("DP: a directory the computer will not open a session in can be walked into but not chosen, and its reason is said; at 390 px the dialog is inside the window", async () => {
  const p = await page(dp(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("new-chat-btn").click())
  await p.click(".kind__tab >> text=Agent")
  await pickDevice(p, "studio")
  await targetChips(p)
  await p.click("#target-chips .cchip--folder")
  await p.waitForSelector("dialog[open] .dirs__list:not([aria-busy]) .dirs__row")
  await p.locator("dialog[open] .dirs__row", { hasText: "project" }).click()
  await dirWhere(p, PROJECT)
  assert.ok(await p.isEnabled("#dirs-use"), "an accepted directory can be used")
  assert.ok(await p.isHidden("dialog[open] .dirs__said"))
  const refused = p.locator("dialog[open] .dirs__row.is-refused")
  assert.match(await refused.getAttribute("title"), /This directory is not trusted on the device\./, "the reason, on the row")
  await refused.click()
  await dirWhere(p, `${PROJECT}/vendor`)
  assert.equal(await p.textContent("dialog[open] .dirs__said"), "This directory is not trusted on the device.")
  assert.ok(await p.isDisabled("#dirs-use"), "not to be chosen")
  await p.focus("dialog[open] .dirs__typed")
  await p.keyboard.press("Enter")
  assert.equal(await p.locator("dialog[open]").count(), 1, "Enter in the path does not choose it either")
  assert.equal(await p.textContent("dialog[open] .dirs__path"), `${PROJECT}/vendor`)
  const box = await p.locator("dialog[open]").boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, `the dialog is inside the window: ${JSON.stringify(box)}`)
  assert.ok(await p.$$eval("dialog[open] .dirs__row", (l) => l.every((b) => b.getBoundingClientRect().height >= 36)), "rows a finger can press")
  assert.ok(await noSideways(p, 390))
  await shot(p, "dp-picker-refused-390")
  // A typed path is still the person's to try: the computer decides when the chat starts.
  await p.fill("dialog[open] .dirs__typed", "/home/user/elsewhere")
  assert.ok(await p.isEnabled("#dirs-use"))
  await p.locator("dialog[open] .dirs__row--up").click()
  await dirWhere(p, PROJECT)
  assert.ok(await p.isEnabled("#dirs-use"))
  await p.click("#dirs-use")
  await p.waitForFunction(() => /project/.test(document.getElementById("chat-target").textContent))
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/chats").length), 0)
  assert.deepEqual(p.errors, [])
})

test("DP: a computer whose CLI is too old to list, or that is not linked, says so and leaves the recent folders and the typed path", async () => {
  for (const name of ["device_directories_cli_too_old", "device_directories_not_linked"]) {
    const answer = { ...fixture(name), device: "token9" }
    // A chat in the sidebar worked in /srv/site there: the recent folder, and the draft's first.
    const p = await page(d4({ "GET /devices/token9/directories": answer }))
    await p.click("#new-chat-btn")
    await p.click(".kind__tab >> text=Agent")
    await pickDevice(p, "studio")
    await p.waitForFunction(() => /site/.test(document.querySelector("#target-chips .cchip--folder")?.textContent || ""))
    await p.click("#target-chips .cchip--folder")
    assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => (x.querySelector(".menu__label--two > :first-child") || x.querySelector(".menu__label")).textContent)), ["site", "Browse…", "Type a folder…"], "recent, browse, typed")
    await p.locator(".menu .menu__item", { hasText: "Browse…" }).click()
    await p.waitForSelector("dialog[open] .dirs__said:not([hidden])")
    assert.equal(await p.textContent("dialog[open] .dirs__said"), answer.error, "the server's sentence")
    assert.deepEqual(await dirRows(p), [["site", ""]], "only the folder worked in before")
    assert.equal(await p.textContent("dialog[open] .dirs__group"), "Recent")
    assert.equal(await p.inputValue("dialog[open] .dirs__typed"), "/srv/site")
    await p.fill("dialog[open] .dirs__typed", "/home/user/other")
    await p.keyboard.press("Enter")
    await p.waitForSelector("dialog[open]", { state: "detached" })
    await p.waitForFunction(() => /other/.test(document.querySelector("#target-chips .cchip--folder")?.textContent || ""))
    // And the recent one from the dialog: it becomes the path, ready to be used.
    await p.click("#target-chips .cchip--folder")
    await p.locator(".menu .menu__item", { hasText: "Browse…" }).click()
    await p.waitForSelector("dialog[open] .dirs__row--recent")
    await p.click("dialog[open] .dirs__row--recent")
    assert.equal(await p.inputValue("dialog[open] .dirs__typed"), "/srv/site")
    await p.click("#dirs-use")
    await p.waitForFunction(() => /site/.test(document.querySelector("#target-chips .cchip--folder")?.textContent || ""))
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

// --- DM: the model a new agent chat starts on is its folder's usual one ---------------------------
//
// `start { model, from }` of `/models?kind=agent&device=&directory=` (fixture
// models_agent_directory.json): shown as the draft's model, asked again when the folder or the
// computer changes, never over a model picked in the draft -- the only model `POST /chats` names.

const AGENT_MODELS = (start) => {
  const { start: said, ...rest } = fixture("models_agent_directory")
  return start === undefined ? { ...rest, start: said } : start ? { ...rest, start } : rest
}
const startAt = (device, dir) => `GET /models?kind=agent&device=${device}&directory=${encodeURIComponent(dir)}`

function dm(over = {}) {
  return dp({
    "GET /models": AGENT_MODELS(null),
    [startAt("token9", PROJECT)]: AGENT_MODELS(),
    [startAt("token9", "/home/user")]: AGENT_MODELS({ model: "qwen", from: "default" }),
    "POST /chats": { chat: agentChat({ id: "chat8", running: false, model: "gpt-oss", device: { token_id: "token9", directory: PROJECT } }), message: userMessage("m9", "Check the logs"), reply: null },
    "GET /chats/chat8": { chat: agentChat({ id: "chat8", running: false, model: "gpt-oss", device: { token_id: "token9", directory: PROJECT } }), messages: [userMessage("m9", "Check the logs")], more: false, live: null },
    ...over,
  })
}

const modelSaid = (p, name) => p.waitForFunction((want) => document.querySelector("#chat-settings .cchip--model .cchip__label")?.textContent === want, name)
/** Choose the draft's folder in the dialog: the places, then `rows` clicked in turn. */
async function folderBy(p, ...rows) {
  await p.click("#target-chips .cchip--folder")
  if (await p.locator(".menu .menu__item", { hasText: "Browse…" }).count()) await p.locator(".menu .menu__item", { hasText: "Browse…" }).click()
  await p.waitForSelector("dialog[open] .dirs__list:not([aria-busy]) .dirs__row")
  for (const row of rows) {
    const from = await p.textContent("dialog[open] .dirs__path")
    await p.locator("dialog[open] .dirs__row", { hasText: row }).first().click()
    await p.waitForFunction((was) => document.querySelector("dialog[open] .dirs__path")?.textContent !== was && !document.querySelector("dialog[open] .dirs__list[aria-busy]"), from)
  }
  await p.click("#dirs-use")
  await p.waitForSelector("dialog[open]", { state: "detached" })
}

test("DM: a new agent chat's model is its folder's usual one, read again when the folder changes; none is sent unless one was picked, and a picked one stays", async () => {
  const p = await page(dm())
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await modelSaid(p, "Qwen")
  await pickDevice(p, "studio")
  await p.waitForSelector("#target-chips .cchip--folder.is-warn")
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/models?kind=agent&device=token9&directory=").length), 0, "no folder, nothing to ask")
  await folderBy(p, "project")
  await modelSaid(p, "gpt-oss")
  assert.match(await p.getAttribute("#chat-settings .cchip--model", "title"), /the folder's usual model/)
  // Another folder: asked again; the server says the default there.
  await folderBy(p, "Up a level")
  await modelSaid(p, "Qwen")
  assert.doesNotMatch(await p.getAttribute("#chat-settings .cchip--model", "title"), /usual model/)
  await folderBy(p, "project")
  await modelSaid(p, "gpt-oss")
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/models?kind=agent&device=token9&directory=").length), 3, "once for each change of folder")
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  const first = (await p.evaluate(() => window.__mock.api("POST", "/chats")))[0].args.body
  assert.equal(first.directory, PROJECT)
  assert.ok(!("model" in first) && !("effort" in first), `the server starts it on the folder's model itself: ${JSON.stringify(first)}`)
  // A model picked in the draft is the draft's, whatever the folder says, and is sent.
  await p.waitForSelector('.msg--user[data-id="m9"]')
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await pickDevice(p, "studio")
  await p.waitForSelector("#target-chips .cchip--folder.is-warn")
  await folderBy(p, "project")
  await modelSaid(p, "gpt-oss")
  await p.click("#chat-settings .cchip--model")
  await p.locator(".menu .menu__item", { hasText: "Vision" }).click()
  await modelSaid(p, "Vision")
  await folderBy(p, "Up a level")
  await p.waitForFunction(() => /user/.test(document.querySelector("#target-chips .cchip--folder")?.textContent || ""))
  await p.waitForTimeout(150)
  assert.equal(await p.textContent("#chat-settings .cchip--model .cchip__label"), "Vision", "the picked model stays")
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 2)
  const second = (await p.evaluate(() => window.__mock.api("POST", "/chats")))[1].args.body
  assert.equal(second.model, "local/vision-small", "by its ref")
  assert.equal(second.directory, "/home/user")
  // Nothing of a folder's model is kept by the app.
  assert.deepEqual(await p.evaluate(() => Object.keys(localStorage).filter((k) => /model|director|folder/i.test(k))), [])
  assert.deepEqual(p.errors, [])
})

// --- ST: the two types of schedule, Chat and Agentic ----------------------------------------------
//
// Fixtures schedule_on_device.json (Agentic: `runs_on`), schedule.json (Chat), schedule_models.json
// (`GET /schedules/models`), schedule_run_agentic.json (a run's `ran_on` and `model.reason`).

const WORKSTATION = { id: "tok1", name: "workstation", host: "workstation", platform: "linux", terminal: true, scheduled: true, max_mode: "edit", directory_model: true }

function st(devices, over = {}) {
  const cfg = l8(devices)
  const tok = "/devices/tok1/directories?path="
  Object.assign(cfg.routes, {
    "GET /schedules/models": fixture("schedule_models"),
    [`GET ${tok}`]: { ...fixture("device_directories_places"), device: "tok1" },
    [`GET ${tok}${encodeURIComponent(PROJECT)}`]: { ...fixture("device_directories"), device: "tok1" },
    ...over,
  })
  return cfg
}

async function newTask(p) {
  await p.waitForSelector("#composer")
  await p.evaluate(() => window.__mock.emit("open-schedule", { schedule: "sched3", run: "run5" }))
  await p.waitForSelector("#page-scheduled:not([hidden])")
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "New scheduled")
  await p.keyboard.press("Enter")
  await p.waitForSelector("#sched-type")
}

const saved = async (p, n = 1) => {
  await p.waitForFunction((want) => window.__mock.api("POST", "/schedules").filter((c) => c.args.path === "/schedules").length === want, n)
  return (await p.evaluate(() => window.__mock.api("POST", "/schedules").filter((c) => c.args.path === "/schedules"))).at(-1).args.body
}

test("ST: the form asks the type first; Agentic has its computer, a folder browsed there, mode, approval wait and the folder's usual model; the server's refusal of a model is said as it is", async () => {
  const p = await page(st([WORKSTATION], { "POST /schedules": { __error: { status: 400, detail: "Qwen Plan is for interactive use only: its provider does not allow scheduled work on it." } } }))
  await newTask(p)
  // The type is the first thing in the form, before the words.
  assert.ok(await p.evaluate(() => document.getElementById("sched-type").compareDocumentPosition(document.getElementById("sched-words")) & Node.DOCUMENT_POSITION_FOLLOWING))
  assert.deepEqual(await p.$$eval("#sched-type input", (l) => l.map((i) => [i.value, i.checked, i.disabled])), [["chat", true, false], ["agentic", false, false]])
  assert.equal(await p.locator("#sched-type-off").count(), 0)
  // The two choices start on one line.
  const tops = await p.$$eval(".stype__choice", (l) => l.map((x) => Math.round(x.getBoundingClientRect().top)))
  assert.equal(new Set(tops).size, 1, `${tops}`)
  await p.check("#sched-type-agentic")
  await p.fill("#sched-words", "every day at 7:30 check the build")
  await p.click(".sched--new button[type=submit]")
  await p.waitForSelector("#sched-device")
  assert.deepEqual(await p.$$eval("#sched-device option", (l) => l.map((o) => [o.textContent, o.selected])), [["workstation", true]])
  // The models are the scheduling ones, the empty choice the folder's usual model.
  assert.deepEqual(await p.$$eval("#sched-model option", (l) => l.map((o) => [o.value, o.textContent, o.selected])), [["", "The folder's usual model", true], ["local/gpt-oss", "gpt-oss · busy", false], ["local/qwen", "Qwen", false]])
  assert.match(await p.textContent(".field:has(#sched-model) .hint"), /A run never changes the folder's model\./)
  // The folder: typed, or browsed on the computer.
  assert.equal(await p.inputValue("#sched-cwd"), "")
  await p.click("#sched-save")
  await p.waitForSelector(".sched__card > .status.is-error:not([hidden])")
  assert.equal(await p.textContent(".sched__card > .status.is-error"), "Choose a folder first.")
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/schedules").filter((c) => c.args.path === "/schedules").length), 0)
  await p.click("#sched-browse")
  await p.waitForSelector("dialog[open] .dirs__list:not([aria-busy]) .dirs__row")
  assert.match(await p.textContent("dialog[open] .dialog__title"), /workstation/)
  await p.locator("dialog[open] .dirs__row", { hasText: "project" }).click()
  await dirWhere(p, PROJECT)
  await p.click("#dirs-use")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  assert.equal(await p.inputValue("#sched-cwd"), PROJECT)
  assert.ok(await p.evaluate(() => document.activeElement?.id === "sched-cwd"), "the focus is on the folder's field")
  // The folder's field and its button are one control on the form's shared line.
  const line = await p.$$eval("#sched-device, #sched-cwd, #sched-browse", (l) => l.map((x) => Math.round(x.getBoundingClientRect().top)))
  assert.equal(new Set(line).size, 1, `controls on one line: ${line}`)
  await shot(p, "st-form-agentic-1280")
  await p.click("#sched-save")
  await p.waitForFunction(() => /interactive use only/.test(document.querySelector(".sched__card > .status.is-error")?.textContent || ""))
  assert.equal(await p.textContent(".sched__card > .status.is-error"), "Qwen Plan is for interactive use only: its provider does not allow scheduled work on it.", "the server's sentence")
  const on = fixture("schedule_on_device").schedule
  await p.evaluate((schedule) => window.__mock.answer("POST /schedules", { schedule }), { ...on, id: "sched9" })
  await p.click("#sched-save")
  const body = await saved(p, 2)
  assert.deepEqual(body.runs_on, { device: "tok1", cwd: PROJECT, mode: "edit", approval_wait_minutes: 30 })
  assert.equal(body.model, "", "no model named: the folder's usual one")
  assert.deepEqual(p.errors, [])
})

test("ST: a Chat schedule is one without a computer; Agentic cannot be chosen while no computer accepts scheduled work, and says why, at 1280 and 390 px", async () => {
  for (const [width, height] of [[1280, 860], [390, 844]]) {
    const p = await page(st([{ ...WORKSTATION, scheduled: false }]), { width, height })
    await newTask(p)
    assert.deepEqual(await p.$$eval("#sched-type input", (l) => l.map((i) => [i.value, i.checked, i.disabled])), [["chat", true, false], ["agentic", false, true]])
    assert.match(await p.textContent("#sched-type-off"), /None of your computers accepts scheduled work now\./)
    assert.ok(await noSideways(p, width), `${width}: nothing scrolls sideways`)
    const boxes = await p.$$eval(".stype__choice", (l) => l.map((x) => { const r = x.getBoundingClientRect(); return [r.left, r.right, x.scrollWidth <= x.clientWidth + 1] }))
    assert.ok(boxes.every(([left, right, whole]) => left >= 0 && right <= width && whole), `${width}: ${JSON.stringify(boxes)}`)
    await shot(p, `st-form-type-${width}`)
    await p.fill("#sched-words", "every day at 7:30 check the build")
    await p.click(".sched--new button[type=submit]")
    await p.waitForSelector("#sched-model")
    assert.equal(await p.locator("#sched-device, #sched-cwd").count(), 0, "no computer, no folder")
    assert.equal(await p.$eval("#sched-model option", (o) => o.textContent), "The first free scheduling model")
    await p.click("#sched-save")
    const body = await saved(p)
    assert.equal(body.runs_on, null)
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("ST: a task's page says its type, computer, folder and model; a run says where it ran and how its model was chosen", async () => {
  const agentic = fixture("schedule_run_agentic").run
  const cfg = st([WORKSTATION])
  const chat = fixture("schedule")
  Object.assign(cfg.routes, {
    "GET /schedules/sched3/runs": {
      runs: [
        agentic,
        { ...agentic, id: "run7", model: { ...agentic.model, reason: "default" } },
        { ...agentic, id: "run8", model: { ...agentic.model, reason: "session" } },
        { ...agentic, id: "run9", model: { id: "gpt-oss", name: "gpt-oss", reason: "pinned", switched_from: null } },
      ],
      more: false,
    },
    [`GET /schedules/${chat.schedule.id}`]: chat,
    [`GET /schedules/${chat.schedule.id}/runs`]: { runs: [fixture("schedule_run").run], more: false },
  })
  const p = await page(cfg)
  await openTask(p)
  assert.equal(await p.textContent("#sched-type-said"), "Agentic")
  assert.match(await p.textContent("#sched-computer-said"), /workstation/)
  assert.equal(await p.locator("#sched-computer-said.is-warning").count(), 0)
  assert.match(await p.textContent("#sched-folder-said"), /\/home\/frodo\/waybread/)
  assert.match(await p.textContent(".fact:has(.fact__label:text-is('Model'))"), /The folder's usual model/)
  const rows = await p.$$eval(".run", (l) => l.map((r) => [r.dataset.id, ...[".run__name", ".run__how", ".run__where"].map((s) => r.querySelector(s)?.textContent ?? null)]))
  assert.deepEqual(rows, [
    ["run6", "Qwen", "the folder's usual model", "workstation · project"],
    ["run7", "Qwen", "default model", "workstation · project"],
    ["run8", "Qwen", "the conversation's own model", "workstation · project"],
    ["run9", "gpt-oss", null, "workstation · project"],
  ])
  assert.match(await p.getAttribute(".run[data-id='run6'] .run__where", "title"), /\/home\/user\/project/, "the whole folder in the title")
  // The rows' tracks are shared: every model starts on one line.
  assert.equal(new Set(await p.$$eval(".run__model", (l) => l.map((x) => Math.round(x.getBoundingClientRect().left)))).size, 1)
  await shot(p, "st-task-agentic-1280")
  // A Chat task: its type, no computer or folder, and a run that ran nowhere but the server.
  await p.evaluate((id) => window.__mock.emit("open-schedule", { schedule: id, run: "" }), chat.schedule.id)
  await p.waitForFunction(() => document.getElementById("sched-type-said")?.textContent === "Chat")
  assert.equal(await p.locator("#sched-computer-said, #sched-folder-said, .run__where").count(), 0)
  assert.deepEqual(p.errors, [])
})

// --- RR: a chat read again that cannot be had ------------------------------------------------------

test("RR: a chat read again and not had keeps the thread that is drawn, and the error is said beside it", async () => {
  const p = await page(w1Chat([["status", { text: "Writing…" }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector(".msg.is-live")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  const before = await p.locator("#messages .msg").count()
  assert.ok(before >= 14)
  // The reply ends with another queued behind it: the chat is read again -- and the server is away.
  await p.evaluate(() => window.__mock.answer("GET /chats/chat2", { __error: { status: 502, detail: "The server did not answer." } }))
  const message = { ...fixture("message_stopped"), id: "m2" }
  await w1Send(p, "done", { message, chat: { id: "chat2", title: "Tidy the build" }, next: true })
  await p.waitForSelector("#thread-note:not([hidden])")
  assert.equal(await p.textContent("#thread-note"), "The server did not answer.")
  assert.equal(await p.locator("#messages .msg").count(), before, "the thread is still there")
  assert.equal(await p.locator('.msg--assistant[data-id="m2"]:not(.is-live)').count(), 1, "the finished reply too")
  assert.equal(await p.locator(".thread__loading").count(), 0)
  // The chat is still the open one: a message can be sent to it.
  assert.match(await p.textContent("#chat-title"), /Tidy the build/)
  assert.deepEqual(p.errors, [])
})

// --- Review round: the thread's place by a message, readings that overlap, and what a server may send ---

test("W1: a slow scroll up, a pixel at a time while frames arrive, and a frame that comes while the wheel is still moving, are the person's: the thread is not taken back to its end", async () => {
  const p = await page(w1Chat())
  await openChatRow(p, "chat2")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(4), label: "" })
  const start = await w1At(p)
  w1Ok(start.gap <= 1, "followed to begin with")
  // One pixel up, and a frame before the engine has said anything of it; five times.
  for (let i = 1; i <= 5; i++) {
    await p.evaluate(([path, text]) => {
      document.getElementById("thread").scrollTop -= 1
      window.__mock.frame(path, "tail", { thinking: "", text, label: "" })
    }, [STREAM2, W1_PARAS(4 + i)])
  }
  const crept = await w1At(p)
  w1Ok(Math.abs(crept.top - (start.top - 5)) <= 1, `five pixels up, and there it is (${start.top} -> ${crept.top})`)
  w1Ok(crept.gap > 100, `the reply went on below (${crept.gap} px from the end)`)
  // Back at the end it follows again.
  await p.evaluate(() => document.getElementById("thread").scrollTo(0, 1e9))
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(10), label: "" })
  const back = await w1At(p)
  w1Ok(back.gap <= 1, `at the end again, followed (${back.gap})`)
  // The wheel, and frames while it may still be on its way.
  const box = await p.locator("#thread").boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.mouse.wheel(0, -300)
  for (let i = 11; i <= 13; i++) await w1Send(p, "tail", { thinking: "", text: W1_PARAS(i), label: "" })
  await p.evaluate(async () => {
    const th = document.getElementById("thread")
    const frame = () => new Promise((r) => requestAnimationFrame(r))
    for (let still = 0, at = th.scrollTop; still < 12; at = th.scrollTop) {
      await frame()
      still = th.scrollTop === at ? still + 1 : 0
    }
  })
  const wheeled = await w1At(p)
  // (Whether a frame was drawn before the wheel's first step or between two of them is the engine's: either way the thread is not at its end.)
  w1Ok(wheeled.gap > 200, `the wheel's way up was kept (${back.top} -> ${wheeled.top}, ${wheeled.gap} px from the end)`)
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(16), label: "" })
  const after = await w1At(p)
  w1Ok(Math.abs(after.top - wheeled.top) <= 1, `and stays through the next frame (${wheeled.top} -> ${after.top})`)
  w1End(p)
})

test("W1: a chat read again with earlier messages loaded keeps them, and the message at the top of the window is where it was; where that message is gone, the thread is at its end", async () => {
  const older = Array.from({ length: 12 }, (_, i) => userMessage(`e${i}`, `Earlier ${i}\n\n${"word ".repeat(120)}`))
  const cfg = w1Chat()
  cfg.routes["GET /chats/chat2"].more = true
  cfg.routes["GET /chats/chat2/messages?before=h0"] = { messages: older, more: false }
  const p = await page(cfg)
  await openChatRow(p, "chat2")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  await w1Send(p, "tail", { thinking: "", text: W1_PARAS(3), label: "" })
  await p.click(".thread__earlier")
  await p.waitForSelector('.msg[data-id="e0"]')
  // The fifth earlier message a little above the window's top: it crosses the edge.
  const offset = () => p.evaluate(() => document.querySelector('.msg[data-id="e5"]').getBoundingClientRect().top - document.getElementById("thread").getBoundingClientRect().top)
  await p.evaluate(() => {
    const th = document.getElementById("thread")
    th.scrollTop += document.querySelector('.msg[data-id="e5"]').getBoundingClientRect().top - th.getBoundingClientRect().top + 30
  })
  await w1At(p)
  const before = await offset()
  w1Ok(Math.abs(before + 30) <= 1, `the message crosses the top edge (${before})`)
  const count = await p.locator("#messages .msg").count()
  // The stream closes without `done` (a proxy's time limit): the chat is read again.
  const streams = await p.evaluate(() => window.__mock.streams().length)
  await p.evaluate((path) => window.__mock.frame(path, "end", null), STREAM2)
  await p.waitForFunction((n) => window.__mock.streams().length === n + 1, streams)
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  await w1At(p)
  const ids = await p.$$eval("#messages .msg", (l) => l.map((x) => x.dataset.id))
  assert.equal(ids.length, count, "every message is still drawn")
  assert.equal(new Set(ids).size, ids.length, "none twice")
  assert.deepEqual(ids.slice(0, 13), [...older.map((m) => m.id), "h0"], "the earlier page first, then the newest")
  assert.equal(await p.locator(".thread__earlier").count(), 0, "no more to load, as before")
  const after = await offset()
  w1Ok(Math.abs(after - before) <= 1, `the message at the top is where it was (${before} -> ${after})`)
  // The summary replaced the messages: nothing drawn is in the answer, and the thread is at its end.
  await p.evaluate((m) => window.__mock.answer("GET /chats/chat2", { ...window.__mockConfig.routes["GET /chats/chat2"], messages: [m], more: false, live: null }), userMessage("s1", `The summary\n\n${"word ".repeat(2000)}`))
  await p.evaluate((path) => window.__mock.frame(path, "end", null), STREAM2)
  await p.waitForSelector('.msg[data-id="s1"]')
  assert.deepEqual(await p.$$eval("#messages .msg", (l) => l.map((x) => x.dataset.id)), ["s1"])
  const end = await w1At(p)
  w1Ok(end.gap <= 1, `its anchor gone, the thread is at its end (${end.gap})`)
  w1End(p)
})

test("RR: two readings of the open chat at once: both had, the reply is followed once; both failed, the chat is still whole and can be read again", async () => {
  const p = await page(w1Chat())
  await openChatRow(p, "chat2")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  const opened = () => p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "stream_open").length)
  const twice = async () => {
    const asked = await p.evaluate(() => window.__mock.api("GET", "/chats/chat2").filter((c) => c.args.path === "/chats/chat2").length)
    await p.evaluate(() => {
      window.__mockConfig.hold = ["GET /chats/chat2"]
      window.__mock.emit("open-chat", "chat2")
      window.__mock.emit("open-chat", "chat2")
    })
    await p.waitForFunction((n) => window.__mock.api("GET", "/chats/chat2").filter((c) => c.args.path === "/chats/chat2").length === n + 2, asked)
    await p.evaluate(() => window.__mock.release("GET /chats/chat2"))
  }
  const at = await opened()
  await twice()
  await p.waitForFunction((n) => window.__mock.calls.filter((c) => c.cmd === "stream_open").length > n, at)
  await p.waitForTimeout(200)
  assert.equal(await opened(), at + 1, "the older answer is dropped: the reply is followed once more, not twice")
  assert.equal(await p.locator(".msg.is-live").count(), 1)
  const count = await p.locator("#messages .msg").count()
  // Both fail.
  const good = await p.evaluate(() => window.__mockConfig.routes["GET /chats/chat2"])
  await p.evaluate(() => window.__mock.answer("GET /chats/chat2", { __error: { status: 502, detail: "The server did not answer." } }))
  await twice()
  await p.waitForSelector(".msg.is-live .msg__again")
  assert.equal(await p.locator(".msg__again").count(), 1, "said once")
  assert.equal(await p.locator("#messages .msg").count(), count)
  // The chat is the agent chat it was: its own commands still answer.
  await p.fill("#composer-text", "/mode")
  await p.focus("#composer-text")
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => /Modes: manual, edit, auto, plan/.test(document.getElementById("thread-note").textContent))
  await p.evaluate((was) => window.__mock.answer("GET /chats/chat2", was), good)
  await p.click(".msg__again")
  await p.waitForFunction((n) => window.__mock.calls.filter((c) => c.cmd === "stream_open").length === n + 2, at)
  await p.waitForSelector(".msg.is-live:not(:has(.msg__again))")
  assert.equal(await p.locator(".msg.is-live").count(), 1)
  assert.deepEqual(p.errors, [])
})

test("RR: a reply's stream lost and the chat not had: the card waiting for an answer stays, and the reply says so with Read again", async () => {
  const p = await page(w1Chat([["status", { text: "Waiting for you to allow bash…" }], ["ask", { cards: [deviceBashCard()] }]]))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#cards:not([hidden]) .ask")
  await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
  await p.evaluate(() => window.__mock.answer("GET /chats/chat2", { __error: { status: 502, detail: "The server did not answer." } }))
  await p.evaluate((path) => window.__mock.frame(path, "end", null), STREAM2)
  await p.waitForSelector(".msg.is-live .msg__again")
  assert.match(await p.textContent(".msg.is-live .msg__status"), /The server did not answer\./)
  assert.equal(await p.locator("#cards .ask").count(), 1, "the approval is still there to answer")
  assert.equal(await p.inputValue("#cards .ask__edit"), "ls -la build")
  assert.equal(await p.locator(".thread__loading").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("DM: an effort picked in the draft goes with its model: kept and sent while the model offers it, given up when the folder's model does not", async () => {
  const p = await page(dm())
  const effort = "#chat-settings .cchip:not(.cchip--model):not(.cchip--subagents)"
  const draftOn = async () => {
    await p.click("#new-chat-btn")
    await p.click(".kind__tab >> text=Agent")
    await pickDevice(p, "studio")
    await p.waitForSelector("#target-chips .cchip--folder.is-warn")
    await folderBy(p, "project")
    await modelSaid(p, "gpt-oss")
    await p.click(effort)
    await p.locator(".menu .menu__item", { hasText: "low" }).click()
    await p.waitForFunction((sel) => /low/.test(document.querySelector(sel)?.textContent || ""), effort)
  }
  await draftOn()
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  const first = (await p.evaluate(() => window.__mock.api("POST", "/chats")))[0].args.body
  assert.ok(first.effort === "low" && !("model" in first), `the picked effort, the model left to the server: ${JSON.stringify(first)}`)
  await p.waitForSelector('.msg--user[data-id="m9"]')
  // Another folder, another model (thinking on or off, no "low"): the effort is that model's own again.
  await draftOn()
  await folderBy(p, "Up a level")
  await modelSaid(p, "Qwen")
  await p.waitForFunction((sel) => !/low/.test(document.querySelector(sel)?.textContent || ""), effort)
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 2)
  const second = (await p.evaluate(() => window.__mock.api("POST", "/chats")))[1].args.body
  assert.ok(!("effort" in second) && !("model" in second), `no effort without the model it was picked for: ${JSON.stringify(second)}`)
  assert.deepEqual(p.errors, [])
})

test("DM: a folder's model the account's own list does not carry is shown as what the server says the chat starts on", async () => {
  const answer = AGENT_MODELS()
  const p = await page(dm({ "GET /models": models(), [startAt("token9", PROJECT)]: answer }))
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await pickDevice(p, "studio")
  await p.waitForSelector("#target-chips .cchip--folder.is-warn")
  await folderBy(p, "project")
  await modelSaid(p, "gpt-oss")
  assert.match(await p.getAttribute("#chat-settings .cchip--model", "title"), /the folder's usual model/)
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  assert.ok(!("model" in (await p.evaluate(() => window.__mock.api("POST", "/chats")))[0].args.body))
  assert.deepEqual(p.errors, [])
})

test("DP: no answer worth the name is said, never a list that loads for ever; a huge directory is drawn a part at a time; Cancel gives the focus back to the chip", async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ path: `${PROJECT}/pkg-${String(i).padStart(3, "0")}`, name: `pkg-${String(i).padStart(3, "0")}`, accepted: true, reason: "", model: null }))
  const p = await page(dp({ [`GET ${DIRS}${encodeURIComponent(PROJECT)}`]: dirAt(PROJECT, { parent: "/home/user", entries: many }), [`GET ${DIRS}${encodeURIComponent("/home/user")}`]: null }))
  await openPicker(p)
  assert.equal(await p.getAttribute("dialog[open]", "aria-labelledby"), "dirs-title")
  assert.match(await p.textContent("#dirs-title"), /studio/)
  await p.locator("dialog[open] .dirs__row", { hasText: "project" }).click()
  await dirWhere(p, PROJECT)
  assert.equal(await p.locator("dialog[open] .dirs__row:not(.dirs__row--up)").count(), 200)
  assert.equal(await p.textContent("dialog[open] .dirs__more"), "Show 200 more")
  await p.click("dialog[open] .dirs__more")
  await p.waitForFunction(() => document.querySelectorAll("dialog[open] .dirs__row:not(.dirs__row--up)").length === 400)
  assert.equal(await focused(p), "pkg-200", "on with the keys from where the list ended")
  await p.click("dialog[open] .dirs__more")
  await p.waitForFunction(() => document.querySelectorAll("dialog[open] .dirs__row:not(.dirs__row--up)").length === 450)
  assert.equal(await p.locator("dialog[open] .dirs__more").count(), 0)
  // Up, to a directory the server answers nothing for: said, the listing that was there kept.
  await p.locator("dialog[open] .dirs__row--up").click()
  await p.waitForSelector("dialog[open] .dirs__said:not([hidden])")
  assert.equal(await p.textContent("dialog[open] .dirs__said"), "The device did not answer.")
  assert.ok(await p.isHidden("dialog[open] .dirs__list[aria-busy]").catch(() => true))
  assert.equal(await p.locator("dialog[open] .dirs__list[aria-busy]").count(), 0, "not loading for ever")
  await p.click("dialog[open] .dialog__actions .btn:not(.btn--primary)")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  assert.ok(await p.evaluate(() => document.activeElement?.classList.contains("cchip--folder")), "Cancel: the focus is on the folder's chip")
  // Nothing at all for the places either: the path is what is left.
  await p.evaluate((key) => window.__mock.answer(key, null), `GET ${DIRS}`)
  await p.click("#target-chips .cchip--folder")
  await p.waitForSelector("dialog[open] .dirs__said:not([hidden])")
  assert.equal(await p.textContent("dialog[open] .dirs__said"), "The device did not answer.")
  assert.equal(await p.locator("dialog[open] .dirs__list[aria-busy]").count(), 0)
  await p.fill("dialog[open] .dirs__typed", "/home/user/other")
  await p.click("#dirs-use")
  await p.waitForFunction(() => /other/.test(document.querySelector("#target-chips .cchip--folder")?.textContent || ""))
  assert.deepEqual(p.errors, [])
})

test("ST: an Agentic task set to Chat and back keeps its computer, folder, mode and approval wait; saved as Chat, its watched command is given up and that is said", async () => {
  const on = fixture("schedule_on_device")
  for (const type of ["agentic", "chat"]) {
    const p = await page(st([bagEnd()], { "PATCH /schedules/sched3": on }))
    await openTask(p)
    await p.click("#sched-edit")
    await p.waitForSelector("#sched-cwd")
    assert.ok(await p.isChecked("#sched-type-agentic"))
    assert.ok(await p.isHidden("#sched-watch-lost"))
    await p.selectOption("#sched-runmode", "auto")
    await p.fill("#sched-wait", "45")
    await p.check("#sched-type-chat")
    await p.waitForSelector("#sched-cwd", { state: "detached" })
    assert.match(await p.textContent("#sched-watch-lost"), /saved as Chat, it runs every time/)
    assert.ok(await p.isVisible("#sched-watch-lost"))
    if (type === "agentic") {
      await p.check("#sched-type-agentic")
      await p.waitForSelector("#sched-cwd")
      assert.deepEqual([await p.inputValue("#sched-device"), await p.inputValue("#sched-cwd"), await p.inputValue("#sched-runmode"), await p.inputValue("#sched-wait")], ["tok1", "/home/frodo/waybread", "auto", "45"])
      assert.ok(await p.isHidden("#sched-watch-lost"))
    }
    await p.click("#sched-save")
    await p.waitForFunction(() => window.__mock.api("PATCH", "/schedules/sched3").length === 1)
    const body = (await p.evaluate(() => window.__mock.api("PATCH", "/schedules/sched3")))[0].args.body
    if (type === "agentic") {
      assert.deepEqual(body.runs_on, { device: "tok1", cwd: "/home/frodo/waybread", mode: "auto", approval_wait_minutes: 45 })
      assert.ok(!("watch" in body), "the watch is left alone")
    } else {
      assert.equal(body.runs_on, null)
      assert.equal(body.watch, "", "no computer, no command to watch")
    }
    assert.deepEqual(p.errors, [])
    await p.context().close()
  }
})

test("ST: words a server or a computer sends that are no words of the app's -- constructor, valueOf, __proto__ -- are drawn as they came, and the list stands", async () => {
  const agentic = fixture("schedule_run_agentic").run
  const cfg = st([WORKSTATION])
  const on = fixture("schedule_on_device")
  const hostile = ["constructor", "__proto__", "valueOf", "toString"]
  Object.assign(cfg.routes, {
    "GET /schedules/sched3": { schedule: { ...on.schedule, mode: "constructor", runs_on: { ...on.schedule.runs_on, mode: "valueOf" } } },
    "GET /schedules/sched3/runs": {
      runs: hostile.map((word, i) => ({ ...agentic, id: `run${i}`, status: i === 3 ? "constructor" : "ok", timing: word, model: { ...agentic.model, reason: word }, ran_on: { ...agentic.ran_on, mode: word } })),
      more: false,
    },
  })
  const p = await page(cfg)
  await openTask(p)
  await p.waitForSelector(".run[data-id='run3']")
  assert.equal(await p.locator(".run").count(), 4, "every run is drawn")
  assert.equal(await p.locator(".run__how, .run__late").count(), 0, "none of them is a way a model was chosen, or a timing")
  assert.deepEqual(await p.$$eval(".run__name", (l) => l.map((x) => x.textContent)), ["Qwen", "Qwen", "Qwen", "Qwen"])
  assert.equal(await p.textContent(".run[data-id='run3'] .schip"), "constructor", "a status the app has no word for, as it came")
  assert.match(await p.getAttribute(".run[data-id='run1'] .run__where", "title"), /__proto__/)
  assert.match(await p.textContent("#sched-folder-said"), /valueOf · approvals wait/)
  assert.match(await p.textContent(".fact:has(.fact__label:text-is('Runs'))"), /A new chat for each run/)
  assert.deepEqual(p.errors, [])
})

// --- REF: a model is its ref -- two connections may serve one id ------------------------------------

/** The server's models with a twin: Qwen on a second connection, the same id, another ref. */
function twins(over = {}) {
  const base = AGENT_MODELS(null)
  const qwen = base.models.find((m) => m.id === "qwen")
  return { ...base, models: [qwen, { ...qwen, ref: "plan/qwen", provider: "plan", connection: "Plan", default: false }, ...base.models.filter((m) => m.id !== "qwen")], ...over }
}

test("REF: two models with one id are told apart by their connection and chosen by their ref: the draft's picker, the folder's usual model, and what is sent", async () => {
  const p = await page(dm({ "GET /models": twins(), [startAt("token9", PROJECT)]: twins({ start: { model: "qwen", ref: "plan/qwen", from: "directory" } }) }))
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  // The default is the first Qwen; with a twin beside it, each says its connection.
  await modelSaid(p, "Qwen · Local")
  await p.click("#chat-settings .cchip--model")
  assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => [x.querySelector(".menu__label").textContent, x.getAttribute("aria-checked")])), [["Qwen · Local", "true"], ["Qwen · Plan", "false"], ["gpt-oss", "false"], ["Vision", "false"]])
  await p.keyboard.press("Escape")
  // The folder's model is the one on its own connection.
  await pickDevice(p, "studio")
  await p.waitForSelector("#target-chips .cchip--folder.is-warn")
  await folderBy(p, "project")
  await modelSaid(p, "Qwen · Plan")
  assert.match(await p.getAttribute("#chat-settings .cchip--model", "title"), /the folder's usual model/)
  await p.click("#chat-settings .cchip--model")
  assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => x.getAttribute("aria-checked"))), ["false", "true", "false", "false"])
  // Picked: the other twin, sent as its ref.
  await p.locator(".menu .menu__item", { hasText: "Qwen · Local" }).click()
  await modelSaid(p, "Qwen · Local")
  await p.fill("#composer-text", "Check the logs")
  await p.click("#send")
  await p.waitForFunction(() => window.__mock.api("POST", "/chats").length === 1)
  assert.equal((await p.evaluate(() => window.__mock.api("POST", "/chats")))[0].args.body.model, "local/qwen")
  assert.deepEqual(p.errors, [])
})

test("REF: an open chat's model is changed by ref; a schedule's model is offered and saved by ref, twins named by their connection; a run the computer refused says the computer's sentence", async () => {
  const sm = fixture("schedule_models")
  const qwen = sm.models.find((m) => m.id === "qwen")
  const agentic = fixture("schedule_run_agentic").run
  const said = "This schedule's session is open in a terminal on workstation."
  const cfg = st([WORKSTATION], {
    "GET /schedules/models": { ...sm, models: [...sm.models, { ...qwen, ref: "plan/qwen", provider: "plan", connection: "Plan" }] },
    "GET /schedules/sched3/runs": { runs: [{ ...agentic, id: "run7", status: "failed", error: { class: "device", text: said, reason: "terminal" } }], more: false },
    "GET /models": twins(),
    "GET /models?chat=chat1": twins(),
    "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?")], more: false, live: null },
    "PATCH /chats/chat1": { chat: chatRow() },
    "POST /schedules": { schedule: { ...fixture("schedule_on_device").schedule, id: "sched9" } },
  })
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  await modelSaid(p, "Qwen · Local")
  await p.click("#chat-settings .cchip--model")
  await p.locator(".menu .menu__item", { hasText: "Qwen · Plan" }).click()
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat1").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat1")))[0].args.body, { model: "plan/qwen" })
  // The run the computer refused: its own sentence, and why as the server names it.
  await openTask(p)
  await p.waitForSelector(".run[data-id='run7'] .run__error")
  assert.equal(await p.textContent(".run[data-id='run7'] .run__error"), said)
  assert.equal(await p.getAttribute(".run[data-id='run7'] .run__error", "data-reason"), "terminal")
  await p.keyboard.press("Control+k")
  await p.fill(".palette__input", "New scheduled")
  await p.keyboard.press("Enter")
  await p.waitForSelector("#sched-type")
  await p.check("#sched-type-agentic")
  await p.fill("#sched-words", "every day at 7:30 check the build")
  await p.click(".sched--new button[type=submit]")
  await p.waitForSelector("#sched-model")
  assert.deepEqual(await p.$$eval("#sched-model option", (l) => l.map((o) => [o.value, o.textContent])), [["", "The folder's usual model"], ["local/gpt-oss", "gpt-oss · busy"], ["local/qwen", "Qwen · Local"], ["plan/qwen", "Qwen · Plan"]])
  await p.selectOption("#sched-model", "plan/qwen")
  await p.fill("#sched-cwd", PROJECT)
  await p.click("#sched-save")
  assert.equal((await saved(p)).model, "plan/qwen")
  assert.deepEqual(p.errors, [])
})

// --- A9: `model_ref` says which connection a chat's, a message's and a schedule's model is on ----------
//
// Server 2.0.0-beta.17 sends `model_ref` beside `model` (App-API, "Which connection a model is
// on"): on a chat (single and listed), a message and a schedule, and as `model.ref` on a run. The
// line under a chat used to name the first connection serving the id, whichever the chat was on.

test("A9: a chat on the second of two connections serving one id says that connection -- its chip, a reply's model, a schedule and its run; a ref no model here has is the id as it is, never the twin", async () => {
  const on = fixture("schedule_on_device")
  const agentic = fixture("schedule_run_agentic").run
  const second = chatRow({ model: "qwen", model_ref: "plan/qwen" })
  const answer = { id: "m6", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", model_ref: "plan/qwen", metrics: null, steps: [{ kind: "text", markdown: "In leaves." }] }
  const gone = { ...answer, id: "m8", model_ref: "attic/qwen" }
  const old = { ...answer, id: "m7", model_ref: null }
  const task = { ...on.schedule, model: "qwen", model_ref: "plan/qwen" }
  const cfg = st([WORKSTATION], {
    "GET /models": twins(),
    "GET /models?chat=chat1": twins(),
    "GET /chats": { chats: [second, agentChat()], more: false },
    "GET /chats/chat1": { chat: second, messages: [userMessage("m5", "How is lembas made?"), answer, old, gone], more: false, live: null },
    "PATCH /chats/chat1": { chat: chatRow({ model: "qwen", model_ref: "local/qwen" }) },
    "GET /schedules": { schedules: [task] },
    "GET /schedules/sched3": { ...on, schedule: task },
    "GET /schedules/sched3/runs": { runs: [{ ...agentic, id: "run7", model: { ...agentic.model, id: "qwen", name: "Qwen", ref: "plan/qwen" } }], more: false },
    "PATCH /schedules/sched3": { schedule: task },
  })
  const p = await page(cfg)
  await openChatRow(p, "chat1")
  // The chip: the second connection, ticked in its menu.
  await modelSaid(p, "Qwen · Plan")
  assert.match(await p.getAttribute("#chat-settings .cchip--model", "title"), /Qwen · Plan/)
  await p.click("#chat-settings .cchip--model")
  assert.deepEqual(await p.$$eval(".menu .menu__item", (l) => l.map((x) => [x.querySelector(".menu__label").textContent, x.getAttribute("aria-checked")])).then((l) => l.slice(0, 2)), [["Qwen · Local", "false"], ["Qwen · Plan", "true"]])
  await p.keyboard.press("Escape")
  // Each reply's own model: by its ref; without one (an older server) by its id, the first
  // with it; with a ref nothing here has, the id as it came -- not the other connection's name.
  const said = await p.$$eval("#messages .msg__model", (l) => l.map((x) => [x.lastElementChild.textContent, x.title]))
  assert.deepEqual(said, [["Qwen · Plan", "plan/qwen"], ["Qwen · Local", "local/qwen"], ["qwen", "qwen"]])
  // Changing it sends the other's ref, and the chip follows the chat's new ref.
  await p.click("#chat-settings .cchip--model")
  await p.locator(".menu .menu__item", { hasText: "Qwen · Local" }).click()
  await p.waitForFunction(() => window.__mock.api("PATCH", "/chats/chat1").length === 1)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("PATCH", "/chats/chat1")))[0].args.body, { model: "local/qwen" })
  await modelSaid(p, "Qwen · Local")
  // The schedule: its model's connection, its run's, and the same one chosen where it is edited.
  await openTask(p)
  await p.waitForSelector(".run[data-id='run7']")
  assert.match(await p.textContent(".sched__model"), /Qwen · Plan$/)
  assert.equal(await p.textContent(".run[data-id='run7'] .run__name"), "Qwen · Plan")
  await p.click("#sched-edit")
  await p.waitForSelector("#sched-model")
  assert.equal(await p.inputValue("#sched-model"), "plan/qwen")
  await p.click("#sched-save")
  await p.waitForFunction(() => window.__mock.api("PATCH", "/schedules/sched3").length === 1)
  assert.equal((await p.evaluate(() => window.__mock.api("PATCH", "/schedules/sched3")))[0].args.body.model, "plan/qwen")
  assert.deepEqual(p.errors, [])
})

// --- F4: Files as a file manager ---------------------------------------------------------------
//
// The server's tab to parity with the web's explorer, on the routes the server gained after
// 2.0.0-beta.15 (App-API, "Files"): copy, save with its 409, raw bytes, the trash, versions,
// batch, zip. The shapes are the server's contract fixtures, as pinned (tests/ui/fixtures/SOURCE):
// files_listing (with `file_kind`), file_content (`sha`, `writable`), files_copied,
// file_save_conflict, files_trash, file_versions, files_batch.

const HOME = "/home/frodo"
const fileRow = (name, file_kind, mime, size = 27) => ({ name, path: `${HOME}/${name}`, kind: "file", file_kind, size, mime, updated_at: STAMP })
const F4_HOME = fixture("files_listing")
const F4_CONTENT = fixture("file_content")
const SHA = F4_CONTENT.sha
// A refusal as the bridge hands it on: the status, and the server's own sentence (`detail`).
const F4_CONFLICT = { status: 409, detail: fixture("file_save_conflict").detail }
const F4_TRASH = fixture("files_trash")
const F4_VERSIONS = fixture("file_versions")
const F4_BATCH = fixture("files_batch")
const q = (path) => `?path=${encodeURIComponent(path)}`

function f4(over = {}, commands = {}, extra = {}) {
  return {
    status: status(),
    routes: baseRoutes({
      "GET /files": F4_HOME,
      [`GET /files${q(`${HOME}/recipes`)}`]: { path: `${HOME}/recipes`, parent: HOME, entries: [{ name: "breads", path: `${HOME}/recipes/breads`, kind: "dir", file_kind: null, size: 0, mime: "", updated_at: STAMP }] },
      [`GET /files${q(`${HOME}/recipes/breads`)}`]: { path: `${HOME}/recipes/breads`, parent: `${HOME}/recipes`, entries: [] },
      "GET /files/content": F4_CONTENT,
      ...over,
    }),
    commands: {
      local_list: { root: "/home/dev/project", path: "", more: false, entries: [{ name: "src", path: "src", kind: "dir", size: 0, modified: 1767323045, file_kind: null }, { name: "README.md", path: "README.md", kind: "file", size: 10, modified: 1767323045, file_kind: "markdown" }, { name: "map.png", path: "map.png", kind: "file", size: 70, modified: 1767323045, file_kind: "image" }] },
      local_read: { root: "/home/dev/project", path: "README.md", name: "README.md", size: 10, text: "# Project\n", withheld: null, kind: "markdown", mime: "text/markdown", sha: SHA, writable: true },
      ...commands,
    },
    streams: {},
    ...extra,
  }
}

const serverRow = (name) => `#server-list .frow[data-path="${HOME}/${name}"]`
const rowMenu = async (p, sel, item) => {
  await p.click(`${sel} .frow__more`)
  await p.locator(".menu .menu__item", { hasText: new RegExp(`^${item.replace(/[.…]/g, "\\$&")}$`) }).click()
}
const statusSays = (p, id, text) => p.waitForFunction(([i, want]) => document.getElementById(i).textContent === want && !document.getElementById(i).hidden, [id, text])
const callsOf = (p, cmd) => p.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd)
const bodies = (p, method, path) => p.evaluate(([m, at]) => window.__mock.api(m, at).map((c) => c.args.body), [method, path])

test("F4: Move and Copy to… walk to the folder in a dialog -- no path is typed -- and say how it went", async () => {
  const p = await page(f4({ "POST /files/move": F4_HOME, "POST /files/copy": fixture("files_copied") }))
  await serverPane(p)
  await rowMenu(p, serverRow("lembas.md"), "Move")
  await p.waitForSelector("dialog[open] .fpick__row")
  assert.equal(await p.textContent("dialog[open] .dialog__title"), "Move to which folder?")
  assert.equal(await p.locator("dialog[open] input").count(), 0, "there is nowhere to type a path")
  // It opens where the list is, and names what would be chosen; a folder is entered with a click.
  assert.equal(await p.textContent("dialog[open] .fpick__chosen"), "Home")
  await p.click(`dialog[open] .fpick__row[data-path="${HOME}/recipes"]`)
  await p.waitForSelector(`dialog[open] .fpick__row[data-path="${HOME}/recipes/breads"]`)
  assert.equal(await p.textContent("dialog[open] .fpick__chosen"), "Home / recipes")
  await p.click(`dialog[open] .fpick__row[data-path="${HOME}/recipes/breads"]`)
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "Home / recipes / breads")
  assert.match(await p.textContent("dialog[open] .fpick__list"), /No directories here\./)
  // Back up through the crumbs, and chosen with the button.
  await p.locator("dialog[open] .crumbs__link", { hasText: "recipes" }).click()
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "Home / recipes")
  await shot(p, "f4-pick-1280")
  await p.click("#fpick-use")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/move").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/move"), [{ path: `${HOME}/lembas.md`, to: `${HOME}/recipes` }])
  await statusSays(p, "server-status", "Moved.")
  // A copy: the same dialog, the server's name for the copy said. Cancel sends nothing.
  await rowMenu(p, serverRow("lembas.md"), "Copy to…")
  await p.waitForSelector("dialog[open] .fpick__row")
  assert.equal(await p.textContent("dialog[open] .dialog__title"), "Copy to which folder?")
  await p.keyboard.press("Escape")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  assert.equal((await bodies(p, "POST", "/files/copy")).length, 0)
  await rowMenu(p, serverRow("lembas.md"), "Copy to…")
  await p.waitForSelector("dialog[open] .fpick__row")
  assert.equal(await p.textContent("#fpick-use"), "Copy here")
  await p.click("#fpick-use")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/copy").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/copy"), [{ path: `${HOME}/lembas.md`, to: HOME }])
  await statusSays(p, "server-status", "Copied as lembas (2).md.")
  // A refusal is the server's sentence, and stays.
  await p.evaluate(() => window.__mock.answer("POST /files/move", { __error: { status: 400, detail: "A folder cannot be moved inside itself." } }))
  await rowMenu(p, serverRow("recipes"), "Move")
  await p.waitForSelector("dialog[open] .fpick__row")
  await p.click("#fpick-use")
  await statusSays(p, "server-status", "A folder cannot be moved inside itself.")
  assert.ok(await p.$eval("#server-status", (x) => x.classList.contains("is-error") && x.getAttribute("role") === "alert"))
  // The dialog at 390 px: inside the window.
  await p.setViewportSize({ width: 390, height: 844 })
  await rowMenu(p, serverRow("lembas.md"), "Move")
  await p.waitForSelector("dialog[open] .fpick__row")
  const box = await p.locator("dialog[open]").boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the dialog is inside the window (${box.x}..${box.x + box.width})`)
  assert.ok(await noSideways(p, 390))
  await shot(p, "f4-pick-390")
  assert.deepEqual(p.errors, [])
})

test("F4: several ticked at once: a bar counts them and moves, copies, deletes or downloads them as a zip, and says which the server refused", async () => {
  const p = await page(f4({ "POST /files/batch": F4_BATCH }, { files_zip_save: { path: "/home/dev/Downloads/files.zip", size: 400 } }))
  await serverPane(p)
  assert.ok(await p.isHidden("#server-batch"), "no bar until something is ticked")
  await p.check(`${serverRow("lembas.md")} .frow__pick`)
  await p.waitForSelector("#server-batch:not([hidden])")
  assert.equal(await p.textContent("#server-batch .fx__count"), "1 selected")
  await p.check(`${serverRow("map.png")} .frow__pick`)
  assert.equal(await p.textContent("#server-batch .fx__count"), "2 selected")
  assert.deepEqual(await p.$$eval("#server-batch button", (l) => l.map((b) => b.textContent)), ["Move", "Copy to…", "Download as a zip", "Delete", "Clear the selection"])
  assert.ok(await p.$eval("#server-list .frow--head .frow__pick", (x) => x.indeterminate), "some, not all")
  // Every tick in one column, the head's with them.
  const ticks = await p.$$eval("#server-list .frow__pick", (l) => [...new Set(l.map((x) => Math.round(x.getBoundingClientRect().left)))])
  assert.equal(ticks.length, 1, `the ticks stand in one column: ${ticks}`)
  await shot(p, "f4-batch-1280")
  // Move: one request for all of them; what the server refused is said by its path.
  await p.locator("#server-batch button", { hasText: /^Move$/ }).click()
  await p.waitForSelector("dialog[open] .fpick__row")
  await p.click(`dialog[open] .fpick__row[data-path="${HOME}/recipes"]`)
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "Home / recipes")
  await p.click("#fpick-use")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/batch").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/batch"), [{ op: "move", paths: [`${HOME}/lembas.md`, `${HOME}/map.png`], to: `${HOME}/recipes` }])
  await statusSays(p, "server-status", `${HOME}/map.png: Read-only: ${HOME}/map.png can be read in this session but not changed.`)
  assert.ok(await p.$eval("#server-status", (x) => x.classList.contains("is-error")))
  await p.waitForSelector("#server-batch", { state: "hidden" })
  // Everything here, from the head's tick; a mount would not be among them.
  await p.waitForSelector(`${serverRow("lembas.md")} .frow__pick`)
  await p.check("#server-list .frow--head .frow__pick")
  assert.equal(await p.textContent("#server-batch .fx__count"), "3 selected")
  // As a zip, to where the person says: Rust is given the paths and nothing else.
  await p.locator("#server-batch button", { hasText: "Download as a zip" }).click()
  await statusSays(p, "server-status", "Saved. /home/dev/Downloads/files.zip")
  assert.deepEqual((await callsOf(p, "files_zip_save"))[0].paths, [`${HOME}/recipes`, `${HOME}/lembas.md`, `${HOME}/map.png`])
  // Delete: asked once for all, then one request.
  await p.evaluate(() => window.__mock.answer("POST /files/batch", { op: "delete", to: null, atomic: false, results: [], done: 3, failed: 0 }))
  await p.locator("#server-batch button", { hasText: /^Delete$/ }).click()
  assert.match(await p.textContent("dialog[open]"), /Move the 3 selected to the trash\? They can be restored from there\./)
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/batch").length === 2)
  assert.deepEqual((await bodies(p, "POST", "/files/batch"))[1], { op: "delete", paths: [`${HOME}/recipes`, `${HOME}/lembas.md`, `${HOME}/map.png`] })
  await statusSays(p, "server-status", "Moved to the trash: 3.")
  // Cleared, the bar goes.
  await p.waitForSelector(`${serverRow("lembas.md")} .frow__pick`)
  await p.check(`${serverRow("lembas.md")} .frow__pick`)
  await p.locator("#server-batch button", { hasText: "Clear the selection" }).click()
  await p.waitForSelector("#server-batch", { state: "hidden" })
  assert.equal(await p.isChecked(`${serverRow("lembas.md")} .frow__pick`), false)
  // At 390 px the bar wraps: every button of it inside the window, nothing scrolls sideways.
  await p.setViewportSize({ width: 390, height: 844 })
  await p.check("#server-list .frow--head .frow__pick")
  await p.waitForSelector("#server-batch:not([hidden])")
  const out = await p.$$eval("#server-batch button", (l) => l.filter((b) => b.getBoundingClientRect().left < 0 || b.getBoundingClientRect().right > 390).map((b) => b.textContent))
  assert.deepEqual(out, [], "the bar's buttons are inside the window")
  assert.ok(await noSideways(p, 390))
  await shot(p, "f4-batch-390")
  assert.deepEqual(p.errors, [])
})

test("F4: a row dragged onto a folder is moved there, with everything ticked when it is ticked; files dropped from the computer are uploaded into the folder under them", async () => {
  const p = await page(f4({ "POST /files/move": F4_HOME, "POST /files/batch": { ...F4_BATCH, results: [], done: 2, failed: 0 } }, { library_upload_dropped: { listing: F4_HOME, sent: 2, failed: [] } }))
  await serverPane(p)
  const centre = async (sel) => {
    const b = await p.locator(sel).boundingBox()
    return [b.x + Math.min(b.width / 2, 120), b.y + b.height / 2]
  }
  const drag = async (from, to, check) => {
    const [x, y] = await centre(from)
    const [tx, ty] = await centre(to)
    await p.mouse.move(x, y)
    await p.mouse.down()
    await p.mouse.move(x + 3, y + 3)
    await p.mouse.move((x + tx) / 2, (y + ty) / 2, { steps: 4 })
    await p.mouse.move(tx, ty, { steps: 4 })
    await check?.()
    await p.mouse.up()
  }
  // Onto a folder in the list: it says it would take it, and takes it.
  await drag(`${serverRow("lembas.md")} .frow__label`, `${serverRow("recipes")} .frow__label`, async () => {
    assert.equal(await p.textContent(".fdrag"), "lembas.md")
    assert.ok(await p.$eval(`#server-list .frow[data-path="/home/frodo/recipes"]`, (x) => x.classList.contains("is-drop")))
    await shot(p, "f4-drag-1280")
  })
  await p.waitForFunction(() => window.__mock.api("POST", "/files/move").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/move"), [{ path: `${HOME}/lembas.md`, to: `${HOME}/recipes` }])
  assert.equal(await p.locator(".fdrag").count(), 0)
  await statusSays(p, "server-status", "Moved.")
  assert.ok(await p.isHidden("#viewer"), "the click that ends a drag opens nothing")
  // Let go over nothing that takes it -- a file, itself, the folder it is in -- and nothing is sent.
  await p.waitForSelector(`${serverRow("map.png")} .frow__label`)
  await drag(`${serverRow("lembas.md")} .frow__label`, `${serverRow("map.png")} .frow__label`)
  await drag(`${serverRow("recipes")} .frow__label`, `${serverRow("recipes")} .frow__size`)
  await drag(`${serverRow("lembas.md")} .frow__label`, "#server-tree .ftree__root")
  await p.waitForTimeout(100)
  assert.equal((await bodies(p, "POST", "/files/move")).length, 1)
  // A ticked row carries the others ticked with it: onto the folder's line in the tree.
  await p.check(`${serverRow("lembas.md")} .frow__pick`)
  await p.check(`${serverRow("map.png")} .frow__pick`)
  await drag(`${serverRow("map.png")} .frow__label`, `#server-tree .ftree__row[data-path="${HOME}/recipes"]`, async () => assert.equal(await p.textContent(".fdrag"), "2 selected"))
  await p.waitForFunction(() => window.__mock.api("POST", "/files/batch").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/batch"), [{ op: "move", paths: [`${HOME}/lembas.md`, `${HOME}/map.png`], to: `${HOME}/recipes` }])
  // Files from the computer: held over the pane it shows where they would land; dropped on a
  // folder's row they go into that folder, anywhere else into the folder listed. The page is
  // told only where the drop was -- Rust has the paths.
  await p.waitForSelector(`${serverRow("recipes")} .frow__label`)
  await p.evaluate(() => window.__mock.emit("drag", true))
  assert.equal(await p.getAttribute("#pane-server", "data-drag"), "true")
  const [fx, fy] = await centre(`${serverRow("recipes")} .frow__label`)
  await p.evaluate(([x, y]) => (window.__mock.emit("drop-at", { x, y }), window.__mock.emit("drop", ["a.txt", "b.txt"])), [fx, fy])
  await p.waitForFunction(() => window.__mock.calls.filter((c) => c.cmd === "library_upload_dropped").length === 1)
  await p.evaluate(() => (window.__mock.emit("drop-at", { x: 5, y: 5 }), window.__mock.emit("drop", ["c.txt"])))
  await p.waitForFunction(() => window.__mock.calls.filter((c) => c.cmd === "library_upload_dropped").length === 2)
  assert.deepEqual(await callsOf(p, "library_upload_dropped"), [{ dir: `${HOME}/recipes` }, { dir: HOME }])
  assert.equal(await p.getAttribute("#pane-server", "data-drag"), "false")
  assert.equal((await callsOf(p, "attach_dropped")).length, 0, "a drop on Files is not an attachment")
  // While this computer's tab shows, a drop uploads nothing.
  await p.click('#files-tabs [data-tab="local"]')
  await p.evaluate(() => window.__mock.emit("drop", ["d.txt"]))
  await p.waitForTimeout(50)
  assert.equal((await callsOf(p, "library_upload_dropped")).length, 2)
  assert.deepEqual(p.errors, [])
})

test("F4: a text file is edited in the viewer and saved from what was read; changed meanwhile, both ways on are offered -- read it again, or save anyway", async () => {
  const p = await page(f4({ "PUT /files/content": { ...F4_CONTENT, sha: "ef".repeat(32), text: "# Lembas\n\nWrap it in a leaf. Twice.\n" } }), { width: 1280, height: 860 })
  await serverPane(p)
  await p.dblclick(`${serverRow("lembas.md")} .frow__open`)
  await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
  assert.deepEqual(await p.$$eval("#viewer-modes .seg", (l) => l.map((b) => [b.textContent, b.getAttribute("aria-pressed")])), [["Preview", "true"], ["Source", "false"], ["Edit", "false"]])
  assert.ok(await p.isDisabled("#viewer-save"), "nothing to save yet")
  await p.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
  await p.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
  await p.click("#viewer-body .cm-content")
  await p.keyboard.press("Control+End")
  await p.keyboard.type("Twice.")
  await p.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  assert.ok(await p.isEnabled("#viewer-save"))
  // Seen drawn before it is saved: the edit is kept across the modes.
  await p.locator("#viewer-modes .seg", { hasText: "Preview" }).click()
  await p.waitForSelector("#viewer-body .viewer__md")
  assert.match(await p.textContent("#viewer-body .viewer__md"), /Twice\./)
  await shot(p, "f4-edit-1280")
  await p.click("#viewer-save")
  await p.waitForFunction(() => window.__mock.api("PUT", "/files/content").length === 1)
  const first = (await bodies(p, "PUT", "/files/content"))[0]
  assert.deepEqual(Object.keys(first).sort(), ["base", "path", "text"])
  assert.equal(first.base, SHA, "saved from the sha that was read")
  assert.equal(first.path, `${HOME}/lembas.md`)
  assert.match(first.text, /Wrap it in a leaf\.\nTwice\.$/)
  // The server's answer is what is held now: its text differs from what was typed, so it is still unsaved.
  await p.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  // Someone else saved meanwhile: nothing is written, and the server's sentence offers both ways.
  await p.evaluate((refusal) => window.__mock.answer("PUT /files/content", { __error: refusal }), F4_CONFLICT)
  await p.click("#viewer-save")
  await p.waitForSelector("#viewer-bar.is-conflict")
  assert.equal(await p.textContent("#viewer-bar .viewer__said"), F4_CONFLICT.detail)
  assert.equal(await p.getAttribute("#viewer-bar .viewer__said", "role"), "alert")
  assert.deepEqual(await p.$$eval("#viewer-bar button", (l) => l.map((b) => b.textContent)), ["Reload", "Save anyway"])
  assert.equal((await bodies(p, "PUT", "/files/content"))[1].base, "ef".repeat(32), "from the sha the last save answered")
  await shot(p, "f4-conflict-1280")
  // Save anyway: the same text, forced, with no base.
  await p.evaluate((ok) => window.__mock.answer("PUT /files/content", ok), { ...F4_CONTENT, sha: "12".repeat(32), text: "forced" })
  await p.click("#viewer-force")
  await p.waitForFunction(() => window.__mock.api("PUT", "/files/content").length === 3)
  const forced = (await bodies(p, "PUT", "/files/content"))[2]
  assert.deepEqual(Object.keys(forced).sort(), ["force", "path", "text"])
  assert.equal(forced.force, true)
  await p.waitForFunction(() => !document.querySelector("#viewer-bar").classList.contains("is-conflict"))
  // Reload: the file as the server has it now, the edit gone.
  await p.evaluate((refusal) => window.__mock.answer("PUT /files/content", { __error: refusal }), F4_CONFLICT)
  await p.click("#viewer-save")
  await p.waitForSelector("#viewer-reload")
  const reads = await p.evaluate(() => window.__mock.api("GET", "/files/content").length)
  await p.click("#viewer-reload")
  await p.waitForFunction((n) => window.__mock.api("GET", "/files/content").length === n + 1, reads)
  await p.waitForSelector("#viewer-body .viewer__md")
  assert.equal(await p.textContent("#viewer-body .viewer__md h1"), "Lembas")
  assert.equal(await p.textContent("#viewer-bar .viewer__said"), "")
  // An edit that was not saved is not thrown away without a word: Close asks, and Cancel keeps it.
  await p.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
  await p.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
  await p.click("#viewer-body .cm-content")
  await p.keyboard.type("x")
  await p.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  await p.click("#viewer-close")
  assert.equal(await p.textContent("dialog[open] .dialog__title"), "Not saved yet")
  await p.locator("dialog[open] .btn", { hasText: "Cancel" }).click()
  assert.ok(await p.isVisible("#viewer"))
  // Ctrl+S in the editor saves.
  const before = (await bodies(p, "PUT", "/files/content")).length
  await p.click("#viewer-body .cm-content")
  await p.keyboard.press("Control+s")
  await p.waitForFunction((n) => window.__mock.api("PUT", "/files/content").length === n + 1, before)
  await p.click("#viewer-close")
  await p.click("dialog[open] .btn--danger")
  await p.waitForSelector("#viewer", { state: "hidden" })
  // A file the person may not write has no Edit and no Save.
  await p.evaluate((c) => window.__mock.answer("GET /files/content", c), { ...F4_CONTENT, writable: false, level: "ro" })
  await p.dblclick(`${serverRow("lembas.md")} .frow__open`)
  await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
  assert.deepEqual(await p.$$eval("#viewer-modes .seg", (l) => l.map((b) => b.textContent)), ["Preview", "Source"])
  assert.equal(await p.locator("#viewer-save").count(), 0)
  // At 390 px the line of the viewer and its buttons stay inside the window.
  await p.setViewportSize({ width: 390, height: 844 })
  assert.ok(await noSideways(p, 390))
  const out = await p.$$eval("#viewer button", (l) => l.filter((b) => b.getBoundingClientRect().width > 0 && (b.getBoundingClientRect().left < 0 || b.getBoundingClientRect().right > 390)).map((b) => b.textContent || b.id))
  assert.deepEqual(out, [])
  assert.deepEqual(p.errors, [])
})

test("F4: the trash lists what was deleted: restored, removed for good one by one, or emptied; a file's versions are listed, an older one restored or downloaded", async () => {
  const p = await page(
    f4(
      {
        "GET /files/trash": F4_TRASH,
        "POST /files/restore": { restored: `${HOME}/old.md`, items: [] },
        "DELETE /files/trash": { removed: 1, items: [] },
        "GET /files/versions": F4_VERSIONS,
        "POST /files/versions/restore": { ...F4_VERSIONS, versions: [{ ...F4_VERSIONS.versions[1], id: "ver3", current: true }, { ...F4_VERSIONS.versions[0], current: false }, F4_VERSIONS.versions[1]] },
      },
      { file_save_as: { path: "/home/dev/Downloads/lembas.md", size: 20 } },
    ),
  )
  await serverPane(p)
  await p.click("#server-trash")
  await p.waitForSelector("dialog[open] .ftrash__row")
  assert.equal(await p.textContent("dialog[open] .dialog__title"), "Trash")
  assert.equal(await p.textContent("dialog[open] .ftrash__name"), "old.md")
  assert.equal(await p.textContent("dialog[open] .ftrash__path"), `${HOME}/old.md`)
  await shot(p, "f4-trash-1280")
  // Removed for good only after asking.
  await p.click("dialog[open] .ftrash__remove")
  await p.waitForSelector("dialog[open] .btn--danger >> text=Remove for good")
  assert.match(await p.textContent("dialog[open]:has(.dialog__input, .muted) .muted"), /Remove “old\.md” for good\? This cannot be undone\./)
  await p.locator("dialog[open]:not(.dialog--wide) .btn", { hasText: "Cancel" }).click()
  assert.equal(await p.evaluate(() => window.__mock.api("DELETE", "/files/trash").length), 0)
  await p.click("dialog[open] .ftrash__remove")
  await p.click("dialog[open]:not(.dialog--wide) .btn--danger")
  await p.waitForFunction(() => window.__mock.api("DELETE", "/files/trash?id=node5").length === 1)
  await p.waitForFunction(() => /The trash is empty\./.test(document.querySelector(".ftrash__list").textContent))
  assert.equal(await p.textContent(".ftrash__said"), "Removed for good.")
  assert.ok(await p.isDisabled("#ftrash-empty"), "nothing left to empty")
  await p.locator(".ftrash .dialog__actions .btn", { hasText: "Close" }).click()
  // Restored: it is back, and the list behind is read again.
  const lists = await p.evaluate(() => window.__mock.api("GET", "/files?path=%2F").length)
  await p.click("#server-trash")
  await p.waitForSelector("dialog[open] .ftrash__row")
  await p.click("dialog[open] .ftrash__restore")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/restore").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/restore"), [{ id: "node5" }])
  await p.waitForFunction(() => document.querySelector(".ftrash__said").textContent === "Restored.")
  await p.waitForFunction((n) => window.__mock.api("GET", "/files?path=%2F").length > n, lists)
  await p.keyboard.press("Escape")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  // Emptied, after asking.
  await p.click("#server-trash")
  await p.waitForSelector("dialog[open] .ftrash__row")
  await p.click("#ftrash-empty")
  assert.match(await p.textContent("dialog[open]:not(.dialog--wide)"), /Remove everything in the trash for good\? This cannot be undone\./)
  await p.click("dialog[open]:not(.dialog--wide) .btn--danger")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "api" && c.args.method === "DELETE" && c.args.path === "/files/trash"))
  await p.keyboard.press("Escape")
  await p.waitForSelector("dialog[open]", { state: "detached" })
  // Versions: newest first, the current one marked and with nothing to restore; the columns hold.
  await rowMenu(p, serverRow("lembas.md"), "Versions")
  await p.waitForSelector("dialog[open] .fvers__row")
  assert.match(await p.textContent("dialog[open] .dialog__title"), /Versions.*lembas\.md/)
  assert.deepEqual(await p.$$eval(".fvers__row", (l) => l.map((r) => [r.dataset.id, r.getAttribute("aria-current"), r.querySelectorAll("button").length])), [["ver2", "true", 0], ["ver1", null, 2]])
  const sizes = await p.$$eval(".fvers__size", (l) => [...new Set(l.map((x) => Math.round(x.getBoundingClientRect().right)))])
  assert.equal(sizes.length, 1, `sizes end on one line: ${sizes}`)
  await shot(p, "f4-versions-1280")
  await p.click(".fvers__row[data-id=ver1] .fvers__get")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "file_save_as"))
  assert.deepEqual((await callsOf(p, "file_save_as"))[0], { path: `${HOME}/lembas.md`, name: "lembas.md", version: "ver1", title: "Download" })
  await p.click(".fvers__row[data-id=ver1] .fvers__restore")
  assert.match(await p.textContent("dialog[open]:not(.dialog--wide)"), /Make this version the current one\? The current one stays in the list\./)
  await p.click("dialog[open]:not(.dialog--wide) .btn--primary")
  await p.waitForFunction(() => window.__mock.api("POST", "/files/versions/restore").length === 1)
  assert.deepEqual(await bodies(p, "POST", "/files/versions/restore"), [{ path: `${HOME}/lembas.md`, version: "ver1" }])
  await p.waitForFunction(() => document.querySelectorAll(".fvers__row").length === 3)
  assert.equal(await p.textContent(".fvers__said"), "That version is the current one again.")
  assert.equal(await p.getAttribute(".fvers__row[data-id=ver3]", "aria-current"), "true")
  // Both dialogs at 390 px: inside the window, their buttons too.
  await p.setViewportSize({ width: 390, height: 844 })
  const inside = () => p.$$eval("dialog[open], dialog[open] button", (l) => l.filter((b) => b.getBoundingClientRect().width > 0 && (b.getBoundingClientRect().left < 0 || b.getBoundingClientRect().right > 390)).map((b) => b.className))
  assert.deepEqual(await inside(), [])
  await shot(p, "f4-versions-390")
  await p.keyboard.press("Escape")
  await p.click("#server-trash")
  await p.waitForSelector("dialog[open] .ftrash__row")
  assert.deepEqual(await inside(), [])
  await shot(p, "f4-trash-390")
  assert.deepEqual(p.errors, [])
})

test("F4: a file is drawn by what the server says it is: a picture and an SVG as images only, sound and video in the webview's players, a table, a notebook as text, the rest as details and a download", async () => {
  const csv = `name,note\n"Sam, the gardener","said ""hello"""\n<script>document.title = "a cell ran"</script>,2\n${Array.from({ length: 600 }, (_, i) => `row${i},${i}`).join("\n")}\n`
  const nb = JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Baking\n", "<img src=x onerror=\"document.title='a cell ran'\">"] },
      { cell_type: "code", execution_count: 3, source: "print('<b>hot</b>')", outputs: [{ output_type: "stream", text: ["<b>hot</b>\n"] }, { output_type: "display_data", data: { "text/html": "<script>document.title = 'a cell ran'</script>", "text/plain": "<Figure>", "image/png": MEDIA_PNG.toString("base64") } }, { output_type: "error", ename: "ValueError", evalue: "too dry", traceback: ["\u001b[31mValueError\u001b[0m: too dry"] }] },
    ],
  })
  const rows = [
    fileRow("map.png", "image", "image/png", 70),
    fileRow("mark.svg", "svg", "image/svg+xml", 200),
    fileRow("song.wav", "audio", "audio/wav", 844),
    fileRow("broken.mp4", "video", "video/mp4", 844),
    fileRow("stock.csv", "table", "text/csv", csv.length),
    fileRow("bake.ipynb", "notebook", "application/x-ipynb+json", nb.length),
    fileRow("all.zip", "archive", "application/zip", 5000),
    fileRow("plan.pdf", "pdf", "application/pdf", 9000),
    fileRow("cup.glb", "model3d", "model/gltf-binary", 9000),
    // What it is called is not believed: a "picture" the server found to be a binary.
    fileRow("fake.png", "binary", "application/octet-stream", 12),
  ]
  const none = (name, kind, mime, size) => ({ path: `${HOME}/${name}`, name, size, mime, kind, file_kind: kind, level: "commit", writable: true, language: "", sha: SHA, text: "", withheld: { reason: "not_text", message: "This is not a text file, so it is not shown here." } })
  const content = Object.fromEntries(rows.map((r) => [`GET /files/content${q(r.path)}`, none(r.name, r.file_kind, r.mime, r.size)]))
  content[`GET /files/content${q(`${HOME}/mark.svg`)}`] = { ...none("mark.svg", "svg", "image/svg+xml", 200), text: MEDIA_SVG, withheld: undefined, language: "xml" }
  content[`GET /files/content${q(`${HOME}/stock.csv`)}`] = { ...none("stock.csv", "table", "text/csv", csv.length), text: csv, withheld: undefined }
  content[`GET /files/content${q(`${HOME}/bake.ipynb`)}`] = { ...none("bake.ipynb", "notebook", "application/x-ipynb+json", nb.length), text: nb, withheld: undefined, language: "json" }
  const p = await page(f4({ "GET /files": { ...F4_HOME, entries: rows }, ...content }, { file_save_as: { path: "/home/dev/Downloads/all.zip", size: 5000 } }, { mediaBytes: [...MEDIA_WAV] }), { width: 1600, height: 900 })
  await p.evaluate(() => document.getElementById("nav-files").click())
  await p.click('#files-tabs [data-tab="server"]')
  const open = async (name) => {
    await p.waitForSelector(serverRow(name))
    await p.dblclick(`${serverRow(name)} .frow__open`)
    await p.waitForFunction((n) => !document.getElementById("viewer").hidden && document.getElementById("viewer-name").textContent === n, name)
  }
  // A picture: an <img> at the address Rust serves -- asked for by its path and kind, never a token.
  await open("map.png")
  await p.waitForFunction(() => document.querySelector("#viewer-body img.viewer__image")?.naturalWidth === 1)
  const asked = (await callsOf(p, "media_open")).at(-1)
  assert.deepEqual(asked, { source: "server", kind: "image", path: `${HOME}/map.png` })
  assert.equal(await p.getAttribute("#viewer-body img", "alt"), "map.png")
  // The row's icon is the kind's, and the details show the picture.
  assert.ok(await p.$eval(serverRow("map.png"), (r) => r.querySelector(".frow__icon").classList.contains("frow__icon--image")))
  await p.click(`${serverRow("map.png")} .frow__open`)
  await p.waitForFunction(() => document.querySelector("#server-details .fdetails__picture")?.naturalWidth === 1)
  // An SVG: an image and nothing else -- no frame, no inline <svg>, and what it carries does not run.
  await open("mark.svg")
  await p.waitForFunction(() => document.querySelector("#viewer-body img.viewer__image")?.naturalWidth === 40)
  assert.equal(await p.locator("#viewer-body iframe, #viewer-body svg:not(.icon), #viewer-body object, #viewer-body embed").count(), 0)
  assert.equal((await callsOf(p, "media_open")).at(-1).kind, "svg")
  // ... and its source can be read, as text.
  await p.locator("#viewer-modes .seg", { hasText: "Source" }).click()
  await p.waitForSelector("#viewer-body .cm-content")
  assert.match(await p.textContent("#viewer-body .cm-content"), /<script>document\.title = "an svg ran"<\/script>/)
  assert.equal(await p.locator("#viewer-body img").count(), 0)
  // Sound: the webview's own player, on the address; it knows the length, so it can seek.
  await open("song.wav")
  await p.waitForFunction(() => document.querySelector("#viewer-body audio")?.duration > 0)
  assert.ok(await p.$eval("#viewer-body audio", (a) => a.controls && a.src.startsWith("http://media.test/audio/")))
  assert.equal(await p.textContent("#viewer-bar .btn"), "Download")
  await shot(p, "f4-audio-1600")
  // A player that will not take the address is handed the file whole, once: a blob, which plays.
  await open("broken.mp4")
  await p.waitForFunction(() => document.querySelector("#viewer-body video")?.src.startsWith("blob:"))
  await p.waitForFunction(() => document.querySelector("#viewer-body video").duration > 0)
  assert.equal((await callsOf(p, "media_bytes")).length, 1)
  // A table: the first row its head, quoted fields whole, markup as the text it is, and a cap.
  await open("stock.csv")
  await p.waitForSelector("#viewer-body table.vtable")
  assert.deepEqual(await p.$$eval("#viewer-body thead th", (l) => l.map((x) => x.textContent)), ["name", "note"])
  assert.deepEqual(await p.$$eval("#viewer-body tbody tr:nth-child(-n+2) td", (l) => l.map((x) => x.textContent)), ["Sam, the gardener", 'said "hello"', '<script>document.title = "a cell ran"</script>', "2"])
  assert.equal(await p.locator("#viewer-body tbody tr").count(), 499, "500 rows with the head")
  assert.equal(await p.textContent("#viewer-body .viewer__cap"), "Only the first 500 rows are shown.")
  // The table scrolls in its own box, both ways; the viewer does not.
  assert.ok(await p.$eval("#viewer-body .vtable__scroll", (x) => x.scrollHeight > x.clientHeight && getComputedStyle(x).overflowY === "auto"))
  assert.ok(await p.$eval("#viewer-body", (x) => x.scrollHeight <= x.clientHeight + 1))
  await shot(p, "f4-table-1600")
  // A notebook: its cells as text -- markup shown, not made -- and a picture among the outputs.
  await open("bake.ipynb")
  await p.waitForSelector("#viewer-body .viewer__nb")
  assert.match(await p.textContent("#viewer-body .nbcell--words"), /# Baking\n<img src=x onerror=/)
  assert.equal(await p.textContent("#viewer-body .nbcell__code"), "print('<b>hot</b>')")
  assert.deepEqual(await p.$$eval("#viewer-body .nbcell__out", (l) => l.map((x) => x.textContent)), ["<b>hot</b>\n", "ValueError: too dry"])
  assert.equal(await p.textContent("#viewer-body .nbcell__n"), "[3]")
  assert.equal(await p.locator("#viewer-body .nbcell b, #viewer-body script, #viewer-body .nbcell--words img, #viewer-body iframe").count(), 0)
  await p.waitForFunction(() => document.querySelector("#viewer-body .nbcell__picture")?.naturalWidth === 1)
  assert.ok((await p.getAttribute("#viewer-body .nbcell__picture", "src")).startsWith("data:image/png;base64,"))
  await shot(p, "f4-notebook-1600")
  // An archive and a binary: what it is, and a way to save it -- to a place the person chooses
  // in the system's dialog, written there by Rust. (A PDF and a 3D model: the MD tests.)
  for (const [name, mime] of [["all.zip", "application/zip"], ["fake.png", "application/octet-stream"]]) {
    await open(name)
    await p.waitForSelector("#viewer-body .viewer__facts")
    assert.match(await p.textContent("#viewer-body .viewer__facts"), new RegExp(mime.replace(/[.+/]/g, "\\$&")), name)
    assert.equal(await p.locator("#viewer-body img, #viewer-body iframe, #viewer-body embed, #viewer-body object").count(), 0, `${name} is not drawn`)
    assert.equal(await p.textContent("#viewer-body .viewer__do .btn"), "Download")
  }
  await open("all.zip")
  await p.click("#viewer-body .viewer__do .btn")
  await statusSays(p, "server-status", "Saved. /home/dev/Downloads/all.zip")
  assert.deepEqual((await callsOf(p, "file_save_as")).at(-1), { path: `${HOME}/all.zip`, name: "all.zip", version: null, title: "Download" })
  // Nothing any of them carried ran.
  assert.equal(await p.title(), "LLeMbas")
  assert.deepEqual(p.errors, [])
})

// This computer's tab: the same hands, each a command Rust answers inside the agent's folders
// (src-tauri/src/files.rs checks every path, and its tests say what is refused). The page names
// the folder it shows and paths inside it, never a path of its own making.

const ROOT = "/home/dev/project"
const localRow = (name) => `#local-list .frow[data-path="${name}"]`
async function localPaneOpen(p) {
  await p.evaluate(() => document.getElementById("nav-files").click())
  await p.waitForSelector(localRow("README.md"))
}

test("F4: this computer's folder is managed like the server's: new file and folder, rename, move and copy through the dialog, several at once, delete to the system's trash -- each said as Rust answered it", async () => {
  const ok = (path, to) => ({ path, ok: true, to: to ?? null, error: null })
  const p = await page(f4({}, { local_make: "notes.md", local_rename: "READ.md", local_transfer: [ok("README.md", "src/README.md")], local_delete: [ok("README.md")] }))
  await localPaneOpen(p)
  assert.ok(await p.isVisible("#local-mkdir") && (await p.isVisible("#local-mkfile")))
  // New file and new folder, in the folder listed and in a folder's own menu.
  await p.click("#local-mkfile")
  assert.match(await p.textContent("dialog[open]"), /What should the file be called\? With its extension, such as notes\.md\./)
  await p.fill("dialog[open] .dialog__input", "notes.md")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "local_make"))
  await p.waitForFunction(() => window.__mock.calls.filter((c) => c.cmd === "local_list").length >= 2 && !document.querySelector("dialog[open]"))
  await p.waitForSelector(`${localRow("src")} .frow__more`)
  await rowMenu(p, localRow("src"), "New folder")
  await p.fill("dialog[open] .dialog__input", "lib")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.calls.filter((c) => c.cmd === "local_make").length === 2)
  assert.deepEqual(await callsOf(p, "local_make"), [{ root: ROOT, dir: "", name: "notes.md", folder: false }, { root: ROOT, dir: "src", name: "lib", folder: true }])
  await statusSays(p, "local-status", "Folder made.")
  // Rename.
  await p.waitForSelector(`${localRow("README.md")} .frow__more`)
  await rowMenu(p, localRow("README.md"), "Rename")
  await p.fill("dialog[open] .dialog__input", "READ.md")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "local_rename"))
  assert.deepEqual(await callsOf(p, "local_rename"), [{ root: ROOT, path: "README.md", name: "READ.md" }])
  // Move, through the dialog: it walks this folder and nothing above it.
  await p.waitForSelector(`${localRow("README.md")} .frow__more`)
  await rowMenu(p, localRow("README.md"), "Move")
  await p.waitForSelector('dialog[open] .fpick__row[data-path="src"]')
  assert.equal(await p.textContent("dialog[open] .fpick__chosen"), "project")
  assert.equal(await p.locator("dialog[open] .crumbs__link").count(), 0, "the top is the agent's folder: no way above it")
  await p.click('dialog[open] .fpick__row[data-path="src"]')
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "project / src")
  await p.click("#fpick-use")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "local_transfer"))
  assert.deepEqual((await callsOf(p, "local_transfer"))[0], { root: ROOT, paths: ["README.md"], to: "src", copy: false })
  await statusSays(p, "local-status", "Moved.")
  // Copy: the name Rust gave the copy is said.
  await p.evaluate((r) => (window.__mockConfig.commands.local_transfer = r), [ok("README.md", "README (2).md")])
  await p.waitForSelector(`${localRow("README.md")} .frow__more`)
  await rowMenu(p, localRow("README.md"), "Copy to…")
  await p.waitForSelector('dialog[open] .fpick__row[data-path="src"]')
  await p.click("#fpick-use")
  await statusSays(p, "local-status", "Copied as README (2).md.")
  assert.deepEqual((await callsOf(p, "local_transfer"))[1], { root: ROOT, paths: ["README.md"], to: "", copy: true })
  // Several at once; what Rust refused is said by its path, and the rest is done.
  await p.evaluate((r) => (window.__mockConfig.commands.local_transfer = r), [ok("README.md", "src/README.md"), { path: "map.png", ok: false, to: null, error: "There is already something called map.png here." }])
  await p.waitForSelector(`${localRow("README.md")} .frow__pick`)
  await p.check(`${localRow("README.md")} .frow__pick`)
  await p.check(`${localRow("map.png")} .frow__pick`)
  assert.deepEqual(await p.$$eval("#local-batch button", (l) => l.map((b) => b.textContent)), ["Move", "Copy to…", "Delete", "Clear the selection"])
  await p.locator("#local-batch button", { hasText: /^Move$/ }).click()
  await p.waitForSelector('dialog[open] .fpick__row[data-path="src"]')
  await p.click('dialog[open] .fpick__row[data-path="src"]')
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "project / src")
  await p.click("#fpick-use")
  await statusSays(p, "local-status", "map.png: There is already something called map.png here.")
  assert.deepEqual((await callsOf(p, "local_transfer"))[2], { root: ROOT, paths: ["README.md", "map.png"], to: "src", copy: false })
  // A row dragged onto a folder.
  await p.evaluate((r) => (window.__mockConfig.commands.local_transfer = r), [ok("map.png", "src/map.png")])
  await p.waitForSelector(`${localRow("map.png")} .frow__label`)
  const from = await p.locator(`${localRow("map.png")} .frow__label`).boundingBox()
  const to = await p.locator(`${localRow("src")} .frow__label`).boundingBox()
  await p.mouse.move(from.x + 10, from.y + 5)
  await p.mouse.down()
  await p.mouse.move(from.x + 20, from.y + 15, { steps: 3 })
  await p.mouse.move(to.x + 10, to.y + 5, { steps: 4 })
  assert.equal(await p.locator(".fdrag").count(), 1, "one thing is dragged, however often the pane was drawn")
  await p.mouse.up()
  await p.waitForFunction(() => window.__mock.calls.filter((c) => c.cmd === "local_transfer").length === 4)
  assert.deepEqual((await callsOf(p, "local_transfer"))[3], { root: ROOT, paths: ["map.png"], to: "src", copy: false })
  // Delete: asked first; a refusal (the CLI's own file, say) is Rust's sentence, as an error.
  await p.waitForSelector(`${localRow("README.md")} .frow__more`)
  await rowMenu(p, localRow("README.md"), "Delete")
  assert.match(await p.textContent("dialog[open]"), /Move “README\.md” to the trash\? It can be restored from there\./)
  await p.click("dialog[open] .btn--danger")
  await statusSays(p, "local-status", "Moved to the trash.")
  assert.deepEqual(await callsOf(p, "local_delete"), [{ root: ROOT, paths: ["README.md"] }])
  await p.evaluate((r) => (window.__mockConfig.commands.local_delete = r), [{ path: "README.md", ok: false, to: null, error: "/home/dev/project/README.md belongs to the LLeMbas CLI: the app reads it and never changes it." }])
  await p.waitForSelector(`${localRow("README.md")} .frow__more`)
  await rowMenu(p, localRow("README.md"), "Delete")
  await p.click("dialog[open] .btn--danger")
  await p.waitForFunction(() => /belongs to the LLeMbas CLI/.test(document.getElementById("local-status").textContent))
  assert.ok(await p.$eval("#local-status", (x) => x.classList.contains("is-error")))
  await p.evaluate(() => (window.__mockConfig.commands.local_make = { __error: { status: 400, detail: "There is already something called notes.md here." } }))
  await p.click("#local-mkfile")
  await p.fill("dialog[open] .dialog__input", "notes.md")
  await p.click("dialog[open] .btn--primary")
  await statusSays(p, "local-status", "There is already something called notes.md here.")
  // At 390 px: the bar's tools and the status inside the window.
  await p.setViewportSize({ width: 390, height: 844 })
  assert.ok(await noSideways(p, 390))
  const out = await p.$$eval("#pane-local button", (l) => l.filter((b) => b.getBoundingClientRect().width > 0 && (b.getBoundingClientRect().left < -1 || b.getBoundingClientRect().right > 391)).map((b) => b.id || b.className))
  assert.deepEqual(out, [])
  await shot(p, "f4-local-390")
  assert.deepEqual(p.errors, [])
})

test("F4: a file on this computer is edited and saved, a picture drawn from its own bytes; a file is copied to the server and one brought from it, each into a folder walked to", async () => {
  const p = await page(
    f4(
      {},
      {
        local_write: { root: ROOT, path: "README.md", name: "README.md", size: 14, text: "# Project\nnew\n", withheld: null, kind: "markdown", mime: "text/markdown", sha: "ef".repeat(32), writable: true },
        local_upload: { listing: F4_HOME, sent: 1, failed: [] },
        local_download: "src/lembas.md",
      },
    ),
    { width: 1280, height: 860 },
  )
  await localPaneOpen(p)
  // Edited and saved: from the sha Rust read; a file changed meanwhile offers both ways on.
  await p.dblclick(`${localRow("README.md")} .frow__open`)
  await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
  assert.equal(await p.textContent("#viewer-where"), "This computer")
  await p.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
  await p.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
  await p.click("#viewer-body .cm-content")
  await p.keyboard.press("Control+End")
  await p.keyboard.type("new")
  await p.click("#viewer-save")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "local_write"))
  assert.deepEqual((await callsOf(p, "local_write"))[0], { root: ROOT, path: "README.md", text: "# Project\nnew", base: SHA, force: false })
  await p.evaluate((refusal) => (window.__mockConfig.commands.local_write = { __error: refusal }), F4_CONFLICT)
  await p.click("#viewer-body .cm-content")
  await p.keyboard.type("!")
  await p.click("#viewer-save")
  await p.waitForSelector("#viewer-bar.is-conflict")
  assert.deepEqual(await p.$$eval("#viewer-bar button", (l) => l.map((b) => b.textContent)), ["Reload", "Save anyway"])
  assert.equal((await callsOf(p, "local_write"))[1].base, "ef".repeat(32))
  await p.evaluate(() => (window.__mockConfig.commands.local_write = { root: "/home/dev/project", path: "README.md", name: "README.md", size: 15, text: "forced", sha: "12".repeat(32), writable: true, kind: "markdown", mime: "text/markdown", withheld: null }))
  await p.click("#viewer-force")
  await p.waitForFunction(() => window.__mock.calls.filter((c) => c.cmd === "local_write").length === 3)
  const forced = (await callsOf(p, "local_write"))[2]
  assert.deepEqual([forced.base, forced.force], [null, true])
  await p.click("#viewer-close")
  if (await p.locator("dialog[open]").count()) await p.click("dialog[open] .btn--danger")
  // One of the CLI's own files, as Rust says it: read, with no Edit.
  await p.evaluate(() => (window.__mockConfig.commands.local_read = { root: "/home/dev/project", path: "README.md", name: "README.md", size: 10, text: "# Project\n", withheld: null, kind: "markdown", mime: "text/markdown", sha: "ab".repeat(32), writable: false }))
  await p.dblclick(`${localRow("README.md")} .frow__open`)
  await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
  assert.deepEqual(await p.$$eval("#viewer-modes .seg", (l) => l.map((b) => b.textContent)), ["Preview", "Source"])
  // A picture: drawn from the file's own bytes, at an address asked for by folder and path.
  await p.evaluate(() => (window.__mockConfig.commands.local_read = { root: "/home/dev/project", path: "map.png", name: "map.png", size: 70, text: null, withheld: "binary", kind: "image", mime: "image/png", sha: null, writable: true }))
  await p.dblclick(`${localRow("map.png")} .frow__open`)
  await p.waitForFunction(() => document.querySelector("#viewer-body img.viewer__image")?.naturalWidth === 1)
  assert.deepEqual((await callsOf(p, "media_open")).at(-1), { source: "local", kind: "image", root: ROOT, path: "map.png" })
  assert.equal(await p.locator("#viewer-bar .btn").count(), 0, "it is on this computer already: nothing to download")
  await p.click("#viewer-close")
  // To the server: the folder there is walked to, and Rust sends the file (checked against the folders first).
  await rowMenu(p, localRow("README.md"), "Copy to the server…")
  await p.waitForSelector(`dialog[open] .fpick__row[data-path="${HOME}/recipes"]`)
  assert.equal(await p.textContent("dialog[open] .fpick__chosen"), "Home")
  await p.click(`dialog[open] .fpick__row[data-path="${HOME}/recipes"]`)
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "Home / recipes")
  await p.click("#fpick-use")
  await statusSays(p, "local-status", "Uploaded.")
  assert.deepEqual(await callsOf(p, "local_upload"), [{ root: ROOT, paths: ["README.md"], dir: `${HOME}/recipes` }])
  // What the server did not take is said.
  await p.evaluate(() => (window.__mockConfig.commands.local_upload = { listing: null, sent: 0, failed: [{ name: "README.md", error: "README.md is larger than 20 MB, the most that can be uploaded here." }] }))
  await rowMenu(p, localRow("README.md"), "Copy to the server…")
  await p.waitForSelector("dialog[open] .fpick__row")
  await p.click("#fpick-use")
  await statusSays(p, "local-status", "README.md: README.md is larger than 20 MB, the most that can be uploaded here.")
  // From the server: into one of the agent's folders, under the name Rust found free there.
  await p.click('#files-tabs [data-tab="server"]')
  await p.waitForSelector(serverRow("lembas.md"))
  await rowMenu(p, serverRow("lembas.md"), "Copy to this computer…")
  await p.waitForSelector('dialog[open] .fpick__row[data-path="src"]')
  await p.click('dialog[open] .fpick__row[data-path="src"]')
  await p.waitForFunction(() => document.querySelector("dialog[open] .fpick__chosen").textContent === "project / src")
  await p.click("#fpick-use")
  await statusSays(p, "server-status", "Copied as lembas.md.")
  assert.deepEqual(await callsOf(p, "local_download"), [{ root: ROOT, dir: "src", path: `${HOME}/lembas.md`, name: "lembas.md" }])
  // A folder is not offered either way.
  await p.click(`${serverRow("recipes")} .frow__more`)
  assert.equal(await p.locator(".menu .menu__item", { hasText: "Copy to this computer…" }).count(), 0)
  await p.keyboard.press("Escape")
  assert.deepEqual(p.errors, [])
})

// --- MD: what a model made, the sealed viewers, and the small things of the media round -------------
//
// The shapes are the server's contract fixtures (tool_media, media_job*, mcp_servers,
// file_create_exists), as pinned.

const MADE = fixture("tool_media").calls
const GENERATED = `${HOME}/Generated`
function md(over = {}, commands = {}, extra = {}) {
  const made = { id: "m2", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: null, steps: [{ index: 0, kind: "tools", open: false, calls: MADE }, { index: 1, kind: "text", open: true, markdown: "A kite, and a video of it on its way." }] }
  return {
    status: status(),
    routes: baseRoutes({
      "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m1", "Draw a kite, then film it"), made], more: false, live: null },
      "GET /models?chat=chat1": models(),
      "GET /media/jobs/mjob1": fixture("media_job"),
      "GET /files": F4_HOME,
      [`GET /files${q(GENERATED)}`]: { path: GENERATED, parent: HOME, entries: [{ name: MADE[0].media.name, path: MADE[0].media.path, kind: "file", file_kind: "image", size: MADE[0].media.size, mime: "image/png", updated_at: STAMP }] },
      ...over,
    }),
    commands: { media_save_as: { path: "/home/dev/Downloads/kite.png", size: 180000 }, ...commands },
    streams: {},
    ...extra,
  }
}
const jobAsks = (p) => p.evaluate(() => window.__mock.api("GET", "/media/jobs/").length)
const inWindow = (p, sel) => p.$$eval(sel, (l) => l.every((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.left >= -0.5 && b.right <= innerWidth + 0.5 }))

test("MD1: what a tool call made is a card under the call -- a picture by the file's id, Open in Files, Download -- and a long generation a card that follows its job until it is done, then plays what was made", async () => {
  const p = await page(md(), { width: 1280, height: 900, clock: true })
  await openChatRow(p, "chat1")
  // The picture: under its call, without a click, at an address asked for by the file's id.
  await p.waitForSelector("#messages .mcard[data-media=image] img.mcard__image")
  await p.waitForFunction(() => document.querySelector("#messages .mcard__image").naturalWidth === 1)
  assert.deepEqual((await callsOf(p, "media_open"))[0], { source: "server", kind: "image", node: "node8" })
  assert.ok((await p.getAttribute("#messages .mcard__image", "src")).startsWith("http://media.test/image/node8"))
  assert.equal(await p.textContent("#messages .mcard[data-media=image] .mcard__name"), MADE[0].media.name)
  assert.match(await p.textContent("#messages .mcard[data-media=image] .mcard__facts"), /1024 × 1024/)
  assert.deepEqual(await p.$$eval("#messages .mcard[data-media=image] .mcard__do .btn", (l) => l.map((b) => b.textContent)), ["Open in Files", "Download"])
  // The card is not inside the call's fold: it shows while the call is closed.
  assert.equal(await p.$eval("#messages .mcard[data-media=image]", (el) => !!el.closest("details")), false)
  // Download: by the id, to where the person chooses; said where it went.
  await p.click("#messages .mcard[data-media=image] .mcard__download")
  await p.waitForFunction(() => document.querySelector("#messages .mcard[data-media=image] .mcard__said").textContent === "Saved. /home/dev/Downloads/kite.png")
  assert.deepEqual(await callsOf(p, "media_save_as"), [{ node: "node8", name: MADE[0].media.name, title: "Download" }])
  // The job: what is being made, how it stands, for how long, Cancel -- asked for at once.
  const job = '#messages .mjob[data-job="mjob1"]'
  await p.waitForFunction((sel) => document.querySelector(`${sel} .mjob__time`)?.textContent === "0:42", job)
  assert.deepEqual(await p.$eval(job, (el) => [el.querySelector(".mjob__kind").textContent, el.querySelector(".mjob__state").textContent, el.querySelector(".mjob__cancel").textContent]), ["Video", "Being made", "Cancel"])
  assert.match(await p.textContent(`${job} .mjob__what`), /Studio · Text to video · a kite over dunes/)
  assert.equal(await jobAsks(p), 1)
  await shot(p, "md-cards-1280")
  // Every three seconds while the card is there; the time counts on between.
  await p.clock.fastForward(2000)
  await p.waitForFunction((sel) => document.querySelector(`${sel} .mjob__time`).textContent === "0:44", job)
  assert.equal(await jobAsks(p), 1)
  await p.clock.fastForward(1000)
  await p.waitForFunction(() => window.__mock.api("GET", "/media/jobs/").length === 2)
  // It ends by itself: the player is drawn on the card of the call that started it, from the
  // job's result, and the chat -- which the server wakes with a reply -- is read again.
  const reads = await p.evaluate(() => window.__mock.api("GET", "/chats/chat1").length)
  await p.evaluate((done) => window.__mock.answer("GET /media/jobs/mjob1", done), { ...fixture("media_job_done"), id: "mjob1" })
  await p.clock.fastForward(3000)
  await p.waitForSelector(`${job}[data-state=done] .mcard[data-media=video] video.mcard__video`)
  assert.ok((await p.getAttribute(`${job} video`, "src")).startsWith("http://media.test/video/node7"))
  assert.ok(await p.$eval(`${job} video`, (v) => v.controls))
  assert.deepEqual((await callsOf(p, "media_open")).at(-1), { source: "server", kind: "video", node: "node7" })
  await p.waitForFunction((n) => window.__mock.api("GET", "/chats/chat1").length > n, reads)
  await p.waitForSelector(`${job}[data-state=done] video`)
  // A job that has ended is asked for no more.
  const asked = await jobAsks(p)
  await p.clock.fastForward(12000)
  assert.equal(await jobAsks(p), asked)
  // Open in Files: the server's files, at the folder the file is in, the file chosen.
  await p.click("#messages .mcard[data-media=image] .mcard__files")
  await p.waitForSelector(`#server-list .frow.is-chosen[data-path="${MADE[0].media.path}"]`)
  assert.ok(await p.isVisible("#pane-server"))
  await shot(p, "md-files-1280")
  assert.deepEqual(p.errors, [])
})

test("MD2: a long generation is cancelled from its card, and one that failed says the server's own sentence; neither is asked for again; at 390 px the cards stay inside the window", async () => {
  const stopped = { ...fixture("media_job"), state: "cancelled", active: false, seconds: 50, ended: STAMP, error: "Stopped on the server that was making it." }
  const p = await page(md({ "DELETE /media/jobs/mjob1": stopped }), { width: 390, height: 844, clock: true })
  await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
  await p.waitForSelector("#messages .msg")
  const job = '#messages .mjob[data-job="mjob1"]'
  await p.waitForSelector(`${job} .mjob__cancel`)
  await p.waitForFunction(() => document.querySelector("#messages .mcard__image")?.naturalWidth === 1)
  // Narrow: nothing reaches out of the window, and the page does not scroll sideways.
  assert.ok(await inWindow(p, "#messages .mcard, #messages .mjob, #messages .mcard__do .btn, #messages .mjob__cancel"))
  assert.ok(await p.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth))
  // The row's parts stand on one line, each in its own track.
  assert.ok(await p.$eval(`${job} .mjob__row`, (row) => { const tops = [...row.children].filter((c) => c.getBoundingClientRect().width > 0).map((c) => { const b = c.getBoundingClientRect(); return b.top + b.height / 2 }); return Math.max(...tops) - Math.min(...tops) < 1 }))
  await shot(p, "md-cards-390")
  const reads = await p.evaluate(() => window.__mock.api("GET", "/chats/chat1").length)
  await p.click(`${job} .mjob__cancel`)
  await p.waitForFunction((sel) => document.querySelector(`${sel} .mjob__state`).textContent === "Cancelled", job)
  assert.deepEqual(await p.evaluate(() => window.__mock.api("DELETE", "/media/jobs/mjob1").length), 1)
  assert.equal(await p.textContent(`${job} .mjob__error`), stopped.error)
  assert.equal(await p.locator(`${job} .mjob__cancel`).count(), 0)
  assert.equal(await p.textContent(`${job} .mjob__time`), "0:50")
  // Cancelled: nothing more is asked, and the chat is not read again (a cancelled job wakes nobody).
  const asked = await jobAsks(p)
  await p.clock.fastForward(12000)
  assert.equal(await jobAsks(p), asked)
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/chats/chat1").length), reads)
  assert.deepEqual(p.errors, [])

  // One that failed before it was looked at: the server's sentence, no Cancel, asked for once.
  const failed = fixture("media_job_failed")
  const f = await page(md({ "GET /media/jobs/mjob1": { ...failed, id: "mjob1" } }), { width: 1280, height: 900, clock: true })
  await openChatRow(f, "chat1")
  await f.waitForFunction((sel) => document.querySelector(`${sel} .mjob__state`)?.textContent === "Failed", job)
  assert.equal(await f.textContent(`${job} .mjob__error`), failed.error)
  assert.equal(await f.locator(`${job} .mjob__cancel`).count(), 0)
  await f.clock.fastForward(12000)
  assert.equal(await jobAsks(f), 1)
  assert.deepEqual(f.errors, [])
})

// A PDF of one page and a model of one triangle, written out here.
function tinyPdf() {
  const paint = "0 0 1 rg 20 20 160 60 re f"
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>", `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`]
  let out = "%PDF-1.4\n"
  const at = objects.map((o, i) => {
    const here = out.length
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
    return here
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return [...Buffer.from(out, "latin1")]
}
const TINY_STL = [...Buffer.from("solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n")]

test("MD3: a PDF and a 3D model are drawn by the server's viewers in a sealed frame -- an opaque origin fed the bytes once -- in the file viewer and on a chat's card; PDF.js never runs in the app's page", async () => {
  const rows = [fileRow("plan.pdf", "pdf", "application/pdf", 600), fileRow("wedge.stl", "model3d", "model/stl", 110)]
  const none = (r) => ({ path: r.path, name: r.name, size: r.size, mime: r.mime, kind: r.file_kind, file_kind: r.file_kind, level: "commit", writable: true, language: "", sha: SHA, text: "", withheld: fixture("file_content_withheld").withheld })
  const content = Object.fromEntries(rows.map((r) => [`GET /files/content${q(r.path)}`, none(r)]))
  const model = { ...MADE[0], id: "call6", name: "model_generate", image: undefined, media: { kind: "model3d", path: `${GENERATED}/model-1.stl`, node_id: "node9", version_id: "ver9", name: "model-1.stl", mime: "model/stl", size: 110 }, block: { ...MADE[0].block, label: "3D model", title: "a wedge" } }
  const reply = { id: "m2", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: null, steps: [{ index: 0, kind: "tools", open: false, calls: [model] }] }
  const p = await page(
    f4(
      { "GET /files": { ...F4_HOME, entries: rows }, ...content, "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m1", "Model a wedge"), reply], more: false, live: null }, "GET /models?chat=chat1": models() },
      { file_save_as: { path: "/home/dev/Downloads/plan.pdf", size: 600 } },
      { viewerBytes: { "plan.pdf": tinyPdf(), "wedge.stl": TINY_STL, node9: TINY_STL }, viewerLibs: { main: viewerFile("pdf.min.mjs"), worker: viewerFile("pdf.worker.min.mjs") } },
    ),
    { width: 1600, height: 900 },
  )
  await openServerTab(p)
  const open = async (name) => {
    await p.click(`${serverRow(name)} .frow__open`)
    await p.dblclick(`${serverRow(name)} .frow__open`)
  }
  const frameOf = async (kind) => {
    await p.waitForSelector(`iframe.sview__frame[data-view="${kind}"]`)
    for (let i = 0; i < 100; i++) {
      const f = p.frames().find((x) => x.url() === `${SEALED}/viewer/${kind}`)
      if (f) return f
      await new Promise((go) => setTimeout(go, 50))
    }
    throw new Error(`no ${kind} frame`)
  }
  // A PDF: its page drawn on a canvas, inside the frame.
  await open("plan.pdf")
  const pdf = await frameOf("pdf")
  await pdf.waitForFunction(() => document.documentElement.getAttribute("data-drawn") === "1", null, { timeout: 30000 })
  assert.equal(await pdf.evaluate(() => document.documentElement.getAttribute("data-pages")), "1")
  assert.ok(await pdf.$eval("canvas.page", (c) => c.width > 100 && c.height > 50))
  // Sealed: an opaque origin, scripts and nothing else; the app's page was handed the library
  // as text and never ran it.
  assert.equal(await pdf.evaluate(() => origin), "null")
  assert.equal(await p.getAttribute("#viewer-body iframe.sview__frame", "sandbox"), "allow-scripts")
  assert.equal(await p.evaluate(() => typeof window.pdfjsLib + typeof globalThis.pdfjsWorker), "undefinedundefined")
  assert.deepEqual(await callsOf(p, "viewer_open"), [{ kind: "pdf" }])
  assert.deepEqual(await callsOf(p, "viewer_bytes"), [{ source: "server", path: `${HOME}/plan.pdf`, root: null, node: null }])
  // The frame fills the viewer; Download stays beside it.
  assert.ok(await p.$eval("#viewer-body iframe.sview__frame", (f) => { const [a, b] = [f.getBoundingClientRect(), document.getElementById("viewer-body").getBoundingClientRect()]; return Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2 && a.height > 200 }))
  assert.deepEqual(await p.$$eval("#viewer-bar .btn", (l) => l.map((b) => b.textContent)), ["Download"])
  await shot(p, "md-pdf-1600")
  // A 3D model: its triangle read and drawn, or -- a browser without WebGL -- said so in the frame.
  await open("wedge.stl")
  const stl = await frameOf("model3d")
  await stl.waitForFunction(() => document.documentElement.hasAttribute("data-triangles") || document.documentElement.hasAttribute("data-failed") || !!document.querySelector(".note"), null, { timeout: 30000 })
  const drawn = await stl.evaluate(() => ({ triangles: document.documentElement.getAttribute("data-triangles"), note: document.querySelector(".note")?.textContent || "" }))
  assert.ok(drawn.triangles === "1" || drawn.note === "3D cannot be drawn here.", JSON.stringify(drawn))
  assert.deepEqual((await callsOf(p, "viewer_bytes")).at(-1), { source: "server", path: `${HOME}/wedge.stl`, root: null, node: null })
  // The PDF's document was let go when the viewer moved on.
  assert.ok((await callsOf(p, "sealed_close")).length >= 1)
  // On a chat's card a model is drawn when asked for, by the file's id.
  await p.click("#viewer-close")
  await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
  await p.waitForSelector("#messages .mcard[data-media=model3d] .mcard__show")
  assert.equal(await p.locator("#messages iframe").count(), 0, "nothing is loaded before it is asked for")
  await p.click("#messages .mcard__show")
  await p.waitForSelector("#messages .mcard iframe.sview__frame[data-view=model3d]")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "viewer_bytes" && c.args.node === "node9"))
  assert.deepEqual((await callsOf(p, "viewer_bytes")).at(-1), { source: "server", path: null, root: null, node: "node9" })
  assert.ok(await p.$eval("#messages .mcard iframe.sview__frame", (f) => f.getBoundingClientRect().height > 200 && f.getAttribute("sandbox") === "allow-scripts"))
  await shot(p, "md-model-card-1600")
  // A file that is gone says so, in the app's page, with no frame left behind.
  await p.evaluate(() => (window.__mockConfig.commands.viewer_bytes = { __error: { status: 404, detail: "Not found" } }))
  await p.evaluate(() => document.getElementById("nav-files").click())
  await open("plan.pdf")
  await p.waitForFunction(() => document.querySelector("#viewer-body .sview__note.is-error")?.textContent === "This file is no longer there.")
  assert.equal(await p.locator("#viewer-body iframe").count(), 0)
  assert.deepEqual(p.errors, [])
})

test("MD4: New file is made by the server and never written over -- a taken name is its sentence, with no listing read first; signing out with an edit not saved asks first", async () => {
  const taken = fixture("file_create_exists")
  const p = await page(f4({ "PUT /files/content": { __error: { status: 409, detail: taken.detail } } }), { width: 1280, height: 860 })
  await openServerTab(p)
  await p.waitForSelector(serverRow("lembas.md"))
  const listings = await p.evaluate(() => window.__mock.api("GET", "/files").filter((c) => !c.args.path.startsWith("/files/")).length)
  await p.click("#server-mkfile")
  await p.fill("dialog[open] .dialog__input", "lembas.md")
  await p.click("dialog[open] button[type=submit]")
  await statusSays(p, "server-status", taken.detail)
  assert.deepEqual(await bodies(p, "PUT", "/files/content"), [{ path: `${HOME}/lembas.md`, text: "", create: true }])
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/files").filter((c) => !c.args.path.startsWith("/files/")).length), listings, "the folder is not read before the file is made")
  // A free name: made, and the folder read again.
  await p.evaluate((made) => window.__mock.answer("PUT /files/content", made), { ...F4_CONTENT, path: `${HOME}/notes.md`, name: "notes.md", text: "", size: 0 })
  await p.click("#server-mkfile")
  await p.fill("dialog[open] .dialog__input", "notes.md")
  await p.click("dialog[open] button[type=submit]")
  await p.waitForFunction(() => window.__mock.api("PUT", "/files/content").length === 2)
  assert.deepEqual((await bodies(p, "PUT", "/files/content"))[1], { path: `${HOME}/notes.md`, text: "", create: true })
  // An edit that was not saved, then Sign out: asked first; Cancel keeps the edit and the sign-in.
  await p.click(`${serverRow("lembas.md")} .frow__open`)
  await p.dblclick(`${serverRow("lembas.md")} .frow__open`)
  await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
  await p.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
  await p.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
  await p.click("#viewer-body .cm-content")
  await p.keyboard.type("Twice.")
  await p.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  await p.evaluate(() => document.getElementById("settings-btn").click())
  await p.waitForSelector("#sign-out")
  await p.evaluate(() => document.getElementById("sign-out").click())
  await p.waitForSelector("dialog[open] .dialog__title")
  assert.equal(await p.textContent("dialog[open] .dialog__title"), "Not saved yet")
  assert.deepEqual(await p.$$eval("dialog[open] .dialog__actions .btn", (l) => l.map((b) => b.textContent)), ["Cancel", "Discard"])
  await p.locator("dialog[open] .dialog__actions .btn", { hasText: "Cancel" }).click()
  await p.waitForFunction(() => !document.querySelector("dialog[open]"))
  assert.equal((await callsOf(p, "sign_out")).length, 0)
  assert.ok(await p.$eval("#viewer-body .cm-content", (el) => el.textContent.includes("Twice.")), "the edit is still there")
  // Discard: signed out.
  await p.evaluate(() => document.getElementById("sign-out").click())
  await p.locator("dialog[open] .dialog__actions .btn", { hasText: "Discard" }).click()
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "sign_out"))
  assert.equal((await callsOf(p, "sign_out")).length, 1)
  assert.deepEqual(p.errors, [])
})

test("MD5: a model that is not for chatting is in no chat's picker; sound and video a message carries have players; Settings lists the MCP servers and opens a sign-in in the system's browser, only on the instance itself", async () => {
  const listed = fixture("models")
  const other = (id, name, capability) => ({ ...listed.models[0], id, ref: `cloud/${id}`, name, capability, default: false })
  const all = { ...listed, models: [...listed.models, other("embed-small", "Embed Small", "embedding"), other("film-1", "Film One", "video")] }
  const song = { id: "att9", name: "song.wav", mime: "audio/wav", size: 844, kind: "audio", image: false, width: 0, height: 0 }
  const clip = { id: "att10", name: "clip.mp4", mime: "video/mp4", size: 9000, kind: "video", image: false, width: 0, height: 0 }
  const mcp = fixture("mcp_servers")
  const server = new URL(mcp.servers.find((m) => m.auth.signin_url).auth.signin_url).origin
  const p = await page(
    {
      status: status({ server }),
      routes: baseRoutes({
        "GET /models": all,
        "GET /models?chat=chat1": all,
        "GET /chats/chat1": { chat: chatRow(), messages: [{ ...userMessage("m1", "Listen to this"), attachments: [song, clip] }, { id: "m2", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: null, steps: [{ index: 0, kind: "tools", open: false, calls: [{ ...MADE[0], media: undefined }] }] }], more: false, live: null },
        "GET /mcp": mcp,
      }),
      commands: { model_image: `data:image/png;base64,${MEDIA_PNG.toString("base64")}` },
      streams: {},
    },
    { width: 1280, height: 900 },
  )
  await openChatRow(p, "chat1")
  // The players: fed by the attachment's id, never a path -- asked for once their tiles are in
  // sight (the thread opens at its end, and they are above it).
  await p.waitForSelector("#messages .ptile[data-kind=audio]")
  assert.equal((await callsOf(p, "media_open")).length, 0, "nothing is asked for while they are out of sight")
  await p.$eval("#messages .ptile[data-kind=audio]", (el) => el.scrollIntoView({ block: "center" }))
  await p.waitForSelector("#messages .ptile[data-kind=audio] audio.mcard__audio")
  await p.waitForSelector("#messages .ptile[data-kind=video] video.mcard__video")
  assert.deepEqual((await callsOf(p, "media_open")).sort((a, b) => a.kind.localeCompare(b.kind)), [{ source: "attachment", kind: "audio", attachment: "att9" }, { source: "attachment", kind: "video", attachment: "att10" }])
  assert.ok(await p.$eval("#messages .ptile audio", (a) => a.controls && a.src.startsWith("http://media.test/audio/att9")))
  assert.equal(await p.textContent("#messages .ptile[data-kind=audio] .ptile__name"), "song.wav")
  assert.ok(await inWindow(p, "#messages .ptile"))
  // A picture a call made that an older server names only as an attachment is drawn all the same.
  await p.waitForFunction(() => document.querySelector("#messages .call__made .mcard__image")?.naturalWidth === 1)
  assert.ok((await callsOf(p, "model_image")).some((c) => c.path === `/attachments/${MADE[0].image.id}`))
  assert.equal(await p.locator("#messages .call__made .mcard__do").count(), 0, "nothing to open or download by without the file's id")
  // The picker: every chat model the server lists, and neither of the two that are for something else.
  await p.click(".cchip--model")
  await p.waitForSelector(".menu .menu__item")
  const offered = await p.$$eval(".menu .menu__item", (l) => l.map((x) => x.textContent))
  for (const m of listed.models) assert.ok(offered.some((o) => o.includes(m.name)), m.name)
  assert.ok(!offered.some((o) => /Embed Small|Film One/.test(o)), offered.join(" | "))
  await p.keyboard.press("Escape")
  // Settings: the MCP servers, each with how its sign-in stands.
  await p.evaluate(() => document.getElementById("settings-btn").click())
  await p.waitForSelector("#set-mcp .set__line[data-mcp]")
  const rows = await p.$$eval("#set-mcp .set__line[data-mcp]", (l) => l.map((r) => ({ id: r.dataset.mcp, state: r.dataset.state, label: r.querySelector(".set__label").textContent, hint: r.querySelector(".set__hint").textContent, control: r.querySelector(".set__control").textContent, button: !!r.querySelector("button") })))
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.label, r.button]), [["mcp1", "ready", "Tracker", false], ["mcp2", "signed_in", "Mail", false], ["mcp3", "signed_out", "Notes", true], ["mcp4", "needs_signin", "Wiki", false]])
  assert.equal(rows[0].hint, "4 tools")
  assert.equal(rows[1].hint, "7 tools · Signed in as frodo@example.org.")
  assert.match(rows[2].hint, /Not signed in/)
  assert.match(rows[3].hint, /Needs sign-in/)
  assert.equal(rows[3].control, "An administrator signs in to this one.", "a shared sign-in that is not the person's to make")
  assert.ok(await p.$eval("#settings-nav", (n) => [...n.querySelectorAll(".navrow")].some((b) => b.dataset.id === "mcp")))
  await shot(p, "md-mcp-1280")
  // Sign in: the instance's own page, in the system's browser; asked again on coming back.
  await p.click('#set-mcp .set__line[data-mcp="mcp3"] button')
  assert.deepEqual(await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "open_external").map((c) => c.args.url)), [mcp.servers[2].auth.signin_url])
  const asks = await p.evaluate(() => window.__mock.api("GET", "/mcp").length)
  const signedIn = { servers: mcp.servers.map((m) => (m.id === "mcp3" ? { ...m, auth: { ...m.auth, state: "signed_in", account: "frodo@example.org", signin_url: null } } : m)) }
  await p.evaluate((now) => (window.__mock.answer("GET /mcp", now), window.dispatchEvent(new Event("focus"))), signedIn)
  await p.waitForFunction(() => document.querySelector('#set-mcp .set__line[data-mcp="mcp3"]')?.dataset.state === "signed_in")
  assert.equal(await p.evaluate(() => window.__mock.api("GET", "/mcp").length), asks + 1)
  assert.equal(await p.locator('#set-mcp .set__line[data-mcp="mcp3"] button').count(), 0)
  // Narrow: the rows keep their two tracks inside the window.
  await p.setViewportSize({ width: 390, height: 844 })
  assert.ok(await inWindow(p, "#set-mcp .set__line, #set-mcp .set__control"))
  await shot(p, "md-mcp-390")
  assert.deepEqual(p.errors, [])

  // A sign-in page anywhere but on the instance is not opened at all: no button.
  const elsewhere = await page({ status: status(), routes: baseRoutes({ "GET /mcp": mcp }), streams: {} }, { width: 1280, height: 900 })
  await elsewhere.evaluate(() => document.getElementById("settings-btn").click())
  await elsewhere.waitForSelector("#set-mcp .set__line[data-mcp]")
  assert.equal(await elsewhere.locator("#set-mcp .set__line button").count(), 0)
  assert.deepEqual(elsewhere.errors, [])
})

// --- RV: what a review of the files and media rounds found, in the page ---------------------------

test("RV3: a chat with more files than Rust keeps addresses for asks for each as it comes into sight, asks once more for one that was given up, and gives them all back when the chat is left", async () => {
  // Forty pictures in one reply: more than were ever kept at once.
  const many = Array.from({ length: 40 }, (_, i) => ({ ...MADE[0], id: `call${100 + i}`, image: null, media: { ...MADE[0].media, node_id: `pic${i}`, version_id: `v${i}`, name: `kite-${i}.png`, path: `${GENERATED}/kite-${i}.png` } }))
  const reply = { id: "m2", role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: null, steps: [{ index: 0, kind: "tools", open: false, calls: many }, { index: 1, kind: "text", open: true, markdown: "Forty kites." }] }
  const cfg = md({ "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m1", "Draw forty kites"), reply], more: false, live: null } }, {}, { mediaStale: 1 })
  const p = await page(cfg, { width: 1280, height: 900 })
  await openChatRow(p, "chat1")
  await p.waitForFunction(() => document.querySelectorAll("#messages .mcard[data-media=image]").length === 40)
  const nodes = async () => (await callsOf(p, "media_open")).map((c) => c.node)
  const drawn = () => p.$$eval("#messages .mcard__image", (l) => l.filter((i) => i.naturalWidth === 1).map((i) => i.closest(".mcard").dataset.node))
  // What comes into sight is drawn; what has not been in sight has asked for nothing. (The
  // thread settles where a chat opens before this is looked at.)
  await p.waitForFunction(() => [...document.querySelectorAll("#messages .mcard__image")].some((i) => i.naturalWidth === 1))
  await p.waitForTimeout(400)
  const first = [...new Set(await nodes())]
  assert.ok(first.length > 0 && first.length < 40, `asked for ${first.length} of 40 before the rest was scrolled to`)
  assert.equal(await p.$$eval("#messages .mcard[data-media=image] .mcard__view", (l) => l.filter((v) => v.querySelector("img")).length), first.length, "a card not seen yet holds no picture")
  // The first address was one Rust had given up: the picture failed, was asked for once more,
  // and is drawn -- the dead address given back.
  const all = await nodes()
  const twice = all.filter((n) => n === all[0])
  assert.equal(twice.length, 2, "the picture whose address was gone is asked for once more")
  await p.waitForFunction((node) => document.querySelector(`#messages .mcard[data-node="${node}"] .mcard__image`)?.naturalWidth === 1, all[0])
  assert.deepEqual(await callsOf(p, "media_close"), [{ url: `http://media.test/stale/${all[0]}` }])
  // Scrolled to, the others are asked for and drawn, each once.
  const far = Array.from({ length: 40 }, (_, i) => `pic${i}`).find((n) => !first.includes(n))
  assert.ok(!(await drawn()).includes(far))
  await p.$eval(`#messages .mcard[data-node="${far}"]`, (el) => el.scrollIntoView({ block: "center" }))
  await p.waitForFunction((node) => document.querySelector(`#messages .mcard[data-node="${node}"] .mcard__image`)?.naturalWidth === 1, far)
  assert.equal((await nodes()).filter((n) => n === far).length, 1)
  // The chat is left: every address asked for is given back, and none twice.
  const held = (await callsOf(p, "media_open")).length
  await p.evaluate(() => document.getElementById("new-chat-btn").click())
  await p.waitForFunction((n) => window.__mock.calls.filter((c) => c.cmd === "media_close").length === n, held)
  const closed = (await callsOf(p, "media_close")).map((c) => c.url)
  assert.equal(new Set(closed).size, closed.length)
  assert.deepEqual(p.errors, [])
})

test("RV4: a job the server does not know is asked for once and no more; one that cannot be read is asked for again after longer and longer, a few times, and then says why", async () => {
  const job = '#messages .mjob[data-job="mjob1"]'
  const forward = async (p, seconds) => {
    // The page's clock jumps a second at a time, so each of its ticks is one the card sees.
    for (let i = 0; i < seconds; i++) await p.clock.fastForward(1000)
  }
  // Gone, or somebody else's: the server's 404 is the end of it.
  const gone = await page(md({ "GET /media/jobs/mjob1": { __error: { status: 404, detail: "There is no such job." } } }), { width: 1280, height: 900, clock: true })
  await openChatRow(gone, "chat1")
  await gone.waitForFunction((sel) => document.querySelector(`${sel} .mjob__state`)?.textContent === "Failed", job)
  assert.equal(await gone.textContent(`${job} .mjob__error`), "There is no such job.")
  assert.equal(await gone.locator(`${job} .mjob__cancel`).count(), 0)
  await forward(gone, 60)
  assert.equal(await jobAsks(gone), 1, "a job that is gone is not asked for again")
  assert.deepEqual(gone.errors, [])

  // The server cannot be reached: again after 6 s, 12 s, 24 s, 48 s, a minute -- six asks in
  // all -- and then no more, with the reason on the card.
  const down = await page(md({ "GET /media/jobs/mjob1": { __error: { status: 0, detail: "Could not reach the server: timed out" } } }), { width: 1280, height: 900, clock: true })
  await openChatRow(down, "chat1")
  await down.waitForFunction(() => window.__mock.api("GET", "/media/jobs/").length === 1)
  await forward(down, 4)
  assert.equal(await jobAsks(down), 1, "not every three seconds")
  await forward(down, 3)
  await down.waitForFunction(() => window.__mock.api("GET", "/media/jobs/").length === 2)
  await forward(down, 9)
  assert.equal(await jobAsks(down), 2, "twice as long the second time")
  await forward(down, 400)
  assert.equal(await jobAsks(down), 6, "and no more after a few")
  await down.waitForFunction((sel) => document.querySelector(`${sel} .mjob__said`)?.textContent === "Could not reach the server: timed out", job)
  await forward(down, 120)
  assert.equal(await jobAsks(down), 6)
  // It answers again and the chat is opened again: followed as before.
  await down.evaluate((now) => window.__mock.answer("GET /media/jobs/mjob1", now), fixture("media_job"))
  await down.evaluate(() => document.getElementById("new-chat-btn").click())
  await openChatRow(down, "chat1")
  await down.waitForFunction((sel) => document.querySelector(`${sel} .mjob__time`)?.textContent === "0:42", job)
  assert.equal(await down.locator(`${job} .mjob__said`).count(), 0)
  assert.deepEqual(down.errors, [])
})

test("RV5: a save that cannot say what it started from is not sent until the person says anyway; a copy that left something out says so", async () => {
  // The server's content answer without `sha`: there is nothing to compare a save with.
  const blind = { ...F4_CONTENT }
  delete blind.sha
  const p = await page(f4({ "GET /files/content": blind, "PUT /files/content": { ...F4_CONTENT, text: "# Lembas\n\nTwice.\n" } }, { local_transfer: [{ path: "src", ok: true, to: "src (2)", error: null, note: "Left out of the copy: the LLeMbas CLI's own files (2)." }] }), { width: 1280, height: 860 })
  await serverPane(p)
  await p.dblclick(`${serverRow("lembas.md")} .frow__open`)
  await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
  await p.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
  await p.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
  await p.click("#viewer-body .cm-content")
  await p.keyboard.type("Twice.")
  await p.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  await p.click("#viewer-save")
  // Nothing is sent: both ways on are offered, as for a file that changed.
  await p.waitForSelector("#viewer-force")
  assert.ok(await p.isVisible("#viewer-reload"))
  assert.match(await p.textContent("#viewer-bar .viewer__said"), /Reload it, or save anyway/)
  assert.equal((await bodies(p, "PUT", "/files/content")).length, 0, "a save with no base is not sent")
  // Save anyway is the person's word: sent, and said to be forced.
  await p.click("#viewer-force")
  await p.waitForFunction(() => window.__mock.api("PUT", "/files/content").length === 1)
  const sent = (await bodies(p, "PUT", "/files/content"))[0]
  assert.equal(sent.force, true)
  assert.ok(!("base" in sent))
  // The answer says what the file is now: the next save starts from that.
  await p.click("#viewer-body .cm-content")
  await p.keyboard.type("!")
  await p.waitForFunction(() => !document.getElementById("viewer-save")?.disabled)
  await p.click("#viewer-save")
  await p.waitForFunction(() => window.__mock.api("PUT", "/files/content").length === 2)
  assert.equal((await bodies(p, "PUT", "/files/content"))[1].base, SHA)

  // This computer: a folder copied without the CLI's files in it says what was left out.
  const q = await page(f4({}, { local_transfer: [{ path: "src", ok: true, to: "src (2)", error: null, note: "Left out of the copy: the LLeMbas CLI's own files (2)." }] }), { width: 1280, height: 860 })
  await localPaneOpen(q)
  await q.waitForSelector(`${localRow("src")} .frow__more`)
  await rowMenu(q, localRow("src"), "Copy to…")
  await q.waitForSelector("dialog[open] #fpick-use")
  await q.click("#fpick-use")
  await statusSays(q, "local-status", "Copied as src (2).\nLeft out of the copy: the LLeMbas CLI's own files (2).")
  assert.deepEqual(p.errors, [])
  assert.deepEqual(q.errors, [])
})

test("RV6: an edit not saved when the server refuses the sign-in is kept, and is back in the editor when the same person has signed in again -- saved only against what it started from; another person gets none of it", async () => {
  const cfg = () => f4({ "PUT /files/content": { __error: F4_CONFLICT } })
  const edit = async (p) => {
    await serverPane(p)
    await p.dblclick(`${serverRow("lembas.md")} .frow__open`)
    await p.waitForSelector("#viewer:not([hidden]) .viewer__md")
    await p.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
    await p.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
    await p.click("#viewer-body .cm-content")
    await p.keyboard.press("Control+End")
    await p.keyboard.type("Twice, kept.")
    await p.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  }
  const signal = (p, st) => p.evaluate((now) => { window.__mockConfig.status = now; window.__mock.emit("status", now) }, st)
  const p = await page(cfg(), { width: 1280, height: 860 })
  await edit(p)
  // The token is refused: Rust forgets the account and the page shows the sign-in.
  await signal(p, status({ account: null }))
  await p.waitForSelector("#setup:not([hidden])")
  assert.ok(await p.isHidden("#viewer"))
  // Meanwhile the file changed on the server.
  await p.evaluate((now) => window.__mock.answer("GET /files/content", now), { ...F4_CONTENT, sha: "cd".repeat(32), text: "# Lembas\n\nSomebody else's.\n" })
  // Signed in again as the same person: the file is open, in the editor, with the edit.
  await signal(p, status())
  await p.waitForSelector("#shell:not([hidden])")
  await p.waitForSelector("#viewer:not([hidden]) #viewer-body .cm-content[contenteditable=true]")
  assert.match(await p.textContent("#viewer-body .cm-content"), /Twice, kept\./)
  assert.doesNotMatch(await p.textContent("#viewer-body .cm-content"), /Somebody else's/)
  assert.equal(await p.textContent("#viewer-bar .viewer__said"), "Not saved yet")
  assert.equal(await p.getAttribute('#viewer-modes .seg[data-mode="edit"]', "aria-pressed"), "true")
  // Saved from what the edit started from, not from what was read just now: the change made
  // meanwhile is the usual conflict, not something written over unseen.
  await p.click("#viewer-save")
  await p.waitForSelector("#viewer-force")
  assert.equal((await bodies(p, "PUT", "/files/content"))[0].base, SHA)
  assert.deepEqual(p.errors, [])

  // Another person signs in on the same app: nothing of the edit is theirs to see.
  const o = await page(cfg(), { width: 1280, height: 860 })
  await edit(o)
  await signal(o, status({ account: null }))
  await o.waitForSelector("#setup:not([hidden])")
  await signal(o, status({ account: { name: "Bo Example", email: "bo@example.org" } }))
  await o.waitForSelector("#shell:not([hidden])")
  await o.waitForFunction(() => window.__mock.api("GET", "/me").length >= 2)
  await o.waitForTimeout(200)
  assert.ok(await o.isHidden("#viewer"))
  await serverPane(o)
  await o.dblclick(`${serverRow("lembas.md")} .frow__open`)
  await o.waitForSelector("#viewer:not([hidden]) .viewer__md")
  assert.doesNotMatch(await o.textContent("#viewer-body"), /Twice, kept\./)
  // Sign out by the person's own word, the edit let go: none is kept either.
  await o.locator("#viewer-modes .seg", { hasText: "Edit" }).click()
  await o.waitForSelector("#viewer-body .cm-content[contenteditable=true]")
  await o.click("#viewer-body .cm-content")
  await o.keyboard.type("Let go.")
  await o.waitForFunction(() => document.querySelector("#viewer-bar .viewer__said").textContent === "Not saved yet")
  await o.evaluate(() => document.getElementById("settings-btn").click())
  await o.waitForSelector("#sign-out")
  await o.evaluate(() => document.getElementById("sign-out").click())
  await o.locator("dialog[open] .dialog__actions .btn", { hasText: "Discard" }).click()
  await o.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "sign_out"))
  await signal(o, status({ account: null }))
  await o.waitForSelector("#setup:not([hidden])")
  await signal(o, status({ account: { name: "Bo Example", email: "bo@example.org" } }))
  await o.waitForSelector("#shell:not([hidden])")
  await o.waitForFunction(() => window.__mock.api("GET", "/me").length >= 3)
  await o.waitForTimeout(200)
  assert.ok(await o.isHidden("#viewer"))
  assert.deepEqual(o.errors, [])
})

test("RV7: Open in Files asks where the file is now, by its id -- moved, it is found; in the trash, that is said; an archive's viewer lists what is in it, as text, and says when the server could not", async () => {
  const where = fixture("file_node")
  const moved = `${HOME}/Kept`
  const now = { ...where, id: "node8", path: `${moved}/kite.png`, name: "kite.png", parent: moved, file_kind: "image" }
  const listing = { path: moved, parent: HOME, entries: [{ name: "kite.png", path: now.path, kind: "file", file_kind: "image", size: 180000, mime: "image/png", updated_at: STAMP }] }
  const p = await page(md({ "GET /files/node": now, [`GET /files${q(moved)}`]: listing }), { width: 1280, height: 900 })
  await openChatRow(p, "chat1")
  await p.waitForSelector("#messages .mcard[data-media=image] .mcard__files")
  // Renamed and moved since the chat made it: found by its id, where it is now.
  await p.click("#messages .mcard[data-media=image] .mcard__files")
  await p.waitForSelector(`#server-list .frow.is-chosen[data-path="${now.path}"]`)
  assert.deepEqual((await p.evaluate(() => window.__mock.api("GET", "/files/node").map((c) => c.args.path))), ["/files/node?id=node8"])
  assert.ok(await p.isHidden("#server-status") || (await p.textContent("#server-status")) === "")
  // In the trash: said, and nothing is listed for it.
  await p.evaluate((t) => window.__mock.answer("GET /files/node", t), { ...now, trashed: true })
  await p.evaluate(() => document.querySelector("#messages .mcard[data-media=image] .mcard__files").click())
  await statusSays(p, "server-status", "This file is in the trash.")
  // A server without the route (its 404): by the path the chat knew, as before.
  await p.evaluate(() => window.__mock.answer("GET /files/node", { __error: { status: 404, detail: "Not Found" } }))
  await p.evaluate(() => document.querySelector("#messages .mcard[data-media=image] .mcard__files").click())
  await p.waitForSelector(`#server-list .frow.is-chosen[data-path="${MADE[0].media.path}"]`)
  assert.deepEqual(p.errors, [])

  // An archive: the server's listing, every name as text.
  const zip = fixture("file_content_archive")
  const row = { name: zip.name, path: zip.path, kind: "file", file_kind: "archive", size: zip.size, mime: zip.mime, updated_at: STAMP }
  const nasty = { ...zip, archive: { ...zip.archive, entries: [...zip.archive.entries, { name: "<img src=x onerror=\"document.title='ran'\">.txt", size: 12, dir: false }], total: 3 } }
  const home = { ...F4_HOME, entries: [...F4_HOME.entries, row] }
  const a = await page(f4({ "GET /files": home, [`GET /files/content${q(zip.path)}`]: nasty }), { width: 1280, height: 860 })
  await serverPane(a)
  await a.dblclick(`${serverRow(zip.name)} .frow__open`)
  await a.waitForSelector("#viewer:not([hidden]) .viewer__archive .varchive tr")
  assert.deepEqual(await a.$$eval("#viewer-body .varchive tr", (l) => l.map((r) => [...r.children].map((c) => c.textContent))), [["maps/", ""], ["maps/shire.png", "2.0 KB"], ["<img src=x onerror=\"document.title='ran'\">.txt", "12 B"]])
  assert.equal(await a.textContent("#viewer-body .viewer__cap"), "3 entries. Nothing is unpacked here.")
  assert.equal(await a.locator("#viewer-body img").count(), 0)
  assert.notEqual(await a.title(), "ran")
  assert.deepEqual(await a.$$eval("#viewer-bar .btn", (l) => l.map((b) => b.textContent)), ["Download"])
  // Every row's size starts where every other's does: one track, whatever the names are.
  assert.ok(await a.$$eval("#viewer-body .varchive tr", (l) => new Set(l.map((r) => Math.round(r.children[1].getBoundingClientRect().left))).size === 1))
  await shot(a, "rv-archive-1280")
  // Narrow: the listing scrolls in its own box, not the window.
  await a.setViewportSize({ width: 390, height: 844 })
  assert.ok(await a.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth))
  await shot(a, "rv-archive-390")
  // More than are listed, and one the server could not read: its own sentence, and Download.
  await a.evaluate(([key, cut]) => window.__mock.answer(key, cut), [`GET /files/content${q(zip.path)}`, { ...zip, archive: { ...zip.archive, truncated: true, total: 9000 } }])
  await a.setViewportSize({ width: 1280, height: 860 })
  await a.dblclick(`${serverRow(zip.name)} .frow__open`)
  await a.waitForFunction(() => document.querySelector("#viewer-body .viewer__cap")?.textContent === "Only the first 2 entries are listed.")
  await a.evaluate(([key, bad]) => window.__mock.answer(key, bad), [`GET /files/content${q(zip.path)}`, { ...zip, archive: { entries: [], total: null, truncated: false, problem: "unsupported", message: "What is inside this kind of archive cannot be listed here." } }])
  await a.dblclick(`${serverRow(zip.name)} .frow__open`)
  await a.waitForFunction(() => document.querySelector("#viewer-body .viewer__note")?.textContent === "What is inside this kind of archive cannot be listed here.")
  assert.equal(await a.locator("#viewer-body .viewer__facts .btn").count(), 1)
  assert.deepEqual(a.errors, [])
})

// --- POS: where the chat stands, measured ------------------------------------------------------------
//
// The rule: at the end of the thread, the person stays at the end; anywhere else, what they look
// at does not move by a pixel, whatever is added above or below it, and a chat read again is not
// drawn in a way that loses the place. Each test here scripts a chat and watches the thread after
// every frame the browser paints -- where it stands, how tall it is, and where one thing the
// person looks at (a prompt, a paragraph, a row) is from the thread's top edge -- so a place lost
// for one frame counts as much as one lost for good. With $POS_TRACE set the measurements are
// printed (`POS|case|window|rule|worst|final`) and nothing fails: the table of what moved.

const POS_WINDOWS = { wide: [1280, 860], narrow: [390, 844] }
const POS_BIG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#888"/></svg>`
const posText = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ${"lembas ".repeat(40)}`).join("\n\n")
const posReply = (id, steps) => ({ id, role: "assistant", created_at: STAMP, complete: true, stopped: false, error: null, model: "qwen", metrics: null, steps })
const posWords = (id, n) => posReply(id, [{ index: 0, kind: "text", open: true, markdown: posText(n) }])
const posMedia = (id, media) => ({ ...MADE[0], id, image: undefined, media: { ...MADE[0].media, version_id: `v-${id}`, ...media } })
/** What one reply made: a picture whose size the server says, a long generation, a picture and a video it says no size for, a video with one, a track. */
const POS_MADE = () => [
  MADE[0],
  MADE[1],
  posMedia("call6", { node_id: "bignode", name: "sketch.svg", mime: "image/svg+xml", width: 0, height: 0 }),
  posMedia("call7", { kind: "video", node_id: "node5", name: "kite.mp4", mime: "video/mp4", width: 832, height: 480, seconds: 5 }),
  posMedia("call8", { kind: "video", node_id: "node4", name: "dunes.mp4", mime: "video/mp4", width: 0, height: 0, seconds: 5 }),
  posMedia("call9", { kind: "music", node_id: "node6", name: "tune.mp3", mime: "audio/mpeg", width: 0, height: 0, seconds: 30 }),
]
const posMade = (id) => posReply(id, [{ index: 0, kind: "tools", open: false, calls: POS_MADE() }, { index: 1, kind: "text", open: true, markdown: "A kite, a film of it, and a tune." }])
const POS_FILES = [
  { id: "att5", kind: "image", image: true, name: "oven.png", size: 1000, media_type: "image/png" },
  { id: "att6", kind: "audio", image: false, name: "note.wav", size: 800, media_type: "audio/wav" },
]
/** A long chat: questions and answers, what a model made in the middle of it (or as its last message), files on a question. */
function posMessages({ madeLast = false } = {}) {
  const calls = [call(), call({ id: "t2", name: "edit", args: { path: "a.txt" }, diff: "--- a\n+++ b\n@@ -1 +1,3 @@\n-old\n+new\n+newer\n+newest", text: "", block: { kind: "edit", title: "a.txt", chips: [], added: 3, removed: 1 } })]
  const list = [
    userMessage("q0", `Question 0\n\n${"word ".repeat(120)}`),
    posWords("a0", 6),
    userMessage("q1", `Question 1\n\n${"word ".repeat(120)}`),
    posWords("a1", 6),
    userMessage("q2", "Draw a kite, film it, and write it a tune"),
    posMade("a2"),
    userMessage("q3", `Question 3\n\n${"word ".repeat(60)}`),
    posReply("a3", [{ index: 0, kind: "text", open: true, markdown: posText(2) }, { index: 1, kind: "tools", open: false, calls }, { index: 2, kind: "text", open: true, markdown: posText(5) }]),
    { ...userMessage("q4", "And what is on this one?"), attachments: POS_FILES },
    posWords("a4", 5),
  ]
  return madeLast ? [...list, userMessage("q5", "Once more, all of it"), posMade("a5")] : list
}
function posChat(over = {}, opts = {}) {
  const messages = posMessages(opts)
  return {
    status: status(),
    routes: baseRoutes({
      "GET /chats/chat2": { chat: agentChat(), messages, more: false, live: null },
      "GET /chats/chat1": { chat: chatRow(), messages: [userMessage("m5", "How is lembas made?"), posWords("m6", 12)], more: false, live: null },
      "GET /models?chat=chat2": models(),
      "GET /models?chat=chat1": models(),
      "POST /chats/chat2/messages": { message: userMessage("m1", "What is in build?"), reply: { id: "m2" } },
      "GET /media/jobs/mjob1": fixture("media_job"),
      ...over,
    }),
    commands: { model_image: `data:image/png;base64,${MEDIA_PNG.toString("base64")}` },
    streams: { [STREAM2]: [["status", { text: "Writing…" }]] },
  }
}

const posRows = []
const posMissed = []

/** Watch the thread: after every frame painted, where it stands and where what the person looks at (`__pos.anchor`) is. */
async function posWatch(p) {
  await p.evaluate(() => {
    const th = document.getElementById("thread")
    const pos = (window.__pos = { log: [], anchor: null, seen: [] })
    pos.find = () => {
      const a = pos.anchor
      if (!a) return null
      if (!a.text) return document.querySelector(a.sel)
      for (const el of document.querySelectorAll(a.sel)) if (el.textContent.startsWith(a.text)) return el
      return null
    }
    // How tall each thing in the thread is, by a name for it: for a step that went wrong, what took another size.
    pos.sizes = () => {
      const out = {}
      const put = (name, el) => (out[name] = Math.round(el.getBoundingClientRect().height * 10) / 10)
      for (const msg of document.querySelectorAll("#messages > *")) {
        const id = msg.dataset.id || msg.className
        put(id, msg)
        msg.querySelectorAll(":scope > *, .msg__steps > *, .step--tools > *, .tiles > *, .mcard > *, .mcard__frame, .mcard__frame > *, .ptile > *, .call > *").forEach((el, i) => put(`${id} ${i} ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`, el))
      }
      return out
    }
    pos.sample = () => {
      const el = pos.find()
      const s = { top: th.scrollTop, height: th.scrollHeight, client: th.clientHeight, a: el ? el.getBoundingClientRect().top - th.getBoundingClientRect().top : null, sizes: pos.sizes() }
      pos.log.push(s)
      return s
    }
    // Each time the page itself puts the thread somewhere: where, how tall the thread was then,
    // and every size in it -- against the sizes at rest, what grew after the thread was put.
    const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
    pos.puts = []
    // And each time the page looks where the thread stands and finds it, or its sizes, other
    // than at its last look: what it found, what in the thread took another size since, and
    // from where in the page it looked.
    pos.looks = []
    let looked = ""
    let sizesThen = null
    const look = () => {
      const top = own.get.call(th)
      const state = `${Math.round(top)}/${th.scrollHeight}/${th.clientHeight}`
      if (state !== looked) {
        const now = pos.sizes()
        const grew = []
        if (sizesThen) for (const k of new Set([...Object.keys(sizesThen), ...Object.keys(now)])) if (sizesThen[k] !== now[k]) grew.push(`${k}: ${sizesThen[k] ?? "-"} -> ${now[k] ?? "-"}`)
        const from = String(new Error().stack || "").split("\n").filter((l) => !l.includes("look") && l.trim()).slice(1, 5).map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+\//, "")).join(" < ")
        pos.looks.push({ at: pos.log.length, state, grew: grew.slice(0, 8).join("; "), from })
        looked = state
        sizesThen = now
      }
      return top
    }
    Object.defineProperty(th, "scrollTop", {
      configurable: true,
      get: look,
      set: (v) => {
        own.set.call(th, v)
        pos.puts.push({ at: pos.log.length, to: Math.round(v), top: Math.round(own.get.call(th)), height: th.scrollHeight, client: th.clientHeight, sizes: pos.sizes() })
      },
    })
    // And after everything the page changes in itself (a microtask after each change): where the
    // thread stands and its sizes, with what was changed -- a size that changed and changed back
    // between two frames is seen here and nowhere else.
    pos.changes = []
    const name = (el) => (el.nodeType === 1 ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).split(" ")[0]}` : "text")
    new MutationObserver((records) => {
      const state = `${Math.round(own.get.call(th))}/${th.scrollHeight}/${th.clientHeight}`
      const what = [...new Set(records.map((r) => `${r.type === "attributes" ? `@${r.attributeName} ` : ""}${name(r.target)}`))].slice(0, 6).join(",")
      pos.changes.push({ at: pos.log.length, state, what })
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    // For a step that went wrong, what the thread was told between the frames: its scroll events
    // and the changes of size, each with where it stood then.
    const told = (what) => pos.seen.push({ at: pos.log.length, what, top: th.scrollTop, height: th.scrollHeight, client: th.clientHeight })
    th.addEventListener("scroll", () => told("scroll"), { passive: true })
    new ResizeObserver(() => told("size")).observe(document.getElementById("messages"))
    new ResizeObserver(() => told("room")).observe(th)
    // A task of its own after each frame's callbacks, layout and observers: what was painted.
    const after = new MessageChannel()
    after.port1.onmessage = () => {
      pos.sample()
      requestAnimationFrame(() => after.port2.postMessage(0))
    }
    requestAnimationFrame(() => after.port2.postMessage(0))
  })
}

/** Until the thread has stood still for some frames (three seconds at most). */
const posRest = (p) =>
  p.evaluate(async () => {
    const pos = window.__pos
    const key = (s) => `${s.top}|${s.height}|${s.client}|${s.a}`
    const from = performance.now()
    for (;;) {
      await new Promise((r) => setTimeout(r, 60))
      const last = pos.log.slice(-12)
      if (last.length === 12 && last.every((s) => key(s) === key(last[0]))) return
      if (performance.now() - from > 3000) return
    }
  })

/**
 * One thing happens (`act`), and the thread is judged over every frame from just before it until
 * it rests: by `rule` "end" (never further than a pixel from its end), "held" (what the person
 * looks at never further than a pixel from where it was) or "back" (the same, of where it comes
 * to rest only: the thread showed something else meanwhile). `act` may return the sample to
 * judge from, where it had to move the thread itself first.
 */
async function posStep(p, win, name, rule, act = async () => {}) {
  await posRest(p)
  const mark = await p.evaluate(() => (window.__pos.sample(), window.__pos.log.length - 1))
  const own = await act()
  await posRest(p)
  const r = await p.evaluate(
    ([from, how]) => {
      const log = window.__pos.log.slice(from)
      const gap = (s) => s.height - s.top - s.client
      // How it went, should it have gone wrong: each frame that differs from the one before
      // it (top/height/room, and where the thing looked at is), with what the thread was told
      // meanwhile -- the first forty of them.
      const went = []
      const told = window.__pos.seen.filter((e) => e.at >= from)
      for (let i = 0, last = ""; i < log.length; i++) {
        for (const e of told) if (e.at === from + i) went.push(`(${e.what} ${Math.round(e.top)}/${e.height}/${e.client})`)
        const s = log[i]
        const key = `${Math.round(s.top * 10) / 10}/${s.height}/${s.client}${s.a === null ? "" : `@${Math.round(s.a * 10) / 10}`}`
        if (key !== last) went.push((last = key))
      }
      // And what in the thread took another size from one frame to the next (the first thirty).
      const grew = []
      for (let i = 1; i < log.length; i++) {
        const [a, b] = [log[i - 1].sizes, log[i].sizes]
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) grew.push(`[${k}: ${a[k] ?? "-"} -> ${b[k] ?? "-"}]`)
      }
      const puts = window.__pos.puts.filter((e) => e.at >= from)
      const put = puts.slice(-6).map((e) => `{put ${e.to} -> ${e.top} of ${e.height}/${e.client} before frame ${e.at - from}}`)
      if (puts.length) {
        const [a, b] = [puts.at(-1).sizes, log.at(-1).sizes]
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) grew.push(`[since the last put, ${k}: ${a[k] ?? "-"} -> ${b[k] ?? "-"}]`)
      }
      // The page's own changes from the last put on, where the thread's state differs from the change before (the first forty).
      const changed = []
      const since = puts.length ? puts.at(-1).at : from
      for (let i = 0, last = ""; i < window.__pos.changes.length; i++) {
        const c = window.__pos.changes[i]
        if (c.at < since) continue
        if (c.state !== last) changed.push(`<${c.what} => ${c.state} before frame ${c.at - from}>`)
        last = c.state
      }
      const looks = window.__pos.looks.filter((e) => e.at >= since).slice(0, 12).map((e) => `«looked: ${e.state}; ${e.grew}; from ${e.from}»`)
      const how_ = `${went.slice(0, 40).join(" ")} ${put.join(" ")} ${grew.slice(0, 30).join(" ")} ${changed.slice(0, 40).join(" ")} ${looks.join(" ")}`
      if (how === "end") return { first: gap(log[0]), worst: Math.max(...log.map(gap)), final: gap(log.at(-1)), went: how_ }
      const was = log[0].a
      const moved = (how === "back" ? [log.at(-1)] : log).map((s) => (s.a === null || was === null ? NaN : s.a - was))
      return { first: was, worst: moved.reduce((m, x) => (Number.isNaN(m) || Number.isNaN(x) ? NaN : Math.abs(x) > Math.abs(m) ? x : m), 0), final: moved.at(-1), went: how_ }
    },
    [typeof own === "number" ? own : mark, rule],
  )
  const round = (x) => Math.round(x * 10) / 10
  const row = { name, win, rule, worst: round(r.worst), final: round(r.final) }
  posRows.push(row)
  const ok = rule === "end" ? r.first <= 1 && r.worst <= 1 : Math.abs(r.worst) <= 1
  if (process.env.POS_TRACE) console.log(`POS|${name}|${win}|${rule}|${row.worst}|${row.final}${rule === "end" && r.first > 1 ? `|not at the end to begin with (${round(r.first)})` : ""}`)
  if (!ok) posMissed.push(`${name} (${win}): ${rule === "end" ? `${row.worst} px from the end at worst, ${row.final} at rest` : `moved ${row.worst} px at worst, ${row.final} at rest`} -- ${r.went}`)
  return r
}
function posEnd(p) {
  const missed = posMissed.splice(0)
  if (!process.env.POS_TRACE) assert.deepEqual(missed, [], "where the thread stood")
  assert.deepEqual(p.errors, [])
}

/** The person leaves the end, and has `anchor` (a selector, or `{ sel, text }`) `offset` px under the thread's top edge. */
async function posLook(p, anchor, offset) {
  const spec = typeof anchor === "string" ? { sel: anchor } : anchor
  const gap = await p.evaluate(() => {
    const th = document.getElementById("thread")
    return th.scrollHeight - th.scrollTop - th.clientHeight
  })
  if (gap < 100) await w1Wheel(p, -300)
  const at = await p.evaluate(
    ([a, off]) => {
      const pos = window.__pos
      pos.anchor = a
      const th = document.getElementById("thread")
      th.scrollTop += pos.find().getBoundingClientRect().top - th.getBoundingClientRect().top - off
      pos.sample()
      return { from: pos.log.length - 1, gap: th.scrollHeight - th.scrollTop - th.clientHeight }
    },
    [spec, offset],
  )
  // (Nearer the end than this, moving down to the place would be the person coming back to the end.)
  assert.ok(at.gap > 120, `the place looked at is well above the thread's end (${at.gap} px from it)`)
  return at.from
}

const posOpen = async (p, id = "chat2", last = "a4") => {
  // (Clicked from the page: at a narrow window the list is off the screen until asked for.)
  await posWatch(p)
  await p.evaluate((c) => document.querySelector(`.chatrow[data-id="${c}"]`).click(), id)
  await p.waitForSelector(`#messages .msg[data-id="${last}"]`)
}
const posToEnd = async (p) => {
  await w1Wheel(p, 200000)
  await p.evaluate(() => (window.__pos.anchor = null))
}
const posReads = (p, id = "chat2") => p.evaluate((c) => window.__mock.api("GET", `/chats/${c}`).filter((x) => x.args.path === `/chats/${c}`).length, id)
/** The chat read again as a notification's click reads it (the chat that is open, asked for anew). */
async function posReadAgain(p, times = 1) {
  const n = await posReads(p)
  await p.evaluate(() => window.__mock.emit("open-chat", "chat2"))
  await p.waitForFunction(([c, m]) => window.__mock.api("GET", `/chats/${c}`).filter((x) => x.args.path === `/chats/${c}`).length >= m, ["chat2", n + times])
}

for (const [win, [width, height]] of Object.entries(POS_WINDOWS)) {
  test(`POS: ${win} 1 -- a message sent from the end, a reply written past one screen, the person scrolling up to their prompt: nothing moves through the frames, the calls, a card, the end and the title`, async () => {
    const p = await page(posChat(), { width, height })
    await posOpen(p)
    const step = (name, rule, act) => posStep(p, win, name, rule, act)
    await step("a chat opened stands at its end", "end", async () => 0)
    await step("the composer grows while typing (at the end)", "end", () => p.fill("#composer-text", "one\ntwo\nthree\nfour\nfive\nsix"))
    await step("a message sent from the end, the composer shrinking", "end", async () => {
      await p.focus("#composer-text")
      await p.keyboard.press("Enter")
      await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
    })
    await step("a reply written past one screen (at the end)", "end", async () => {
      await w1Send(p, "tail", { thinking: "Let me think. ".repeat(60), text: "", label: "1s" })
      for (let i = 1; i <= 6; i++) await w1Send(p, "tail", { thinking: "", text: posText(i * 2), label: "" })
    })
    const tall = await p.evaluate(() => document.querySelector(".msg.is-live").getBoundingClientRect().height > document.getElementById("thread").clientHeight)
    assert.ok(tall, "the reply is taller than the thread")
    // Up, to the prompt just sent.
    await posLook(p, '.msg[data-id="m1"]', 24)
    const steps = [W1_THOUGHT]
    await step("scrolled up to the prompt: the reply is written on", "held", async () => {
      for (let i = 13; i <= 15; i++) await w1Send(p, "tail", { thinking: "", text: posText(i), label: "" })
    })
    steps.push({ index: 1, kind: "text", open: false, markdown: posText(15) })
    await step("scrolled up to the prompt: the reasoning folds, a call runs", "held", () => w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: "", label: "", calls: [fixture("event_tail").calls[0]] } }))
    steps.push({ index: 2, kind: "tools", open: false, calls: [W1_CALL(), { ...W1_CALL(), id: "c2" }] })
    await step("scrolled up to the prompt: the calls finish", "held", () => w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: posText(2), label: "", calls: [] } }))
    await step("scrolled up to the prompt: a card asks under the thread", "held", async () => {
      await w1Send(p, "ask", { cards: [deviceBashCard()] })
      await p.waitForSelector("#cards:not([hidden]) .ask")
    })
    await step("scrolled up to the prompt: the card goes", "held", () => w1Send(p, "ask", { cards: [] }))
    steps.push({ index: 3, kind: "text", open: false, markdown: posText(2) })
    await step("scrolled up to the prompt: the reply ends", "held", async () => {
      await w1Send(p, "done", { message: { ...fixture("event_done").message, id: "m2", steps }, chat: { id: "chat2", title: "Tidy the build" } })
      await p.waitForSelector(".msg.is-live", { state: "detached" })
    })
    await step("scrolled up to the prompt: the title arrives", "held", async () => {
      await w1Send(p, "title", { chat: { id: "chat2", title: "The build, tidied, and a far longer name for it than the head has room for" } })
      await p.waitForFunction(() => document.getElementById("chat-title").textContent.startsWith("The build, tidied"))
    })
    posEnd(p)
  })

  test(`POS: ${win} 2 -- reading the reply while it is written: the paragraph under the eyes stays through the reasoning folding above it, the calls, the end, and the chat read again`, async () => {
    const p = await page(posChat(), { width, height })
    await posOpen(p)
    const step = (name, rule, act) => posStep(p, win, name, rule, act)
    await p.fill("#composer-text", "What is in build?")
    await p.focus("#composer-text")
    await p.keyboard.press("Enter")
    await p.waitForFunction((path) => window.__mock.started(path), STREAM2)
    await w1Send(p, "tail", { thinking: "Let me think. ".repeat(60), text: "", label: "1s" })
    await step("the reasoning gives way to the reply's first words (at the end)", "end", () => w1Send(p, "tail", { thinking: "", text: posText(16), label: "" }))
    await posLook(p, { sel: "#messages > .msg:last-child p", text: "Paragraph 3:" }, 30)
    await step("reading the reply: it is written on", "held", async () => {
      for (let i = 17; i <= 19; i++) await w1Send(p, "tail", { thinking: "", text: posText(i), label: "" })
    })
    const steps = [W1_THOUGHT, { index: 1, kind: "text", open: false, markdown: posText(19) }]
    await step("reading the reply: the reasoning becomes a row above, a call runs", "held", () => w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: "", label: "", calls: [fixture("event_tail").calls[0]] } }))
    steps.push({ index: 2, kind: "tools", open: false, calls: [W1_CALL(), { ...W1_CALL(), id: "c2" }] })
    await step("reading the reply: the calls finish, more is written", "held", () => w1Send(p, "steps", { steps: [...steps], tail: { thinking: "", text: `Then:\n\n${posText(3)}`, label: "", calls: [] } }))
    await step("reading the reply: the reasoning thinks again at its end", "held", () => w1Send(p, "tail", { thinking: "More thought. ".repeat(30), text: "", label: "2s" }))
    steps.push({ index: 3, kind: "text", open: false, markdown: `Then:\n\n${posText(3)}` })
    const done = { ...fixture("event_done").message, id: "m2", steps }
    await p.evaluate(([key, m, d]) => window.__mock.answer(key, { ...window.__mockConfig.routes[key], messages: [...window.__mockConfig.routes[key].messages, m, d] }), ["GET /chats/chat2", userMessage("m1", "What is in build?"), done])
    await step("reading the reply: it ends", "held", async () => {
      await w1Send(p, "done", { message: done, chat: { id: "chat2", title: "Tidy the build" } })
      await p.waitForSelector(".msg.is-live", { state: "detached" })
    })
    await step("reading the reply: the chat is read again", "held", () => posReadAgain(p))
    // The person opens the reasoning above what they read: a block opened above the window.
    await step("reading the reply: the chat is read again, twice at once", "held", async () => {
      const n = await posReads(p)
      await p.evaluate(() => (window.__mock.emit("open-chat", "chat2"), window.__mock.emit("open-chat", "chat2")))
      await p.waitForFunction((m) => window.__mock.api("GET", "/chats/chat2").filter((x) => x.args.path === "/chats/chat2").length >= m, n + 2)
    })
    posEnd(p)
  })

  test(`POS: ${win} 3 -- pictures, players and a generation's card take their room without moving the thread: coming into sight above the window, a generation ending above it, and at the end of a chat just opened`, async () => {
    const p = await page(posChat(), { width, height })
    await posOpen(p)
    const step = (name, rule, act) => posStep(p, win, name, rule, act)
    await step("a chat opened stands at its end", "end", async () => 0)
    // Each card of the reply above, from the last up: its lower edge brought 30 px into sight.
    const cards = [
      ["a sound file's player on a prompt", '.msg[data-id="q4"] .ptile', "audio", "a4"],
      ["a track's player", '.mcard[data-node="node6"]', "audio", "q3"],
      ["a video the server gave no size for", '.mcard[data-node="node4"]', "video", "q3"],
      ["a video whose size the server gave", '.mcard[data-node="node5"]', "video", "q3"],
      ["a picture the server gave no size for", '.mcard[data-node="bignode"]', "img", "q3"],
      ["a picture whose size the server gave", '.mcard[data-node="node8"]', "img", "q3"],
    ]
    await w1Wheel(p, -300)
    for (const [what, sel, tag, read] of cards) {
      await step(`${what} comes into sight above what is read`, "held", async () => {
        const from = await p.evaluate(([s, id]) => {
          window.__pos.anchor = { sel: `.msg[data-id="${id}"]` }
          const th = document.getElementById("thread")
          th.scrollTop += document.querySelector(`${s} .mcard__view`).getBoundingClientRect().bottom - th.getBoundingClientRect().top - 30
          window.__pos.sample()
          return window.__pos.log.length - 1
        }, [sel, read])
        await p.waitForSelector(`${sel} ${tag}`)
        if (tag === "img") await p.waitForFunction((s) => document.querySelector(`${s} img`).complete, sel)
        return from
      })
    }
    // The generation ends while the person reads below it: its row becomes a player's card, and
    // the chat -- woken by the server with a reply nobody here asked for -- is read again, twice.
    const woken = posReply("a9", [{ index: 0, kind: "text", open: true, markdown: "The film is ready." }])
    const from = await posLook(p, '.msg[data-id="q3"]', 20)
    await step("a generation ends above what is read: its card becomes a player, the chat is read again twice", "held", async () => {
      const n = await posReads(p)
      await p.evaluate(
        ([done, m]) => {
          window.__mock.answer("GET /media/jobs/mjob1", done)
          const key = "GET /chats/chat2"
          window.__mock.answer(key, { ...window.__mockConfig.routes[key], messages: [...window.__mockConfig.routes[key].messages, m] })
        },
        [{ ...fixture("media_job_done"), id: "mjob1", chat_id: "chat2", told: false }, woken],
      )
      await p.waitForFunction((m) => window.__mock.api("GET", "/chats/chat2").filter((x) => x.args.path === "/chats/chat2").length >= m, n + 2, { timeout: 15000 })
      await p.waitForSelector('.msg[data-id="a9"]')
      return from
    })
    await step("the player of the generation that ended comes into sight above what is read", "held", async () => {
      const at = await p.evaluate(() => {
        const th = document.getElementById("thread")
        th.scrollTop += document.querySelector('.mjob[data-job="mjob1"] .mcard__view').getBoundingClientRect().bottom - th.getBoundingClientRect().top - 30
        window.__pos.sample()
        return window.__pos.log.length - 1
      })
      await p.waitForSelector('.mjob[data-job="mjob1"] video')
      return at
    })
    // Another chat like it, the cards in its last message: opened, it stands at its end while they are drawn.
    const q = await page(posChat({}, { madeLast: true }), { width, height })
    await posOpen(q, "chat2", "a5")
    await posStep(q, win, "a chat opened with pictures and players at its end stands there while they are drawn", "end", async () => {
      await q.waitForSelector('.msg[data-id="a5"] .mcard[data-node="node6"] audio')
    })
    assert.deepEqual(q.errors, [])
    posEnd(p)
  })

  test(`POS: ${win} 4 -- the chat read again, another chat and back, a call's row opened and closed, the composer, the window and the side panel: at the end the thread stays there, and scrolled up what is read does not move`, async () => {
    const older = Array.from({ length: 6 }, (_, i) => userMessage(`e${i}`, `Earlier ${i}\n\n${"word ".repeat(120)}`))
    const cfg = posChat({ "GET /chats/chat2/messages?before=q0": { messages: older, more: false } })
    cfg.routes["GET /chats/chat2"].more = true
    const p = await page(cfg, { width, height })
    await posOpen(p)
    const step = (name, rule, act) => posStep(p, win, name, rule, act)
    const other = async () => {
      await p.evaluate(() => document.querySelector('.chatrow[data-id="chat1"]').click())
      await p.waitForSelector('#messages .msg[data-id="m6"]')
      await p.waitForTimeout(150)
      await p.evaluate(() => document.querySelector('.chatrow[data-id="chat2"]').click())
      await p.waitForSelector('#messages .msg[data-id="a4"]')
    }
    const side = async () => {
      await p.evaluate(() => document.getElementById("side-toggle").click())
      await p.waitForTimeout(400)
    }
    const [w2, h2] = win === "wide" ? [720, 700] : [800, 600]
    await step("at the end: the chat is read again", "end", () => posReadAgain(p))
    await step("at the end: another chat and back", "end", other)
    await step("at the end: the window made another size", "end", () => p.setViewportSize({ width: w2, height: h2 }))
    await step("at the end: the window made its own size again", "end", () => p.setViewportSize({ width, height }))
    if (await p.isVisible("#side-toggle")) {
      await step("at the end: the side panel closed (or opened)", "end", side)
      await step("at the end: the side panel as it was", "end", side)
    }
    // Where the header's settings fold behind their button: opened, they are a row of their
    // own, and the header measures itself without them whenever it may have changed -- for a
    // moment the thread is taller, and what it could not scroll to then must not be lost.
    const folds = await p.isVisible("#chat-fold")
    const fold = () => p.evaluate(() => document.getElementById("chat-fold").click())
    if (folds) {
      await step("at the end: the header's settings opened as a row of their own", "end", fold)
      await step("at the end: the header measures itself (the chat read again)", "end", () => posReadAgain(p))
      await step("at the end: the header's settings folded again", "end", fold)
    }
    // Scrolled up: a prompt's first line exactly at the thread's top edge.
    await posLook(p, '.msg[data-id="q3"]', 0)
    if (folds) {
      await step("scrolled up: the header's settings opened as a row of their own", "held", fold)
      await step("scrolled up: the header measures itself (the chat read again)", "held", () => posReadAgain(p))
      await step("scrolled up: the header's settings folded again", "held", fold)
    }
    await step("scrolled up: the chat is read again", "held", () => posReadAgain(p))
    await step("scrolled up: another chat and back", "back", other)
    await posLook(p, '.msg[data-id="q3"]', 0)
    await step("scrolled up: the composer grows while typing", "held", () => p.fill("#composer-text", "one\ntwo\nthree\nfour\nfive\nsix"))
    await step("scrolled up: the composer shrinks", "held", () => p.fill("#composer-text", ""))
    await step("scrolled up: the window made another size", "held", () => p.setViewportSize({ width: w2, height: h2 }))
    await step("scrolled up: the window made its own size again", "held", () => p.setViewportSize({ width, height }))
    if (await p.isVisible("#side-toggle")) {
      await step("scrolled up: the side panel closed (or opened)", "held", side)
      await step("scrolled up: the side panel as it was", "held", side)
    }
    // A call's row, opened and closed by the person: the row itself stays under the pointer.
    const row = '.msg[data-id="a3"] details.call[data-kind="shell"]'
    await posLook(p, `${row} > summary`, 120)
    await step("scrolled up: a call's row opened", "held", async () => {
      await p.click(`${row} > summary`)
      await p.waitForSelector(`${row}[open]`)
    })
    await step("scrolled up: the row closed", "held", async () => {
      await p.click(`${row} > summary`)
      await p.waitForSelector(`${row}:not([open])`)
    })
    // The same row above the window (the text under it is what is read), opened from the keyboard.
    await p.evaluate((sel) => document.querySelector(`${sel} > summary`).focus({ preventScroll: true }), row)
    await posLook(p, { sel: '.msg[data-id="a3"] p', text: "Paragraph 2:" }, 10)
    await step("scrolled up: a row above what is read opens", "held", () => p.evaluate((sel) => (document.querySelector(sel).open = true), row))
    await step("scrolled up: a row above what is read closes", "held", () => p.evaluate((sel) => (document.querySelector(sel).open = false), row))
    // Earlier messages, asked for at the thread's top: put in above the first message, which stays.
    // (At the thread's very top, the button whole on the screen: the click moves nothing by itself.)
    await posLook(p, '.msg[data-id="q0"]', 5000)
    await step("earlier messages are put in above the first one", "held", async () => {
      await p.click(".thread__earlier")
      await p.waitForSelector('.msg[data-id="e0"]')
    })
    await step("with earlier messages loaded: the composer grows", "held", () => p.fill("#composer-text", "one\ntwo\nthree"))
    posEnd(p)
  })
}

// --- Run ----------------------------------------------------------------------------------------

const only = process.argv[2] || ""
// One browser process does not carry the whole run: it is replaced every few tests, so what a
// test's pages held is given back to the system, not kept until the end.
const RELAUNCH_EVERY = Number(process.env.RELAUNCH_EVERY || 8)
let failed = 0
let ran = 0
try {
  for (const { name, fn } of tests) {
    if (only && !name.includes(only)) continue
    if (!browser || ran % RELAUNCH_EVERY === 0) {
      await browser?.close().catch(() => {})
      browser = await launch()
    }
    ran++
    try {
      await fn()
      // What the pages' own watch of every opened menu found (see `page`).
      const menus = []
      for (const context of opened) for (const pg of context.pages()) menus.push(...(await pg.evaluate(() => window.__menuProblems || []).catch(() => [])))
      assert.deepEqual([...new Set(menus)], [], "every opened menu's rows")
      console.log(`ok   ${name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${name}\n     ${String(err?.stack || err).split("\n").slice(0, 6).join("\n     ")}`)
      // On GitHub Actions, also as an annotation: readable without the job's log.
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=tests/ui::${`${name}: ${String(err?.message || err)} (${String(err?.stack || "").match(/run\.mjs:\d+/)?.[0] || ""})`.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 900)}`)
    } finally {
      for (const context of [...opened]) await context.close().catch(() => {})
      opened.clear()
    }
  }
} finally {
  await browser?.close().catch(() => {})
}
console.log(failed ? `tests/ui: ${failed} failed` : ran ? "tests/ui: all passed" : "tests/ui: no test matches")
process.exit(failed || !ran ? 1 : 0)
