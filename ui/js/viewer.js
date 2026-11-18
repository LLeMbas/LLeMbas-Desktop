// The viewer beside the chat: a file from this computer, from the server, or one the agent showed
// (`show`), drawn by what it is -- the server's word for it (`file_kind`), and this computer's
// the same (src-tauri/src/kinds.rs). Markdown is drawn (`markdown.js`), code and text are
// CodeMirror, HTML is a sealed frame (src-tauri/src/sealed.rs): its own scheme, no bridge, no
// network, no way out. A picture -- an SVG too, only ever as a picture -- is an `<img>`, sound
// and video the webview's own players, each fed by Rust a piece at a time
// (src-tauri/src/media.rs: the page holds an address that names one file, never the token). A
// table is a table, a notebook its cells as text; an archive, a binary, a PDF and a 3D model
// are their details and a way to save them. What a file says is never part of the app's page.
//
// A text file that may be written can be edited here and saved; a save the file has changed
// under is not made, and offers both ways on: read it again, or save anyway.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, why } from "./bridge.js"
import { markdown } from "./markdown.js"
import { codeView } from "./code.js"
import { ask } from "./popup.js"

// The viewer's kind by a file's name: the CLI's and the server's `showKind`, the same table.
const LANGUAGES = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", json: "json", py: "python", rs: "rust", go: "go",
  rb: "ruby", php: "php", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", css: "css", scss: "scss", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", svg: "xml", ipynb: "json", gltf: "json", lua: "lua", zig: "zig", dart: "dart", vue: "vue", svelte: "svelte",
}

export function showKind(path) {
  const name = String(path).split("/").pop() || ""
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : ""
  if (ext === "md" || ext === "markdown") return { kind: "markdown", language: "markdown" }
  if (ext === "html" || ext === "htm") return { kind: "html", language: "html" }
  const language = LANGUAGES[ext] || (name === "Dockerfile" ? "dockerfile" : name === "Makefile" ? "makefile" : "")
  return language ? { kind: "code", language } : { kind: "text", language: "" }
}

// What a file is by its name alone, for a server that does not say (`file_kind`, 2.0.0-beta.17)
// and for an icon: the registry's kinds. The bytes decide where they are at hand.
const BY_EXT = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", svg: "svg", pdf: "pdf",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio", m4a: "audio", aac: "audio", weba: "audio",
  mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video", ogv: "video",
  csv: "table", tsv: "table", ipynb: "notebook", glb: "model3d", gltf: "model3d", obj: "model3d", stl: "model3d",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive", xz: "archive", "7z": "archive",
}
export const KINDS = ["markdown", "code", "text", "html", "image", "svg", "pdf", "audio", "video", "table", "notebook", "model3d", "archive", "binary"]
/** The kinds that are text: what the editor may open (the server's TEXT_KINDS). */
const TEXT_KINDS = ["markdown", "code", "text", "html", "svg", "table", "notebook"]
/** The kinds drawn from the file's bytes by the webview itself. */
const MEDIA_KINDS = ["image", "svg", "audio", "video"]

/** A file's kind: `said` where it is one of the registry's (plain `text` told from code by the name), else by the name. */
export function fileKind(name, said) {
  const byName = () => {
    const base = String(name).split("/").pop() || ""
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : ""
    return BY_EXT[ext] || showKind(name).kind
  }
  if (!KINDS.includes(said)) return byName()
  return said === "text" ? showKind(name).kind : said
}

// The most of a table drawn: the rest is in the source, and in the file.
export const TABLE_ROWS = 500
const TABLE_COLUMNS = 60
// The most of a notebook drawn, and the largest picture among a cell's outputs.
const NOTEBOOK_CELLS = 300
const NOTEBOOK_PICTURE = 4 * 1024 * 1024
// The largest file a player that will not take the scheme's address is given whole instead.
const WHOLE_BYTES = 64 * 1024 * 1024

let current = null // { editor, sealed, media, dirty }
let onChange = () => {}

/** Called when the viewer opens or closes (the layout makes room for it). */
export function onViewer(fn) {
  onChange = fn
}

function teardownBody() {
  if (!current) return
  current.editor?.destroy()
  current.editor = null
  if (current.sealed) invoke("sealed_close", { url: current.sealed })
  current.sealed = null
  for (const url of current.blobs || []) URL.revokeObjectURL(url)
  current.blobs = []
}

