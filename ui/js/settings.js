// Settings: the app's, not the server's (no admin page here, ever -- an admin sees what everyone
// sees). Grouped, with the groups listed beside them: the account (the server and the app's
// sign-in), the agent and the folders it may work in, the language and theme, notifications, and
// this release.

import { $, h, clear, icon, ICONS } from "./dom.js"
import { invoke, listen } from "./bridge.js"
import { agentBlock, onAgentChange, link } from "./agent.js"
import { chosenTheme, chooseTheme, accountTheme, chosenLanguage, chooseLanguage } from "./look.js"

let folderError = ""
let current = () => null

const SECTIONS = [
  ["account", ICONS.user, () => t("Account")],
  ["agent", ICONS.terminal, () => t("Agent")],
  ["folders", ICONS.folder, () => t("Project folders")],
  ["look", ICONS.contrast, () => t("Appearance")],
  ["notify", ICONS.bell, () => t("Notifications")],
  ["about", ICONS.info, () => t("About")],
]

/** Bring one group into view (the title bar's agent panel opens Settings at Agent). */
export function scrollToSection(id) {
  const el = $(`set-${id}`)
  if (!el) return
  el.scrollIntoView({ block: "start" })
  markNav(id)
  el.querySelector("button, select, input")?.focus({ preventScroll: true })
}

function markNav(id) {
  for (const b of $("settings-nav").querySelectorAll("button")) b.setAttribute("aria-current", String(b.dataset.id === id))
}

function section(id, title, ...body) {
  return h("section", { class: "set", id: `set-${id}`, "aria-labelledby": `set-${id}-h` }, h("h2", { class: "set__title", id: `set-${id}-h`, text: title }), h("div", { class: "set__card" }, body))
}

/** One line of a group: its words on the left (a label and a hint), its control on the right. */
function line(label, hint, control) {
  return h("div", { class: "set__line" }, h("div", { class: "set__words" }, h("p", { class: "set__label", text: label }), h("p", { class: "set__hint", text: hint || "" })), h("div", { class: "set__control" }, control))
}

export function renderSettings(s) {
  if (!s) return
  const nav = clear($("settings-nav"))
  for (const [id, ico, title] of SECTIONS) {
    if (id === "folders" && !(s.linked && s.remote)) continue
    nav.append(h("button", { type: "button", class: "navrow", dataset: { id }, onclick: () => scrollToSection(id) }, h("span", { class: "navrow__icon" }, icon(ico)), h("span", { text: title() })))
  }
  const box = clear($("settings-body"))
  const who = s.account ? [s.account.name, s.account.email].filter(Boolean).join(" · ") : ""
  box.append(
    section(
      "account",
      t("Account"),
      line(t("Server"), s.discovery ? `LLeMbas ${s.discovery.version}` : "", h("bdi", { class: "set__value", text: s.server || "" })),
      line(
        who ? t("Signed in as %(who)s.", { who }) : t("Sign in"),
        t("Signing out gives the app's sign-in up on the server; the agent's link stays. Sign out to use another server."),
        h("button", { type: "button", class: "btn btn--sm", text: t("Sign out"), onclick: () => invoke("sign_out") }),
      ),
    ),
  )

  // The agent: what it says, and the one thing to do about it; then start or stop, link again.
  box.append(
    section(
      "agent",
      t("Agent"),
      h("p", { class: "set__intro", text: t("The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.") }),
      agentBlock(s),
      h(
        "div",
        { class: "set__buttons" },
        h("button", { type: "button", class: "btn btn--sm", text: s.agent_wanted ? t("Stop the agent") : t("Start the agent"), disabled: !s.linked && !s.agent_wanted, onclick: () => invoke("set_agent", { on: !s.agent_wanted }) }),
        s.linked && s.agent.state !== "refused" ? h("button", { type: "button", class: "btn btn--sm", text: t("Link again"), title: t("Link it again to give the agent a new token."), onclick: () => link() }) : null,
      ),
    ),
  )

  // The folders.
  const r = s.remote
  if (s.linked && r) {
    const list = h("ul", { class: "folders" })
    if (!r.enabled || !r.roots.length) list.append(h("li", { class: "empty", text: t("No folder yet: the agent can open nothing. Add the folder of a project.") }))
    for (const dir of r.enabled ? r.roots : []) {
      list.append(
        h(
          "li",
          null,
          h("span", { class: "folders__icon" }, icon(ICONS.folder)),
          h("span", { class: "path", title: dir }, h("bdi", { text: dir })),
          h("button", { type: "button", class: "btn btn--sm", text: t("Remove"), "aria-label": t("Remove %(dir)s", { dir }), onclick: () => invoke("remote_remove", { dir }) }),
        ),
      )
    }
    const mode = h(
      "select",
      { id: "max-mode", "aria-label": t("The most an agent chat may do here"), onchange: (e) => invoke("remote_mode", { mode: e.target.value }) },
      [
        ["manual", t("Manual — asks first")],
        ["edit", t("Edit — asks before commands")],
        ["auto", t("Auto — asks nothing")],
        ["plan", t("Plan — changes nothing")],
      ].map(([v, label]) => h("option", { value: v, text: label, selected: r.max_mode === v })),
    )
    const terminal = h("input", { type: "checkbox", role: "switch", id: "terminal", checked: r.terminal, "aria-label": t("Let the server open a terminal here"), onchange: (e) => invoke("remote_terminal", { on: e.target.checked }) })
    box.append(
      section(
        "folders",
        t("Project folders"),
        h("p", { class: "set__intro", text: t("Agent chats can work in these folders and anything inside them — nowhere else on this computer.") }),
        list,
        folderError ? h("p", { class: "status is-error", text: folderError }) : null,
        h("div", { class: "set__buttons" }, h("button", { type: "button", class: "btn btn--sm btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") })),
        line(t("The most an agent chat may do here"), t("A chat asking for more is lowered to this."), mode),
        line(t("Let the server open a terminal here"), t("A shell as you, in one of these folders."), h("label", { class: "toggle" }, terminal)),
      ),
    )
  }

  box.append(lookSection())

  box.append(
    section(
      "notify",
      t("Notifications"),
      line(
        t("Tell me when a reply or an agent's work is finished while I am elsewhere"),
        t("Scheduled tasks tell you of a result, too, while the app runs."),
        h("label", { class: "toggle" }, h("input", { type: "checkbox", role: "switch", checked: s.notify, "aria-label": t("Notifications"), onchange: (e) => invoke("set_notify", { on: e.target.checked }) })),
      ),
    ),
  )

  box.append(
    section(
      "about",
      t("About"),
      line(
        `LLeMbas Desktop ${s.version}`,
        s.update ? t("LLeMbas %(version)s is available (this is %(current)s)", { version: s.update, current: s.version }) : "",
        h("button", { type: "button", class: "btn btn--sm", text: s.update ? t("Install LLeMbas %(version)s…", { version: s.update }) : t("Check for updates…"), onclick: () => invoke("update_app") }),
      ),
    ),
  )
}

