// What a chat may use: the web's chat-settings switches, from a chat's menu. The tool families
// the server offers this chat now (web search among them) and the skills, each on or off for this
// chat only, and the commands it was told to stop asking about.
//
//   GET  /chats/{chat}/scope              -> { scope: { families: [{ gate, label, on }], skills: [{ name, description, on }], allow: [entry] } }
//   POST /chats/{chat}/scope              { kind: "family"|"skill", name, on } -> { scope }
//   POST /chats/{chat}/allow/clear        -> { scope }
//
// Narrowing only, on the server: switching on what the model, the permissions or the instance
// left out reaches nothing. Labels, skill names and descriptions are set as text.

import { h } from "./dom.js"
import { get, post, why } from "./bridge.js"
import { popover } from "./popup.js"

/** The switches of `chat`, in a popover under `anchor`. */
export async function scopePopover(anchor, chat) {
  const path = `/chats/${encodeURIComponent(chat.id)}`
  let scope = null
  let error = ""
  let busy = false
  const pop = popover(anchor, () => draw(), { align: "end", label: t("Tools") })

  // Drawn again after each answer: the switch that was used keeps the focus.
  const redraw = (key) => {
    pop.redraw()
    if (key) document.querySelector(`.scope [data-key="${CSS.escape(key)}"]`)?.focus()
  }
  const send = async (url, body) => {
    const key = document.activeElement?.dataset?.key || ""
    busy = true
    redraw(key)
    try {
      scope = (await post(url, body))?.scope || scope
      error = ""
    } catch (err) {
      error = why(err)
    }
    busy = false
    redraw(key)
  }

  const toggle = (kind, name, label, on) =>
    h(
      "label",
      { class: "check scope__row", title: label.title || null },
      h("input", { type: "checkbox", checked: on, disabled: busy, dataset: { key: `${kind}:${name}` }, onchange: (e) => send(`${path}/scope`, { kind, name, on: e.target.checked }) }),
      h("span", { text: label.text }),
    )

  function draw() {
    const body = h("div", { class: "pop__body scope" })
    if (!scope) {
      body.append(error ? h("p", { class: "status is-error", role: "alert", text: error }) : h("p", { class: "muted", text: t("Loading…") }))
      return body
    }
    const families = scope.families || []
    const skills = scope.skills || []
    const allow = scope.allow || []
    if (families.length || skills.length) body.append(h("p", { class: "muted scope__hint", text: t("Switched off here only. What is on to begin with is your default for this model, in Settings → Models.") }))
    if (families.length) {
      body.append(
        h("p", { class: "pop__title", text: t("Tools") }),
        h("div", { class: "scope__list" }, families.map((f) => toggle("family", f.gate, { text: f.label || f.gate }, !!f.on))),
      )
    }
    if (skills.length) {
      body.append(
        h("p", { class: "pop__title", text: t("Skills") }),
        h("div", { class: "scope__list" }, skills.map((s) => toggle("skill", s.name, { text: s.name, title: s.description || "" }, !!s.on))),
      )
    }
    if (allow.length) {
      body.append(
        h("p", { class: "pop__title", text: t("Always allowed here") }),
        h("ul", { class: "scope__allow" }, allow.map((a) => h("li", {}, h("code", { text: a })))),
        h("div", { class: "pop__actions" }, h("button", { type: "button", class: "btn btn--sm", disabled: busy, text: t("Ask me about these again"), onclick: () => send(`${path}/allow/clear`, {}) })),
      )
    }
    if (!families.length && !skills.length && !allow.length) body.append(h("p", { class: "muted", text: t("Nothing to switch in this chat.") }))
    if (error) body.append(h("p", { class: "status is-error", role: "alert", text: error }))
    return body
  }

  try {
    scope = (await get(`${path}/scope`))?.scope || { families: [], skills: [], allow: [] }
  } catch (err) {
    error = why(err)
  }
  pop.redraw()
}
