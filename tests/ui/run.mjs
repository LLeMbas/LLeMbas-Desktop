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

async function page(config, { width = 1280, height = 860, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height } })
  const p = await context.newPage()
  // The page's own timers, moved on by the test (`p.clock.fastForward`) rather than waited for.
  if (clock) await p.clock.install()
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
  assert.equal(await p.getAttribute("#target-sum", "aria-expanded"), "true", "a choice keeps the three open")
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
  await p.waitForFunction(() => window.__mock.api("GET", "/chats/chat1").length === 1)
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
    await targetChips(p)
    // One family: the same height, on one line where they are side by side.
    const boxes = await p.$$eval("#target-chips .cchip", (l) => l.map((x) => { const r = x.getBoundingClientRect(); return { h: r.height, top: r.top, cls: x.className } }))
    assert.equal(boxes.length, 3, `${width}: computer, folder, mode`)
    assert.equal(new Set(boxes.map((b) => b.h)).size, 1, `${width}: one height`)
    if (!folded) assert.equal(new Set(boxes.map((b) => b.top)).size, 1, `${width}: one line`)
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
      await p.keyboard.press("Escape")
    }
    await shot(p, `t1-target-${width}`)
    // The mode chosen there is the one the chat starts in.
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
const call = (over = {}) => ({ id: "t1", name: "bash", status: "ok", args: { command: "bun test\n--bail" }, text: "12 pass", block: { kind: "shell", title: "bun test", chips: ["exit 0"], added: 0, removed: 0 }, ...over })
const CALLS = [
  call({ exit: 0 }),
  call({ id: "t2", name: "edit", args: { path: "README.md" }, text: "", diff: DIFF, block: { kind: "edit", title: "README.md", chips: ["+2", "−1"], added: 2, removed: 1 } }),
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

// --- S3: the composer's `/` and `@` menus -----------------------------------------------------------
//
// CONTRACT (unpinned): the server's menu routes as the plan for server 2.0.0-beta.11 words them --
// GET /devices/{id}/commands, GET /devices/{id}/files, GET /mentions, POST /attachments/from.
// The answers below are written to that wording, not copied from a server fixture; replace them
// with the fixtures (scripts/fetch-fixtures.sh) once the server has them.

const MENTIONS = {
  items: [
    { kind: "file", path: "/notes/recipes/lembas recipe #2.md", name: "lembas recipe #2.md", detail: "/notes/recipes/lembas recipe #2.md" },
    { kind: "attachment", id: "att7", name: "oven.png", detail: "48 kB" },
  ],
}
const DEVICE_FILES = { files: [{ path: "src/app main.ts", kind: "file" }, { path: "src/tui", kind: "dir" }] }
const DEVICE_COMMANDS = { commands: [{ name: "review", description: "Review the working tree", hint: "" }, { name: "commit", description: "Commit with a message", hint: "<message>" }, { name: "compact", description: "The device's own compact", hint: "" }] }

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
    "POST /attachments/from": { attachment: { id: "att9", name: "oven.png", size: 48000, image: false } },
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
  await o.keyboard.press("Escape")
  await o.fill("#composer-text", "")
  await o.keyboard.type("/")
  await o.waitForSelector("#composer-menu:not([hidden])")
  assert.ok((await menuRows(o)).includes("/help"), "the app's own commands need no route")
  assert.deepEqual(o.errors, [])
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
