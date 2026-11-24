// A PDF and a 3D model, drawn sealed off from the app.
//
// Both are somebody else's file read by a parser (PDF.js; a small WebGL reader), so neither is
// ever read in this page, the one context that has the bridge. They are drawn by the server's
// own sealed viewers, compiled into the app (src-tauri/viewers/, src-tauri/src/sealed.rs) and
// served to a frame on the sealed scheme: an opaque origin with no bridge, no network and no way
// out. The frame's document holds no file. When it says it is ready, this page hands it, in one
// message, the file's bytes (read by Rust: `viewer_bytes`) and, for a PDF, the library as text
// (`viewer_libs`) -- text this page's own policy would not let it run. Nothing comes back from
// the frame but that one word, "ready"; nothing the file says reaches this page.

import { h } from "./dom.js"
import { invoke, why } from "./bridge.js"

// The frame's colours: the theme's, by the names the viewer's page knows them under.
const THEME = { bg: "--surface", ink: "--ink", muted: "--ink-muted", accent: "--accent", line: "--border" }
const FORMATS = ["glb", "gltf", "stl", "obj"]
const KINDS = ["pdf", "model3d"]

let libs = null // PDF.js as text, asked for once
const waiting = new Map() // a frame not fed yet -> what feeds it

function colours() {
  const style = getComputedStyle(document.documentElement)
  const out = {}
  for (const [name, token] of Object.entries(THEME)) {
    const value = style.getPropertyValue(token).trim()
    if (value) out[name] = value
  }
  return out
}

const words = () => ({
  failed: t("This file could not be shown here. It can still be downloaded."),
  more: t("More pages"),
  unsupported: t("This model is stored in a way this viewer cannot read. It can still be downloaded."),
  external: t("This model keeps its data in other files, which cannot be read here. It can still be downloaded."),
  nowebgl: t("3D cannot be drawn here."),
  hint: t("Drag to turn it, scroll to zoom."),
  cut: t("Only part of this model is drawn."),
})

/** A 3D model's format by its name: what the viewer reads it as. */
export function modelFormat(name) {
  const ext = String(name || "").split(".").pop().toLowerCase()
  return FORMATS.includes(ext) ? ext : "glb"
}

/** Whether a file of this kind is drawn by a sealed viewer. */
export const sealedKind = (kind) => KINDS.includes(kind)

window.addEventListener("message", (event) => {
  const kind = event.data && typeof event.data === "object" ? event.data.lembasViewerReady : null
  if (!KINDS.includes(kind)) return
  for (const [frame, feed] of waiting) {
    // Only a frame this module made, saying the kind it was made for, is ever handed a file.
    if (frame.contentWindow === event.source && frame.dataset.view === kind) {
      waiting.delete(frame)
      feed()
      return
    }
  }
})

/**
 * A sealed viewer for one file. `kind` is `pdf` or `model3d`; `from` names the file to Rust
 * (`{ source: "server", path }`, `{ source: "server", node }` or `{ source: "local", root, path }`).
 * Answers `{ el, close() }`: the element to place (it fills the box it is given), and what lets
 * the frame's document go.
 */
export function sealedViewer(kind, from, { name = "" } = {}) {
  const note = (text, error = false) => h("p", { class: `sview__note${error ? " is-error" : ""}`, role: error ? "alert" : "status", text })
  const el = h("div", { class: "sview", dataset: { view: kind } }, note(t("Loading…")))
  let url = null
  let frame = null
  let closed = false
  const close = () => {
    closed = true
    if (frame) waiting.delete(frame)
    if (url) invoke("sealed_close", { url }).catch(() => {})
    url = null
  }
  const fail = (err) => {
    if (closed) return
    close()
    closed = false
    el.replaceChildren(note(err?.status === 404 ? t("This file is no longer there.") : why(err), true))
  }
  const feed = async () => {
    try {
      const asked = [invoke("viewer_bytes", { source: from.source, path: from.path ?? null, root: from.root ?? null, node: from.node ?? null, device: from.device ?? null })]
      if (kind === "pdf") {
        libs ||= invoke("viewer_libs")
        asked.push(libs.catch((err) => ((libs = null), Promise.reject(err))))
      }
      const [data, lib] = await Promise.all(asked)
      if (closed || !frame?.contentWindow) return
      const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer
      const message = { lembasView: kind, bytes, format: kind === "model3d" ? modelFormat(name) : "", theme: colours(), words: words() }
      if (kind === "pdf") message.libs = { main: String(lib?.main || ""), worker: String(lib?.worker || "") }
      // To an opaque origin, which has no name to address: the frame is ours, its document Rust's.
      frame.contentWindow.postMessage(message, "*", [bytes])
    } catch (err) {
      fail(err)
    }
  }
  invoke("viewer_open", { kind }).then(
    (address) => {
      if (closed) return void invoke("sealed_close", { url: address }).catch(() => {})
      url = address
      // No allow-same-origin: an opaque page that runs its own script and reaches nothing. The
      // address's own policy says the same again.
      frame = h("iframe", { class: "sview__frame", src: address, sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: t("%(name)s, drawn sealed off from this application", { name }), dataset: { view: kind } })
      waiting.set(frame, feed)
      el.replaceChildren(frame)
    },
    (err) => fail(err),
  )
  return { el, close }
}
