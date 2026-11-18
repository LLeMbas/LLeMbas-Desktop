// The dialogs of the Files page: choosing a folder (for a move, a copy, and a copy between this
// computer and the server), the server's trash, and a file's versions. Each is a modal dialog
// built from elements, every name in it set as text; Escape closes it and the focus goes back
// where it was.

import { h, clear, icon, ICONS, bytes, when } from "./dom.js"
import { why } from "./bridge.js"
import { ask } from "./popup.js"

function modal(labelledby, body) {
  const back = document.activeElement
  const dlg = h("dialog", { class: "dialog", "aria-labelledby": labelledby }, body)
  let closed = null
  const done = new Promise((resolve) => (closed = resolve))
  let settled = false
  const close = (value) => {
    if (settled) return
    settled = true
    dlg.close()
    dlg.remove()
    back?.focus?.()
    closed(value)
  }
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault()
    close(null)
  })
  document.body.append(dlg)
  dlg.showModal()
  return { dlg, close, done }
}

/**
 * Choose a folder by walking to it: no path is typed. `source` is an explorer's place --
 *   list(path) -> { path, entries }   top()   ask(path)   crumbs(path) -> [[name, path], ...]
 * `start` the folder the dialog opens in, `title` its question, `ok` the button that chooses
 * the folder stood in. Resolves with that folder's path, or null.
 */
export function pickFolder({ source, start, title, ok }) {
  let here = start ?? source.top()
  let asked = 0
  const where = h("nav", { class: "crumbs fpick__where", "aria-label": t("Where you are") })
  const list = h("ul", { class: "fpick__list", role: "list", "aria-label": t("Folders") })
  const chosen = h("bdi", { class: "fpick__chosen" })
  const use = h("button", { type: "submit", class: "btn btn--primary", id: "fpick-use", text: ok })
  const form = h(
    "form",
    { class: "dialog__body fpick", method: "dialog" },
    h("h2", { class: "dialog__title", id: "fpick-title", text: title }),
    where,
    list,
    h("p", { class: "fpick__said" }, icon(ICONS.folder), chosen),
    h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", text: t("Cancel"), onclick: () => close(null) }), use),
  )
  const { close, done } = modal("fpick-title", form)
  const note = (text, cls = "") => h("li", { class: `fnote ${cls}` }, h("span", { text }))
  const load = async (path) => {
    const mine = ++asked
    here = path
    use.disabled = true
    chosen.textContent = t("No folder chosen yet.")
    clear(list).append(note(t("Loading…"), "is-loading"))
    try {
      const answer = await source.list(source.ask(path))
      if (mine !== asked) return
      if (answer.path !== undefined && source.ask(answer.path) === source.ask(path)) here = answer.path
      const parts = source.crumbs(here)
      clear(where).append(
        ...parts.flatMap(([name, at], i) => {
          const last = i === parts.length - 1
          const part = last
            ? h("span", { class: "crumbs__here", "aria-current": "page", title: at, text: name })
            : h("button", { type: "button", class: "crumbs__link", title: at, text: name, onclick: () => load(at) })
          return i ? [h("span", { class: "crumbs__sep", "aria-hidden": "true", text: "/" }), part] : [part]
        }),
      )
      where.scrollLeft = where.scrollWidth
      chosen.textContent = parts.map(([name]) => name).join(" / ")
      chosen.title = here
      use.disabled = false
      const dirs = (answer.entries || []).filter((e) => e.kind === "dir" || e.kind === "mount")
      clear(list)
      if (!dirs.length) list.append(note(t("No directories here.")))
      for (const e of dirs) {
        // Every row the same three tracks: icon, name, chevron.
        list.append(
          h(
            "li",
            null,
            h("button", { type: "button", class: "fpick__row", title: e.path, dataset: { path: e.path }, onclick: () => load(e.path) }, icon(e.kind === "mount" ? ICONS.drive : ICONS.folder), h("span", { class: "fpick__name", text: e.name }), icon(ICONS.chevron)),
          ),
        )
      }
    } catch (err) {
      if (mine !== asked) return
      clear(list).append(note(why(err), "is-error"))
    }
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    if (!use.disabled) close(here)
  })
  load(here)
  return done
}

/** A stamp as the dialogs say it: how long ago, and the whole of it for a title. */
function stamp(value) {
  const d = new Date(value)
  return { short: when(value), full: Number.isNaN(d.getTime()) ? "" : d.toLocaleString(document.documentElement.lang || undefined) }
}

/**
 * The server's trash: what was deleted, each to be restored or removed for good, and all of it
 * to be emptied. `api`: { list() -> { items }, restore(id), remove(id), empty() }; `changed()`
 * is told when something came back, so the list behind is read again.
 */
