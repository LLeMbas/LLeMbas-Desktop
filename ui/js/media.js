// What a model made, in the chat: a picture, a video, a track, a 3D model -- the typed result a
// tool call carries (`media`), drawn as a card under the call -- and the card of a long
// generation (`media_job`): what is being made, how it stands, for how long, and Cancel.
//
// A generated file is named by its id (`node_id`), so it is found where it is now, renamed or
// moved. A picture is an `<img>`, video and music the webview's own players, each at an address
// of the media scheme that names that one file (src-tauri/src/media.rs: Rust asks the server,
// with the token, a piece at a time; the page never holds the token). A 3D model is drawn in a
// sealed frame (sealedview.js) once the person asks to see it. Download goes through the
// system's save dialog and is written by Rust as it arrives.
//
// A job has no stream frame -- a chat has no stream while no reply is being written -- so a card
// on the screen asks for its job every few seconds until the state is final or the card is gone
// (the chat was left). A job that ends by itself wakes its chat with a reply this app did not
// start: the chat is read again then.
//
// Sound and video the person attached to a message are players too (`attachmentTile`).

import { h, bytes } from "./dom.js"
import { invoke, get, del, why } from "./bridge.js"
import { sealedViewer } from "./sealedview.js"

const POLL_MS = 3000
const ACTIVE = ["queued", "running"]
const FINAL = ["done", "failed", "cancelled", "expired"]

let ctx = { openInFiles: () => {}, woken: () => {} }
const cards = new Map() // node:version -> the card drawn for it (kept while the chat shows)
const closers = new Set() // what lets go of a sealed frame or a `blob:`
const jobs = new Map() // job id -> { job, at, timer, ticks, asked }

/** `openInFiles(media)`: show the file in the server's files; `woken(job)`: its chat has a new reply. */
export function initMedia(context) {
  ctx = { ...ctx, ...context }
}

/** The chat was left: its cards, their frames and the jobs' timers go. What is known of a job stays. */
export function forgetMedia() {
  for (const close of closers) close()
  closers.clear()
  cards.clear()
  for (const j of jobs.values()) {
    clearInterval(j.timer)
    j.timer = null
  }
}

const gone = () => t("This file is no longer there.")
const cannot = () => t("This file could not be shown here. It can still be downloaded.")

/**
 * A picture, sound or video at an address `open()` asks Rust for. A webview whose player will
 * not take the scheme's address is handed the whole sound or video once instead (a `blob:`); a
 * file that is no longer there says so.
 */
function shown(kind, open, { name = "", mime = "", width = 0, height = 0 } = {}) {
  const note = (text) => h("p", { class: "mcard__note", text })
  const box = h("div", { class: "mcard__view" }, note(t("Loading…")))
  open().then(
    (url) => {
      const el =
        kind === "image"
          ? h("img", { class: "mcard__image", alt: name, src: url, draggable: "false", width: width > 0 ? width : null, height: height > 0 ? height : null })
          : h(kind, { class: kind === "audio" ? "mcard__audio" : "mcard__video", controls: true, preload: "metadata", src: url, "aria-label": name })
      // The room a video takes is known before its first frame is: nothing under it moves.
      if (kind === "video" && width > 0 && height > 0) el.style.aspectRatio = `${width} / ${height}`
      let again = false
      el.addEventListener("error", async () => {
        if (again) return void box.replaceChildren(note(cannot()))
        again = true
        try {
          const data = await invoke("media_bytes", { url })
          // A picture that would not draw from the scheme will not draw from anywhere else (the
          // page's policy takes pictures from the scheme and `data:` only): asked for whole
          // only to learn whether the file is still there.
          if (kind === "image") return void box.replaceChildren(note(cannot()))
          const blob = URL.createObjectURL(new Blob([data], { type: mime || (kind === "audio" ? "audio/mpeg" : "video/mp4") }))
          closers.add(() => URL.revokeObjectURL(blob))
          el.src = blob
        } catch (err) {
          box.replaceChildren(note(err?.status === 404 ? gone() : cannot()))
        }
      })
      box.replaceChildren(el)
    },
    (err) => box.replaceChildren(note(why(err))),
  )
  return box
}

/** A 3D model: drawn when asked for, in a sealed frame. */
function model(m) {
  const box = h("div", { class: "mcard__view mcard__view--model" })
  const show = h("button", {
    type: "button",
    class: "btn mcard__show",
    text: t("Preview"),
    onclick: () => {
      const viewer = sealedViewer("model3d", { source: "server", node: m.node_id }, { name: m.name || "" })
      closers.add(viewer.close)
      box.replaceChildren(viewer.el)
    },
  })
  box.append(show)
  return box
}

