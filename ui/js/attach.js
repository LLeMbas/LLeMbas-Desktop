// The files the next message carries. Three ways in, each the person's own act: the attach
// button (the system's file dialog, in Rust), files dropped on the window (Rust holds the drop;
// the page never names a path), and an image pasted into the composer (its bytes, as pasted).
// Each is sent to the server at once (`/api/v2/attachments`), shown above the composer, and goes
// with the message that is sent next; one taken off before that is deleted on the server.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, listen, del, why } from "./bridge.js"

let pending = [] // { key, name, size, state: "sending" | "ready" | "failed", id?, error? }
let seq = 0
let ctx = null // { chat(): the open chat's id, or "" for one not made yet; allowed(): bool }

const REASONS = {
  folder: () => t("This is a folder; attach the files in it."),
  too_large: () => t("This file is too large to send."),
}

/** The ids of the files sent and ready to go with the message. */
export function readyIds() {
  return pending.filter((p) => p.state === "ready").map((p) => p.id)
}

/** A file is still being sent. */
export function sending() {
  return pending.some((p) => p.state === "sending")
}

/** After a send: the files belong to the message now. */
export function sent() {
  pending = []
  render()
}

/** Another chat opened, or a new one: files never sent are deleted on the server. */
export function discard() {
  for (const p of pending) if (p.state === "ready") del(`/attachments/${encodeURIComponent(p.id)}`).catch(() => {})
  pending = []
  render()
}

function remove(p) {
  if (p.state === "ready") del(`/attachments/${encodeURIComponent(p.id)}`).catch(() => {})
  pending = pending.filter((x) => x !== p)
  render()
}

/** One file as the composer shows it: the same three tracks for every row. */
function row(p) {
  const status =
    p.state === "sending" ? t("Sending…") : p.state === "failed" ? p.error || "" : p.size ? bytes(p.size) : ""
  return h(
    "li",
    { class: `file is-${p.state}`, title: p.state === "failed" ? `${p.name}: ${p.error || ""}` : p.name },
    h("span", { class: "file__name" }, h("bdi", { text: p.name })),
    h("span", { class: "file__state", text: status }),
    h(
      "button",
      {
        type: "button",
        class: "file__remove",
        "aria-label": t("Remove %(dir)s", { dir: p.name }),
        title: t("Remove"),
        disabled: p.state === "sending",
        onclick: () => remove(p),
      },
      icon(ICONS.close),
    ),
  )
}

function render() {
  const list = clear($("composer-files"))
  list.hidden = !pending.length
  for (const p of pending) list.append(row(p))
}

/** Show `names` as being sent while `call` sends them; then what became of each. */
async function track(names, call) {
  const placeholders = names.map((name) => ({ key: ++seq, name, size: 0, state: "sending" }))
  pending.push(...placeholders)
  render()
  let results
  try {
    results = await call()
  } catch (err) {
    results = placeholders.map((p) => ({ name: p.name, size: 0, error: why(err) }))
  }
  pending = pending.filter((p) => !placeholders.includes(p))
  for (const r of results || []) {
    pending.push(
      r.attachment
        ? { key: ++seq, name: r.attachment.name || r.name, size: r.attachment.size || r.size, state: "ready", id: r.attachment.id }
        : { key: ++seq, name: r.name, size: r.size, state: "failed", error: (REASONS[r.reason] || (() => r.error))() },
    )
  }
  render()
}

/** Choose files in the system's dialog. */
async function pick() {
  const b = $("attach")
  b.disabled = true
  try {
    await track([], () => invoke("attach_pick", { chat: ctx.chat() || null, title: t("Attach files") }))
  } finally {
    b.disabled = false
  }
}

/** Files pasted into the composer (a screenshot, mostly): sent from their bytes. */
async function paste(e) {
  const files = [...(e.clipboardData?.files || [])]
  if (!files.length || !ctx.allowed()) return
  e.preventDefault()
  for (const f of files) {
    const name = f.name || "pasted"
    track([name], async () => {
      const data = new Uint8Array(await f.arrayBuffer())
      const attachment = await invoke("attach_bytes", data, { headers: { "x-name": encodeURIComponent(name), "x-chat": ctx.chat() || "" } })
      return [{ name, size: f.size, attachment }]
    })
  }
}

export function initAttach(context) {
  ctx = context
  $("attach").replaceChildren(icon(ICONS.attach))
  $("attach").addEventListener("click", pick)
  $("composer-text").addEventListener("paste", paste)
  const usable = () => !$("composer").hidden && !$("shell").hidden && ctx.allowed()
  listen("drag", (e) => {
    $("composer").dataset.drag = String(!!e.payload && usable())
  })
  listen("drop", (e) => {
    $("composer").dataset.drag = "false"
    if (!usable()) return
    const names = Array.isArray(e.payload) ? e.payload : []
    track(names, () => invoke("attach_dropped", { chat: ctx.chat() || null }))
  })
}

/** Whether this account may attach files at all: the button shows only then. */
export function allowAttach(on) {
  $("attach").hidden = !on
  $("composer").dataset.attach = String(on)
}
