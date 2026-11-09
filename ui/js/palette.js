// The command palette (Ctrl+K): one line to type into, and what matches -- the app's commands,
// and the chats of both kinds by title, newest first. Up and Down move, Enter does it, Escape
// closes. The chats are asked of the server each time it opens, so a chat started elsewhere
// is there.

import { h, clear, icon, ICONS, when } from "./dom.js"
import { get } from "./bridge.js"

let ctx = null // { commands(): [{ label, hint?, run }], open(id) }
let dlg = null

/** Lower case, without diacritics: "Príliš" is found by "prilis". */
function fold(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
}

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
  const close = () => {
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
    const found = chats.filter((c) => matches(c.title || t("New chat"), words)).slice(0, 30)
    shown = [
      ...commands.map((c) => ({ kind: "command", label: c.label, hint: c.hint || "", run: c.run })),
      ...found.map((c) => ({
        kind: c.kind,
        label: c.title || t("New chat"),
        hint: `${c.kind === "agent" ? t("Agent") : t("Chats")} · ${when(c.updated_at)}`,
        run: () => ctx.open(c),
      })),
    ]
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
          h("span", { class: "palette__icon" }, icon(item.kind === "command" ? ICONS.chevron : item.kind === "agent" ? ICONS.folder : ICONS.file)),
          h("span", { class: "palette__label", text: item.label }),
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
  input.addEventListener("input", () => {
    at = 0
    draw()
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
