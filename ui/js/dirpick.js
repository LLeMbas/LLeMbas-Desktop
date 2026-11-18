// Choosing a folder on a linked computer: the server asks the computer for its directories
// (`GET /api/v2/devices/{id}/directories?path=`, the JSON twin of the web's directory dialog) and
// this dialog walks them. No path lists the computer's places; a row opens its directory; the
// directory stood in is what Use this directory chooses -- only where the computer would open a
// session there (`accepted`; its `reason` is said otherwise). Beside a folder, the model last
// used in it, where the computer remembers one.
//
// The path can always be typed instead, and the folders worked in before are offered: a computer
// that is away, too old to list, slow or unwilling (`code`, with the server's sentence) leaves
// exactly those two. Every name here comes from somebody else's disk: set as text.
//
// Keys: the rows are a list the arrows walk (Home and End its ends); Enter or → opens the row,
// ← or Backspace goes up a level; the list is one stop for Tab, the path the next, then the
// buttons; Escape closes, and the focus is back where it was.

import { h, icon, ICONS } from "./dom.js"
import { get, why } from "./bridge.js"

const enc = encodeURIComponent
// A directory with thousands in it: this many rows at a time, and a button for the next ones.
const ROWS = 200

/**
 * pickDirectory({ device, name, value, recent }) -> the chosen path, or null.
 * `device` the linked device's id, `name` what the person calls it, `value` the folder chosen so
 * far (the dialog opens there), `recent` the folders worked in before on that computer.
 */
