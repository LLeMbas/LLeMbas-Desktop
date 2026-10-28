// Before the app: which server, and the app's sign-in to it. A server older than LLeMbas 2.0 is
// refused here, with the reason Rust gave (src-tauri/src/server.rs, `check`). Signing in is the
// server's device login: the approval page opens in the system's browser; this page shows the
// code to compare and waits.

import { $, h, clear } from "./dom.js"
import { invoke, listen, why } from "./bridge.js"

let code = null // the code being approved, while signing in
let failed = ""

export function renderSetup(s) {
  const box = clear($("setup-body"))
  $("setup-version").textContent = s.version
  const server = h("section", { "aria-labelledby": "setup-server-h" }, h("h2", { id: "setup-server-h", text: t("Server") }))
  const address = h("input", {
    id: "address",
    name: "address",
    type: "text",
    inputmode: "url",
    autocomplete: "url",
    placeholder: "https://ai.example",
    spellcheck: "false",
    value: s.server || "",
  })
  const hint = h("p", { class: "hint", id: "server-hint", "aria-live": "polite" })
  if (!s.checked) hint.textContent = t("Looking for a LLeMbas server there…")
  else if (s.refused) {
    hint.textContent = s.refused
    hint.classList.add("is-error")
  } else if (s.discovery) hint.textContent = t("%(name)s, LLeMbas %(version)s.", { name: s.discovery.name, version: s.discovery.version })
  else hint.textContent = t("LLeMbas Desktop needs a LLeMbas 2.0 server or later.")
  const connect = h("button", { type: "submit", class: "btn btn--primary", text: t("Connect") })
  const form = h(
    "form",
    { class: "field", novalidate: true },
    h("label", { for: "address", text: t("Address of your LLeMbas server") }),
    h("div", { class: "row" }, address, connect),
    hint,
  )
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    connect.disabled = true
    hint.className = "hint"
    hint.textContent = t("Looking for a LLeMbas server there…")
    try {
      await invoke("set_server", { address: address.value })
    } catch (err) {
      hint.className = "hint is-error"
      hint.textContent = why(err)
    } finally {
      connect.disabled = false
    }
  })
  server.append(form)
  if (s.refused && s.server) {
    server.append(h("div", { class: "row--buttons" }, h("button", { type: "button", class: "btn", text: t("Try again"), onclick: () => invoke("recheck_server") })))
  }
  box.append(server)

  if (s.discovery && !s.account) {
    const sign = h("section", { "aria-labelledby": "setup-sign-h" }, h("h2", { id: "setup-sign-h", text: t("Sign in") }))
    sign.append(h("p", { class: "muted", text: t("The app signs in to your server once, in your browser, as any device does. It may then read and write your chats, as the web interface does.") }))
    if (s.signing_in && code) {
      sign.append(
        h("p", null, t("Approve this code in the page that opened in your browser:")),
        h("p", { class: "code", text: code.user_code }),
        h(
          "div",
          { class: "row--buttons" },
          h("button", { type: "button", class: "btn", text: t("Open the page again"), onclick: () => invoke("open_external", { url: code.verification_uri_complete }) }),
          h("button", { type: "button", class: "btn", text: t("Cancel"), onclick: () => invoke("sign_in_cancel") }),
        ),
      )
    } else {
      sign.append(
        h(
          "div",
          { class: "row--buttons" },
          h("button", {
            type: "button",
            class: "btn btn--primary",
            text: s.signing_in ? t("Waiting for the browser…") : t("Sign in"),
            disabled: s.signing_in,
            onclick: () => {
              failed = ""
              invoke("sign_in").catch((err) => {
                failed = why(err)
                renderSetup(s)
              })
            },
          }),
        ),
      )
    }
    if (failed) sign.append(h("p", { class: "status is-error", text: failed }))
    box.append(sign)
  }
}

export function initSetup(current) {
  listen("signin", (e) => {
    const p = e.payload
    if (p.state === "code") code = p.code
    if (p.state === "done") code = null
    if (p.state === "failed") {
      code = null
      failed = p.message
    }
    renderSetup(current())
  })
}
