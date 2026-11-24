// The Files page: two explorers, kept apart as two tabs -- this computer's (the agent's folders,
// read through a command that reaches only them, src-tauri/src/files.rs) and the server's (the
// person's files, as the chats see them, read through /api/v2). Each is the web explorer's shape,
// using the window's width: where you are (crumbs) and what can be done there, the folder tree,
// the list (name, type, size, changed), and the chosen file's details and preview. A file opens in
// the viewer either way.
//
// Both are file managers, with the same hands: a new file and a new folder, rename, move and
// copy through a dialog that walks to the folder (no path is typed), delete, several things at
// once from a bar that appears when something is ticked, a row dragged onto a folder to move it
// there, and a text file edited in the viewer. What differs is what does the work (`ops`): the
// server's routes, or Rust inside the agent's folders (src-tauri/src/files.rs, which checks
// every path again). The server's has its trash, its versions, a download to where the person
// chooses and files dropped from the computer; and a thing can be copied from one tab to the
// other.
//
// Nothing here is ever an empty box: a directory being read says Loading…, past SLOW_MS it says
// the server has not answered (with Try again, the late answer still drawn), and a refusal, an
// answer that is not a listing or a failure to draw it is said in its place with Try again.

import { $, h, clear, icon, ICONS, bytes } from "./dom.js"
import { invoke, listen, api, get, post, del, why } from "./bridge.js"
import { menu, ask } from "./popup.js"
import { openViewer, showKind, fileKind, withheldWords } from "./viewer.js"
import { pickFolder, trashDialog, versionsDialog } from "./filedialogs.js"

// The server's tree as the app's door gives it, read as the person (their own access, no chat):
//   GET /files?path=/a        -> { path, parent, entries: [{ name, path, kind: "dir"|"file"|"mount", size, mime, updated_at }] }
//   GET /files/content?path=  -> { path, name, size, mime, kind, language, sha, text, withheld?: { reason, message } }
// A path the person cannot read is the server's 404, in its words. `/` answers with where the
// person's explorer opens (`fs.start`): `/` itself for an organisation's owner or administrator,
// the person's home for anyone else -- its `path` says which.
export const SERVER_FILES = {
  list: (path) => `/files?path=${encodeURIComponent(path || "/")}`,
  read: (path) => `/files/content?path=${encodeURIComponent(path)}`,
}

/** How long a directory may take before the pane says it is still waiting, and offers to ask again. */
export const SLOW_MS = 8000

/** How long an answer is shared between the tree and the list after it came. */
const SHARED_MS = 1500

/** The most of a file the details pane previews: the viewer has the rest. */
const PREVIEW_CHARS = 6000

/** A directory in either tree: the server's mounts open like its folders. */
const isDir = (e) => e.kind === "dir" || e.kind === "mount"

/** What a file is: the server's word for it (`file_kind`), this computer's, or its name's. */
const kindOf = (e) => (isDir(e) ? "" : fileKind(e.name, e.file_kind))

const KIND_ICONS = { markdown: "fileText", text: "fileText", table: "fileText", notebook: "fileCode", code: "fileCode", html: "fileCode", image: "picture", svg: "picture", audio: "speaker", video: "play", archive: "archive" }

/** An entry's icon, by what the viewer would make of it (the web's `file_icon`). */
function iconOf(e) {
  if (e.kind === "mount") return ICONS.drive
  if (isDir(e)) return ICONS.folder
  return ICONS[KIND_ICONS[kindOf(e)] || "file"]
}

/** The Type column: a folder, a mount, or the extension (the web's `type_label`). */
function typeOf(e) {
  if (e.kind === "mount") return t("mount")
  if (isDir(e)) return t("folder")
  const i = e.name.lastIndexOf(".")
  return i > 0 ? e.name.slice(i + 1).toLowerCase() : ""
}

/** A stamp as a date the person reads, and the whole of it for a title. */
function dateOf(stamp) {
  if (!stamp) return { short: "", full: "" }
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return { short: "", full: "" }
  const lang = document.documentElement.lang || undefined
  return {
    short: new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(d),
    full: new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(d),
  }
}

/** Is the details pane on the screen (wide windows): a file is chosen there, else opened. */
const detailsShown = (el) => !!el && getComputedStyle(el).display !== "none"

/**
 * Read something into `holder` and draw it, never leaving it empty: Loading… at once, the slow
 * note and Try again past SLOW_MS, a refusal or a failure to draw in its place. `tag` is the
 * element the notes are (an `li` inside a list). Only the latest reading of a holder is drawn:
 * one that comes after the holder was read again, or left the page, is dropped. Returns a promise
 * that settles once the reading is drawn or said.
 */
function reading(holder, { tag = "div", depth = 0, load, draw }) {
  const mine = (readings.get(holder) || 0) + 1
  readings.set(holder, mine)
  const stale = () => readings.get(holder) !== mine || !holder.isConnected
  const again = () => reading(holder, { tag, depth, load, draw })
  const retry = () => h("button", { type: "button", class: "btn btn--sm fnote__retry", text: t("Try again"), onclick: again })
  const note = (cls, role, text) => {
    const n = h(tag, { class: `fnote ${cls}`, role }, h("span", { text }))
    n.style.setProperty("--depth", String(depth))
    return n
  }
  clear(holder)
  const loading = note("is-loading", "status", t("Loading…"))
  loading.setAttribute("aria-live", "polite")
  holder.append(loading)
  const slow = setTimeout(() => {
    if (!stale()) loading.append(h("span", { text: t("The server has not answered in %(n)s seconds.", { n: Math.round(SLOW_MS / 1000) }) }), retry())
  }, SLOW_MS)
  const said = (text) => {
    const n = note("is-error", "alert", text)
    n.append(retry())
    clear(holder).append(n)
  }
  return Promise.resolve()
    .then(load)
    .then(
      (answer) => {
        clearTimeout(slow)
        if (stale()) return
        try {
          clear(holder)
          draw(answer)
        } catch (err) {
          said(err instanceof Error ? err.message : why(err))
        }
      },
      (err) => {
        clearTimeout(slow)
        if (!stale()) said(why(err))
      },
    )
}
const readings = new WeakMap() // holder -> the reading it shows now (a number)

/** How far a pressed row is moved before it is being dragged. */
const DRAG_PX = 6

/**
 * One explorer, inside the pane's elements (`crumbs`, `tree`, `list`, `details`, `status`,
 * `batch`). `source`:
 *   key           "local" | "server" (the rows' data, the tests' handle)
 *   list(path)    -> { path, entries } (`path` as answered: the server's `/` says where it is)
 *   top()         the directory the explorer opens at (the server's: as `/` answered)
 *   ask(path)     the path to ask for a directory (the server's top is asked as `/`)
 *   crumbs(path)  -> [[name, path], ...] from the top down
 *   parent(path)  the directory a path is in
 *   rootName()    the tree's first line
 *   open(entry)   in the viewer
 *   preview(entry) -> { text, withheld, size }
 *   media?(entry, kind) -> the address a picture's bytes are served at (the details' thumbnail)
 *   ops?          what changes the tree, each a promise:
 *     mkdir(dir, name)  mkfile(dir, name)  rename(entry, name)
 *     move(paths, to)  copy(paths, to)  remove(paths)   -> { done, failed: [{ path, error }], said? }
 *   dirItems?(entry), fileItems?(entry), acrossItems?(entry)  -> more of a row's menu
 *   batchItems?(paths) -> more of the bar's buttons: [{ label, run }]
 *   treeFiles?    the tree lists files as well as folders, each line with the list's own menu
 *                 (the workspace, whose tree is the whole of its files; the list is not shown)
 *   across?       what a drop onto another place does: { words(place) -> the sentence said
 *                 while it is held there, drop(entries, place) } -- a place is an element with
 *                 `data-place-drop`, anywhere in the window
 */
