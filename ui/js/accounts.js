// Multiple accounts and instances: quick switching (from the title bar or command palette) and
// adding another account/instance in a modal dialog without disturbing the active session until
// the browser approval completes.

import { h, clear, icon, ICONS } from "./dom.js"
import { invoke, listen, why } from "./bridge.js"
import { menu } from "./popup.js"
import { mayLeave } from "./viewer.js"

let dialogEl = null
let addCode = null
let addError = ""
let addBusy = false
let addDiscovery = null
let addAddress = ""
let getStatus = () => null

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url || ""
  }
}

/** Normalised list of saved accounts (falls back to the single active account in minimal mocks). */
export function accountList(s) {
  if (Array.isArray(s?.accounts) && s.accounts.length) return s.accounts
  if (!s?.account || !s?.server) return []
  return [
    {
      id: `${s.account.email || ""}@${s.server}`,
      server: s.server,
      instance_name: s.discovery?.name || "",
      email: s.account.email || "",
      name: s.account.name || "",
      active: true,
      default: true,
      agent_linked: !!s.linked,
    },
  ]
}

/** Switch to another saved account, guarding any unsaved viewer edits first (workspace tabs shelf per account). */
export async function switchAccount(id) {
  if (!(await mayLeave())) return false
  await invoke("switch_account", { id })
  return true
}

/** Open a quick-switcher menu anchored to `anchor` (the title bar host or a command button). */
export function openAccountSwitcher(anchor, s, openSettings) {
  const list = accountList(s)
  const items = list.map((a) => {
    const label = a.instance_name || hostOf(a.server) || a.server
    const parts = [a.email || a.name, hostOf(a.server)]
    if (a.default) parts.push(t("Default"))
    return {
      label,
      hint: parts.filter(Boolean).join(" · "),
      checked: !!a.active,
      run: () => {
        if (!a.active) switchAccount(a.id).catch(() => {})
      },
    }
  })
  if (items.length) items.push(null)
  items.push(
    {
      label: t("Add account or instance…"),
      lead: icon(ICONS.plus),
      run: () => openAddAccount(),
    },
    {
      label: t("Manage accounts…"),
      lead: icon(ICONS.gear),
      run: () => openSettings("account"),
    },
  )
  menu(anchor, items)
}

function closeAddDialog() {
  if (!dialogEl) return
  if (addBusy) invoke("add_sign_in_cancel").catch(() => {})
  addBusy = false
  addCode = null
  addError = ""
  addDiscovery = null
  const el = dialogEl
  dialogEl = null
  el.close()
  el.remove()
}

function redrawDialog() {
  if (!dialogEl) return
  const s = getStatus()
  const knownServers = [...new Set(accountList(s).map((a) => a.server).filter(Boolean))]
  const body = clear(dialogEl.querySelector(".dialog__body"))
  body.append(
    h("h2", { class: "dialog__title", text: t("Add account or instance") }),
    h("p", { class: "muted", text: t("Sign in to another LLeMbas 2.0 server, or another account on one you already use.") }),
  )

  if (knownServers.length && !addBusy) {
    body.append(
      h(
        "div",
        { class: "acc__known" },
        knownServers.map((url) =>
          h("button", {
            type: "button",
            class: "btn btn--sm",
            text: hostOf(url),
            title: url,
            onclick: () => {
              addAddress = url
              addDiscovery = null
              addError = ""
              redrawDialog()
            },
          }),
        ),
      ),
    )
  }

  const input = h("input", {
    type: "text",
    class: "dialog__input",
    id: "add-account-address",
    inputmode: "url",
    placeholder: "https://ai.example",
    spellcheck: "false",
    value: addAddress,
    disabled: addBusy,
    "aria-label": t("Address of your LLeMbas server"),
    oninput: (e) => {
      addAddress = e.target.value
      addDiscovery = null
    },
  })
  const probeBtn = h("button", {
    type: "submit",
    class: "btn btn--primary",
    text: t("Connect"),
    disabled: addBusy,
  })
  const form = h("form", { class: "row", novalidate: true }, input, probeBtn)
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!addAddress.trim() || addBusy) return
    addError = ""
    probeBtn.disabled = true
    try {
      addDiscovery = await invoke("probe_server", { address: addAddress })
      addAddress = addDiscovery.base || addAddress
    } catch (err) {
      addDiscovery = null
      addError = why(err)
    } finally {
      probeBtn.disabled = false
      redrawDialog()
    }
  })
  body.append(form)

  if (addDiscovery) {
    body.append(
      h("p", {
        class: "hint",
        text: t("%(name)s, LLeMbas %(version)s.", { name: addDiscovery.name, version: addDiscovery.version }),
      }),
    )
  }

  if (addBusy && addCode) {
    body.append(
      h("p", { text: t("Approve this code in the page that opened in your browser:") }),
      h("p", { class: "code", text: addCode.user_code }),
      h(
        "div",
        { class: "row--buttons" },
        h("button", {
          type: "button",
          class: "btn btn--sm",
          text: t("Open the page again"),
          onclick: () => invoke("open_external", { url: addCode.verification_uri_complete }).catch(() => {}),
        }),
      ),
    )
  }

  if (addError) body.append(h("p", { class: "status is-error", text: addError }))

  const actions = h("div", { class: "dialog__actions" })
  actions.append(h("button", { type: "button", class: "btn", text: t("Cancel"), onclick: closeAddDialog }))
  if (addDiscovery && !addCode) {
    actions.append(
      h("button", {
        type: "button",
        class: "btn btn--primary",
        text: addBusy ? t("Waiting for the browser…") : t("Sign in"),
        disabled: addBusy,
        onclick: () => {
          addBusy = true
          addError = ""
          redrawDialog()
          invoke("add_sign_in", { address: addDiscovery.base || addAddress }).catch((err) => {
            addBusy = false
            addError = why(err)
            redrawDialog()
          })
        },
      }),
    )
  }
  body.append(actions)
}

/** Open the modal dialog to add another account or server instance. */
export function openAddAccount(prefill = "") {
  closeAddDialog()
  addAddress = prefill || ""
  addDiscovery = null
  addCode = null
  addError = ""
  addBusy = false
  dialogEl = h("dialog", { class: "dialog", id: "add-account-dialog" }, h("div", { class: "dialog__body" }))
  dialogEl.addEventListener("cancel", (e) => {
    e.preventDefault()
    closeAddDialog()
  })
  dialogEl.addEventListener("click", (e) => {
    if (e.target === dialogEl) closeAddDialog()
  })
  document.body.append(dialogEl)
  redrawDialog()
  dialogEl.showModal()
  dialogEl.querySelector("#add-account-address")?.focus()
}

export function initAccounts(statusFn) {
  getStatus = statusFn
  listen("add-signin", (e) => {
    const p = e.payload
    if (!dialogEl) return
    if (p.state === "code") {
      addCode = p.code
      redrawDialog()
    } else if (p.state === "done") {
      addBusy = false
      closeAddDialog()
    } else if (p.state === "failed") {
      addBusy = false
      addCode = null
      addError = p.message || ""
      redrawDialog()
    }
  })
}
