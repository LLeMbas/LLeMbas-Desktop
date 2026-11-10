// Draw a picture: the instance's own image generation (`POST /v1/images/generations`, its
// workflow and default checkpoint), from Ctrl+K. Offered only where `GET /me` says the account may
// (`services.images`) and the token holds `models`.
//
// The pictures are shown only as Rust read them: each one of the person's own files on this
// server (`/v1/files/<id>/content`, fetched by id from the app's own server, never from an
// address the answer named), handed over as a `data:` URL of an image type -- checked again here
// before it becomes an <img>.

import { h, icon, ICONS } from "./dom.js"
import { invoke, why } from "./bridge.js"

const PICTURE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** Whether pictures can be drawn here, for the account `me` (`GET /me`). */
export function canDraw(me) {
  const models = !Array.isArray(me?.scopes) || me.scopes.includes("models")
  return !!me?.services?.images && models && me?.permissions?.["tools.image"] !== false
}

/** The dialog: a prompt, a shape, Draw, and the pictures under it. */
export function openDraw() {
  const prompt = h("textarea", { class: "textarea draw__prompt", rows: "3", placeholder: t("What to draw…"), "aria-label": t("What to draw…") })
  const size = h(
    "select",
    { class: "draw__size", "aria-label": t("Shape") },
    h("option", { value: "1024x1024", text: t("Square") }),
    h("option", { value: "1344x768", text: t("Wide") }),
    h("option", { value: "768x1344", text: t("Tall") }),
  )
  const status = h("p", { class: "status", role: "status", hidden: true })
  const out = h("div", { class: "draw__out" })
  const go = h("button", { type: "submit", class: "btn btn--primary", text: t("Draw") })
  const form = h(
    "form",
    { class: "dialog__body draw", method: "dialog" },
    h("h2", { class: "dialog__title" }, icon(ICONS.picture), h("span", { text: t("Draw a picture") })),
    prompt,
    h("div", { class: "draw__bar" }, size, h("button", { type: "button", class: "btn", text: t("Close"), onclick: () => close() }), go),
    status,
    out,
  )
  const dlg = h("dialog", { class: "dialog dialog--wide" }, form)
  let asked = 0
  const close = () => {
    asked++
    dlg.close()
    dlg.remove()
  }
  const said = (text, error = false) => {
    status.hidden = !text
    status.textContent = text
    status.className = `status${error ? " is-error" : ""}`
    status.setAttribute("role", error ? "alert" : "status")
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    const words = prompt.value.trim()
    if (!words) return prompt.focus()
    const mine = ++asked
    go.disabled = true
    said(t("Drawing… a picture can take a minute or two."))
    try {
      const urls = await invoke("draw", { prompt: words, size: size.value })
      if (mine !== asked) return
      const pictures = (urls || []).filter((u) => PICTURE.test(u))
      if (!pictures.length) throw { detail: t("The server's answer had no picture in it.") }
      out.prepend(...pictures.map((src) => h("figure", { class: "draw__pic" }, h("img", { src, alt: words }), h("figcaption", { text: words }))))
      said("")
    } catch (err) {
      if (mine === asked) said(why(err), true)
    } finally {
      if (mine === asked) go.disabled = false
    }
  })
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit()
  })
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault()
    close()
  })
  document.body.append(dlg)
  dlg.showModal()
  prompt.focus()
}
