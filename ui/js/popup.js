// Things that open over the page: a menu under a button (or at the pointer), and a small modal
// dialog that asks for a line of text or a yes. Built from elements, text as text; Escape and a
// click outside close them; the focus goes back where it came from.

import { h } from "./dom.js"

let openMenu = null

/** Close the menu that is open, if any. */
export function closeMenu() {
  if (!openMenu) return
  const { el, back } = openMenu
  openMenu = null
  el.remove()
  document.removeEventListener("pointerdown", outside, true)
  back?.focus?.()
}

function outside(e) {
  if (openMenu && !openMenu.el.contains(e.target)) closeMenu()
}

/**
 * A menu of `items` ({ label, run, lead?, checked?, danger?, disabled? }, or null for a separator), under
 * `anchor` (an element) or at `{ x, y }` (page pixels). Arrow keys move, Enter chooses.
 */
export function menu(anchor, items) {
  closeMenu()
  const plain = !items.some((i) => i?.lead)
  const el = h("div", { class: `menu${plain ? " menu--plain" : ""}`, role: "menu" })
  for (const item of items) {
    if (!item) {
      el.append(h("div", { class: "menu__sep", role: "separator" }))
      continue
    }
    // Every item the same three tracks -- a lead (an avatar), the label, a check -- so the
    // labels line up whether or not an item has a lead.
    el.append(
      h(
        "button",
        {
          type: "button",
          role: item.checked === undefined ? "menuitem" : "menuitemradio",
          "aria-checked": item.checked === undefined ? null : String(!!item.checked),
          class: `menu__item${item.danger ? " is-danger" : ""}`,
          disabled: !!item.disabled,
          onclick: () => {
            closeMenu()
            item.run()
          },
        },
        h("span", { class: "menu__lead" }, item.lead || null),
        h("span", { class: "menu__label", text: item.label }),
        h("span", { class: "menu__check", "aria-hidden": "true", text: item.checked ? "✓" : "" }),
      ),
    )
  }
  el.addEventListener("keydown", (e) => {
    const all = [...el.querySelectorAll(".menu__item:not(:disabled)")]
    const i = all.indexOf(document.activeElement)
    if (e.key === "Escape") {
      e.preventDefault()
      closeMenu()
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      all[(i + 1) % all.length]?.focus()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      all[(i - 1 + all.length) % all.length]?.focus()
    }
  })
  document.body.append(el)
  // Placed inside the window: under the anchor's bottom-left, moved in where it would overflow.
  const at = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y }
  const r = el.getBoundingClientRect()
  // Its width as measured at the left edge, kept: moved right, it would shrink to fit instead.
  el.style.width = `${Math.ceil(r.width)}px`
  el.style.left = `${Math.max(0, Math.min(at.left, window.innerWidth - r.width))}px`
  el.style.top = `${Math.max(0, Math.min(at.bottom, window.innerHeight - r.height))}px`
  openMenu = { el, back: anchor instanceof Element ? anchor : document.activeElement }
  document.addEventListener("pointerdown", outside, true)
  el.querySelector(".menu__item:not(:disabled)")?.focus()
}

/**
 * A modal dialog: `title`, an optional `text`, an optional line to edit (`value` given), and two
 * buttons. Resolves with the line (or true) on OK, null on cancel.
 */
export function ask({ title, text, value, ok, cancel, danger }) {
  return new Promise((resolve) => {
    const input = value === undefined ? null : h("input", { type: "text", class: "dialog__input", value, "aria-label": title })
    const okBtn = h("button", { type: "submit", class: `btn ${danger ? "btn--danger" : "btn--primary"}`, text: ok })
    const form = h(
      "form",
      { class: "dialog__body", method: "dialog" },
      h("h2", { class: "dialog__title", text: title }),
      text ? h("p", { class: "muted", text }) : null,
      input,
      h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", text: cancel, onclick: () => done(null) }), okBtn),
    )
    const dlg = h("dialog", { class: "dialog" }, form)
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      resolve(v)
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault()
      if (input && !input.value.trim()) return input.focus()
      done(input ? input.value.trim() : true)
    })
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault()
      done(null)
    })
    document.body.append(dlg)
    dlg.showModal()
    if (input) {
      input.focus()
      input.select()
    } else okBtn.focus()
  })
}
