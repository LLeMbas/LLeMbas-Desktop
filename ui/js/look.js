// The app's language and theme, as Settings chooses them.
//
// The language is the account's (`/me`'s `language`) unless Settings chose this computer's or
// another one; that choice is kept in this app (localStorage `lembas.language`), as the phone
// keeps its own. It is read once, as the page loads (ui/i18n.js): every sentence is drawn through
// `t()` as it is needed, so a new language opens the window again.
//
// The theme is the account's, changed with `PATCH /me` so the web interface and the phone follow
// it. A server whose `/me` lists no `themes` cannot be told: there the choice is kept in this app.

import { invoke, patch, letGoAll } from "./bridge.js"
import { terminalThemeChanged } from "./terminal.js"

const LOOKS = ["moria", "shire"] // the two looks tokens.css draws; any other theme draws as Moria
let me = null // /me, as last read

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

/** The app's code for a server's language (`pt_BR` -> `pt`), or "" for one the app lacks. */
function known(code) {
  const c = String(code || "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0]
  return Object.prototype.hasOwnProperty.call(LEMBAS_LANGS, c) ? c : ""
}

/** Whether the server takes the theme on `PATCH /me`: its `/me` lists the themes it offers. */
export function accountThemes() {
  return Array.isArray(me?.themes) && me.themes.length ? me.themes : null
}

/** The theme chosen in this app, where the server cannot be told ("" for the account's). */
export function localTheme() {
  const name = read("lembas.theme")
  return !accountThemes() && LOOKS.includes(name) ? name : ""
}

/** The account's theme, as the server says it. */
export function accountTheme() {
  return me?.theme || "moria"
}

/** The look the window is drawn in: `name` (the account's, or Rust's last), or the one kept here. */
export function applyTheme(name) {
  name = localTheme() || name
  if (!LOOKS.includes(name)) name = "moria"
  const root = document.documentElement
  root.dataset.theme = name
  root.dataset.base = name
  terminalThemeChanged()
  return name
}

function paint() {
  invoke("set_theme", { name: applyTheme(accountTheme()) })
}

/**
 * `/me` was read: drawn in the account's theme, and, where the language follows the account and
 * it is now another, the window opens again in it.
 */
export function noteMe(next) {
  me = next || null
  paint()
  if (!me || !me.language) return
  const account = known(me.language)
  const before = read("lembas.account-language")
  write("lembas.account-language", account)
  // Only once it is kept: where it cannot be, opening again would find it unknown again, and again.
  if (read("lembas.account-language") !== account) return
  if (LEMBAS_CHOICE === "" && account !== before && (account || LEMBAS_SYSTEM_LANG) !== LEMBAS_LANG) reopen()
}

/**
 * Choose a theme: the account's, through `PATCH /me` (rejects with the server's words); where the
 * server cannot be told, kept here ("" goes back to the account's).
 */
export async function chooseTheme(name) {
  if (accountThemes()) {
    const r = await patch("/me", { theme: name })
    me = r && r.theme ? r : { ...me, theme: name }
  } else write("lembas.theme", LOOKS.includes(name) ? name : "")
  paint()
}

/** Settings' language: "" the account's, "system" this computer's, or a code the app has. */
export function chosenLanguage() {
  return LEMBAS_CHOICE === "system" || known(LEMBAS_CHOICE) ? LEMBAS_CHOICE : ""
}

/** The account's language, as /me last said it ("" if the app lacks it or the server says none). */
export function accountLanguage() {
  return me?.language ? known(me.language) : ""
}

/** Choose the language; the window opens again in it. */
export function chooseLanguage(choice) {
  if (choice === chosenLanguage()) return
  write("lembas.language", choice === "system" || known(choice) ? choice : "")
  return reopen()
}

/** Open the window again: the replies followed and the shells open let go first. */
async function reopen() {
  await letGoAll()
  location.reload()
}