const PLAYERS = { image: "image", image_edit: "image", video: "video", music: "audio" }

/** The card of a generated file: what it is, its name, Open in Files, Download. */
export function mediaCard(m) {
  if (!m || typeof m !== "object" || !m.node_id) return null
  const key = `${m.node_id}:${m.version_id || ""}`
  // While a reply is written its steps are drawn again with every change: the card that is
  // there is kept, so a picture is not fetched twice and a player keeps its place.
  if (cards.has(key)) return cards.get(key)
  const player = PLAYERS[m.kind]
  const view = player ? shown(player, () => invoke("media_open", { source: "server", kind: player, node: m.node_id }), m) : m.kind === "model3d" ? model(m) : null
  const said = h("p", { class: "mcard__said", role: "status" })
  const say = (text, error = false) => {
    said.textContent = text
    said.classList.toggle("is-error", error)
  }
  const download = async (e) => {
    const button = e.currentTarget
    button.disabled = true
    say("")
    try {
      const r = await invoke("media_save_as", { node: m.node_id, name: m.name || "file", title: t("Download") })
      if (r?.path) say(`${t("Saved.")} ${r.path}`)
    } catch (err) {
      say(err?.status === 404 ? gone() : why(err), true)
    }
    button.disabled = false
  }
  const facts = [Number.isFinite(m.size) && m.size > 0 ? bytes(m.size) : "", m.width > 0 && m.height > 0 ? `${m.width} × ${m.height}` : "", m.seconds > 0 ? clock(m.seconds) : ""].filter(Boolean).join(" · ")
  const el = h(
    "figure",
    { class: "mcard", dataset: { media: String(m.kind || ""), node: m.node_id } },
    view,
    h(
      "figcaption",
      { class: "mcard__bar" },
      h("span", { class: "mcard__name", title: m.path || m.name || "" }, h("bdi", { text: m.name || "" })),
      h("span", { class: "mcard__facts", text: facts }),
      h("span", { class: "mcard__do" }, h("button", { type: "button", class: "btn btn--sm mcard__files", text: t("Open in Files"), onclick: () => ctx.openInFiles(m) }), h("button", { type: "button", class: "btn btn--sm mcard__download", text: t("Download"), onclick: download })),
    ),
    said,
  )
  cards.set(key, el)
  return el
}

/**
 * A picture a call made that the server names only as an attachment (`image: { id, width,
 * height }`, a server before `media`): drawn, with nothing to open or download by.
 */
export function pictureCard(image, attachmentPicture) {
  if (!image || typeof image !== "object" || !image.id) return null
  const key = `image:${image.id}`
  if (cards.has(key)) return cards.get(key)
  const box = h("div", { class: "mcard__view" })
  const el = h("figure", { class: "mcard", dataset: { media: "image" } }, box)
  attachmentPicture(`/attachments/${image.id}`).then((url) => {
    if (!url || !url.startsWith("data:image/")) return void box.replaceChildren(h("p", { class: "mcard__note", text: cannot() }))
    box.replaceChildren(h("img", { class: "mcard__image", alt: "", src: url, draggable: "false", width: image.width > 0 ? image.width : null, height: image.height > 0 ? image.height : null }))
  })
  cards.set(key, el)
  return el
}

// --- A long generation ------------------------------------------------------------------------------

const KIND_WORDS = { image: () => t("Image"), image_edit: () => t("Image"), video: () => t("Video"), music: () => t("Music"), model3d: () => t("3D model") }
const STATE_WORDS = { queued: () => t("Waiting to start"), running: () => t("Being made"), done: () => t("Done"), failed: () => t("Failed"), cancelled: () => t("Cancelled"), expired: () => t("Given up on") }

/** Seconds as m:ss. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** How long a job has run by now: the server's count, and what has passed here since it was read. */
function elapsed(j) {
  const job = j.job
  if (!Number.isFinite(job?.seconds)) return null
  return job.seconds + (ACTIVE.includes(job.state) && j.at ? Math.floor((Date.now() - j.at) / 1000) : 0)
}