export function trashDialog({ api, changed }) {
  const list = h("ul", { class: "ftrash__list", role: "list" })
  const said = h("p", { class: "status ftrash__said", role: "status", hidden: true })
  const emptyBtn = h("button", { type: "button", class: "btn btn--danger", id: "ftrash-empty", text: t("Empty the trash"), disabled: true })
  const body = h(
    "div",
    { class: "dialog__body ftrash" },
    h("h2", { class: "dialog__title", id: "ftrash-title", text: t("Trash") }),
    said,
    list,
    h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", text: t("Close"), onclick: () => close(null) }), emptyBtn),
  )
  const { dlg, close, done } = modal("ftrash-title", body)
  dlg.classList.add("dialog--wide")
  const say = (text, error = false) => {
    said.hidden = !text
    said.textContent = text || ""
    said.className = `status ftrash__said${error ? " is-error" : ""}`
    said.setAttribute("role", error ? "alert" : "status")
  }
  const draw = (items) => {
    clear(list)
    emptyBtn.disabled = !items.length
    if (!items.length) {
      list.append(h("li", { class: "fnote" }, h("span", { text: t("The trash is empty.") })))
      return
    }
    for (const item of items) {
      const at = stamp(item.trashed_at)
      // One row, four tracks: the name over where it was, when, Restore, Remove for good.
      list.append(
        h(
          "li",
          { class: "ftrash__row", dataset: { id: item.id } },
          h("span", { class: "ftrash__id" }, h("span", { class: "ftrash__name", text: item.name }), h("span", { class: "ftrash__path", title: item.path, text: item.path })),
          h("span", { class: "ftrash__when", title: at.full, text: at.short }),
          h("button", { type: "button", class: "btn btn--sm ftrash__restore", text: t("Restore"), onclick: () => act(() => api.restore(item.id), t("Restored."), true) }),
          h("button", {
            type: "button",
            class: "btn btn--sm ftrash__remove",
            "aria-label": t("Remove %(name)s for good", { name: item.name }),
            text: t("Remove for good"),
            onclick: async () => {
              const yes = await ask({ title: t("Remove for good"), text: t("Remove “%(name)s” for good? This cannot be undone.", { name: item.name }), ok: t("Remove for good"), cancel: t("Cancel"), danger: true })
              if (yes) act(() => api.remove(item.id), t("Removed for good."))
            },
          }),
        ),
      )
    }
  }
  const act = async (run, words, back = false) => {
    try {
      const r = await run()
      say(words)
      draw(Array.isArray(r?.items) ? r.items : [])
      if (back) changed?.(r?.restored || "")
    } catch (err) {
      say(why(err), true)
    }
  }
  emptyBtn.addEventListener("click", async () => {
    const yes = await ask({ title: t("Empty the trash"), text: t("Remove everything in the trash for good? This cannot be undone."), ok: t("Empty the trash"), cancel: t("Cancel"), danger: true })
    if (yes) act(() => api.empty(), t("Removed for good."))
  })
  list.append(h("li", { class: "fnote is-loading" }, h("span", { text: t("Loading…") })))
  api.list().then(
    (r) => draw(Array.isArray(r?.items) ? r.items : []),
    (err) => {
      clear(list)
      say(why(err), true)
    },
  )
  return done
}

/**
 * A file's versions, newest first: when, by whom, how large; an older one can be made the
 * current one again (as a new version) or saved somewhere. `api`: { list() -> { versions },
 * restore(id) -> { versions }, download?(id) }; `changed()` after a restore.
 */
export function versionsDialog({ name, api, changed }) {
  const list = h("ul", { class: "fvers__list", role: "list" })
  const said = h("p", { class: "status fvers__said", role: "status", hidden: true })
  const body = h(
    "div",
    { class: "dialog__body fvers" },
    h("h2", { class: "dialog__title", id: "fvers-title" }, h("span", { text: t("Versions") }), h("bdi", { class: "fvers__name", text: name })),
    said,
    list,
    h("div", { class: "dialog__actions dialog__actions--one" }, h("button", { type: "button", class: "btn", text: t("Close"), onclick: () => close(null) })),
  )
  const { dlg, close, done } = modal("fvers-title", body)
  dlg.classList.add("dialog--wide")
  const say = (text, error = false) => {
    said.hidden = !text
    said.textContent = text || ""
    said.className = `status fvers__said${error ? " is-error" : ""}`
    said.setAttribute("role", error ? "alert" : "status")
  }
  const draw = (versions) => {
    clear(list)
    for (const v of versions) {
      const at = stamp(v.at)
      // One row, five tracks, the same on every row: when, by whom, the size, and the two
      // buttons -- which the current version has as empty boxes, so the columns hold.
      list.append(
        h(
          "li",
          { class: `fvers__row${v.current ? " is-current" : ""}`, dataset: { id: v.id }, "aria-current": v.current ? "true" : null },
          h("span", { class: "fvers__when", title: at.full, text: at.short || at.full }),
          h("span", { class: "fvers__by", text: v.by || "" }),
          h("span", { class: "fvers__size", text: bytes(v.size) }),
          v.current || !api.download ? h("span", { class: "fvers__gap" }) : h("button", { type: "button", class: "btn btn--sm fvers__get", text: t("Download"), onclick: () => api.download(v.id).catch((err) => say(why(err), true)) }),
          v.current
            ? h("span", { class: "fvers__gap" })
            : h("button", {
                type: "button",
                class: "btn btn--sm fvers__restore",
                text: t("Restore this version"),
                onclick: async () => {
                  const yes = await ask({ title: t("Restore this version"), text: t("Make this version the current one? The current one stays in the list."), ok: t("Restore"), cancel: t("Cancel") })
                  if (!yes) return
                  try {
                    const r = await api.restore(v.id)
                    say(t("That version is the current one again."))
                    draw(Array.isArray(r?.versions) ? r.versions : [])
                    changed?.()
                  } catch (err) {
                    say(why(err), true)
                  }
                },
              }),
        ),
      )
    }
  }
  list.append(h("li", { class: "fnote is-loading" }, h("span", { text: t("Loading…") })))
  api.list().then(
    (r) => draw(Array.isArray(r?.versions) ? r.versions : []),
    (err) => {
      clear(list)
      say(why(err), true)
    },
  )
  return done
}
