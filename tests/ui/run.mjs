#!/usr/bin/env node
// The page under a headless browser, against a mocked bridge (tests/ui/mock-tauri.js): what the
// person sees for a given answer of the server's /api/v2, and what the page sends back.
//
//     node tests/ui/run.mjs [name-filter]
//
// Needs Playwright (`playwright` or `playwright-core`, from NODE_PATH or a node_modules beside
// the repository) and a Chromium: Playwright's own, or the one in $CHROMIUM (/usr/bin/chromium
// is tried when Playwright has none). Nothing is built and no server is started: the page's
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
const UI = join(HERE, "..", "..", "ui")
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
  p.on("pageerror", (e) => errors.push(String(e)))
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
    const html = `${fixture("page").html}<script>document.title = "a script ran"; document.body.append("a script ran")</script>`
    return route.fulfill({ status: 200, headers: { "Content-Security-Policy": PAGE_POLICY, "X-Content-Type-Options": "nosniff" }, contentType: "text/html; charset=utf-8", body: html })
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
    commands: { transcribe: "baked in leaves", speak: "data:audio/mpeg;base64,SUQz", draw: [PNG, "https://elsewhere.example/x.png"], ...commands },
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
  assert.deepEqual((await p.evaluate(() => window.__mock.calls.find((c) => c.cmd === "speak").args)), { text: "Lembas is baked in leaves." })
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
  await p.waitForSelector(".fact >> text=Where it runs")
}

test("L8: a task on a linked computer says the computer, the folder and mode; a run waits for it", async () => {
  const p = await page(l8([bagEnd()]))
  await openTask(p)
  const where = await p.textContent(".fact:has-text('Where it runs')")
  assert.match(where, /bag-end/)
  assert.match(where, /\/home\/frodo\/waybread/)
  assert.match(where, /Edit — asks before commands · approvals wait 30 min/)
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
  await p.fill("#sched-words", "every day at 7:30 check the build")
  await p.click(".sched--new button[type=submit]")
  await p.waitForSelector("#sched-where")
  const options = await p.$$eval("#sched-where option", (l) => l.map((o) => [o.textContent, o.disabled]))
  assert.deepEqual(options, [["On this server", false], ["bag-end — does not accept scheduled work", true], ["This computer (workbench)", false]])
  await p.selectOption("#sched-where", "token1")
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
  await p.waitForSelector(".fact >> text=Where it runs")
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
  assert.deepEqual(await p.$$eval("#server-list .frow--head [role=columnheader]", (l) => l.map((x) => x.textContent)), ["Name", "Type", "Size", "Changed", "Actions"])
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
const reportChat = () => ({ ...chatRow({ id: fixture("report_reply").chat, title: REPORT.title }), kind: "report" })
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
  // Read here: said to the server, and the count goes.
  await p.waitForFunction((id) => window.__mock.api("POST", `/reports/${id}/read`).length === 1, REPORT.id)
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
  // An older server: 404, and no row.
  p = await page({ status: status(), routes: baseRoutes(), streams: {} })
  await p.waitForTimeout(200)
  assert.ok(await p.isHidden("#nav-reports"))
  await p.context().close()
  // Narrow.
  p = await page(r1(), { width: 390, height: 844 })
  await p.evaluate((id) => window.__mock.emit("open-report", id), REPORT.id)
  await p.waitForSelector("#reports-body .report .hpage__frame")
  assert.ok(await noSideways(p, 390))
  assert.deepEqual(await controlsOut(p, 390), [])
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
  // The server has it no more (a grant taken away, the message gone): said in its place.
  await p.evaluate(() => (window.__mockConfig.pages = { __error: { status: 404, detail: "The page is not there." } }))
  await p.evaluate(() => document.querySelector('.msg[data-id="p15"]').scrollIntoView({ block: "center" }))
  await p.waitForSelector('.msg[data-id="p15"] .hpage__note.is-error')
  assert.match(await p.textContent('.msg[data-id="p15"] .hpage__body'), /This page could not be shown: The page is not there\./)
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
  assert.ok(tops.length === 2)
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