export function explorer(el, source) {
  let current = null // the directory listed now (as answered)
  let chosen = null // the file whose details show
  let shown = [] // the entries listed now
  const picked = new Map() // path -> entry: what is ticked
  let thumb = null // the address of the details' picture, to let go
  const ops = source.ops || null

  /** What happened, under the bar: a word, or -- an error -- what went wrong, and it stays. */
  const say = (text, error = false) => {
    const line = el.status
    if (!line) return
    line.hidden = !text
    line.textContent = text || ""
    line.className = `status fx__status${error ? " is-error" : ""}`
    line.setAttribute("role", error ? "alert" : "status")
  }

  // One request per directory for the tree and the list together: an answer is shared while it
  // is on its way and for a moment after (the tree drawn again once the top is known); a refusal
  // is never kept, so Try again asks afresh. Read again and a change forget them all.
  const pending = new Map() // asked path -> promise
  const fetchDir = (path) => {
    const asked = source.ask(path)
    if (!pending.has(asked)) {
      const p = Promise.resolve().then(() => source.list(asked))
      pending.set(asked, p)
      const forget = () => pending.get(asked) === p && pending.delete(asked)
      p.then(() => setTimeout(forget, SHARED_MS), forget)
    }
    return pending.get(asked)
  }

  // --- The folder tree: folders only, opened lazily; a name lists its folder.
  const treeBox = el.tree
  const opened = new Set()
  const branches = new Map() // path -> { ul, depth }
  const known = new Map() // path -> entry: what the tree has listed (a dragged line's entry)
  const drawTree = () => {
    clear(treeBox)
    const rootRow = h(
      "button",
      { type: "button", class: "ftree__row ftree__root", dataset: { path: source.top(), drop: source.top() }, onclick: () => go(source.top()) },
      icon(ICONS.folder),
      h("span", { class: "ftree__name", text: source.rootName() }),
    )
    const ul = h("ul", { class: "ftree", role: "tree", "aria-label": t("Folders") })
    treeBox.append(rootRow, ul)
    branch(ul, source.top(), 0)
    mark()
  }
  const branch = (ul, path, depth) => {
    branches.set(path, { ul, depth })
    return reading(ul, {
      tag: "li",
      depth,
      load: () => fetchDir(path),
      draw: (answer) => {
        const all = answer.entries || []
        // (Never forgotten when a folder is read again: a line still on the screen is always
        // one the tree knows, whichever folder was read last.)
        for (const e of all) known.set(e.path, e)
        for (const e of all.filter(isDir)) ul.append(twig(e, depth))
        if (source.treeFiles) {
          for (const e of all.filter((x) => !isDir(x))) ul.append(leaf(e, depth))
          if (!all.length && depth === 0) ul.append(h("li", { class: "fnote" }, h("span", { text: t("Nothing here yet. Not even a hobbit hole.") })))
        }
        mark()
      },
    })
  }
  /** What a line of a tree that lists files has at its end: the list's own menu for the entry. */
  const more = (e) =>
    source.treeFiles && itemsFor(e).length
      ? h("button", { type: "button", class: "tool ftree__more", "aria-label": t("More for %(name)s", { name: e.name }), title: t("More for %(name)s", { name: e.name }), onclick: (ev) => menu(ev.currentTarget, itemsFor(e)) }, icon(ICONS.more))
      : null
  /** A file's line in the tree (only where the tree lists files): opens it. */
  const leaf = (e, depth) => {
    const row = h(
      "button",
      { type: "button", class: "ftree__row ftree__row--file", title: e.path, dataset: { path: e.path, file: "true" }, onclick: () => source.open(e) },
      h("span", { class: `frow__icon frow__icon--${kindOf(e)}` }, icon(iconOf(e))),
      h("span", { class: "ftree__name", text: e.name }),
    )
    const line = h("div", { class: "ftree__line" }, h("span", { class: "ftree__gap", "aria-hidden": "true" }), row, more(e))
    line.style.setProperty("--depth", String(depth))
    line.addEventListener("contextmenu", (ev) => (ev.preventDefault(), menu({ x: ev.clientX, y: ev.clientY }, itemsFor(e))))
    return h("li", { role: "treeitem", dataset: { path: e.path, kind: e.kind } }, line)
  }
  const twig = (e, depth) => {
    const chevron = h("button", { type: "button", class: "ftree__chevron", "aria-label": e.name, "aria-expanded": "false", tabindex: "-1" }, icon(ICONS.chevron))
    const row = h(
      "button",
      { type: "button", class: "ftree__row", title: e.path, dataset: { path: e.path, drop: e.path } },
      icon(iconOf(e)),
      h("span", { class: "ftree__name", text: e.name }),
    )
    const line = h("div", { class: "ftree__line" }, chevron, row, more(e))
    line.style.setProperty("--depth", String(depth))
    if (source.treeFiles) line.addEventListener("contextmenu", (ev) => (ev.preventDefault(), menu({ x: ev.clientX, y: ev.clientY }, itemsFor(e))))
    const li = h("li", { role: "treeitem", dataset: { path: e.path, kind: e.kind } }, line)
    let kids = null
    const expand = (opening) => {
      chevron.setAttribute("aria-expanded", String(opening))
      li.setAttribute("aria-expanded", String(opening))
      kids?.remove()
      kids = null
      if (!opening) {
        opened.delete(e.path)
        branches.delete(e.path)
        return
      }
      opened.add(e.path)
      kids = h("ul", { role: "group" })
      li.append(kids)
      branch(kids, e.path, depth + 1)
    }
    chevron.addEventListener("click", () => expand(chevron.getAttribute("aria-expanded") !== "true"))
    row.addEventListener("click", () => {
      go(e.path)
      if (chevron.getAttribute("aria-expanded") !== "true") expand(true)
    })
    if (opened.has(e.path)) expand(true)
    return li
  }
  /** The tree's line for the folder listed now. */
  const mark = () => {
    for (const r of treeBox.querySelectorAll(".ftree__row")) {
      const here = r.dataset.path === current || (r.classList.contains("ftree__root") && current === source.top())
      r.classList.toggle("is-current", here)
      if (here) r.setAttribute("aria-current", "true")
      else r.removeAttribute("aria-current")
    }
  }

  // --- Where you are.
  const drawCrumbs = () => {
    const parts = source.crumbs(current ?? source.top())
    clear(el.crumbs).append(
      ...parts.flatMap(([name, at], i) => {
        const last = i === parts.length - 1
        const part = last
          ? h("span", { class: "crumbs__here", "aria-current": "page", title: at, text: name })
          : h("button", { type: "button", class: "crumbs__link", title: at, text: name, dataset: { drop: at }, onclick: () => go(at) })
        return i ? [h("span", { class: "crumbs__sep", "aria-hidden": "true", text: "/" }), part] : [part]
      }),
    )
    el.crumbs.scrollLeft = el.crumbs.scrollWidth
  }

  // --- The list.
  const go = (path) => {
    current = path
    chosen = null
    shown = []
    picked.clear()
    drawBatch()
    drawDetails()
    drawCrumbs()
    mark()
    return reading(el.list, {
      load: () => fetchDir(path),
      draw: (answer) => {
        if (!answer || !Array.isArray(answer.entries)) throw { detail: t("The server's answer could not be read.") }
        if (answer.path !== undefined && answer.path !== path && source.ask(path) === source.ask(answer.path)) current = answer.path
        drawCrumbs()
        mark()
        shown = answer.entries
        drawRows(answer.entries)
      },
    })
  }
  /** What can be ticked: everything but a mount, where the tree can be changed at all. */
  const tickable = (e) => !!ops && e.kind !== "mount"
  let pickAll = null
  const drawRows = (entries) => {
    pickAll = null
    if (!entries.length) {
      el.list.append(h("div", { class: "fx__empty" }, icon(ICONS.folder), h("p", { text: t("Nothing here yet. Not even a hobbit hole.") })))
      return
    }
    pickAll = entries.some(tickable)
      ? h("input", {
          type: "checkbox",
          class: "frow__pick",
          "aria-label": t("Select everything here"),
          title: t("Select everything here"),
          onchange: (ev) => {
            picked.clear()
            if (ev.target.checked) for (const e of entries) if (tickable(e)) picked.set(e.path, e)
            for (const box of el.list.querySelectorAll(".frow[data-path] .frow__pick")) box.checked = picked.has(box.closest(".frow").dataset.path)
            drawBatch()
          },
        })
      : null
    const head = h(
      "div",
      { class: "frow frow--head", role: "row" },
      h("span", { role: "columnheader", class: "frow__tick" }, pickAll),
      h("span", { role: "columnheader", text: t("Name") }),
      h("span", { role: "columnheader", class: "frow__type", text: t("Type") }),
      h("span", { role: "columnheader", class: "frow__size", text: t("Size") }),
      h("span", { role: "columnheader", class: "frow__when", text: t("Changed") }),
      h("span", { role: "columnheader" }, h("span", { class: "visually-hidden", text: t("Actions") })),
    )
    el.list.append(h("div", { class: "frows", role: "table", "aria-label": t("Contents") }, head, entries.map(row)))
  }
  const row = (e) => {
    const date = dateOf(e.updated_at)
    const items = itemsFor(e)
    const kind = e.kind === "mount" ? "mount" : isDir(e) ? "dir" : kindOf(e)
    const openRow = h(
      "button",
      { type: "button", class: "frow__open", title: e.path },
      h("span", { class: `frow__icon frow__icon--${kind}` }, icon(iconOf(e))),
      h("span", { class: "frow__label", text: e.name }),
    )
    const tick = tickable(e)
      ? h("input", {
          type: "checkbox",
          class: "frow__pick",
          "aria-label": t("Select %(name)s", { name: e.name }),
          checked: picked.has(e.path),
          onchange: (ev) => {
            if (ev.target.checked) picked.set(e.path, e)
            else picked.delete(e.path)
            drawBatch()
          },
        })
      : null
    const r = h(
      "div",
      { class: "frow", role: "row", dataset: { path: e.path, kind: e.kind, ...(isDir(e) ? { drop: e.path } : {}) } },
      h("span", { role: "cell", class: "frow__tick" }, tick),
      h("span", { role: "cell", class: "frow__name" }, openRow, e.kind === "mount" ? h("span", { class: "badge", text: t("mount") }) : null),
      h("span", { role: "cell", class: "frow__type", text: typeOf(e) }),
      h("span", { role: "cell", class: "frow__size", text: isDir(e) ? "" : bytes(e.size) }),
      h("span", { role: "cell", class: "frow__when", title: date.full, text: date.short }),
      h(
        "span",
        { role: "cell", class: "frow__actions" },
        items.length
          ? h("button", { type: "button", class: "tool frow__more", "aria-label": t("More for %(name)s", { name: e.name }), title: t("More for %(name)s", { name: e.name }), onclick: (ev) => menu(ev.currentTarget, itemsFor(e)) }, icon(ICONS.more))
          : null,
      ),
    )
    openRow.addEventListener("click", () => {
      if (isDir(e)) go(e.path)
      else if (detailsShown(el.details)) choose(e)
      else source.open(e)
    })
    openRow.addEventListener("dblclick", () => {
      if (!isDir(e)) source.open(e)
    })
    return r
  }

  // --- What can be done: to one thing (its menu), and to everything ticked (the bar).
  const dirOf = (path) => source.parent(path)
  /** Do something to the tree, say how it went, and draw what is there now. */
  const act = async (work, words) => {
    say("")
    try {
      const r = await work()
      const failed = r?.failed || []
      // What worked may still have something to say (a copy that left the CLI's own files out).
      if (failed.length) say(failed.map((f) => `${f.path}: ${f.error}`).join("\n"), true)
      else say([r?.said || (typeof words === "function" ? words(r) : words) || "", ...(r?.notes || [])].filter(Boolean).join("\n"))
      if (!r?.quiet) await refresh()
      return r
    } catch (err) {
      say(why(err), true)
      return null
    }
  }
  const newIn = async (dir, folder) => {
    const name = await ask(
      folder
        ? { title: t("New folder"), value: "", ok: t("Create"), cancel: t("Cancel") }
        : { title: t("New file"), text: t("What should the file be called? With its extension, such as notes.md."), value: "", ok: t("Create"), cancel: t("Cancel") },
    )
    if (!name) return
    await act(() => (folder ? ops.mkdir(dir, name) : ops.mkfile(dir, name)), folder ? t("Folder made.") : "")
  }
  const renameOne = async (e) => {
    const name = await ask({ title: t("Rename"), value: e.name, ok: t("Rename"), cancel: t("Cancel") })
    if (!name || name === e.name) return
    await act(() => ops.rename(e, name), "")
  }
  const removeThese = async (entries) => {
    const one = entries.length === 1 ? entries[0] : null
    const yes = await ask({
      title: t("Move to the trash"),
      text: one ? t("Move “%(name)s” to the trash? It can be restored from there.", { name: one.name }) : t("Move the %(n)s selected to the trash? They can be restored from there.", { n: entries.length }),
      ok: t("Move to the trash"),
      cancel: t("Cancel"),
      danger: true,
    })
    if (!yes) return
    await act(() => ops.remove(entries.map((e) => e.path)), (r) => (one ? t("Moved to the trash.") : t("Moved to the trash: %(n)s.", { n: r?.done ?? entries.length })))
  }
  /** Move or copy these into a folder chosen by walking to it. */
  const sendThese = async (entries, copy) => {
    const to = await pickFolder({ source, start: current ?? source.top(), title: copy ? t("Copy to which folder?") : t("Move to which folder?"), ok: copy ? t("Copy here") : t("Move here") })
    if (to === null || to === undefined) return
    await moveInto(entries.map((e) => e.path), to, copy)
  }
  const moveInto = (paths, to, copy = false) =>
    act(
      () => (copy ? ops.copy(paths, to) : ops.move(paths, to)),
      (r) => (copy ? (r?.copied ? t("Copied as %(name)s.", { name: r.copied }) : t("Copied: %(n)s.", { n: r?.done ?? paths.length })) : paths.length === 1 ? t("Moved.") : t("Moved: %(n)s.", { n: r?.done ?? paths.length })),
    )

  const itemsFor = (e) => {
    const items = []
    if (isDir(e)) {
      items.push(...(source.dirItems?.(e) || []))
      if (ops?.mkdir && !e.fixed) items.push({ label: t("New folder"), run: () => newIn(e.path, true) })
      if (ops?.mkfile && !e.fixed) items.push({ label: t("New file"), run: () => newIn(e.path, false) })
    } else items.push({ label: t("Open in the viewer"), run: () => source.open(e) }, ...(source.fileItems?.(e) || []))
    if (e.kind === "mount" || !ops) return items
    const across = source.acrossItems?.(e) || []
    // What may not be changed where it is can still be taken to another place.
    if (e.fixed) return across.length ? [...items, ...(items.length ? [null] : []), ...across] : items
    items.push(null, { label: t("Move"), run: () => sendThese([e], false) }, { label: t("Copy to…"), run: () => sendThese([e], true) }, ...across)
    items.push(null, { label: t("Rename"), run: () => renameOne(e) }, { label: t("Delete"), danger: true, run: () => removeThese([e]) })
    return items
  }

  /** The bar for what is ticked: how many, and what can be done to all of them at once. */
  const drawBatch = () => {
    const bar = el.batch
    if (!bar) return
    const entries = [...picked.values()]
    bar.hidden = !entries.length
    if (pickAll) {
      const all = shown.filter(tickable).length
      pickAll.checked = entries.length > 0 && entries.length === all
      pickAll.indeterminate = entries.length > 0 && entries.length < all
    }
    clear(bar)
    if (!entries.length) return
    const btn = (label, run, cls = "") => h("button", { type: "button", class: `btn btn--sm ${cls}`, text: label, onclick: run })
    bar.append(
      h("span", { class: "fx__count", role: "status", text: t("%(n)s selected", { n: entries.length }) }),
      h(
        "span",
        { class: "fx__batch-do" },
        btn(t("Move"), () => sendThese(entries, false)),
        btn(t("Copy to…"), () => sendThese(entries, true)),
        (source.batchItems?.(entries) || []).map((i) => btn(i.label, i.run)),
        btn(t("Delete"), () => removeThese(entries), "btn--danger"),
        btn(t("Clear the selection"), () => {
          picked.clear()
          for (const box of el.list.querySelectorAll(".frow[data-path] .frow__pick")) box.checked = false
          drawBatch()
        }),
      ),
    )
  }

  // --- A row dragged onto a folder moves it there (and with it everything ticked, when it is
  // ticked). Followed with the pointer rather than the browser's own drag and drop, which the
  // window's file drop takes over on some systems; a folder in the list, in the tree or among
  // the crumbs takes it.
  // The pane's elements outlive an explorer (the pane is drawn again for another folder): the
  // list has one such handler, the latest explorer's, never one from each.
  const dragFrom = (ev, paths, label) => {
    let ghost = null
    let over = null
    let words = ""
    const nameOf = (to) => (to === source.top() ? source.rootName() : baseName(to))
    // What takes a drop, and what the drop would do, in words: a folder of this place moves it
    // there; another place (its button) is a copy to there, the folder asked for afterwards.
    const takes = (x, y) => {
      const under = document.elementFromPoint(x, y)
      const place = source.across ? under?.closest?.("[data-place-drop]") : null
      if (place && place.dataset.placeDrop !== source.place) {
        words = source.across.words(place.dataset.placeDrop, place)
        return words ? place : null
      }
      const hit = under?.closest?.("[data-drop]")
      if (!hit || !el.pane.contains(hit)) return null
      const to = hit.dataset.drop
      // Not onto itself, into itself, or into the folder it is in already.
      if (paths.some((p) => to === p || to.startsWith(`${p}/`) || dirOf(p) === to)) return null
      words = t("Move to %(folder)s", { folder: nameOf(to) })
      return hit
    }
    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < DRAG_PX) return
        ghost = h("div", { class: "fdrag", "aria-hidden": "true" }, h("span", { class: "fdrag__what", text: label }), h("span", { class: "fdrag__does" }))
        document.body.append(ghost)
        el.pane.classList.add("is-dragging")
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`
      const hit = takes(e.clientX, e.clientY)
      if (hit === over) return
      over?.classList.remove("is-drop")
      over = hit
      over?.classList.add("is-drop")
      // What letting go here would do, in words; nothing where nothing would take it.
      ghost.lastChild.textContent = over ? words : ""
    }
    const end = (e) => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", end)
      document.removeEventListener("pointercancel", end)
      el.pane.classList.remove("is-dragging")
      over?.classList.remove("is-drop")
      if (!ghost) return
      ghost.remove()
      // The click that ends a drag opens nothing.
      const swallow = (c) => (c.stopPropagation(), c.preventDefault())
      document.addEventListener("click", swallow, { capture: true, once: true })
      setTimeout(() => document.removeEventListener("click", swallow, true), 0)
      if (e.type !== "pointerup" || !over) return
      if (over.dataset.placeDrop) source.across.drop(paths.map((p) => picked.get(p) || shown.find((x) => x.path === p) || known.get(p)).filter(Boolean), over.dataset.placeDrop)
      else moveInto(paths, over.dataset.drop)
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", end)
    document.addEventListener("pointercancel", end)
  }
  el.list.onpointerdown = !ops?.move
    ? null
    : (ev) => {
      if (ev.button !== 0 || ev.pointerType !== "mouse") return
      const from = ev.target.closest?.(".frow[data-path]")
      if (!from || from.dataset.kind === "mount" || ev.target.closest(".frow__actions, .frow__tick")) return
      const paths = picked.has(from.dataset.path) ? [...picked.keys()] : [from.dataset.path]
      dragFrom(ev, paths, paths.length > 1 ? t("%(n)s selected", { n: paths.length }) : from.querySelector(".frow__label")?.textContent || "")
    }
  // (A tree that lists files is dragged from as the list is: a line onto a folder, or a place.)
  el.tree.onpointerdown = !(ops?.move && source.treeFiles)
    ? null
    : (ev) => {
      if (ev.button !== 0 || ev.pointerType !== "mouse") return
      const from = ev.target.closest?.("li[data-path]")
      if (!from || from.dataset.kind === "mount" || ev.target.closest(".ftree__more, .ftree__chevron")) return
      dragFrom(ev, [from.dataset.path], from.querySelector(".ftree__name")?.textContent || "")
    }

  // --- The chosen file's details and preview.
  const choose = (e) => {
    chosen = e
    for (const r of el.list.querySelectorAll(".frow[data-path]")) r.classList.toggle("is-chosen", r.dataset.path === e.path)
    drawDetails()
  }
  const drawDetails = () => {
    const box = el.details
    if (!box) return
    if (thumb) invoke("media_close", { url: thumb }).catch(() => {})
    thumb = null
    for (const r of el.list.querySelectorAll(".frow.is-chosen")) if (!chosen || r.dataset.path !== chosen.path) r.classList.remove("is-chosen")
    clear(box)
    if (!chosen) {
      box.append(h("div", { class: "fdetails__none" }, icon(ICONS.file), h("p", { text: t("Choose a file to see it here.") })))
      return
    }
    const e = chosen
    const kind = kindOf(e)
    const date = dateOf(e.updated_at)
    const fact = (label, value, title) => (value ? [h("dt", { text: label }), h("dd", { title: title || value, text: value })] : [])
    const preview = h("div", { class: "fdetails__preview", "aria-label": t("Preview") })
    box.append(
      h("div", { class: "fdetails__id" }, h("span", { class: `frow__icon frow__icon--${kind}` }, icon(iconOf(e))), h("h2", { class: "fdetails__name", title: e.name, text: e.name })),
      h("dl", { class: "fdetails__facts" }, fact(t("Type"), typeOf(e)), fact(t("Size"), bytes(e.size)), fact(t("Changed"), date.short, date.full), fact(t("Path"), e.path)),
      h(
        "div",
        { class: "fdetails__do" },
        h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Open in the viewer"), onclick: () => source.open(e) }),
        (source.fileItems?.(e) || []).filter((i) => i?.details).map((i) => h("button", { type: "button", class: "btn btn--sm", text: i.label, onclick: i.run })),
      ),
      preview,
    )
    // A picture is seen; text is read; anything else has its facts above and no more.
    if ((kind === "image" || kind === "svg") && source.media) {
      reading(preview, {
        load: () => source.media(e, kind),
        draw: (url) => {
          if (chosen !== e) return void invoke("media_close", { url }).catch(() => {})
          thumb = url
          const img = h("img", { class: "fdetails__picture", alt: "", src: url, draggable: "false" })
          img.addEventListener("error", () => img.replaceWith(h("p", { class: "fdetails__note", text: t("This file cannot be shown here.") })), { once: true })
          preview.append(img)
        },
      })
      return
    }
    if (["audio", "video", "pdf", "model3d", "archive", "binary"].includes(kind)) return
    reading(preview, {
      load: () => source.preview(e),
      draw: (f) => {
        if (chosen !== e) return
        if (f.withheld) preview.append(h("p", { class: "fdetails__note", text: withheldWords(f.withheld, f.size ?? e.size) }))
        else {
          const text = String(f.text ?? "")
          preview.append(h("pre", { class: "fdetails__text", text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : text }))
        }
      },
    })
  }

  /** Read again: the list, the tree as it is open, the file chosen. */
  const refresh = () => {
    pending.clear()
    const at = current ?? source.top()
    drawTree()
    return go(at)
  }
  /** A directory changed (an upload, a new folder, a rename, a delete): draw what is there now. */
  const changed = (dir) => {
    pending.clear()
    const b = branches.get(dir)
    if (b) branch(b.ul, dir, b.depth)
    if (dir === current || source.ask(dir) === source.ask(current ?? source.top())) return go(current ?? source.top())
    return Promise.resolve()
  }
  /** The folder under a point of the window, where this pane shows one there; else the one listed. */
  const folderAt = (x, y) => {
    const hit = Number.isFinite(x) ? document.elementFromPoint(x, y)?.closest?.("[data-drop]") : null
    return hit && el.pane.contains(hit) ? hit.dataset.drop : (current ?? source.top())
  }
  /** Go to the folder a file is in and choose the file there; false when it is not there. */
  const reveal = async (path) => {
    await go(dirOf(path))
    const e = shown.find((x) => x.path === path)
    if (e) choose(e)
    return !!e
  }
  return { go, refresh, changed, drawTree, say, act, newIn, folderAt, reveal, current: () => current ?? source.top() }
}

// --- This computer ------------------------------------------------------------------------------

let local = { root: "", roots: [], fixed: false }
let localPane = null

/**
 * Point this computer's pane at a folder: `fixed` (an agent chat's working directory, which is
 * what the pane shows while that chat is open) or one of the agent's folders, chosen in the pane.
 */
export function showLocal({ roots, root, fixed }) {
  const changed = root !== local.root || fixed !== local.fixed || roots.join("\n") !== local.roots.join("\n")
  local = { roots, root: root || (roots.includes(local.root) ? local.root : roots[0] || ""), fixed: !!fixed }
  if (changed) renderLocal()
}

const baseName = (p) => String(p).replace(/\/+$/, "").split("/").pop() || p

/** What Rust says of several things moved, copied or deleted, as the explorer takes it. */
const outcomes = (results) => ({ done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => ({ path: r.path, error: r.error || "" })), notes: results.filter((r) => r.ok && r.note).map((r) => String(r.note)) })

/** This computer's tree under `root`, as an explorer's (and a folder dialog's) place. */
export function localSource(root) {
  const where = t("This computer")
  const read = (e) => invoke("local_read", { root, path: e.path })
  // The file as the viewer takes it (`openViewer`, `mountFile`): read now; `reload` shows it read again.
  const file = async (e, reload) => {
    try {
      const f = await read(e)
      const editable = f.writable && typeof f.text === "string"
      return {
        name: f.name,
        path: `${f.root}/${f.path}`,
        where,
        kind: f.kind,
        mime: f.mime,
        text: f.text ?? undefined,
        withheld: f.withheld,
        size: f.size,
        sha: f.sha,
        media: () => invoke("media_open", { source: "local", kind: fileKind(f.name, f.kind), root, path: f.path }),
        sealed: { source: "local", root, path: f.path },
        save: editable ? (text, { base, force }) => invoke("local_write", { root, path: f.path, text, base: base || null, force: !!force }) : undefined,
        reload,
      }
    } catch (err) {
      return { name: e.name, path: e.path, where, error: why(err) }
    }
  }
  const open = async (e) => openViewer(await file(e, () => open(e)))
  return {
    key: "local",
    place: "local",
    root,
    file,
    top: () => "",
    ask: (path) => path || "",
    parent: (path) => (String(path).includes("/") ? String(path).replace(/\/[^/]*$/, "") : ""),
    rootName: () => baseName(root),
    crumbs: (path) => {
      const out = [[baseName(root), ""]]
      let at = ""
      for (const part of String(path).split("/").filter(Boolean)) {
        at = at ? `${at}/${part}` : part
        out.push([part, at])
      }
      return out
    },
    list: async (path) => {
      const r = await invoke("local_list", { root, path })
      if (!r || !Array.isArray(r.entries)) throw { detail: t("The server's answer could not be read.") }
      return {
        path: r.path ?? path,
        entries: r.entries.map((e) => ({ ...e, updated_at: e.modified ? new Date(e.modified * 1000).toISOString() : null })),
      }
    },
    preview: read,
    media: (e, kind) => invoke("media_open", { source: "local", kind, root, path: e.path }),
    open,
    ops: {
      mkdir: (dir, name) => invoke("local_make", { root, dir, name, folder: true }),
      mkfile: (dir, name) => invoke("local_make", { root, dir, name, folder: false }),
      rename: (e, name) => invoke("local_rename", { root, path: e.path, name }),
      move: async (paths, to) => outcomes(await invoke("local_transfer", { root, paths, to, copy: false })),
      copy: async (paths, to) => {
        const results = await invoke("local_transfer", { root, paths, to, copy: true })
        return { ...outcomes(results), copied: results.length === 1 && results[0].ok ? baseName(results[0].to || "") : "" }
      },
      remove: async (paths) => outcomes(await invoke("local_delete", { root, paths })),
    },
    // To the server: into a folder of the person's files there, chosen by walking to it.
    acrossItems: (e) =>
      isDir(e)
        ? []
        : [
            {
              label: t("Copy to the server…"),
              run: async () => {
                const dir = await pickFolder({ source: serverSource(), start: serverRoot, title: t("Copy to which folder?"), ok: t("Copy here") })
                if (dir === null || dir === undefined) return
                await localPane?.act(async () => {
                  const r = await invoke("local_upload", { root, paths: [e.path], dir })
                  if (r.sent) reloadServer(dir)
                  return { quiet: true, done: r.sent, failed: (r.failed || []).map((f) => ({ path: f.name, error: f.error || "" })) }
                }, t("Uploaded."))
              },
            },
          ],
  }
}

function renderLocal() {
  const head = clear($("local-where"))
  const els = { pane: $("pane-local"), crumbs: $("local-crumbs"), tree: $("local-tree"), list: $("local-list"), details: $("local-details"), status: $("local-status"), batch: $("local-batch") }
  $("pane-local").dataset.empty = String(!local.roots.length)
  for (const id of ["local-mkdir", "local-mkfile"]) $(id).hidden = !local.roots.length
  els.status.hidden = true
  els.batch.hidden = true
  if (!local.roots.length) {
    clear(els.crumbs)
    clear(els.tree)
    clear(els.details)
    clear(els.list).append(
      h(
        "div",
        { class: "fx__empty" },
        icon(ICONS.folder),
        h("p", { text: t("No project folder yet: the agent can open nothing on this computer.") }),
        h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") }),
      ),
    )
    localPane = null
    return
  }
  if (!local.fixed && local.roots.length > 1) {
    head.append(
      h(
        "select",
        { class: "pane__pick", "aria-label": t("Folder"), title: local.root, onchange: (e) => showLocal({ roots: local.roots, root: e.target.value, fixed: false }) },
        local.roots.map((r) => h("option", { value: r, text: r, selected: r === local.root })),
      ),
    )
  }
  localPane = explorer(els, localSource(local.root))
  localPane.drawTree()
  localPane.go("")
}

/** Read a file the agent showed in a chat on this computer: `path` from the chat's folder. */
export async function readLocal(root, path) {
  return invoke("local_read", { root, path })
}

// --- A linked computer ---------------------------------------------------------------------------
//
// The files of another computer of the person's, through the server's relay to the LLeMbas agent
// there (the CLI's `_lembas/fs/*`, harness spec 3.11.0 *Device files*; inside that computer's own
// folders and under its limits).
//
// The server's routes for the apps (its `api/v2/device_files.py`; fixtures device_fs_*.json),
// shaped as its own `/files` routes are, so a computer's file is read with the code that reads
// the server's. DEVICE_FILES and `deviceSource` are the one place the app spells them (Rust's
// `upload_to_device` spells the upload):
//
//   GET  /devices/{id}/fs?path=           -> { device, path, parent, writable, entries: [{ name, path, kind: "dir"|"file"|"other",
//                                              size, updated_at, file_kind, link, outside, protected, runs_code, writable }], truncated }
//   GET  /devices/{id}/fs/content?path=   -> { path, name, size, mime, kind, file_kind, writable, language, sha, text, withheld? }
//   PUT  /devices/{id}/fs/content         { path, text, base | create | force } -> { path, size, mtime, sha };
//                                         409 { detail, reason: "changed", conflict, sha } when it changed
//   POST /devices/{id}/fs/mkdir           { path, name } -> { path }
//   POST /devices/{id}/fs/rename          { path, name } -> { path }
//   POST /devices/{id}/fs/move | /copy    { paths, to } -> { results: [{ path, ok, error?, reason? }], done, failed }
//   POST /devices/{id}/fs/delete          { paths }     -> the same (to that computer's trash; one it has no trash for fails, in words)
//   POST /devices/{id}/fs/upload?path=    multipart `files` (by Rust: `device_upload_dropped`)
// Paths are absolute on that computer. What the computer will not let be changed says so
// (`writable: false` on an entry, on a file's content): no change is offered there. Not used
// yet: `/fs/raw` (a file's bytes), `/fs/stat`, `/fs/search`, a delete for good (`permanent`).
export const DEVICE_FILES = {
  list: (device, path) => `/devices/${enc(device)}/fs?path=${enc(path)}`,
  read: (device, path) => `/devices/${enc(device)}/fs/content?path=${enc(path)}`,
  write: (device) => `/devices/${enc(device)}/fs/content`,
  act: (device, what) => `/devices/${enc(device)}/fs/${what}`,
}

/** A linked computer's tree under `root` (a folder there), as an explorer's place. `name`: the computer's. */
export function deviceSource(device, root, name) {
  const where = name || t("A linked computer")
  const top = String(root).replace(/\/+$/, "") || "/"
  const read = (e) => get(DEVICE_FILES.read(device, e.path))
  const several = (r, n) => (Array.isArray(r?.results) ? batched(r) : { done: n, failed: [] })
  const file = async (e, reload) => {
    try {
      const f = await read(e)
      const at = f.path || e.path
      const kind = fileKind(f.name || e.name, f.file_kind || f.kind || e.file_kind)
      return {
        name: f.name || e.name,
        path: at,
        where,
        kind,
        mime: f.mime || "",
        text: f.text ?? undefined,
        withheld: f.withheld,
        size: f.size,
        sha: f.sha,
        // (A linked computer's bytes -- `/fs/raw` -- are not drawn by the viewer yet: what is not text says so.)
        save: f.writable !== false && typeof f.text === "string" && !f.withheld ? (text, { base, force }) => api("PUT", DEVICE_FILES.write(device), force ? { path: at, text, force: true } : { path: at, text, base }) : undefined,
        reload,
      }
    } catch (err) {
      return { name: e.name, path: e.path, where, error: why(err) }
    }
  }
  const open = async (e) => openViewer(await file(e, () => open(e)))
  return {
    key: "device",
    place: "device",
    device,
    root: top,
    file,
    top: () => top,
    ask: (path) => path || top,
    parent: (path) => (path === top ? top : String(path).replace(/\/[^/]*$/, "") || "/"),
    rootName: () => baseName(top),
    crumbs: (path) => {
      const out = [[baseName(top), top]]
      const rest = String(path).startsWith(top) ? String(path).slice(top.length) : ""
      let at = top
      for (const part of rest.split("/").filter(Boolean)) {
        at = `${at.replace(/\/$/, "")}/${part}`
        out.push([part, at])
      }
      return out
    },
    list: async (path) => {
      const r = await get(DEVICE_FILES.list(device, path || top))
      if (!r || !Array.isArray(r.entries)) throw { detail: r?.error || t("The server's answer could not be read.") }
      // (An entry the computer lets nobody change from here is offered no change: `fixed`.)
      return { path: r.path ?? path, entries: r.entries.map((e) => (e.writable === false ? { ...e, fixed: true } : e)) }
    },
    preview: read,
    open,
    ops: {
      mkdir: (dir, folder) => post(DEVICE_FILES.act(device, "mkdir"), { path: dir, name: folder }),
      mkfile: async (dir, fileName) => {
        if (fileName.includes("/")) throw { detail: t("A file needs a name without a slash.") }
        return api("PUT", DEVICE_FILES.write(device), { path: `${dir.replace(/\/$/, "")}/${fileName}`, text: "", create: true })
      },
      rename: (e, to) => post(DEVICE_FILES.act(device, "rename"), { path: e.path, name: to }),
      move: async (paths, to) => several(await post(DEVICE_FILES.act(device, "move"), { paths, to }), paths.length),
      copy: async (paths, to) => several(await post(DEVICE_FILES.act(device, "copy"), { paths, to }), paths.length),
      remove: async (paths) => several(await post(DEVICE_FILES.act(device, "delete"), { paths }), paths.length),
    },
  }
}

// --- The server ---------------------------------------------------------------------------------

export async function readServer(path) {
  return get(SERVER_FILES.read(path))
}

// The library's writes, as the person (each answers with the directory's listing, or a refusal
// in the server's words):
//   POST /files/upload?path=   multipart `files` (sent by Rust: `library_upload`, from the dialog,
//                              and `library_upload_dropped`, the files dropped on the window)
//   POST /files/mkdir          { path, name }
//   POST /files/rename         { path, name }
//   POST /files/move           { path, to }        POST /files/copy { path, to } -> + `copied`
//   POST /files/batch          { op: move|copy|delete, paths, to? } -> { results, done, failed }
//   PUT  /files/content        { path, text, base?, force? }: save; a new path makes the file
//   DELETE /files?path=        to the trash, as on the web
//   GET /files/trash · POST /files/restore { id } · DELETE /files/trash[?id=]
//   GET /files/versions?path= · POST /files/versions/restore { path, version }
// and, by Rust, to a place the person chooses in the system's dialog, written as they arrive:
//   GET /files/raw?path=[&version=]   (`file_save_as`)       POST /files/zip { paths } (`files_zip_save`)

let server = null // the explorer drawn now
let serverRoot = "/" // the directory the server answered `/` with: `/` or the person's home

const enc = encodeURIComponent
const parentOf = (path) => path.replace(/\/[^/]*$/, "") || "/"
const reloadServer = (dir) => server?.changed(dir)
const serverSaid = (text, error = false) => server?.say(text, error)

/** Into `dir`: files chosen in the system's dialog, or -- `dropped` -- the ones just dropped on the window. */
export async function uploadInto(dir, dropped = false) {
  serverSaid("")
  try {
    const r = dropped ? await invoke("library_upload_dropped", { dir }) : await invoke("library_upload", { dir, title: t("Upload") })
    if (r.failed?.length) serverSaid(r.failed.map((f) => `${f.name}: ${f.error}`).join("\n"), true)
    if (r.sent) await reloadServer(dir)
  } catch (err) {
    serverSaid(why(err), true)
  }
}

/** A download, to where the person chooses: said where it went, or why it did not. */
async function saved(work) {
  serverSaid("")
  try {
    const r = await work()
    if (r?.path) serverSaid(`${t("Saved.")} ${r.path}`)
  } catch (err) {
    serverSaid(why(err), true)
  }
}
const downloadFile = (path, name, version = null) => saved(() => invoke("file_save_as", { path, name, version, title: t("Download") }))
const downloadZip = (paths, name) => saved(() => invoke("files_zip_save", { paths, name: `${name || "files"}.zip`, title: t("Download as a zip") }))

/** What the server says of several things at once (`POST /files/batch`), as the explorer takes it. */
const batched = (r) => ({ done: Number(r?.done) || 0, failed: (r?.results || []).filter((x) => !x.ok).map((x) => ({ path: x.path, error: x.error || "" })) })

function showVersions(e) {
  const path = e.path
  return versionsDialog({
    name: e.name,
    api: {
      list: () => get(`/files/versions?path=${enc(path)}`),
      restore: (version) => post("/files/versions/restore", { path, version }),
      download: (version) => invoke("file_save_as", { path, name: e.name, version, title: t("Download") }),
    },
    changed: () => reloadServer(parentOf(path)),
  })
}

function showTrash() {
  return trashDialog({
    api: {
      list: () => get("/files/trash"),
      restore: (id) => post("/files/restore", { id }),
      remove: (id) => del(`/files/trash?id=${enc(id)}`),
      empty: () => del("/files/trash"),
    },
    changed: () => server?.refresh(),
  })
}

let firstListing = true

/** The server's tree, as an explorer's (and a folder dialog's) place. */
export function serverSource() {
  return {
    key: "server",
    place: "server",
    file: (e, reload) => serverFile(e.path, e.name, e, reload),
    top: () => serverRoot,
    // The top is asked as `/`, which is what the server opens a person at.
    ask: (path) => (!path || path === serverRoot ? "/" : path),
    parent: parentOf,
    rootName: () => (serverRoot === "/" ? t("All files") : t("Home")),
    crumbs: (path) => {
      const out = [[serverRoot === "/" ? t("All files") : t("Home"), serverRoot]]
      const rest = path.startsWith(serverRoot) ? path.slice(serverRoot.length) : path
      let at = serverRoot
      for (const part of rest.split("/").filter(Boolean)) {
        at = `${at.replace(/\/$/, "")}/${part}`
        out.push([part, at])
      }
      return out
    },
    list: async (path) => {
      const r = await get(SERVER_FILES.list(path))
      if (!r || !Array.isArray(r.entries)) throw { detail: t("The server's answer could not be read.") }
      if (path === "/" && r.path && r.path !== serverRoot) {
        serverRoot = r.path
        // The top is known now: the tree and the crumbs start there.
        if (firstListing) queueMicrotask(() => server?.drawTree())
      }
      firstListing = false
      return r
    },
    preview: (e) => readServer(e.path),
    media: (e, kind) => invoke("media_open", { source: "server", kind, path: e.path }),
    open: (e) => openServerFile(e.path, e.name, e),
    ops: {
      mkdir: (dir, name) => post("/files/mkdir", { path: dir, name }),
      // `create`: the server makes a new, empty file and never writes over one -- a taken name
      // (a file's or a folder's) is its 409, said in its own sentence. Nothing is checked here
      // first: between a look and a write somebody else's file could have appeared.
      mkfile: async (dir, name) => {
        if (name.includes("/")) throw { detail: t("A file needs a name without a slash.") }
        return api("PUT", "/files/content", { path: `${dir.replace(/\/$/, "")}/${name}`, text: "", create: true })
      },
      rename: (e, name) => post("/files/rename", { path: e.path, name }),
      move: async (paths, to) => (paths.length === 1 ? (await post("/files/move", { path: paths[0], to }), { done: 1, failed: [] }) : batched(await post("/files/batch", { op: "move", paths, to }))),
      copy: async (paths, to) => {
        if (paths.length > 1) return batched(await post("/files/batch", { op: "copy", paths, to }))
        const r = await post("/files/copy", { path: paths[0], to })
        return { done: 1, failed: [], copied: r?.copied?.name || "" }
      },
      remove: async (paths) => (paths.length === 1 ? (await del(`/files?path=${enc(paths[0])}`), { done: 1, failed: [] }) : batched(await post("/files/batch", { op: "delete", paths }))),
    },
    dirItems: (e) => [{ label: t("Upload"), run: () => uploadInto(e.path) }, ...(e.kind === "mount" ? [] : [{ label: t("Download as a zip"), run: () => downloadZip([e.path], e.name) }])],
    fileItems: (e) => [
      { label: t("Download"), details: true, run: () => downloadFile(e.path, e.name) },
      { label: t("Versions"), run: () => showVersions(e) },
    ],
    // To this computer: into one of the agent's folders, chosen by walking to it.
    acrossItems: (e) =>
      isDir(e) || !local.root
        ? []
        : [
            {
              label: t("Copy to this computer…"),
              run: async () => {
                const root = local.root
                const dir = await pickFolder({ source: localSource(root), start: "", title: t("Copy to which folder?"), ok: t("Copy here") })
                if (dir === null || dir === undefined) return
                serverSaid("")
                try {
                  const at = await invoke("local_download", { root, dir, path: e.path, name: e.name })
                  serverSaid(t("Copied as %(name)s.", { name: baseName(at) }))
                  localPane?.changed(dir)
                } catch (err) {
                  serverSaid(why(err), true)
                }
              },
            },
          ],
    batchItems: (entries) => [{ label: t("Download as a zip"), run: () => downloadZip(entries.map((e) => e.path), entries.length === 1 ? entries[0].name : "") }],
  }
}

export function renderServer() {
  const els = { pane: $("pane-server"), crumbs: $("server-crumbs"), tree: $("server-tree"), list: $("server-list"), details: $("server-details"), status: $("server-status"), batch: $("server-batch") }
  els.status.hidden = true
  firstListing = true
  server = explorer(els, serverSource())
  server.drawTree()
  return server.go(serverRoot)
}

/**
 * A file in the server's tree, in the viewer: from the explorer (`entry`: its row, which says
 * its size and what it is) and from a chat's outputs. One the person may write is edited there.
 */
export async function openServerFile(path, name, entry) {
  return openViewer(await serverFile(path, name, entry, () => openServerFile(path, name, entry)))
}

/** A file in the server's tree as the viewer takes it: read now; `reload` shows it read again. */
export async function serverFile(path, name, entry, reload) {
  const where = t("Server")
  try {
    const f = await readServer(path)
    // The server's own word for what it is (its table and the viewer's are the same one).
    const kind = fileKind(f.name || name, f.file_kind || f.kind || entry?.file_kind)
    const at = f.path || path
    const save = async (text, { base, force }) => {
      const body = { path: at, text }
      if (force) body.force = true
      else if (base) body.base = base
      return api("PUT", "/files/content", body)
    }
    return {
      name: f.name || name,
      path: at,
      where,
      text: f.text,
      kind,
      language: f.language || undefined,
      mime: f.mime || entry?.mime || "",
      withheld: f.withheld,
      size: f.size,
      sha: f.sha,
      // What is inside an archive, where the server lists it (2.0.0-beta.17).
      archive: f.archive,
      media: () => invoke("media_open", { source: "server", kind, path: at }),
      sealed: { source: "server", path: at },
      download: () => downloadFile(at, f.name || name),
      // Only where the server says the person may write it (a server before that says nothing).
      save: f.writable === true && !f.withheld ? save : undefined,
      reload,
    }
  } catch (err) {
    return { name, path, where, error: why(err) }
  }
}

/**
 * Show a file of the server's tree where it is: its folder listed, the file chosen (a chat's
 * "Open in Files"). `node` is the file's id, where it has one (a generated file): the server is
 * asked where the file is now (`GET /files/node?id=`), so one renamed or moved since is found;
 * one in the trash, and one that is gone, are said. A server that has no such route (it answers
 * 404, as it does for an id that names nothing) is followed by the path the chat knew.
 */
export async function revealServerFile(path, node = "") {
  showFilesTab("server")
  let at = path
  if (node) {
    try {
      const now = await get(`/files/node?id=${enc(node)}`)
      if (now?.trashed === true) return serverSaid(t("This file is in the trash."), true), false
      if (typeof now?.path === "string" && now.path.startsWith("/")) at = now.path
    } catch (err) {
      if (err?.status !== 404) return serverSaid(why(err), true), false
    }
  }
  if (!server || !at || !at.startsWith("/")) return false
  serverSaid("")
  const found = await server.reveal(at).catch(() => false)
  if (!found) serverSaid(t("This file is no longer there."), true)
  return found
}

let tab = "local"
let serverRead = false

/** Show one of the two explorers: `local` (this computer) or `server`. The server's is read once. */
export function showFilesTab(which) {
  tab = which === "server" ? "server" : "local"
  for (const b of $("files-tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab))
  $("pane-local").hidden = tab !== "local"
  $("pane-server").hidden = tab !== "server"
  if (tab === "server" && !serverRead) {
    serverRead = true
    renderServer()
  }
}

/** Whether the server's files are what the window shows now: where dropped files are uploaded. */
const serverShown = () => !$("page-files").hidden && tab === "server" && !!server

export function initExplorer() {
  const tabBtn = (which, ico, label) =>
    h("button", { type: "button", role: "tab", class: "tabs__tab", dataset: { tab: which }, "aria-selected": String(which === tab), onclick: () => showFilesTab(which) }, icon(ico), h("span", { text: label }))
  $("files-tabs").replaceChildren(tabBtn("local", ICONS.folder, t("This computer")), tabBtn("server", ICONS.file, t("Server")))
  const tool = (id, ico, run) => {
    $(id).replaceChildren(icon(ico))
    $(id).addEventListener("click", run)
  }
  const here = () => server?.current() ?? serverRoot
  tool("server-refresh", ICONS.refresh, () => {
    serverSaid("")
    return server ? server.refresh() : renderServer()
  })
  tool("server-upload", ICONS.send, () => uploadInto(here()))
  tool("server-mkdir", ICONS.folder, () => server?.newIn(here(), true))
  tool("server-mkfile", ICONS.fileText, () => server?.newIn(here(), false))
  tool("server-trash", ICONS.trash, () => showTrash())
  tool("local-refresh", ICONS.refresh, () => (localPane ? localPane.refresh() : renderLocal()))
  tool("local-mkdir", ICONS.folder, () => localPane?.newIn(localPane.current(), true))
  tool("local-mkfile", ICONS.fileText, () => localPane?.newIn(localPane.current(), false))
  // Files dropped on the window while the server's files show are uploaded: into the folder
  // they were dropped on, where that is one, else into the folder listed. Rust holds the drop
  // and says where it landed; the page never names a path on this computer.
  let at = null
  listen("drop-at", (e) => {
    at = e.payload && typeof e.payload === "object" ? e.payload : null
  })
  listen("drag", (e) => {
    $("pane-server").dataset.drag = String(!!e.payload && serverShown())
  })
  listen("drop", () => {
    $("pane-server").dataset.drag = "false"
    if (!serverShown()) return
    const dir = server.folderAt(Number(at?.x), Number(at?.y))
    at = null
    uploadInto(dir, true)
  })
}
