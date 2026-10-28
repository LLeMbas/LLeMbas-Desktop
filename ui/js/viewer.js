// The viewer beside the chat: a file from this computer, from the server, or one the agent showed
// (`show`). Markdown is drawn (`markdown.js`), code and text are CodeMirror, read-only, and HTML
// is a sealed frame (src-tauri/src/sealed.rs): its own scheme, no bridge, no network, no way
// out. What a file says is never part of the app's page.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke } from "./bridge.js"
import { markdown } from "./markdown.js"
import { codeView } from "./code.js"

// The viewer's kind by a file's name: the CLI's and the server's `showKind`, the same table.
const LANGUAGES = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", json: "json", py: "python", rs: "rust", go: "go",
  rb: "ruby", php: "php", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", css: "css", scss: "scss", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", svg: "xml", lua: "lua", zig: "zig", dart: "dart", vue: "vue", svelte: "svelte",
}

export function showKind(path) {
  const name = String(path).split("/").pop() || ""
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : ""
  if (ext === "md" || ext === "markdown") return { kind: "markdown", language: "markdown" }
  if (ext === "html" || ext === "htm") return { kind: "html", language: "html" }
  const language = LANGUAGES[ext] || (name === "Dockerfile" ? "dockerfile" : name === "Makefile" ? "makefile" : "")
  return language ? { kind: "code", language } : { kind: "text", language: "" }
}

let current = null // { editor, sealed }
let onChange = () => {}

/** Called when the viewer opens or closes (the layout makes room for it). */
export function onViewer(fn) {
  onChange = fn
}

function teardown() {
  if (!current) return
  current.editor?.destroy()
  if (current.sealed) invoke("sealed_close", { url: current.sealed })
  current = null
}

export function closeViewer() {
  teardown()
  $("viewer").hidden = true
  clear($("viewer-body"))
  onChange(false)
}

/**
 * Show a file. `file`: { name, path, where (words for its place), text, kind?, language?, line?,
 * withheld?: "binary" | "too_big", size?, error? }.
 */
export async function openViewer(file) {
  teardown()
  const kind = file.kind || showKind(file.path || file.name).kind
  const lang = file.language ?? showKind(file.path || file.name).language
  $("viewer").hidden = false
  onChange(true)
  $("viewer-name").textContent = file.name || file.path || ""
  $("viewer-name").title = file.path || ""
  $("viewer-where").textContent = file.where || ""
  const body = clear($("viewer-body"))
  const modes = clear($("viewer-modes"))
  current = {}
  if (file.error) {
    body.append(h("p", { class: "viewer__note is-error", text: file.error }))
    return
  }
  if (file.withheld) {
    body.append(
      h("p", {
        class: "viewer__note",
        text:
          file.withheld === "too_big"
            ? t("This file is too big to show here (%(size)s).", { size: bytes(file.size) })
            : t("This is not a text file; it cannot be shown here."),
      }),
    )
    return
  }
  const text = file.text ?? ""
  // Markdown and HTML can be seen drawn or as their source.
  const drawn = kind === "markdown" || kind === "html"
  const show = async (asSource) => {
    teardown()
    current = {}
    clear(body)
    for (const b of modes.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.source === String(asSource)))
    if (asSource || !drawn) {
      const holder = h("div", { class: "viewer__code" })
      body.append(holder)
      current.editor = await codeView(holder, text, { lang, line: file.line || 0 })
    } else if (kind === "markdown") {
      body.append(h("div", { class: "md viewer__md" }, markdown(text)))
    } else {
      const url = await invoke("sealed_open", { html: text })
      current.sealed = url
      // No allow-same-origin, no allow-top-navigation: an opaque page that can run its own
      // scripts and nothing else. The address's own policy says the same again.
      body.append(h("iframe", { class: "viewer__frame", src: url, sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: file.name || "" }))
    }
  }
  if (drawn) {
    modes.append(
      h("button", { type: "button", class: "seg", dataset: { source: "false" }, text: kind === "html" ? t("Page") : t("Preview"), onclick: () => show(false) }),
      h("button", { type: "button", class: "seg", dataset: { source: "true" }, text: t("Source"), onclick: () => show(true) }),
    )
  }
  await show(false)
}

export function initViewer() {
  $("viewer-close").replaceChildren(icon(ICONS.close))
  $("viewer-close").addEventListener("click", closeViewer)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("viewer").hidden && !e.defaultPrevented) closeViewer()
  })
}
