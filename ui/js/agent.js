// The agent on this computer as the person sees it: one sentence for its state, and the one thing
// to do about it -- link this computer, link it again, add a folder, start it. The same words in
// three places: the title bar's chip (its popover), above the composer of a new agent chat, and
// Settings. The state is the CLI's word for its link (src-tauri/src/agent.rs); "refused" is the
// server's word only, with the server's reason.

import { h, icon, ICONS } from "./dom.js"
import { invoke, listen, why } from "./bridge.js"

let linking = null // { user_code, uri } while a link waits for its approval
let linkError = ""
const watchers = new Set()

/** Linked and allowed into a folder: what an agent chat needs. */
export function agentReady(s) {
  const a = s?.agent || {}
  const linked = a.state === "running" || (a.state === "elsewhere" && a.detail?.linked)
  return linked && !!(s.remote?.enabled && s.remote.roots?.length)
}

/**
 * The agent's state for the page: `tone` (ok, busy, warn, off), the sentence, and `action`: what
 * the one button does ("link", "relink", "folder", "start" or null).
 */
export function agentState(s) {
  const a = s?.agent || { state: "off" }
  const why = typeof a.detail === "string" ? a.detail : ""
  const noFolders = s?.remote && !(s.remote.enabled && s.remote.roots?.length)
  switch (a.state) {
    case "not_linked":
      return { tone: "warn", action: "link", sentence: t("This computer is not linked yet."), more: t("Link it to your server, and agent chats can work in its folders.") }
    case "refused":
      return { tone: "warn", action: "relink", sentence: t("The server refused this computer's link: %(why)s", { why: why || "…" }), more: t("Link it again to give the agent a new token.") }
    case "starting":
      return { tone: "busy", action: null, sentence: t("The agent is starting…") }
    case "connecting":
      return { tone: "busy", action: null, sentence: t("The agent is connecting to the server…") }
    case "waiting":
      return { tone: "warn", action: null, sentence: t("The agent is not connected: %(why)s. It keeps trying.", { why: why || "…" }) }
    case "failed":
      return { tone: "warn", action: s.linked ? "start" : "link", sentence: t("The agent stopped: %(why)s. Trying again shortly.", { why: why || "…" }) }
    case "elsewhere": {
      const pid = a.detail?.pid
      if (!a.detail?.linked) return { tone: "warn", action: null, sentence: t("A LLeMbas CLI service already runs here (pid %(pid)s), but is not connected: %(why)s", { pid, why: a.detail?.why || "…" }) }
      if (noFolders) return { tone: "warn", action: "folder", sentence: t("The agent is connected, but may open no folder yet.") }
      return { tone: "ok", action: null, sentence: t("A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.", { pid }) }
    }
    case "running":
      if (noFolders) return { tone: "warn", action: "folder", sentence: t("The agent is connected, but may open no folder yet.") }
      return { tone: "ok", action: null, sentence: t("The agent is running: agent chats can use this computer.") }
    default:
      return { tone: "off", action: s?.linked ? "start" : "link", sentence: s?.linked ? t("The agent is off.") : t("This computer is not linked yet.") }
  }
}

/** Start linking this computer: the approval opens in the browser; the page hears `linking`. */
export function link() {
  linkError = ""
  changed()
  return invoke("link_computer").catch((err) => {
    linkError = why(err)
    changed()
  })
}

const LABELS = {
  link: () => t("Link this computer"),
  relink: () => t("Link again"),
  folder: () => t("Add folder…"),
  start: () => t("Start the agent"),
}

function run(action) {
  if (action === "link" || action === "relink") return link()
  if (action === "folder") return invoke("remote_add")
  if (action === "start") return invoke("set_agent", { on: true })
}

/**
 * The agent's state as a block: its sentence, a line more where there is one, and its button;
 * while a link waits for approval, the code to compare and Cancel instead. `compact` leaves the
 * second line out.
 */
export function agentBlock(s, { compact = false } = {}) {
  const st = agentState(s)
  const el = h("div", { class: `agentbox is-${st.tone}`, role: "status", "aria-live": "polite" })
  el.append(h("span", { class: "agentbox__dot", "aria-hidden": "true" }), h("p", { class: "agentbox__text", text: st.sentence }))
  if (!compact && st.more) el.append(h("p", { class: "agentbox__more", text: st.more }))
  if (linking) {
    el.append(
      h("p", { class: "agentbox__more", text: t("Approve this code in the page that opened in your browser:") }),
      h("p", { class: "code agentbox__code", text: linking.user_code }),
      h(
        "div",
        { class: "agentbox__actions" },
        h("button", { type: "button", class: "btn btn--sm", text: t("Open the page again"), onclick: () => invoke("open_external", { url: linking.uri }).catch(() => {}) }),
        h("button", { type: "button", class: "btn btn--sm", text: t("Cancel"), onclick: () => invoke("link_cancel") }),
      ),
    )
  } else if (st.action) {
    el.append(
      h(
        "div",
        { class: "agentbox__actions" },
        h("button", { type: "button", class: `btn btn--sm ${st.tone === "warn" || st.tone === "off" ? "btn--primary" : ""}`, onclick: () => run(st.action) }, st.action === "link" || st.action === "relink" ? icon(ICONS.link) : null, LABELS[st.action]()),
      ),
    )
  }
  if (linkError) el.append(h("p", { class: "agentbox__error", text: linkError }))
  return el
}

/** Something that shows `agentBlock` and draws it again when linking moves on. */
export function onAgentChange(fn) {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

function changed() {
  for (const fn of watchers) fn()
}

export function linkingNow() {
  return linking
}

export function initAgent() {
  listen("linking", (e) => {
    const p = e.payload
    linking = p.state === "code" ? { user_code: p.user_code, uri: p.uri } : null
    linkError = p.state === "failed" ? p.message : ""
    changed()
  })
}