function drawJob(el, j) {
  const job = j.job
  el.dataset.state = String(job.state || "")
  if (job.state === "done" && job.result) {
    const card = mediaCard(job.result)
    if (card) return void el.replaceChildren(card)
  }
  const state = STATE_WORDS[job.state] ? job.state : "failed"
  const busy = ACTIVE.includes(job.state)
  const time = elapsed(j)
  const said = h("p", { class: "mjob__said is-error", role: "alert", text: j.problem || "" })
  // Cancel only for a job the server said is running: the call's own word may be an old one.
  const cancel =
    job.active === true
      ? h("button", {
          type: "button",
          class: "btn btn--sm mjob__cancel",
          text: t("Cancel"),
          onclick: async (e) => {
            e.currentTarget.disabled = true
            try {
              took(j, await del(`/media/jobs/${encodeURIComponent(job.id)}`))
            } catch (err) {
              j.problem = why(err)
              redraw(job.id)
            }
          },
        })
      : null
  el.replaceChildren(
    h(
      "div",
      { class: "mjob__row" },
      h("span", { class: `mjob__dot dot${busy ? " is-busy" : state === "failed" || state === "expired" ? " is-error" : ""}`, "aria-hidden": "true" }),
      h("span", { class: "mjob__kind", text: (KIND_WORDS[job.kind] || (() => String(job.kind || "")))() }),
      h("span", { class: "mjob__state", role: "status", text: STATE_WORDS[state]() }),
      h("span", { class: "mjob__time", text: time === null ? "" : clock(time) }),
      h("span", { class: "mjob__do" }, cancel),
    ),
    job.source || job.prompt ? h("p", { class: "mjob__what", text: [job.source, job.prompt].filter(Boolean).join(" · ") }) : null,
    // Why it ended as it did, in the server's own sentence.
    job.error ? h("p", { class: "mjob__error", text: String(job.error) }) : null,
    j.problem ? said : null,
  )
}

const cardsOf = (id) => [...document.querySelectorAll(".mjob[data-job]")].filter((el) => el.dataset.job === id)

function redraw(id) {
  const j = jobs.get(id)
  if (j) for (const el of cardsOf(id)) drawJob(el, j)
}

/** What the server said of a job just now. */
function took(j, job) {
  if (!job || typeof job !== "object" || !job.id) return
  const was = j.job
  j.job = job
  j.at = Date.now()
  j.problem = ""
  redraw(job.id)
  // It ended by itself while its card was looked at: its chat has, or is about to have, a
  // reply nobody here asked for. (A cancelled job wakes nobody.)
  if (j.read && ACTIVE.includes(was?.state) && FINAL.includes(job.state) && job.state !== "cancelled") ctx.woken(job)
  j.read = true
}

async function read(id) {
  const j = jobs.get(id)
  if (!j || j.asking) return
  j.asking = true
  try {
    took(j, await get(`/media/jobs/${encodeURIComponent(id)}`))
  } catch (err) {
    // Somebody else's job, or one that is gone: nothing more is asked. Anything else is tried again.
    if (err?.status === 404) {
      j.job = { ...j.job, state: "failed", active: false, error: why(err) }
      redraw(id)
    }
  }
  j.asking = false
}

function follow(id) {
  const j = jobs.get(id)
  if (!j || j.timer) return
  if (j.read && !ACTIVE.includes(j.job.state)) return
  j.ticks = 0
  read(id)
  j.timer = setInterval(() => {
    const els = cardsOf(id)
    const final = j.read && !ACTIVE.includes(j.job.state)
    if (!els.length || final) {
      clearInterval(j.timer)
      j.timer = null
      return
    }
    j.ticks += 1
    if (j.ticks % (POLL_MS / 1000) === 0) read(id)
    const time = elapsed(j)
    if (time !== null) for (const el of els) for (const at of el.querySelectorAll(".mjob__time")) at.textContent = clock(time)
  }, 1000)
}

/** The card of a tool call's `media_job` (`{ id, kind, state }` as it was when the call returned). */
export function jobCard(stub) {
  if (!stub || typeof stub !== "object" || !stub.id) return null
  const id = String(stub.id)
  if (!jobs.has(id)) jobs.set(id, { job: { id, kind: stub.kind, state: stub.state }, at: 0, timer: null, ticks: 0, read: false, asking: false, problem: "" })
  const j = jobs.get(id)
  const el = h("div", { class: "mjob", dataset: { job: id } })
  drawJob(el, j)
  follow(id)
  return el
}

// --- Sound and video a message carries ---------------------------------------------------------------

/** An attached sound or video file, as a tile with its player: `a` is the message's attachment. */
export function attachmentTile(a) {
  const kind = a.kind === "video" ? "video" : "audio"
  return h(
    "li",
    { class: "ptile", title: a.name || "", dataset: { kind } },
    shown(kind, () => invoke("media_open", { source: "attachment", kind, attachment: String(a.id) }), { name: a.name || "", mime: a.media_type || a.mime || "" }),
    h("span", { class: "ptile__name" }, h("bdi", { text: a.name || "" })),
    h("span", { class: "ptile__size", text: a.size ? bytes(a.size) : "" }),
  )
}
