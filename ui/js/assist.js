// The editor's helper in a workspace tab: a completion offered as it is typed (and on a key),
// and a selection rewritten by an instruction -- which comes back as changes to take or leave,
// piece by piece, and puts nothing into the file before that.
//
// Both are the bundled LLeMbas CLI's methods for an editor (harness spec 3.11.0, harness/acp.md
// *An editor as the client*): `_lembas/complete` and `_lembas/edit`, asked through Rust
// (src-tauri/src/editor.rs), which runs the CLI as it is. They see only the text sent here --
// a window around the cursor, the selection with some lines around it -- and run no tool. What
// comes back is a model's text: it is put into the editor as text, shown as text, and never
// anything else.
//
// THE SEAMS, each one object:
//   HELPER    the CLI's methods as this page calls them (the tests answer `editor_call`);
//   SETTINGS  the two model settings on the server's /api/v2 (`GET` and `PUT /editor`; the
//             server's fixtures editor.json and editor_unset.json). A model is named by its
//             `ref`, as `GET /models` lists it.

import { h, clear, icon, ICONS } from "./dom.js"
import { invoke, listen, get, api, why } from "./bridge.js"
import { ask, menu } from "./popup.js"
import { codeMirror } from "./code.js"
import { hunksOf, applyHunks, hunkBlock, countOf } from "./diff.js"

// --- The CLI's methods -------------------------------------------------------------------------

let nextId = 0
const deltas = new Map() // a rewrite's id -> what to do with a piece of it
let listening = false

function listenOnce() {
  if (listening) return
  listening = true
  listen("editor", (e) => {
    const { id, delta } = e.payload || {}
    if (typeof id === "string" && typeof delta === "string") deltas.get(id)?.(delta)
  })
}

export const HELPER = {
  /** `_lembas/complete`: `{ id, prefix, suffix?, path?, language?, model? }` -> `{ text, model, finish }` | `{ text: "", cancelled: true }`. */
  complete: (params) => invoke("editor_call", { method: "_lembas/complete", params }),
  /** `_lembas/complete/cancel { id }`: the request under that id is answered with nothing. */
  cancelComplete: (id) => invoke("editor_cancel", { id, edit: false }),
  /** `_lembas/edit`: `{ id, text, instruction, path?, language?, before?, after?, cwd?, model? }` -> `{ text, model }`, written in pieces (`onDelta`). */
  edit: (params, onDelta) => {
    listenOnce()
    if (onDelta) deltas.set(params.id, onDelta)
    return Promise.resolve(invoke("editor_call", { method: "_lembas/edit", params })).finally(() => deltas.delete(params.id))
  },
  cancelEdit: (id) => invoke("editor_cancel", { id, edit: true }),
}

// --- The two model settings ----------------------------------------------------------------------

export const SETTINGS = {
  /** -> { autocomplete: { model|null, source: "person"|"instance"|null, allowed: [refs]|null }, main: { model|null } } -- a model is its `ref` */
  read: () => get("/editor"),
  /** { autocomplete_model?: ref|null, main_model?: ref|null } (null: back to the instance's) -> the same object as `read`; 403 and 404 in words. */
  write: (body) => api("PUT", "/editor", body),
}

let settings = null // as the server last said them
let settingsError = "" // why they could not be read, in words
const quick = {} // this window's own choice for now ({ autocomplete?, main? }): not saved
const watchers = new Set()

const told = () => {
  for (const fn of watchers) fn()
}

/** Read the settings from the server (again). A server without the route: said, and nothing chosen. */
export async function loadAssist() {
  try {
    const r = await SETTINGS.read()
    settings = r && typeof r === "object" ? r : null
    settingsError = ""
  } catch (err) {
    settings = null
    settingsError = err?.status === 404 ? t("This server has no editor settings yet. Ask its administrator to update it.") : why(err)
  }
  told()
  return settings
}

/** Forget everything of one account's (signed out). */
export function resetAssist() {
  settings = null
  settingsError = ""
  delete quick.autocomplete
  delete quick.main
  told()
}