/** The language and the theme: this app's choice over the system's language and the account's theme. */
function lookSection() {
  const named = (code) => LEMBAS_LANGS[code] || code
  const language = h(
    "select",
    { id: "set-language", "aria-label": t("Language"), onchange: (e) => chooseLanguage(e.target.value) },
    [["", t("This computer's (%(language)s)", { language: named(LEMBAS_SYSTEM_LANG) })], ...Object.keys(LEMBAS_LANGS).map((code) => [code, named(code)])].map(([v, label]) =>
      h("option", { value: v, text: label, selected: chosenLanguage() === v, lang: v || undefined }),
    ),
  )
  const label = (name) => `${name === "shire" ? "Shire" : "Moria"} — ${name === "shire" ? t("light") : t("dark")}`
  const theme = h(
    "select",
    { id: "set-theme", "aria-label": t("Theme"), onchange: (e) => chooseTheme(e.target.value) },
    [["", t("The account's (%(theme)s)", { theme: label(accountTheme()) })], ["moria", label("moria")], ["shire", label("shire")]].map(([v, text]) => h("option", { value: v, text, selected: chosenTheme() === v })),
  )
  return section(
    "look",
    t("Appearance"),
    line(t("Language"), `${t("The interface only. Models answer in the language you write to them in, whatever this says.")} ${t("Kept in this app on this computer. The window opens again in the language chosen.")}`, language),
    line(t("Theme"), t("Kept in this app on this computer; the account's theme stays as it is."), theme),
  )
}

export function initSettings(getStatus) {
  current = getStatus
  listen("remote-error", (e) => {
    folderError = String(e.payload)
    if (!$("settings").hidden) renderSettings(current())
  })
  listen("status", () => {
    folderError = ""
  })
  onAgentChange(() => {
    if (!$("settings").hidden) renderSettings(current())
  })
  $("settings-body").addEventListener("scroll", () => {
    // The group at the top is the one marked beside them.
    const top = $("settings-body").getBoundingClientRect().top
    let at = ""
    for (const sec of $("settings-body").querySelectorAll(".set")) if (sec.getBoundingClientRect().top - top < 64) at = sec.id.replace(/^set-/, "")
    if (at) markNav(at)
  })
}