function teardown() {
  if (!current) return
  teardownBody()
  if (current.media) invoke("media_close", { url: current.media }).catch(() => {})
  current = null
}

/** Close it, whatever it holds: an edit not saved is let go (the Close button asks first). */
export function closeViewer() {
  teardown()
  $("viewer").hidden = true
  clear($("viewer-body"))
  clear($("viewer-bar")).hidden = true
  onChange(false)
}

/** Whether what is open has changes that were not saved. */
export const viewerDirty = () => !!current?.dirty

/** An edit not saved is not thrown away without a word: true when there is none, or it may go. */
async function mayLeave() {
  if (!current?.dirty) return true
  return !!(await ask({ title: t("Not saved yet"), text: current.name || "", ok: t("Discard"), cancel: t("Cancel"), danger: true }))
}

/**
 * Why a file has no text, in words: this computer's `withheld` is "binary" | "too_big"; the
 * server's is { reason: "not_text" | "too_large", message } with the message in the person's
 * language already.
 */
export function withheldWords(withheld, size) {
  if (typeof withheld === "object" && withheld.message) return String(withheld.message)
  const reason = typeof withheld === "object" ? withheld.reason : withheld
  return reason === "too_big" || reason === "too_large"
    ? t("This file is too big to show here (%(size)s).", { size: bytes(size) })
    : t("This is not a text file; it cannot be shown here.")
}

// --- A table ------------------------------------------------------------------------------------

/**
 * The rows of a CSV or TSV text (RFC 4180: a field in double quotes may hold the separator, a
 * line break and a doubled quote), at most `most` of them; `more` says there were others.
 */
export function tableRows(text, separator, most = TABLE_ROWS + 1) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  let any = false
  const end = () => {
    row.push(field)
    field = ""
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++
      else if (c === '"') quoted = false
      else field += c
      continue
    }
    if (c === '"' && field === "") quoted = any = true
    else if (c === separator) end(), (any = true)
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      if (any || field !== "" || row.length) {
        end()
        rows.push(row)
        if (rows.length >= most) return { rows, more: i < text.length - 1 }
      }
      row = []
      any = false
    } else (field += c), (any = true)
  }
  if (any || field !== "" || row.length) {
    end()
    rows.push(row)
  }
  return { rows, more: false }
}

/** The separator of a table's text: a tab for .tsv; else whichever of , ; and a tab its first line has most of. */
function separatorOf(name, text) {
  if (/\.tsv$/i.test(name)) return "\t"
  const first = text.slice(0, 4096).split(/\r?\n/)[0] || ""
  const count = (c) => first.split(c).length - 1
  return [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0]
}

function drawTable(name, text) {
  const { rows, more } = tableRows(text, separatorOf(name, text))
  const shown = rows.slice(0, TABLE_ROWS)
  const width = Math.min(TABLE_COLUMNS, Math.max(0, ...shown.map((r) => r.length)))
  const cells = (r, tag) => Array.from({ length: width }, (_, i) => h(tag, { text: r[i] ?? "", scope: tag === "th" ? "col" : null }))
  const [first, ...rest] = shown
  const table = h(
    "table",
    { class: "vtable" },
    first ? h("thead", null, h("tr", null, cells(first, "th"))) : null,
    h("tbody", null, rest.map((r) => h("tr", null, cells(r, "td")))),
  )
  // A wide table scrolls inside its own box; the viewer never does.
  return h(
    "div",
    { class: "viewer__table" },
    more || rows.length > TABLE_ROWS ? h("p", { class: "viewer__cap", text: t("Only the first %(n)s rows are shown.", { n: TABLE_ROWS }) }) : null,
    h("div", { class: "vtable__scroll", tabindex: "0", role: "region", "aria-label": name }, table),
  )
}

// --- A notebook ---------------------------------------------------------------------------------
//
// Read-only, and every word of it as text: a cell's source, its printed output, an error's
// lines. Nothing in it is run, and nothing in it is markup -- an output that is HTML is not
// drawn at all (its plain text is, where the notebook kept one). A picture among the outputs is
// drawn where it is a PNG or a JPEG, from its own base64.

const joined = (v) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "")
// The colour codes a traceback carries (ESC [ ... m), which a terminal would have drawn.
const plain = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")