/** The model a completion runs on now: this window's quick choice, else the person's or the instance's; "" for none. */
export const autocompleteModel = () => (quick.autocomplete !== undefined ? quick.autocomplete : settings?.autocomplete?.model) || ""
/** The model a rewrite runs on: this window's quick choice, else the person's main model; "" leaves it to the CLI. */
export const mainModel = () => (quick.main !== undefined ? quick.main : settings?.main?.model) || ""
/** Whether a model may be chosen for autocomplete (none marked by the administrator: all are). */
/** A model's name for the settings: its `ref` (a server from before refs: its id). */
const refOf = (m) => m.ref || m.id
const allowedFor = (id) => !Array.isArray(settings?.autocomplete?.allowed) || settings.autocomplete.allowed.includes(id)

export function onAssist(fn) {
  watchers.add(fn)
  return () => watchers.delete(fn)
}
/** How many are told when the settings change (the tests': one for the head's buttons, one for each editor that lives). */
export const assistWatchers = () => watchers.size

/** Save one of the two as the person's own choice (`null`: the instance's again). */
async function saveSetting(which, model) {
  const r = await SETTINGS.write(which === "autocomplete" ? { autocomplete_model: model } : { main_model: model })
  if (r && typeof r === "object") settings = r
  delete quick[which]
  told()
}

/**
 * The two settings as two buttons of one row -- Autocomplete and Main model, each with the model
 * it stands on -- each opening a menu: the models (the quick switch: this window only, until
 * the app is closed), and "Save as my choice" for the one now picked. `models()` is the account's list.
 */
export function assistControls(models) {
  const box = h("div", { class: "assist", role: "group", "aria-label": t("Models for the editor") })
  const nameOf = (id) => models().find((m) => refOf(m) === id)?.name || id
  const button = (which, label) => {
    const value = h("span", { class: "assist__value" })
    const btn = h("button", { type: "button", class: "assist__pick", dataset: { which }, "aria-haspopup": "menu" }, h("span", { class: "assist__label", text: label }), value)
    const now = () => (which === "autocomplete" ? autocompleteModel() : mainModel())
    const draw = () => {
      const id = now()
      value.textContent = id ? nameOf(id) : which === "autocomplete" ? t("Off") : t("The chat's")
      btn.title = settingsError || (quick[which] !== undefined ? t("For this window only, until it is saved or the app is closed.") : "")
      btn.dataset.quick = String(quick[which] !== undefined)
    }
    btn.addEventListener("click", () => {
      const id = now()
      const pick = (model) => {
        quick[which] = model
        told()
      }
      const items = models()
        .filter((m) => which !== "autocomplete" || allowedFor(refOf(m)))
        .map((m) => ({ label: m.name || m.id, checked: refOf(m) === id, run: () => pick(refOf(m)) }))
      items.unshift({ label: which === "autocomplete" ? t("Off: only when asked for") : t("The chat's own model"), checked: !id, run: () => pick("") })
      items.push(null)
      if (quick[which] !== undefined)
        items.push({
          label: t("Save as my choice"),
          hint: t("Follows you to every editor"),
          run: () => saveSetting(which, quick[which] || null).catch((err) => ((settingsError = why(err)), told())),
        })
      else items.push({ label: t("Saved as your choice"), disabled: true, run: () => {} })
      menu(btn, items)
    })
    draw()
    return { btn, draw }
  }
  const a = button("autocomplete", t("Autocomplete"))
  const m = button("main", t("Main model"))
  box.append(a.btn, m.btn)
  const off = onAssist(() => (box.isConnected ? (a.draw(), m.draw()) : off()))
  return box
}

// --- The editor's extensions ----------------------------------------------------------------------

/** How long after the last key a completion is asked for (ms). */
export const TYPING_PAUSE = 350
/** How much of the file around the cursor is sent (characters): a window, not the file. */
const BEFORE = 6000
const AFTER = 2000
/** The lines around a selection sent with it. */
const AROUND = 40

/**
 * What the editor of a file being edited gets: `api` is `{ file, lang, view() }` (viewer.js);
 * `hooks`: `{ say(text, error), review: an element for a rewrite's changes, cwd?: the folder on
 * this computer the file is in, name: the file's path as said to the model }`. Returns the
 * extensions, and puts `complete()` and `rewrite()` on `hooks` for the tab's own buttons.
 */
