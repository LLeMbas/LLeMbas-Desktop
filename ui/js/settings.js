// Settings: the app's, not the server's (no admin page here, ever -- an admin sees what everyone
// sees). The server and the app's sign-in, the agent and the folders it may work in, the
// notifications, and this release.

import { $, h, clear } from "./dom.js"
import { invoke, listen, why } from "./bridge.js"

const AGENT = {
  off: () => [t("The agent is off."), ""],
  not_linked: () => [t("This computer is not linked to the server yet."), ""],
  starting: () => [t("The agent is starting…"), ""],
  running: () => [t("The agent is running: agent chats can use this computer."), "is-ok"],
  elsewhere: (pid) => [t("A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.", { pid }), "is-ok"],
  failed: (why) => [t("The agent stopped: %(why)s. Trying again shortly.", { why }), "is-error"],
}

let folderError = ""
let linking = null // { user_code, uri } while the computer is being linked
let linkError = ""

export function agentWords(s) {
  const noFolders = s.remote && !(s.remote.enabled && s.remote.roots.length)
  if (s.agent.state === "running" && noFolders) return [t("The agent is connected, but may open no folder yet: add one below."), "is-error"]
  return (AGENT[s.agent.state] ?? AGENT.off)(s.agent.detail)
}

function section(id, title, ...body) {
  return h("section", { class: "set", "aria-labelledby": id }, h("h2", { id, text: title }), body)
}

export function renderSettings(s) {
  const box = clear($("settings-body"))
  // The server and the account.
  const who = s.account ? [s.account.name, s.account.email].filter(Boolean).join(" · ") : ""
  box.append(
    section(
      "set-server",
      t("Server"),
      h("p", null, h("bdi", { text: s.server || "" }), s.discovery ? h("span", { class: "muted", text: ` · LLeMbas ${s.discovery.version}` }) : null),
      who ? h("p", { class: "muted", text: t("Signed in as %(who)s.", { who }) }) : null,
      h("p", { class: "muted", text: t("Signing out gives the app's sign-in up on the server; the agent's link stays. Sign out to use another server.") }),
      h("div", { class: "row--buttons" }, h("button", { type: "button", class: "btn", text: t("Sign out"), onclick: () => invoke("sign_out") })),
    ),
  )

  // The agent.
  const [text, cls] = agentWords(s)
  const agent = section(
    "set-agent",
    t("Agent"),
    h("p", { class: "muted", text: t("The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.") }),
    h("p", { class: `status ${cls}`, "aria-live": "polite", text }),
  )
  if (linking) {
    agent.append(h("p", null, t("Approve this code in the page that opened in your browser:")), h("p", { class: "code", text: linking.user_code }))
  }
  if (linkError) agent.append(h("p", { class: "status is-error", text: linkError }))
  agent.append(
    h(
      "div",
      { class: "row--buttons" },
      h("button", {
        type: "button",
        class: "btn",
        text: s.linked ? t("Link again") : t("Link this computer"),
        onclick: () => {
          linkError = ""
          invoke("link_computer").catch((err) => {
            linkError = why(err)
            renderSettings(s)
          })
        },
      }),
      h("button", {
        type: "button",
        class: "btn",
        text: s.agent_wanted ? t("Stop the agent") : t("Start the agent"),
        disabled: !s.linked && !s.agent_wanted,
        onclick: () => invoke("set_agent", { on: !s.agent_wanted }),
      }),
    ),
  )
  box.append(agent)

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
          h("span", { class: "path", title: dir }, h("bdi", { text: dir })),
          h("button", { type: "button", class: "btn", text: t("Remove"), "aria-label": t("Remove %(dir)s", { dir }), onclick: () => invoke("remote_remove", { dir }) }),
        ),
      )
    }
    const mode = h(
      "select",
      { id: "max-mode", onchange: (e) => invoke("remote_mode", { mode: e.target.value }) },
      [
        ["manual", t("Manual — asks first")],
        ["edit", t("Edit — asks before commands")],
        ["auto", t("Auto — asks nothing")],
        ["plan", t("Plan — changes nothing")],
      ].map(([v, label]) => h("option", { value: v, text: label, selected: r.max_mode === v })),
    )
    const terminal = h("input", { type: "checkbox", id: "terminal", checked: r.terminal, onchange: (e) => invoke("remote_terminal", { on: e.target.checked }) })
    box.append(
      section(
        "set-folders",
        t("Project folders"),
        h("p", { class: "muted", text: t("Agent chats can work in these folders and anything inside them — nowhere else on this computer.") }),
        list,
        folderError ? h("p", { class: "status is-error", text: folderError }) : null,
        h("div", { class: "row--buttons" }, h("button", { type: "button", class: "btn btn--primary", text: t("Add folder…"), onclick: () => invoke("remote_add") })),
        h(
          "div",
          { class: "fields" },
          h("div", { class: "field" }, h("label", { for: "max-mode", text: t("The most an agent chat may do here") }), mode, h("p", { class: "hint", text: t("A chat asking for more is lowered to this.") })),
          h(
            "div",
            { class: "field" },
            h("span", { class: "label", text: t("Terminal") }),
            h("label", { class: "check" }, terminal, h("span", { text: t("Let the server open a terminal here") })),
            h("p", { class: "hint", text: t("A shell as you, in one of these folders.") }),
          ),
        ),
      ),
    )
  }

  // Notifications.
  box.append(
    section(
      "set-notify",
      t("Notifications"),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: s.notify, onchange: (e) => invoke("set_notify", { on: e.target.checked }) }),
        h("span", { text: t("Tell me when a reply or an agent's work is finished while I am elsewhere") }),
      ),
    ),
  )

  // This release.
  box.append(
    section(
      "set-about",
      t("About"),
      h("p", null, `LLeMbas Desktop ${s.version}`),
      h(
        "div",
        { class: "row--buttons" },
        h("button", { type: "button", class: "btn", text: s.update ? t("Install LLeMbas %(version)s…", { version: s.update }) : t("Check for updates…"), onclick: () => invoke("update_app") }),
      ),
    ),
  )
}

export function initSettings(current) {
  listen("remote-error", (e) => {
    folderError = String(e.payload)
    renderSettings(current())
  })
  listen("status", () => {
    folderError = ""
  })
  listen("linking", (e) => {
    const p = e.payload
    linking = p.state === "code" ? { user_code: p.user_code, uri: p.uri } : null
    linkError = p.state === "failed" ? p.message : ""
    renderSettings(current())
  })
}