function drawNotebook(text) {
  let nb
  try {
    nb = JSON.parse(text)
  } catch {
    return null
  }
  const all = Array.isArray(nb?.cells) ? nb.cells : Array.isArray(nb?.worksheets?.[0]?.cells) ? nb.worksheets[0].cells : null
  if (!all) return null
  const box = h("div", { class: "viewer__nb" })
  for (const cell of all.slice(0, NOTEBOOK_CELLS)) {
    const source = joined(cell?.source ?? cell?.input)
    if (cell?.cell_type !== "code") {
      box.append(h("div", { class: "nbcell nbcell--words" }, h("pre", { class: "nbcell__words", text: source })))
      continue
    }
    const outs = []
    for (const o of Array.isArray(cell.outputs) ? cell.outputs : []) {
      const data = o?.data && typeof o.data === "object" ? o.data : {}
      const png = typeof data["image/png"] === "string" ? ["image/png", data["image/png"]] : typeof data["image/jpeg"] === "string" ? ["image/jpeg", data["image/jpeg"]] : null
      if (png) {
        const b64 = png[1].replace(/\s+/g, "")
        if (b64.length <= NOTEBOOK_PICTURE && /^[A-Za-z0-9+/]+=*$/.test(b64)) {
          outs.push(h("img", { class: "nbcell__picture", alt: "", src: `data:${png[0]};base64,${b64}` }))
          continue
        }
      }
      const words = o?.output_type === "error" ? plain(joined(o.traceback?.join?.("\n")) || `${o.ename || ""}: ${o.evalue || ""}`) : joined(o?.text) || joined(data["text/plain"])
      if (words) outs.push(h("pre", { class: `nbcell__out${o?.output_type === "error" ? " is-error" : ""}`, text: words }))
    }
    const n = Number.isInteger(cell.execution_count) ? String(cell.execution_count) : " "
    box.append(h("div", { class: "nbcell nbcell--code" }, h("span", { class: "nbcell__n", "aria-hidden": "true", text: `[${n}]` }), h("pre", { class: "nbcell__code", text: source }), outs.length ? h("div", { class: "nbcell__outs" }, outs) : null))
  }
  if (all.length > NOTEBOOK_CELLS) box.append(h("p", { class: "viewer__cap", text: "…" }))
  return box
}

// --- A file that is not drawn: what it is, and a way to save it -----------------------------------

function drawFacts(file, words) {
  const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", { text: value })] : [])
  return h(
    "div",
    { class: "viewer__facts" },
    h("span", { class: "viewer__facts-icon" }, icon(ICONS.file)),
    words ? h("p", { class: "viewer__note", text: words }) : null,
    h("dl", { class: "fdetails__facts" }, fact(t("Type"), file.mime || file.kind || ""), fact(t("Size"), Number.isFinite(file.size) ? bytes(file.size) : ""), fact(t("Path"), file.path || "")),
    file.download ? h("div", { class: "viewer__do" }, h("button", { type: "button", class: "btn btn--primary", text: t("Download"), onclick: () => file.download() })) : null,
  )
}

/**
 * Show a file. `file`:
 *   name, path, where (words for its place)
 *   kind?, language?, line?     its kind as the server or this computer said it (else by its name)
 *   text?, withheld?, size?, mime?, error?
 *   media?()                    -> the address its bytes are served at (a picture, sound, video)
 *   download?()                 saves it somewhere the person chooses
 *   save?(text, { base, force }) -> { sha, text }   present where it may be written; rejects with
 *                               { status: 409, detail } when the file changed meanwhile
 *   sha?                        what `text` was read as: what a save starts from
 *   reload?()                   reads it again, and shows that
 * Resolves false when an edit that was not saved is kept instead (the person said so).
 */
