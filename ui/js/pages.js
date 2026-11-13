// A page a model wrote into an answer or a report (harness spec 3.8.0, pages.md: the fenced
// block `html-view Title`; experimental on the server, off unless switched on).
//
// This app does not read, clean or draw the page's markup. The server rebuilds every page as a
// static document -- HTML, CSS and inline SVG; no script, no address that leads anywhere -- and
// is the one place a model's markup is cleaned. Rust fetches that document through the app's
// own door (`page_open`: GET /pages/m/{message}/{digest} or /pages/r/{report}/{digest}, with the
// theme's colours), holds it, and serves it on the sealed scheme under a policy with an empty
// sandbox and `script-src 'none'` (src-tauri/src/sealed.rs `PAGE_POLICY`). What this file makes
// is the frame's place: a titled box of one known height with the page scrolling inside it, a
// frame with `sandbox=""` whose address is the held document, and Open larger. The document's
// text never passes through this page's script, and nothing is ever set as HTML.
//
// A long chat's pages are held by need: a frame is made when its place comes near the window
// and taken away when it is far from it (Rust keeps the most recently asked for, and one that
// went is asked for again). While a reply is still being written a page is only its title.

import { h, icon, ICONS } from "./dom.js"
import { invoke, why } from "./bridge.js"

/** The theme's colours as the page's address takes them (`#rrggbb`), for the frame's variables. */
function colours() {
  const css = getComputedStyle(document.documentElement)
  const canvas = document.createElement("canvas").getContext("2d")
  const out = {}
  for (const [name, token] of [["bg", "--surface"], ["ink", "--ink"], ["muted", "--ink-muted"], ["accent", "--accent"], ["line", "--border"]]) {
    const value = css.getPropertyValue(token).trim()
    if (!value || !canvas) continue
    // The canvas says any colour it knows as #rrggbb (one with no transparency).
    canvas.fillStyle = "#000000"
    canvas.fillStyle = value
    if (/^#[0-9a-f]{6}$/i.test(canvas.fillStyle)) out[name] = canvas.fillStyle
  }
  return out
}

/** The frame for a held document: nothing in it runs, and it can go nowhere. */
function frameFor(url, title) {
  return h("iframe", { class: "hpage__frame", sandbox: "", referrerpolicy: "no-referrer", title, src: url })
}

const mounts = new WeakMap() // a page's box -> { page, body, shown }

// Near the window: made. Far from it: taken away again.
const watcher =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const m = mounts.get(e.target)
            if (!m) continue
            if (e.isIntersecting) show(m)
            else hide(m)
          }
        },
        { rootMargin: "100% 0px" },
      )
    : null

function said(m, ...children) {
  m.body.replaceChildren(...children)
}

async function show(m) {
  if (m.shown) return
  m.shown = true
  const asked = (m.asked = (m.asked || 0) + 1)
  said(m, h("p", { class: "hpage__note muted", text: t("Loading…") }))
  try {
    const r = await invoke("page_open", { kind: m.page.kind, owner: m.page.owner, digest: m.page.digest, colours: colours() })
    if (!m.shown || asked !== m.asked) return
    said(m, frameFor(r.url, m.page.title))
  } catch (err) {
    if (!m.shown || asked !== m.asked) return
    m.shown = false
    said(
      m,
      h("p", { class: "hpage__note is-error", text: t("This page could not be shown: %(why)s", { why: why(err) }) }),
      h("button", { type: "button", class: "btn btn--sm", text: t("Try again"), onclick: () => show(m) }),
    )
  }
}

function hide(m) {
  if (!m.shown) return
  m.shown = false
  said(m)
}

/** The page larger, over the app: the same held document in a dialog; Escape or Close ends it. */
async function larger(page) {
  let url
  try {
    url = (await invoke("page_open", { kind: page.kind, owner: page.owner, digest: page.digest, colours: colours() })).url
  } catch {
    return
  }
  const dlg = h(
    "dialog",
    { class: "hpage-dialog", "aria-label": page.title },
    h(
      "header",
      { class: "hpage__head" },
      h("span", { class: "hpage__icon", "aria-hidden": "true" }, icon(ICONS.fileCode)),
      h("span", { class: "hpage__title", text: page.title }),
      h("button", { type: "button", class: "tool", "aria-label": t("Close"), title: t("Close"), onclick: () => dlg.close() }, icon(ICONS.close)),
    ),
    frameFor(url, page.title),
  )
  dlg.addEventListener("close", () => dlg.remove())
  document.body.append(dlg)
  dlg.showModal()
}

function box(title, cls, ...tools) {
  return h(
    "figure",
    { class: `hpage${cls}` },
    h("figcaption", { class: "hpage__head" }, h("span", { class: "hpage__icon", "aria-hidden": "true" }, icon(ICONS.fileCode)), h("span", { class: "hpage__title", title, text: title }), ...tools),
  )
}

/**
 * The place of one page: `kind` "m" (a reply's, `owner` the message's id) or "r" (a report's,
 * `owner` the report's id), its `title` and `digest` as the server names them.
 */
export function pageMount({ kind, owner, title, digest }) {
  const page = { kind, owner: String(owner), digest: String(digest), title: String(title || "") || t("Page") }
  const body = h("div", { class: "hpage__body" })
  const el = box(page.title, "", h("button", { type: "button", class: "btn btn--sm hpage__larger", text: t("Open larger"), onclick: () => larger(page) }))
  el.dataset.digest = page.digest
  el.append(body)
  const m = { page, body, shown: false }
  mounts.set(el, m)
  if (watcher) watcher.observe(el)
  else show(m)
  return el
}

/** A page in a reply that is still being written: its title, and that it is on its way. */
export function pageWriting(title) {
  const el = box(title || t("Page"), " is-writing")
  el.append(h("div", { class: "hpage__body" }, h("p", { class: "hpage__note muted", text: t("This page is shown when the reply is finished.") })))
  return el
}