export function pickDirectory({ device, name, value = "", recent = [] }) {
  return new Promise((resolve) => {
    const back = document.activeElement
    let here = "" // the directory the listing shows; "" for the computer's places
    let listing = null // the server's last answer, or null while there is none
    let asked = 0
    let showing = ROWS // how many of the listing's folders are drawn

    const where = h("bdi", { class: "dirs__path" })
    const model = h("p", { class: "hint dirs__model", hidden: true })
    const said = h("p", { class: "status is-error dirs__said", role: "alert", hidden: true })
    const list = h("ul", { class: "dirs__list", role: "list", "aria-label": t("Folder") })
    const typed = h("input", { type: "text", class: "dialog__input dirs__typed", spellcheck: "false", autocomplete: "off", "aria-label": t("Path"), placeholder: "/home/…", value })
    const use = h("button", { type: "submit", class: "btn btn--primary", id: "dirs-use", text: t("Use this directory") })
    const form = h(
      "form",
      { class: "dialog__body dirs", method: "dialog" },
      h("h2", { class: "dialog__title", id: "dirs-title", text: t("Folder on %(device)s", { device: name || t("Another device") }) }),
      h("p", { class: "dirs__where" }, icon(ICONS.folder), where),
      model,
      said,
      list,
      typed,
      h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", text: t("Cancel"), onclick: () => done(null) }), use),
    )
    const dlg = h("dialog", { class: "dialog", "aria-labelledby": "dirs-title" }, form)

    let settled = false
    const done = (path) => {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      back?.focus?.()
      resolve(path)
    }

    /** Whether what is in the path box may be chosen: the directory shown only where accepted. */
    const mayUse = () => {
      const path = typed.value.trim()
      if (!path) return false
      return !(listing && !listing.code && path === here && here && listing.accepted === false)
    }
    const drawUse = () => (use.disabled = !mayUse())

    /** One row: icon · name (and, for a place, its path) · a quieter word · chevron. Always all four. */
    const row = ({ path, label, under, hint, title, lead, cls = "" }) =>
      h(
        "li",
        null,
        h(
          "button",
          { type: "button", class: `dirs__row ${cls}`, title: title || path, dataset: { path }, onclick: () => load(path) },
          h("span", { class: "dirs__lead" }, icon(lead || ICONS.folder)),
          h("span", { class: "dirs__name" }, h("bdi", { class: "dirs__label", text: label }), under ? h("bdi", { class: "dirs__under", text: under }) : null),
          h("span", { class: "dirs__hint", text: hint || "" }),
          h("span", { class: "dirs__chev" }, icon(ICONS.chevron)),
        ),
      )

    const draw = (from) => {
      const l = listing
      const none = !l || !!l.code
      where.textContent = here || t("Places on this device")
      model.hidden = !(l && !none && l.model?.name && here)
      if (!model.hidden) model.textContent = t("Last used here: %(model)s. A new chat in this directory starts on it unless you choose another.", { model: l.model.name })
      // Why there is no listing, what the computer could not list, or why this directory is refused.
      const refused = l && !none && here && l.accepted === false
      const words = none ? l?.error || "" : l.error || (refused ? l.reason || t("The device will not open a session here.") : "")
      said.textContent = words
      said.hidden = !words
      const rows = []
      if (!none && here) rows.push(row({ path: l.parent || "", label: l.parent ? t("Up a level") : t("All places"), hint: "", title: l.parent || t("Places on this device"), lead: ICONS.back, cls: "dirs__row--up" }))
      if (!none) {
        const entries = Array.isArray(l.entries) ? l.entries.filter((e) => e && typeof e.path === "string" && e.path) : []
        for (const e of entries.slice(0, showing)) {
          rows.push(
            row({
              path: e.path,
              label: e.name || e.path,
              under: here ? "" : e.path,
              hint: e.accepted === false ? t("Not trusted on the device") : e.model?.name || "",
              title: e.accepted === false && e.reason ? `${e.path} — ${e.reason}` : e.path,
              cls: e.accepted === false ? "is-refused" : "",
            }),
          )
        }
        if (entries.length > showing) {
          rows.push(
            h(
              "li",
              null,
              h("button", {
                type: "button",
                class: "btn btn--sm dirs__more",
                text: t("Show %(n)s more", { n: Math.min(ROWS, entries.length - showing) }),
                title: String(entries.length),
                onclick: () => {
                  const at = showing
                  showing += ROWS
                  draw()
                  // On with the keys from where the list ended.
                  list.querySelectorAll(".dirs__row:not(.dirs__row--up):not(.dirs__row--recent)")[at]?.focus()
                },
              }),
            ),
          )
        }
        if (!entries.length) rows.push(h("li", { class: "muted dirs__empty", text: here ? t("No directories here.") : t("This device offers no directories: its remote roots are empty or missing.") }))
      }
      // The folders worked in before: beside the places, and all there is where nothing is listed.
      if ((none || !here) && recent.length) {
        rows.push(h("li", { class: "dirs__group", text: t("Recent") }))
        for (const r of recent) rows.push(row({ path: r, label: r.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || r, under: r, hint: "", lead: ICONS.clock, cls: "dirs__row--recent" }))
      }
      list.replaceChildren(...rows)
      list.removeAttribute("aria-busy")
      drawUse()
      // Where the focus goes: the folder just left when going up, else the first folder; with
      // nothing to walk, the path.
      const all = [...list.querySelectorAll(".dirs__row")]
      const isUp = (b) => b.classList.contains("dirs__row--up")
      const target = (from && all.find((b) => !isUp(b) && b.dataset.path === from)) || all.find((b) => !isUp(b)) || all[0]
      // One stop for Tab, whichever row the arrows are on; the next is the path.
      for (const b of all) b.tabIndex = b === target ? 0 : -1
      if (target) target.focus()
      else {
        typed.focus()
        typed.select()
      }
    }

    async function load(path) {
      const mine = ++asked
      const from = here
      // A folder worked in before, with nothing listed: it is the path, ready to be used.
      if (listing?.code) {
        typed.value = path
        drawUse()
        use.focus()
        return
      }
      list.setAttribute("aria-busy", "true")
      let r
      try {
        r = await get(`/devices/${enc(device)}/directories?path=${enc(path || "")}`)
      } catch (err) {
        r = { code: "refused", error: why(err), entries: [] }
      }
      if (mine !== asked || settled) return
      // Anything but an object is no answer: said so, never a list that loads for ever.
      if (!r || typeof r !== "object" || Array.isArray(r)) r = { code: "no_answer", error: "", entries: [] }
      // A directory that cannot be listed (the computer's words say why) leaves the listing that
      // was there; no listing at all leaves the typed path and the recent folders.
      if (r.code && listing && !listing.code && path) {
        list.removeAttribute("aria-busy")
        said.textContent = r.error || t("The device did not answer.")
        said.hidden = false
        return
      }
      // The folder chosen before cannot be listed now: the places, with that path still typed.
      if (r.code === "refused" && !listing && path) return load("")
      if (r.code && !r.error) r.error = t("The device did not answer.")
      const first = !listing
      listing = r
      showing = ROWS
      here = r.code ? "" : r.path || ""
      // The path box says where the listing is; what was typed stays where nothing is listed,
      // and when the dialog opens on the places.
      if (!r.code && (here || !first)) typed.value = here
      draw(from)
    }

    list.addEventListener("keydown", (e) => {
      const all = [...list.querySelectorAll(".dirs__row")]
      const i = all.indexOf(document.activeElement)
      const go = (n) => (e.preventDefault(), all[n]?.focus())
      if (e.key === "ArrowDown") go(Math.min(all.length - 1, i + 1))
      else if (e.key === "ArrowUp") go(Math.max(0, i - 1))
      else if (e.key === "Home") go(0)
      else if (e.key === "End") go(all.length - 1)
      else if (e.key === "ArrowRight" && i >= 0 && !all[i].classList.contains("dirs__row--up")) (e.preventDefault(), all[i].click())
      else if ((e.key === "ArrowLeft" || e.key === "Backspace") && here && listing && !listing.code) (e.preventDefault(), load(listing.parent || ""))
    })
    list.addEventListener("focusin", (e) => {
      if (!e.target.classList?.contains("dirs__row")) return
      for (const b of list.querySelectorAll(".dirs__row")) b.tabIndex = b === e.target ? 0 : -1
    })
    typed.addEventListener("input", drawUse)
    // Enter in the path box goes there where the computer lists; where it does not, it is the choice.
    typed.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return
      const path = typed.value.trim()
      if (!path || listing?.code || path === here) return
      e.preventDefault()
      load(path)
    })
    form.addEventListener("submit", (e) => {
      e.preventDefault()
      if (mayUse()) done(typed.value.trim())
    })
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault()
      done(null)
    })
    document.body.append(dlg)
    dlg.showModal()
    list.setAttribute("aria-busy", "true")
    list.append(h("li", { class: "muted dirs__empty", text: t("Loading…") }))
    use.disabled = !mayUse()
    load(value)
  })
}