export async function assistExtensions(api, hooks) {
  // (The editor before this one in the same tab -- another way of seeing the file was shown in
  // between -- is let go first: what it had on its way, and its place among those told of the settings.)
  hooks.close?.()
  const { state: S, view: V } = await codeMirror()
  const setGhost = S.StateEffect.define()
  class Ghost extends V.WidgetType {
    constructor(text) {
      super()
      this.text = text
    }
    eq(other) {
      return other.text === this.text
    }
    toDOM() {
      // (A model's words, as text.)
      return h("span", { class: "cm-ghost", "aria-hidden": "true", text: this.text })
    }
    ignoreEvent() {
      return true
    }
  }
  const ghost = S.StateField.define({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setGhost)) return e.value
      // Anything typed, and the cursor anywhere else: what was offered is offered no longer.
      if (tr.docChanged || tr.selection) return null
      return value
    },
    provide: (f) => V.EditorView.decorations.from(f, (g) => (g ? V.Decoration.set([V.Decoration.widget({ widget: new Ghost(g.text), side: 1 }).range(g.pos)]) : V.Decoration.none)),
  })

  let timer = 0
  let asked = null // the completion on its way: { id }
  let quiet = false // a refusal was said once: nothing more is asked while typing, until something changes
  const forget = onAssist(() => (quiet = false))

  const cancel = () => {
    clearTimeout(timer)
    timer = 0
    if (asked) {
      HELPER.cancelComplete(asked.id)
      asked = null
    }
  }

  /** Ask for what belongs at the cursor. `now`: on the key or the button (said when there is nothing); else while typing. */
  const complete = (view, now = false) => {
    cancel()
    const sel = view.state.selection.main
    if (!sel.empty) return
    const model = autocompleteModel()
    // As it is typed: only where a model was chosen for it, and not again after a refusal.
    if (!now && (!model || quiet)) return
    const pos = sel.head
    const doc = view.state.doc
    const id = `c${++nextId}`
    const mine = (asked = { id })
    const params = { id, prefix: doc.sliceString(Math.max(0, pos - BEFORE), pos), suffix: doc.sliceString(pos, Math.min(doc.length, pos + AFTER)), path: hooks.name || api.file.name || "" }
    if (api.lang) params.language = api.lang
    // (`model` is the quick switch's; without one the server takes the person's, then the instance's.)
    if (quick.autocomplete) params.model = quick.autocomplete
    if (now) hooks.say?.(t("Asking for a completion…"))
    HELPER.complete(params).then(
      (r) => {
        if (asked !== mine) return
        asked = null
        const text = r && !r.cancelled && typeof r.text === "string" ? r.text : ""
        const still = view.state.doc === doc && view.state.selection.main.empty && view.state.selection.main.head === pos
        if (!text || !still) return void (now && hooks.say?.(text ? "" : t("Nothing to complete here.")))
        if (now) hooks.say?.(t("Tab takes it, Escape leaves it."))
        view.dispatch({ effects: setGhost.of({ pos, text }) })
      },
      (err) => {
        if (asked !== mine) return
        asked = null
        quiet = true
        hooks.say?.(why(err), true)
      },
    )
  }

  const take = (view) => {
    const g = view.state.field(ghost, false)
    if (!g) return false
    view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, userEvent: "input.complete" })
    return true
  }
  const leave = (view) => {
    if (!view.state.field(ghost, false)) return false
    view.dispatch({ effects: setGhost.of(null) })
    return true
  }

  hooks.complete = () => {
    const view = api.view()
    if (view) complete(view, true), view.focus()
  }
  hooks.rewrite = () => {
    const view = api.view()
    if (view) rewrite(view, api, hooks)
  }
  const close = () => {
    cancel()
    forget()
    // A rewrite of this editor's that is still written, or waits for its answers: stopped, and its changes gone with the editor.
    hooks.rewriting?.stop()
    if (hooks.close === close) hooks.close = null
  }
  hooks.close = close

  return [
    ghost,
    // The editor gone (the tab closed, the file read again, shown another way): the same.
    V.ViewPlugin.define(() => ({ destroy: close })),
    S.Prec.highest(
      V.keymap.of([
        { key: "Tab", run: take },
        { key: "Escape", run: leave },
        { key: "Alt-\\", run: (view) => (complete(view, true), true) },
        { key: "Mod-e", run: (view) => (rewrite(view, api, hooks), true) },
      ]),
    ),
    V.EditorView.updateListener.of((u) => {
      if (!u.docChanged) {
        // The cursor moved away with nothing typed: what was on its way is for another place.
        if (u.selectionSet && (asked || timer)) cancel()
        return
      }
      // Typed or deleted by the person (not a completion taken, not a rewrite put in, not undo).
      const typed = u.transactions.some((tr) => (tr.isUserEvent("input") && !tr.isUserEvent("input.complete")) || tr.isUserEvent("delete"))
      cancel()
      if (typed) timer = setTimeout(() => ((timer = 0), u.view.dom.isConnected && complete(u.view, false)), TYPING_PAUSE)
    }),
  ]
}