export async function openViewer(file) {
  if (!(await mayLeave())) return false
  teardown()
  const byName = showKind(file.path || file.name)
  const kind = fileKind(file.path || file.name, file.kind)
  const lang = file.language || byName.language
  $("viewer").hidden = false
  onChange(true)
  $("viewer-name").textContent = file.name || file.path || ""
  $("viewer-name").title = file.path || ""
  $("viewer-where").textContent = file.where || ""
  const body = clear($("viewer-body"))
  const modes = clear($("viewer-modes"))
  const bar = clear($("viewer-bar"))
  bar.hidden = true
  const mine = (current = { name: file.name || "", dirty: false, blobs: [] })
  const here = () => current === mine
  if (file.error) {
    body.append(h("p", { class: "viewer__note is-error", text: file.error }))
    return true
  }
  // What the webview draws from the bytes themselves.
  if (MEDIA_KINDS.includes(kind) && file.media && !(kind === "svg" && typeof file.text === "string" && !file.withheld && file.viewAs === "source")) {
    await drawMedia(file, kind, body, modes, bar, mine)
    return true
  }
  const isText = TEXT_KINDS.includes(kind) && !file.withheld && typeof file.text === "string"
  if (!isText) {
    body.append(drawFacts({ ...file, kind }, file.withheld ? withheldWords(file.withheld, file.size) : t("This is not a text file; it cannot be shown here.")))
    return true
  }
  await drawText(file, kind, lang, body, modes, bar, mine, here)
  return true
}

/** A picture, sound or video: the element the webview has for it, at the address Rust serves. */
async function drawMedia(file, kind, body, modes, bar, mine) {
  const here = () => current === mine
  const failed = (text) => {
    if (!here()) return
    clear(body).append(drawFacts({ ...file, kind }, text || t("This file cannot be shown here.")))
  }
  let url
  try {
    url = await file.media()
  } catch (err) {
    return failed(why(err))
  }
  if (!here()) return void invoke("media_close", { url }).catch(() => {})
  mine.media = url
  const holder = h("div", { class: "viewer__media" })
  let el
  if (kind === "image" || kind === "svg") {
    el = h("img", { class: "viewer__image", alt: file.name || "", src: url, draggable: "false" })
    el.addEventListener("error", () => failed(), { once: true })
  } else {
    el = h(kind, { class: kind === "audio" ? "viewer__audio" : "viewer__video", controls: true, preload: "metadata", src: url, "aria-label": file.name || "" })
    // A webview whose player will not take the scheme's address is handed the whole file once
    // instead (a `blob:`), where it is small enough to hold; seeking works there too.
    let again = false
    el.addEventListener("error", async () => {
      if (again || !here() || !(Number(file.size) <= WHOLE_BYTES)) return failed()
      again = true
      try {
        const data = await invoke("media_bytes", { url })
        if (!here()) return
        const blob = URL.createObjectURL(new Blob([data], { type: file.mime || (kind === "audio" ? "audio/mpeg" : "video/mp4") }))
        mine.blobs.push(blob)
        el.src = blob
        el.addEventListener("error", () => failed(), { once: true })
      } catch {
        failed()
      }
    })
  }
  holder.append(el)
  body.append(holder)
  if (file.download) {
    bar.hidden = false
    bar.append(h("span", { class: "viewer__said", text: Number.isFinite(file.size) ? bytes(file.size) : "" }), h("button", { type: "button", class: "btn btn--sm", text: t("Download"), onclick: () => file.download() }))
  }
  // An SVG is text as well: its source can be read (and changed) beside the picture.
  if (kind === "svg" && typeof file.text === "string" && !file.withheld) {
    modes.append(
      h("button", { type: "button", class: "seg", "aria-pressed": "true", text: t("Preview") }),
      h("button", { type: "button", class: "seg", "aria-pressed": "false", text: t("Source"), onclick: () => openViewer({ ...file, viewAs: "source" }) }),
    )
  }
}

