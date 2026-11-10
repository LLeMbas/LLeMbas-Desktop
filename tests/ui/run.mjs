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
    "GET /devices": { devices: [{ id: "token1", name: "workbench", host: "workbench", linked: true }] },
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
  }
}
await browser.close()
console.log(failed ? `tests/ui: ${failed} failed` : "tests/ui: all passed")
process.exit(failed ? 1 : 0)
