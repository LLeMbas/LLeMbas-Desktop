// The command palette (Ctrl+K): one line to type into, and what matches -- the app's commands,
// the chats of both kinds by title, newest first, and below them what the server's search finds
// inside them, in the file library and in memory (`GET /search`, once two letters are typed and
// the typing pauses). Up and Down move, Enter does it, Escape closes. The chats are asked of the
// server each time it opens, so a chat started elsewhere is there.
//
// A hit's snippet is plain text with the ranges that matched (`marks`): drawn as text, the
// ranges as <mark> elements. Titles and snippets may be a model's words; nothing is markup.

import { h, clear, icon, ICONS, when } from "./dom.js"
import { get } from "./bridge.js"

let ctx = null // { commands(): [{ label, hint?, run }], open(chat), openFile(path, name), openMemory(id) }
let dlg = null

/** Lower case, without diacritics: "Príliš" is found by "prilis". */
function fold(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
}

/** `text` with the `[start, end)` ranges of `marks` as <mark> elements: text nodes only. */
function marked(text, marks) {
  const el = h("span", { class: "palette__snippet" })
  let at = 0
  const chars = [...String(text || "")]
  for (const [a, b] of (marks || []).filter((m) => Array.isArray(m) && m[1] > m[0]).sort((x, y) => x[0] - y[0])) {
    if (a < at) continue
    el.append(chars.slice(at, a).join(""), h("mark", { text: chars.slice(a, b).join("") }))
    at = b
  }
  el.append(chars.slice(at).join(""))
  return el
}

const SEARCH_KIND = { chats: () => t("Chats"), files: () => t("Files"), memories: () => t("Memory") }

function matches(text, words) {
  const f = fold(text)
  return words.every((w) => f.includes(w))
}

export async function openPalette() {
  if (dlg) return
  const input = h("input", { type: "text", class: "palette__input", placeholder: t("Type a command or a chat's title"), "aria-label": t("Search"), role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list", autocomplete: "off" })
  const list = h("ul", { class: "palette__list", id: "palette-list", role: "listbox" })
  dlg = h("dialog", { class: "dialog palette", "aria-label": t("Commands") }, h("div", { class: "palette__line" }, icon(ICONS.search), input), list)
  document.body.append(dlg)
  let chats = []
  let shown = []
  let at = 0
  let found = [] // the server's hits for `asked`
  let asked = ""
  let timer = 0
  const close = () => {
    clearTimeout(timer)
    if (!dlg) return
    dlg.close()
    dlg.remove()
    dlg = null
  }
  const choose = (item) => {
    close()
    item?.run()
  }
  const draw = () => {
    const words = fold(input.value).split(/\s+/).filter(Boolean)
    const commands = ctx.commands().filter((c) => matches(c.label, words))
    const titled = chats.filter((c) => matches(c.title || t("New chat"), words)).slice(0, 30)
    shown = [
      ...commands.map((c) => ({ kind: "command", label: c.label, hint: c.hint || "", run: c.run })),
      ...titled.map((c) => ({
        kind: c.kind,
        label: c.title || t("New chat"),
        hint: `${c.kind === "agent" ? t("Agent") : t("Chats")} · ${when(c.updated_at)}`,
        run: () => ctx.open(c),
      })),
    ]
    // What the server found inside: the chats already listed by their title once only.
    const listed = new Set(titled.map((c) => c.id))
    for (const group of input.value.trim() === asked ? found : []) {
      for (const hit of group.hits || []) {
        if (hit.kind === "chat" && listed.has(hit.id)) continue
        const kind = { chat: "found-chat", file: "found-file", memory: "found-memory" }[hit.kind]
        if (!kind) continue
        shown.push({
          kind,
          label: hit.title || (hit.kind === "chat" ? t("New chat") : hit.kind === "file" ? String(hit.path || "").split("/").pop() : t("Memory")),
          snippet: hit.snippet ? marked(hit.snippet, hit.marks) : null,
          hint: SEARCH_KIND[group.kind]?.() || "",
          run: () => (hit.kind === "chat" ? ctx.open({ id: hit.id, kind: hit.agent ? "agent" : "chat" }) : hit.kind === "file" ? ctx.openFile(hit.path, hit.title) : ctx.openMemory(hit.id)),
        })
      }
    }
    at = Math.min(at, Math.max(0, shown.length - 1))
    clear(list)
    if (!shown.length) list.append(h("li", { class: "palette__none", text: t("Nothing matches.") }))
    shown.forEach((item, i) => {
      list.append(
        h(
          "li",
          {
            id: `palette-${i}`,
            role: "option",
            class: "palette__item",
            "aria-selected": String(i === at),
            onclick: () => choose(item),
            onpointermove: () => {
              if (at !== i) {
                at = i
                mark()
              }
            },
          },
          h("span", { class: "palette__icon" }, icon(item.kind === "command" ? ICONS.chevron : item.kind === "found-memory" ? ICONS.bulb : item.kind.startsWith("found") ? ICONS.search : item.kind === "agent" ? ICONS.folder : ICONS.file)),
          item.snippet
            ? h("span", { class: "palette__label palette__label--two" }, h("span", { class: "palette__title", text: item.label }), item.snippet)
            : h("span", { class: "palette__label", text: item.label }),
          h("span", { class: "palette__hint", text: item.hint }),
        ),
      )
    })
    mark()
  }
  const mark = () => {
    list.querySelectorAll(".palette__item").forEach((el, i) => el.setAttribute("aria-selected", String(i === at)))
    input.setAttribute("aria-activedescendant", shown.length ? `palette-${at}` : "")
    list.querySelector(`#palette-${at}`)?.scrollIntoView({ block: "nearest" })
  }
  // The server's search, once the typing pauses: an older server without it finds nothing more.
  const search = () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) {
      found = []
      asked = ""
      return
    }
    timer = setTimeout(async () => {
      try {
        const r = await get(`/search?q=${encodeURIComponent(q)}&in=all&limit=8`)
        if (!dlg || input.value.trim() !== q) return
        found = r.results || []
        asked = q
        draw()
      } catch {}
    }, 250)
  }
  input.addEventListener("input", () => {
    at = 0
    draw()
    search()
  })
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!shown.length) return
      at = (at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length
      mark()
    } else if (e.key === "Enter") {
      e.preventDefault()
      choose(shown[at])
    }
  })
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault()
    close()
  })
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close()
  })
  dlg.showModal()
  input.focus()
  draw()
  try {
    const r = await get("/chats?limit=100")
    chats = (r.chats || []).filter((c) => !c.archived && !c.temporary)
    if (dlg) draw()
  } catch {}
}

export function initPalette(context) {
  ctx = context
}