// --- A selection rewritten --------------------------------------------------------------------------

/**
 * Ask what to do with the selection, have it rewritten, and show what would change in
 * `hooks.review`: each piece taken or left by itself. The file's text is changed only by a piece
 * that was taken -- once every piece has its answer -- and only where the selection is still
 * what it was. Never saved by this: the edit is the person's to save.
 */
async function rewrite(view, api, hooks) {
  // One at a time in a tab: its changes stand in the tab's one place for them.
  if (hooks.rewriting) return void hooks.say?.(t("A rewrite is already under way here: answer or stop it first."), true)
  const sel = view.state.selection.main
  if (sel.empty) return void hooks.say?.(t("Select what should be rewritten first."), true)
  const doc = view.state.doc
  // Whole lines: a change is seen, and taken, by the line.
  const from = doc.lineAt(sel.from).from
  const end = doc.lineAt(sel.to)
  const to = sel.to > sel.from && sel.to === end.from ? sel.to : Math.min(doc.length, end.to + 1)
  const original = doc.sliceString(from, to)
  const instruction = await ask({ title: t("Rewrite the selection"), text: t("Say what should change. Nothing is put into the file until you accept it."), value: "", ok: t("Rewrite"), cancel: t("Cancel") })
  if (!instruction) return void view.focus()
  // (Asked twice before the first was answered, or the editor went meanwhile.)
  if (hooks.rewriting || api.view() !== view) return
  const box = clear(hooks.review)
  box.hidden = false
  const id = `e${++nextId}`
  const firstLine = doc.lineAt(from).number
  const lastLine = doc.lineAt(Math.max(from, to - 1)).number
  const params = {
    id,
    text: original,
    instruction,
    path: hooks.name || api.file.name || "",
    before: doc.sliceString(doc.line(Math.max(1, firstLine - AROUND)).from, from),
    after: doc.sliceString(to, doc.line(Math.min(doc.lines, lastLine + AROUND)).to),
  }
  if (api.lang) params.language = api.lang
  if (hooks.cwd) params.cwd = hooks.cwd
  if (mainModel()) params.model = mainModel()
  let stopped = false
  let answered = false
  const mine = (hooks.rewriting = {
    id,
    // Stopped from outside (the tab closed, the file read again): the CLI is told, nothing is drawn or put in.
    stop: () => {
      if (hooks.rewriting !== mine) return
      hooks.rewriting = null
      stopped = true
      if (!answered) HELPER.cancelEdit(id)
      clear(box).hidden = true
      hooks.reviewing?.(false)
    },
  })
  const done = (words = "", error = false) => {
    if (hooks.rewriting !== mine) return
    hooks.rewriting = null
    clear(box).hidden = true
    hooks.say?.(words, error)
    hooks.reviewing?.(false)
    api.view()?.focus()
  }
  // While it is written: its words so far, as text, and a way to stop it.
  const soFar = h("pre", { class: "review__writing", "aria-label": t("The rewrite so far") })
  box.append(
    h(
      "div",
      { class: "review__head" },
      h("span", { class: "review__title", role: "status", text: t("Rewriting…") }),
      h("button", { type: "button", class: "btn btn--sm review__stop", text: t("Stop"), onclick: () => ((stopped = true), HELPER.cancelEdit(id), done()) }),
    ),
    soFar,
  )
  hooks.reviewing?.(true)
  let r
  try {
    r = await HELPER.edit(params, (piece) => {
      soFar.textContent += piece
      soFar.scrollTop = soFar.scrollHeight
    })
  } catch (err) {
    answered = true
    return void (stopped || done(why(err), true))
  }
  answered = true
  if (stopped || r?.cancelled) return void (stopped || done())
  const text = typeof r?.text === "string" ? r.text : ""
  const hunks = hunksOf(original, text)
  if (!hunks.length) return done(t("Nothing would change."))
  drawReview(box, hunks, {
    model: typeof r?.model === "string" ? r.model : "",
    settle: (taken) => {
      if (!taken.size) return done(t("Nothing was changed."))
      const live = api.view()
      // The selection must still be what was sent: otherwise the changes belong to another text.
      if (!live || live.state.doc.length < to || live.state.doc.sliceString(from, to) !== original) return done(t("The text changed meanwhile: nothing was put in."), true)
      const next = applyHunks(original, hunks, taken)
      live.dispatch({ changes: { from, to, insert: next }, selection: { anchor: from, head: from + next.length }, userEvent: "input.rewrite", scrollIntoView: true })
      done(taken.size === hunks.length ? t("The changes are in the file. Not saved yet.") : t("%(n)s of %(all)s changes are in the file. Not saved yet.", { n: taken.size, all: hunks.length }))
    },
  })
}

