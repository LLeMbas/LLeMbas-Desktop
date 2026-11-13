#!/usr/bin/env node
// Every class the page gives an element has a rule in the page's style sheets, or is on the
// list of the ones that are not meant to (scripts/class-hooks.txt, each with its reason).
//
// A class with no rule is how a row came to read "This computerworkbench": the script named two
// classes for a label and its hint, and no style sheet had heard of either. This finds those
// when they are written, not when somebody sees them.
//
// What is read: `class: "…"` and `class: `…`` in ui/js/*.js (dom.js's `h`), `class="…"` in
// ui/index.html, and classList.add/remove/toggle/contains("…"). In a template, a word that ends
// where a `${…}` begins (`call--${kind}`) is a prefix: some rule must start with it. Words in
// the strings inside a `${…}` (`${live ? " is-live" : ""}`) count when they look like a class
// (a hyphen or an underscore in them).
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const UI = join(ROOT, "ui")
const read = (...p) => readFileSync(join(...p), "utf8")

const css = [...readdirSync(UI).filter((f) => f.endsWith(".css")).map((f) => read(UI, f)), ...readdirSync(join(UI, "vendor")).filter((f) => f.endsWith(".css")).map((f) => read(UI, "vendor", f))].join("\n").replace(/\/\*[\s\S]*?\*\//g, "")
const styled = new Set([...css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]))

const allowed = new Map()
for (const line of read(ROOT, "scripts", "class-hooks.txt").split("\n")) {
  const m = /^(\S+)\s+(\S.*)$/.exec(line.trim())
  if (m && !line.startsWith("#")) allowed.set(m[1], m[2])
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
    const [head, ...rest] = word.split("\u0000")
    if (rest.length) {
      if (head) note(`${head}*`, where)
    } else if (NAME.test(head)) note(head, where)
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
}
const html = read(UI, "index.html")
for (const m of html.matchAll(/\bclass="([^"]*)"/g)) for (const word of m[1].split(/\s+/)) if (word) note(word, `ui/index.html:${html.slice(0, m.index).split("\n").length}`)

const missing = []
for (const [word, where] of used) {
  if (allowed.has(word)) continue
  const ok = word.endsWith("*") ? [...styled].some((c) => c.startsWith(word.slice(0, -1))) : styled.has(word)
  if (!ok) missing.push(`${where}  ${word}`)
}
const stale = [...allowed.keys()].filter((k) => !used.has(k))
for (const k of stale) console.error(`check-classes: scripts/class-hooks.txt lists ${k}, which the page no longer uses`)
if (missing.length) {
  console.error("check-classes: classes the page uses that no style sheet has a rule for (style them, or list them in scripts/class-hooks.txt with the reason):")
  for (const m of missing.sort()) console.error(`  ${m}`)
}
if (missing.length || stale.length) process.exit(1)
console.log(`check-classes: ${used.size} classes and prefixes, each styled or listed as a hook (${allowed.size})`)
