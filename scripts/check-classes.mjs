#!/usr/bin/env node
// Every class the page gives an element has a rule in the page's style sheets, or is on the
// list of the ones that are not meant to (scripts/class-hooks.txt, each with its reason).
//
// A class with no rule is how a row came to read "This computerworkbench": the script named two
// classes for a label and its hint, and no style sheet had heard of either. This finds those
// when they are written, not when somebody sees them.
//
// What is read: `class: "…"` and `class: `…`` in ui/js/*.js (dom.js's `h`), `class="…"` in
// ui/index.html, classList.add/remove/toggle/contains("…"), and -- because a class is as often
// handed to a helper as written beside `class:` (`chip({ cls: "cchip--pages" })`, `btn(label,
// run, "btn--primary")`, `const cls = … ? "is-add" : "is-del"`) -- every string in the scripts
// that reads as class names and nothing else: each word a name with `__`, `--` or a leading
// `is-`/`has-` in it. Words in the strings inside a template's `${…}` count the same way.
//
// In a template, a word that ends where a `${…}` begins is one of two things. Where the word is
// a class by itself (it has a rule, or is a listed hook: `row${unread ? " is-unread" : ""}`),
// what follows adds another class to it. Otherwise it is a prefix
// (`call--${kind}`, `is-${state}`) and the classes it makes are not in the script at all: the
// hooks file must say them -- `prefix*  value|value|…  reason` -- and each one made is then
// held like any class: it has a rule, or the line says the family is a hook (`hook: …`).
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const UI = join(ROOT, "ui")
const read = (...p) => readFileSync(join(...p), "utf8")

const css = [...readdirSync(UI).filter((f) => f.endsWith(".css")).map((f) => read(UI, f)), ...readdirSync(join(UI, "vendor")).filter((f) => f.endsWith(".css")).map((f) => read(UI, "vendor", f))].join("\n").replace(/\/\*[\s\S]*?\*\//g, "")
const styled = new Set([...css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]))

const allowed = new Map() // a class -> why it has no rule
const families = new Map() // a prefix (ending in "*") -> { values, hook, reason }
for (const line of read(ROOT, "scripts", "class-hooks.txt").split("\n")) {
  if (line.startsWith("#")) continue
  const m = /^(\S+)\s+(\S.*)$/.exec(line.trim())
  if (!m) continue
  if (!m[1].endsWith("*")) {
    allowed.set(m[1], m[2])
    continue
  }
  const f = /^(\S+)\s+(\S.*)$/.exec(m[2])
  families.set(m[1], { values: f ? f[1].split("|").filter(Boolean) : [], hook: !!f && f[2].startsWith("hook:"), reason: f ? f[2] : "" })
}

const NAME = /^-?[A-Za-z_][\w-]*$/
const used = new Map() // class or prefix (ending in "-") -> where first seen
const note = (word, where) => {
  if (!used.has(word)) used.set(word, where)
}

function fromValue(value, where) {
  // The template's own words, and prefixes that an expression completes.
  const outside = value.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "\u0000")
  for (const word of outside.split(/\s+/)) {
    if (!word) continue
    const at = word.indexOf("\u0000")
    if (at < 0) {
      if (NAME.test(word)) note(word, where)
      continue
    }
    const head = word.slice(0, at)
    if (!head) continue
    // What follows the word: only ever another class (its strings empty or beginning with a
    // space), or the rest of this one's name.
    if (NAME.test(head) && (styled.has(head) || allowed.has(head))) note(head, where)
    else note(`${head}*`, where)
  }
  // The strings inside its expressions.
  for (const expr of value.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    for (const text of expr[1].matchAll(/"([^"]*)"|'([^']*)'/g)) {
      for (const word of (text[1] ?? text[2]).split(/\s+/)) if (NAME.test(word) && /[-_]/.test(word)) note(word, where)
    }
  }
}

for (const file of readdirSync(join(UI, "js")).filter((f) => f.endsWith(".js"))) {
  const src = read(UI, "js", file)
  const line = (index) => `ui/js/${file}:${src.slice(0, index).split("\n").length}`
  for (const m of src.matchAll(/\bclass(?:Name)?\s*[:=]\s*(?:"([^"]*)"|`((?:[^`\\]|\\.)*)`)/g)) fromValue(m[1] ?? m[2], line(m.index))
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*"([^"]+)"/g)) note(m[1], line(m.index))
  // Any string that is class names and nothing else, wherever it is handed on.
  const CLASSY = /^(?:[a-z][a-z0-9]*(?:__[a-z0-9-]+)?(?:--[a-z0-9_-]+)?|(?:is|has)-[a-z0-9-]+)$/
  for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
    const words = (m[1] ?? m[2]).trim().split(/\s+/).filter(Boolean)
    if (!words.length || !words.every((w) => CLASSY.test(w)) || !words.some((w) => /__|--|^(?:is|has)-/.test(w))) continue
    for (const word of words) note(word, line(m.index))
  }
  for (const m of src.matchAll(/\bcls\s*[:=]\s*`((?:[^`\\]|\\.)*)`/g)) fromValue(m[1], line(m.index))
}
const html = read(UI, "index.html")
for (const m of html.matchAll(/\bclass="([^"]*)"/g)) for (const word of m[1].split(/\s+/)) if (word) note(word, `ui/index.html:${html.slice(0, m.index).split("\n").length}`)

const missing = []
for (const [word, where] of used) {
  if (!word.endsWith("*")) {
    if (!allowed.has(word) && !styled.has(word)) missing.push(`${where}  ${word}`)
    continue
  }
  // A prefix: the classes it makes are the hooks file's to say, and each is held like any other.
  const family = families.get(word)
  if (!family || !family.values.length) {
    missing.push(`${where}  ${word}  (a prefix: say the classes it makes in scripts/class-hooks.txt: ${word}  value|value  reason)`)
    continue
  }
  if (family.hook) continue
  for (const value of family.values) {
    const made = word.slice(0, -1) + value
    if (!styled.has(made) && !allowed.has(made)) missing.push(`${where}  ${made}  (made by ${word})`)
  }
}
// A listed hook the page no longer uses (by itself, or as one a prefix makes) is taken off the list.
const made = new Set([...families].flatMap(([prefix, f]) => (used.has(prefix) ? f.values.map((v) => prefix.slice(0, -1) + v) : [])))
const stale = [...allowed.keys(), ...families.keys()].filter((k) => !used.has(k) && !made.has(k))
for (const k of stale) console.error(`check-classes: scripts/class-hooks.txt lists ${k}, which the page no longer uses`)
if (missing.length) {
  console.error("check-classes: classes the page uses that no style sheet has a rule for (style them, or list them in scripts/class-hooks.txt with the reason):")
  for (const m of missing.sort()) console.error(`  ${m}`)
}
if (missing.length || stale.length) process.exit(1)
console.log(`check-classes: ${used.size} classes and prefixes, each styled or listed as a hook (${allowed.size + families.size})`)