/**
 * The changes, each with Accept and Reject, and both for all that are left. `settle(taken)` once
 * every piece has its answer (`taken`: the indexes accepted).
 */
export function drawReview(box, hunks, { model = "", settle }) {
  const answers = new Map() // index -> true (accepted) | false (rejected)
  const n = countOf(hunks)
  const left = h("span", { class: "review__left", role: "status" })
  const finish = () => {
    if (answers.size < hunks.length) return void (left.textContent = t("%(n)s left to answer", { n: hunks.length - answers.size }))
    settle(new Set([...answers].filter(([, yes]) => yes).map(([i]) => i)))
  }
  const rest = (yes) => {
    hunks.forEach((_, i) => answers.has(i) || answers.set(i, yes))
    finish()
  }
  const list = h(
    "ol",
    { class: "review__list" },
    hunks.map((hunk, i) => {
      const said = h("span", { class: "dhunk__said", role: "status" })
      const yes = h("button", { type: "button", class: "btn btn--sm dhunk__yes", text: t("Accept"), "aria-pressed": "false" })
      const no = h("button", { type: "button", class: "btn btn--sm dhunk__no", text: t("Reject"), "aria-pressed": "false" })
      const li = h(
        "li",
        { class: "dhunk", dataset: { state: "open" } },
        h("div", { class: "dhunk__head" }, h("span", { class: "dhunk__where", text: t("Change %(n)s of %(all)s", { n: i + 1, all: hunks.length }) }), said, no, yes),
        hunkBlock(hunk),
      )
      const answer = (accepted) => {
        answers.set(i, accepted)
        li.dataset.state = accepted ? "accepted" : "rejected"
        yes.setAttribute("aria-pressed", String(accepted))
        no.setAttribute("aria-pressed", String(!accepted))
        said.textContent = accepted ? t("Accepted") : t("Rejected")
        finish()
      }
      yes.addEventListener("click", () => answer(true))
      no.addEventListener("click", () => answer(false))
      return li
    }),
  )
  clear(box).append(
    h(
      "div",
      { class: "review__head" },
      h("span", { class: "review__title", text: t("%(n)s changes: %(del)s lines out, %(add)s in", { n: hunks.length, del: n.del, add: n.add }) }),
      model ? h("span", { class: "review__model", title: model, text: model }) : null,
      left,
      h("button", { type: "button", class: "btn btn--sm review__none", text: t("Reject all"), onclick: () => rest(false) }),
      h("button", { type: "button", class: "btn btn--sm btn--primary review__all", text: t("Accept all"), onclick: () => rest(true) }),
    ),
    list,
  )
  box.hidden = false
  list.querySelector(".dhunk__yes")?.focus()
}

/** The buttons a tab has for its editor's helper: a completion here, the selection rewritten. */
export function assistButtons(hooks) {
  return [
    h("button", { type: "button", class: "tool wtab__complete", "aria-label": t("Complete here"), title: `${t("Complete here")} (Alt+\\)`, onclick: () => hooks.complete?.() }, icon(ICONS.bulb)),
    h("button", { type: "button", class: "tool wtab__rewrite", "aria-label": t("Rewrite the selection"), title: `${t("Rewrite the selection")} (Ctrl+E)`, onclick: () => hooks.rewrite?.() }, icon(ICONS.edit)),
  ]
}
