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

async function page(config, { width = 1280, height = 860 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } })
  const p = await context.newPage()
  const errors = []
  p.on("pageerror", (e) => errors.push(String(e)))
  await context.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    const file = join(UI, path === "/" ? "index.html" : decodeURIComponent(path))
    if (!file.startsWith(UI) || !existsSync(file)) return route.fulfill({ status: 404, body: "" })
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || "application/octet-stream", body: readFileSync(file) })
  })
  await p.addInitScript((c) => {
    window.__mockConfig = c
  }, config)
  await p.addInitScript({ path: join(HERE, "mock-tauri.js") })
  await p.goto(`${ORIGIN}/index.html`)
  await p.waitForSelector("#shell:not([hidden])")
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
  return p.locator("#composer-chips .cchip--subagents")
}

async function openSlider(p) {
  await p.click("#composer-chips .cchip--subagents")
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
  await p.waitForSelector("#composer-chips .cchip--subagents")
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
  await p.waitForSelector("#composer-chips .cchip--terminal")
  assert.equal(await p.evaluate(() => window.__mock.terminals().length), 0, "nothing is opened until asked")
  await p.click("#composer-chips .cchip--terminal")
  await p.waitForSelector("#terminal:not([hidden]) .xterm")
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  const [shell] = await p.evaluate(() => window.__mock.terminals())
  assert.deepEqual(shell.target, { chat: null, device: "token1", directory: "/home/dev/project" })
  await p.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.textContent.includes("dev@workbench"))
  assert.equal(await p.textContent("#terminal-message"), "Connected.")
  assert.equal(await p.textContent("#terminal-title"), "workbench")
  assert.equal(await p.getAttribute("#composer-chips .cchip--terminal", "aria-pressed"), "true")
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
  await p.waitForSelector("#composer-chips .cchip")
  assert.equal(await p.locator("#composer-chips .cchip--terminal").count(), 0, "the device opens no terminal")
  await openChatRow(p, "chat2")
  assert.equal(await p.locator("#chat-tools [data-terminal-toggle]").count(), 0)
  await p.context().close()
  p = await page(b3({}))
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Chat")
  await p.waitForSelector("#composer-chips .cchip")
  assert.equal(await p.locator("#composer-chips .cchip--terminal").count(), 0, "a chat on the server has no shell")
  await p.context().close()
  p = await page({ ...b3({}), status: status({ remote: { enabled: true, roots: [] } }) })
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#composer-chips .cchip")
  assert.equal(await p.locator("#composer-chips .cchip--terminal").count(), 0, "no folder yet")
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
    await p.waitForSelector("#composer-chips .cchip")
    await p.waitForTimeout(200)
    return p
  }
  let p = await newAgent(facts)
  assert.equal(await p.locator("#composer-chips .cchip--subagents").count(), 1, "offered, and the device runs them")
  await p.click("#composer-chips .cchip--subagents")
  await p.waitForSelector(".range2")
  assert.equal(await p.getAttribute(".range2__input--min", "max"), "32", "the server's cap")
  await p.context().close()
  p = await newAgent({ ...facts, agent_subagents: { offered: true, device_runs: false } })
  assert.equal(await p.locator("#composer-chips .cchip--subagents").count(), 0, "this computer's CLI cannot run them")
  await p.context().close()
  p = await newAgent({ ...facts, agent_subagents: { offered: false, device_runs: true } })
  assert.equal(await p.locator("#composer-chips .cchip--subagents").count(), 0, "not offered")
  await p.context().close()
  p = await newAgent({ __error: { status: 400, detail: "older server" } })
  assert.equal(await p.locator("#composer-chips .cchip--subagents").count(), 0, "a server before 3.4.0: none, as before")
  await p.context().close()
  // An open agent chat: its own `subagents` (chat_agent.json offers them).
  const chat = fixture("chat_agent")
  p = await page(c4({ "GET /chats/chat2": { chat: { ...agentChat({ running: false }), subagents: chat.subagents, agents: chat.agents }, messages: [userMessage("m1", "Go")], more: false, live: null } }))
  await openChatRow(p, "chat2")
  await p.waitForSelector("#composer-chips .cchip--subagents")
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

async function pickDevice(p, name) {
  await p.click("#composer-chips .cchip--device")
  await p.locator(".menu .menu__item", { hasText: name }).first().click()
}

test("D4: a new agent chat defaults to this computer and can be sent to another linked one, in a folder it knows", async () => {
  const p = await page(d4())
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#composer-chips .cchip--device")
  assert.match(await p.textContent("#composer-chips .cchip--device"), /This computer/)
  await pickDevice(p, "studio")
  await p.waitForFunction(() => /studio/.test(document.querySelector("#composer-chips .cchip--device")?.textContent || ""))
  assert.match(await p.textContent("#new-chat .hello__sub"), /studio/, "the greeting names the computer")
  assert.match(await p.textContent("#composer-chips"), /site/, "the folder its agent chats work in")
  assert.ok(await p.isHidden("#link-notice"), "this computer's agent is not in the way")
  await shot(p, "d4-device-1280")
  // The Terminal opens on that computer, in that folder, before the first message.
  await p.click("#composer-chips .cchip--terminal")
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
  await p.waitForSelector("#composer-chips .cchip.is-warn")
  await p.fill("#composer-text", "Hello")
  await p.click("#send")
  await p.waitForSelector("#thread-note:not([hidden])")
  assert.equal(await p.evaluate(() => window.__mock.api("POST", "/chats").length), 0, "nothing sent without a folder")
  await p.click("#composer-chips .cchip.is-warn")
  await p.waitForSelector("dialog[open] .dialog__input")
  await p.fill("dialog[open] .dialog__input", "/home/dev/other")
  await p.click("dialog[open] .btn--primary")
  await p.waitForFunction(() => /other/.test(document.querySelector("#composer-chips").textContent))
  await pickDevice(p, "This computer")
  await p.waitForFunction(() => /project/.test(document.querySelector("#composer-chips").textContent))
  assert.deepEqual(p.errors, [])
})

