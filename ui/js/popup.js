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
  document.removeEventListener("keydown", escMenu, true)
  window.removeEventListener("resize", closeMenu)
  back?.focus?.()
}

function outside(e) {
  if (openMenu && !openMenu.el.contains(e.target)) closeMenu()
}

/** Escape closes the menu wherever the focus is (a menu whose items are all disabled holds none). */
function escMenu(e) {
  if (e.key !== "Escape" || !openMenu || openMenu.el.contains(e.target)) return
  e.preventDefault()
  e.stopPropagation()
  closeMenu()
}

/**
 * A row's hint. One that is a path is two parts -- where it is, and its last name -- so that
 * where it does not fit it is the middle that gives (`/srv/proj…/site`): a path cut at its end
 * says the part every path shares and loses the part that tells them apart.
 */
function hintOf(hint) {
  const text = String(hint)
  const path = /^(?:[~/]|[A-Za-z]:[\\/])/.test(text) && !/\s·\s/.test(text)
  const cut = path ? Math.max(text.replace(/[\\/]+$/, "").lastIndexOf("/"), text.replace(/[\\/]+$/, "").lastIndexOf("\\")) : -1
  if (cut <= 0) return h("span", { class: "menu__hint", title: path ? text : null, text })
  return h("span", { class: "menu__hint menu__hint--path", title: text }, h("span", { class: "menu__hint-head", text: text.slice(0, cut) }), h("span", { class: "menu__hint-tail", text: text.slice(cut) }))
}

/**
 * A menu of `items` ({ label, hint?, run, lead?, checked?, danger?, disabled? }, or null for a separator), under
 * `anchor` (an element) or at `{ x, y }` (page pixels). Arrow keys move, Enter chooses.
 */
export function menu(anchor, items) {
  closeMenu()
  closePopover()
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
        item.hint
          ? h("span", { class: "menu__label menu__label--two" }, h("span", { text: item.label }), hintOf(item.hint))
          : h("span", { class: "menu__label", text: item.label }),
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
    } else if (e.key === "Tab") {
      // Tab leaves the menu: it closes, and the focus is back on what opened it -- not somewhere
      // in the page with the menu still hanging open.
      e.preventDefault()
      closeMenu()
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault()
      all[e.key === "Home" ? 0 : all.length - 1]?.focus()
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
  const width = Math.ceil(r.width)
  el.style.width = `${width}px`
  el.style.left = `${Math.max(0, Math.min(at.left, window.innerWidth - width))}px`
  // Below the anchor where it fits, else above it (a chip under the message box opens upwards).
  // A control that sits at the foot of the window by design (`data-menu-up` on it or what holds
  // it: the bar above the composer) opens upward whenever there is room above.
  const up = anchor instanceof Element && !!anchor.closest("[data-menu-up]")
  const above = at.top !== undefined && at.top - r.height >= 0 && (up || at.bottom + r.height > window.innerHeight)
  el.style.top = above ? `${at.top - r.height}px` : `${Math.max(0, Math.min(at.bottom, window.innerHeight - r.height))}px`
  openMenu = { el, back: anchor instanceof Element ? anchor : document.activeElement }
  document.addEventListener("pointerdown", outside, true)
  document.addEventListener("keydown", escMenu, true)
  // Where it was placed is where its anchor was: a window that changes size closes it.
  window.addEventListener("resize", closeMenu)
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

/**
 * A modal dialog that shows a line to copy: `title`, `text`, the line itself (`code`, shown as
 * it is and selectable), and Copy beside Close. Resolves when it is closed.
 */
export function showLine({ title, text, code, copy, copied, close }) {
  return new Promise((resolve) => {
    const line = h("pre", { class: "dialog__code", tabindex: "0", text: code })
    const copyBtn = h("button", { type: "button", class: "btn btn--primary", text: copy })
    const closeBtn = h("button", { type: "button", class: "btn", text: close })
    const dlg = h(
      "dialog",
      { class: "dialog" },
      h("div", { class: "dialog__body" }, h("h2", { class: "dialog__title", text: title }), text ? h("p", { class: "muted", text }) : null, line, h("div", { class: "dialog__actions" }, closeBtn, copyBtn)),
    )
    const done = () => {
      dlg.close()
      dlg.remove()
      resolve()
    }
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        ?.writeText(code)
        .then(() => (copyBtn.textContent = copied))
        .catch(() => {
          // No clipboard: the line is selected, for Ctrl+C.
          const range = document.createRange()
          range.selectNodeContents(line)
          getSelection()?.removeAllRanges()
          getSelection()?.addRange(range)
        })
    })
    closeBtn.addEventListener("click", done)
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault()
      done()
    })
    document.body.append(dlg)
    dlg.showModal()
    copyBtn.focus()
  })
}

let openPop = null

/** Close the popover that is open, if any. */
export function closePopover() {
  if (!openPop) return
  const { el, back, onClose } = openPop
  openPop = null
  el.remove()
  document.removeEventListener("pointerdown", outsidePop, true)
  document.removeEventListener("keydown", escPop, true)
  onClose?.()
  back?.focus?.()
}

function outsidePop(e) {
  if (openPop && !openPop.el.contains(e.target) && !openPop.back?.contains?.(e.target)) closePopover()
}

function escPop(e) {
  if (e.key === "Escape" && openPop) {
    e.preventDefault()
    e.stopPropagation()
    closePopover()
  }
}

/**
 * A small panel under `anchor` (an element, or `{ x, y }` in page pixels as a context menu's
 * point; or above it, `up`), holding `content` (an element, or a function
 * that draws it and is called again by `redraw`). Escape and a click outside close it. Returns
 * { redraw, close }. `align`: "start" (the anchor's left edge) or "end" (its right edge).
 */
export function popover(anchor, content, { up = false, align = "start", label = "", onClose } = {}) {
  closePopover()
  closeMenu()
  const el = h("div", { class: "pop", role: "dialog", "aria-label": label || null })
  const draw = () => el.replaceChildren(typeof content === "function" ? content() : content)
  draw()
  document.body.append(el)
  const place = () => {
    const at = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y }
    const r = el.getBoundingClientRect()
    const left = align === "end" ? at.right - r.width : at.left
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - r.width - 8))}px`
    const top = up ? at.top - r.height - 6 : at.bottom + 6
    el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - r.height - 8))}px`
  }
  place()
  openPop = { el, back: anchor instanceof Element ? anchor : document.activeElement, onClose }
  document.addEventListener("pointerdown", outsidePop, true)
  document.addEventListener("keydown", escPop, true)
  el.querySelector("button, input, select")?.focus()
  return {
    redraw() {
      if (openPop?.el !== el) return
      draw()
      place()
    },
    close: closePopover,
  }
}

export function popoverOpen() {
  return !!openPop
}
