// The app's language and theme, as chosen in Settings: kept in this app (localStorage), over the
// system's language and the account's theme. The account's own language and theme are the
// server's to change (`PATCH /me` has neither yet), so a choice here stays on this computer.
//
// The language is read once, as the page loads (ui/i18n.js, `lembas.language`): every sentence is
// drawn through `t()` as it is needed, so a new one opens the window again. The theme is applied
// at once.

import { invoke, letGoAll } from "./bridge.js"
import { terminalThemeChanged } from "./terminal.js"

const THEMES = ["moria", "shire"]
let account = "moria" // the account's theme, as /me says (a custom one counts as Moria)

function read(key) {
  try {
    return localStorage.getItem(key) || ""
  } catch {
    return ""
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {}
}

/** The theme chosen in this app ("" for the account's). */
export function chosenTheme() {
  const name = read("lembas.theme")
  return THEMES.includes(name) ? name : ""
}

/** The account's theme, as the server says it. */
export function accountTheme() {
  return account
}

/** The look the window is drawn in: the one chosen here, else `name` (the account's, or Rust's last). */
export function applyTheme(name) {
  name = chosenTheme() || name
  if (!THEMES.includes(name)) name = "moria"
  const root = document.documentElement
  root.dataset.theme = name
  root.dataset.base = name
  terminalThemeChanged()
  return name
}

/** The account's theme is known (from /me): drawn in it, unless one is chosen here. */
export function noteAccountTheme(name) {
  account = THEMES.includes(name) ? name : "moria"
  invoke("set_theme", { name: applyTheme(account) })
}

/** Choose a theme here ("" goes back to the account's): drawn at once, and the window painted in it. */
export function chooseTheme(name) {
  write("lembas.theme", THEMES.includes(name) ? name : "")
  invoke("set_theme", { name: applyTheme(account) })
}

/** The language chosen in this app ("" for the system's). */
export function chosenLanguage() {
  return typeof LEMBAS_CHOSEN_LANG === "string" ? LEMBAS_CHOSEN_LANG : ""
}

/** Choose a language here ("" goes back to the system's): the window opens again in it. */
export async function chooseLanguage(code) {
  if (code === chosenLanguage()) return
  write("lembas.language", code && Object.prototype.hasOwnProperty.call(LEMBAS_LANGS, code) ? code : "")
  // The replies followed and the shells open are let go first: the page that opens again has
  // no handle on them.
  await letGoAll()
  location.reload()
}