/** A text file: drawn (Markdown, a page, a table, a notebook), as its source, or being edited. */
async function drawText(file, kind, lang, body, modes, bar, mine, here) {
  let text = file.text // as saved
  let sha = file.sha || null
  let draft = null // what the editor holds, while it differs
  let mode = "view"
  const drawn = ["markdown", "html", "table", "notebook"].includes(kind)
  const editable = typeof file.save === "function"
  const now = () => (mine.editor && mode === "edit" ? mine.editor.state.doc.toString() : draft ?? text)

  const said = h("span", { class: "viewer__said", role: "status" })
  const saveBtn = h("button", { type: "button", class: "btn btn--sm btn--primary", id: "viewer-save", text: t("Save"), onclick: () => save(false) })
  const drawBar = (state) => {
    // One line: what is so, then what can be done about it. A file changed meanwhile says the
    // server's own sentence, and offers both ways on.
    clear(bar)
    bar.hidden = !(editable || file.download || state)
    bar.classList.toggle("is-conflict", state?.conflict === true)
    said.className = `viewer__said${state?.error ? " is-error" : ""}`
    said.setAttribute("role", state?.error ? "alert" : "status")
    said.textContent = state?.text ?? (mine.dirty ? t("Not saved yet") : "")
    bar.append(said)
    if (state?.conflict) {
      bar.append(
        h("button", { type: "button", class: "btn btn--sm", id: "viewer-reload", text: t("Reload"), onclick: () => ((mine.dirty = false), file.reload?.()) }),
        h("button", { type: "button", class: "btn btn--sm btn--danger", id: "viewer-force", text: t("Save anyway"), onclick: () => save(true) }),
      )
      return
    }
    if (editable) {
      saveBtn.disabled = !mine.dirty
      bar.append(saveBtn)
    }
    if (file.download) bar.append(h("button", { type: "button", class: "btn btn--sm", text: t("Download"), onclick: () => file.download() }))
  }
  const touched = () => {
    const dirty = now() !== text
    if (dirty === mine.dirty) return
    mine.dirty = dirty
    drawBar()
  }
  async function save(force) {
    if (!editable || !here()) return
    const sending = now()
    saveBtn.disabled = true
    try {
      const done = await file.save(sending, { base: force ? null : sha, force })
      if (!here()) return
      text = typeof done?.text === "string" ? done.text : sending
      sha = done?.sha || null
      draft = now() === text ? null : now()
      mine.dirty = now() !== text
      drawBar({ text: mine.dirty ? t("Not saved yet") : t("Saved.") })
    } catch (err) {
      if (!here()) return
      drawBar(err?.status === 409 ? { conflict: true, error: true, text: why(err) } : { error: true, text: why(err) })
    }
  }

  const show = async (next) => {
    if (!here()) return
    // What the editor held goes with it: seen drawn, or as source, before it is saved.
    if (mine.editor && mode === "edit") draft = now() === text ? null : now()
    teardownBody()
    mode = next
    clear(body)
    for (const b of modes.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode))
    const words = draft ?? text
    if (mode === "edit" || mode === "source" || !drawn) {
      const holder = h("div", { class: "viewer__code" })
      body.append(holder)
      const ed = await codeView(holder, words, { lang, line: file.line || 0, editable: mode === "edit", onChange: touched, onSave: () => save(false) })
      if (!here() || mode !== next) return ed.destroy()
      mine.editor = ed
      if (mode === "edit") ed.focus()
    } else if (kind === "markdown") {
      body.append(h("div", { class: "md viewer__md" }, markdown(words)))
    } else if (kind === "table") {
      body.append(drawTable(file.name || "", words))
    } else if (kind === "notebook") {
      body.append(drawNotebook(words) || h("p", { class: "viewer__note", text: t("This file cannot be shown here.") }))
    } else {
      const url = await invoke("sealed_open", { html: words })
      if (!here() || mode !== next) return void invoke("sealed_close", { url })
      mine.sealed = url
      // No allow-same-origin, no allow-top-navigation: an opaque page that can run its own
      // scripts and nothing else. The address's own policy says the same again.
      body.append(h("iframe", { class: "viewer__frame", src: url, sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: file.name || "" }))
    }
  }

  const seg = (m, label) => h("button", { type: "button", class: "seg", dataset: { mode: m }, text: label, onclick: () => show(m) })
  if (drawn) modes.append(seg("view", kind === "html" ? t("Page") : t("Preview")), seg("source", t("Source")))
  else if (kind === "svg" && file.media) modes.append(h("button", { type: "button", class: "seg", "aria-pressed": "false", text: t("Preview"), onclick: () => openViewer({ ...file, text, sha, viewAs: "" }) }), seg("view", t("Source")))
  else if (editable) modes.append(seg("view", t("Source")))
  if (editable) modes.append(seg("edit", t("Edit")))
  drawBar()
  await show("view")
}

export function initViewer() {
  $("viewer-close").replaceChildren(icon(ICONS.close))
  const close = async () => {
    if (await mayLeave()) closeViewer()
  }
  $("viewer-close").addEventListener("click", close)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("viewer").hidden && !e.defaultPrevented && !document.querySelector("dialog[open]")) close()
  })
}