test("D4: with no other computer linked there is no choice to make; at 390 px the chips stay inside", async () => {
  let p = await page(b3())
  await p.click("#new-chat-btn")
  await p.click(".kind__tab >> text=Agent")
  await p.waitForSelector("#composer-chips .cchip")
  assert.equal(await p.locator("#composer-chips .cchip--device").count(), 0)
  await p.context().close()
  p = await page(d4(), { width: 390, height: 844 })
  await p.evaluate(() => document.getElementById("new-chat-btn").click())
  await p.click(".kind__tab >> text=Agent")
  await pickDevice(p, "studio")
  await p.waitForFunction(() => /studio/.test(document.querySelector("#composer-chips .cchip--device")?.textContent || ""))
  assert.ok(await noSideways(p, 390), "nothing scrolls sideways")
  await shot(p, "d4-device-390")
  assert.deepEqual(p.errors, [])
})

// E5: the language and the theme, chosen in Settings and kept in this app.

async function openSettings(p) {
  await p.click("#settings-btn")
  await p.waitForSelector("#set-look")
}

test("E5: the theme is the account's until one is chosen here; chosen, it is drawn at once and kept", async () => {
  const p = await page({ status: status(), routes: baseRoutes({ "GET /me": { id: "u1", name: "Ada Example", email: "ada@example.org", theme: "shire", language: "en", permissions: {} } }), streams: {} })
  await p.waitForFunction(() => document.documentElement.dataset.theme === "shire")
  await openSettings(p)
  assert.equal(await p.inputValue("#set-theme"), "")
  assert.match(await p.textContent("#set-theme option[value='']"), /account.*Shire/)
  await p.selectOption("#set-theme", "moria")
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "moria")
  const painted = await p.evaluate(() => window.__mock.calls.filter((c) => c.cmd === "set_theme").map((c) => c.args.name))
  assert.equal(painted.at(-1), "moria", "the window is painted in it too")
  // Opened again: still Moria, over the account's Shire.
  await p.reload()
  await p.waitForSelector("#shell:not([hidden])")
  await p.waitForFunction(() => window.__mock.calls.some((c) => c.cmd === "set_theme"))
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "moria")
  await openSettings(p)
  assert.equal(await p.inputValue("#set-theme"), "moria")
  await p.selectOption("#set-theme", "")
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "shire", "back to the account's")
  assert.deepEqual(p.errors, [])
})

test("E5: a language chosen here opens the window again in it, the shells let go first; the system's again undoes it", async () => {
  const p = await page(b3())
  assert.equal(await p.evaluate(() => document.documentElement.lang), "en")
  await openChatRow(p, "chat2")
  await p.click('#chat-tools [data-terminal-toggle]')
  await p.waitForFunction(() => window.__mock.terminals().length === 1)
  // What the page let go of before it loaded again, kept across the load.
  await p.evaluate(() => addEventListener("beforeunload", () => localStorage.setItem("test.calls", JSON.stringify(window.__mock.calls.map((c) => c.cmd)))))
  await openSettings(p)
  assert.match(await p.textContent("#set-language option[value='']"), /English/)
  await Promise.all([p.waitForEvent("load"), p.selectOption("#set-language", "de")])
  await p.waitForSelector("#shell:not([hidden])")
  assert.equal(await p.evaluate(() => document.documentElement.lang), "de")
  assert.equal((await p.textContent("#settings-btn .navrow__label")).trim(), "Einstellungen")
  const before = await p.evaluate(() => JSON.parse(localStorage.getItem("test.calls") || "[]"))
  assert.ok(before.includes("terminal_close"), "the shell was let go")
  await openSettings(p)
  assert.equal(await p.inputValue("#set-language"), "de")
  assert.match(await p.textContent("#set-look"), /Sprache/)
  await Promise.all([p.waitForEvent("load"), p.selectOption("#set-language", "")])
  await p.waitForSelector("#shell:not([hidden])")
  assert.equal(await p.evaluate(() => document.documentElement.lang), "en")
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

// --- Run ----------------------------------------------------------------------------------------

const only = process.argv[2] || ""
browser = await launch()
let failed = 0
for (const { name, fn } of tests) {
  if (only && !name.includes(only)) continue
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}\n     ${String(err?.stack || err).split("\n").slice(0, 6).join("\n     ")}`)
    // On GitHub Actions, also as an annotation: readable without the job's log.
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=tests/ui::${`${name}: ${String(err?.message || err)} (${String(err?.stack || "").match(/run\.mjs:\d+/)?.[0] || ""})`.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 900)}`)
  }
}
await browser.close()
console.log(failed ? `tests/ui: ${failed} failed` : "tests/ui: all passed")
process.exit(failed ? 1 : 0)
