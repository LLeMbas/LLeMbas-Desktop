// Markdown, as a model writes it, to elements -- never to an HTML string. A reply is model
// output and untrusted: no raw HTML passes (it shows as the text it is), no image is fetched
// (an image is its link), and a link opens in the system's browser only when it is http, https
// or mail. What it does draw: headings, paragraphs, emphasis, strike-through, inline code, fenced
// code, block quotes, lists (nested), tables, rules, links and line breaks. A reply still being
// written renders the same way; an unclosed `*` is simply a star.

import { h } from "./dom.js"
import { openLink } from "./bridge.js"

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const SAFE_LINK = /^(https?:|mailto:)/i

/** The rendered fragment of `source`. */
export function markdown(source) {
  const out = document.createDocumentFragment()
  blocks(String(source ?? "").replace(/\r\n?/g, "\n").split("\n"), out)
  return out
}

function indentOf(line) {
  const m = /^\s*/.exec(line)
  return m ? m[0].replace(/\t/g, "    ").length : 0
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-"))
  )
}

function blocks(lines, parent) {
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1]
      const body = []
      i += 1
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // the closing fence (or the end)
      parent.append(codeBlock(body.join("\n"), fence[2]))
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      parent.append(h(`h${heading[1].length}`, null, inline(heading[2] || "")))
      i += 1
      continue
    }
    if (RULE.test(line)) {
      parent.append(h("hr"))
      i += 1
      continue
    }
    if (QUOTE.test(line)) {
      const inner = []
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        inner.push(lines[i].replace(QUOTE, ""))
        i += 1
      }
      const quote = h("blockquote")
      blocks(inner, quote)
      parent.append(quote)
      continue
    }
    if (ITEM.test(line)) {
      i = list(lines, i, parent)
      continue
    }
    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] || "") && (lines[i + 1] || "").includes("-")) {
      i = table(lines, i, parent)
      continue
    }
    const para = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i])
      i += 1
    }
    parent.append(h("p", null, inline(para.join("\n"))))
  }
}

function codeBlock(text, lang) {
  const code = h("code", { text })
  const copy = h("button", {
    type: "button",
    class: "md-copy",
    text: t("Copy"),
    onclick: () => navigator.clipboard?.writeText(text).catch(() => {}),
  })
  return h("div", { class: "md-code" }, lang ? h("span", { class: "md-lang", text: lang }) : null, copy, h("pre", null, code))
}

function list(lines, start, parent) {
  const first = ITEM.exec(lines[start])
  const base = indentOf(first[1])
  const ordered = /\d/.test(first[2])
  const el = h(ordered ? "ol" : "ul")
  if (ordered) {
    const n = parseInt(first[2], 10)
    if (n !== 1) el.setAttribute("start", String(n))
  }
  let i = start
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break
    const content = [m[3]]
    const width = indentOf(m[1]) + m[2].length + 1
    i += 1
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        // A blank line inside an item, when the item goes on indented after it.
        if (i + 1 < lines.length && indentOf(lines[i + 1]) > base && lines[i + 1].trim()) {
          content.push("")
          i += 1
          continue
        }
        break
      }
      const sub = ITEM.exec(l)
      if (sub && indentOf(sub[1]) <= base) break
      if (indentOf(l) <= base && startsBlock(l, lines[i + 1])) break
      content.push(l.slice(Math.min(width, indentOf(l))))
      i += 1
    }
    const li = h("li")
    const task = /^\[([ xX])\]\s+/.exec(content[0])
    if (task) {
      content[0] = content[0].slice(task[0].length)
      li.classList.add("md-task")
      li.append(h("input", { type: "checkbox", disabled: true, checked: task[1] !== " " }))
    }
    // A tight item is its text; one with blocks in it is blocks.
    if (content.length === 1 || !content.slice(1).some((c) => startsBlock(c) || !c.trim())) {
      li.append(...inline(content.join("\n")))
    } else blocks(content, li)
    el.append(li)
    while (i < lines.length && !lines[i].trim()) {
      const next = ITEM.exec(lines[i + 1] || "")
      if (next && indentOf(next[1]) === base) i += 1
      else break
    }
  }
  parent.append(el)
  return i
}

function cells(line) {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"))
}

function table(lines, start, parent) {
  const head = cells(lines[start])
  const aligns = cells(lines[start + 1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
  )
  let i = start + 2
  const rows = []
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(cells(lines[i]))
    i += 1
  }
  const cell = (tag, text, n) => {
    const c = h(tag, null, inline(text ?? ""))
    if (aligns[n]) c.dataset.align = aligns[n]
    return c
  }
  const tbl = h(
    "table",
    null,
    h("thead", null, h("tr", null, head.map((c, n) => cell("th", c, n)))),
    h("tbody", null, rows.map((r) => h("tr", null, head.map((_, n) => cell("td", r[n], n))))),
  )
  // A wide table scrolls by itself; the page does not.
  parent.append(h("div", { class: "md-table" }, tbl))
  return i
}

function link(label, url) {
  const safe = SAFE_LINK.test(url)
  const a = h("a", { href: safe ? url : null, title: url, class: safe ? null : "md-unsafe" }, label)
  if (safe) {
    a.addEventListener("click", (e) => {
      e.preventDefault()
      openLink(url)
    })
  }
  return a
}

/** The closing `mark` for an opening at `from`, or -1. */
function closing(text, mark, from) {
  let at = text.indexOf(mark, from)
  while (at !== -1) {
    const before = text[at - 1]
    if (at > from && before !== " " && before !== "\\") {
      if (mark !== "_" || !/\w/.test(text[at + 1] || "")) return at
    }
    at = text.indexOf(mark, at + 1)
  }
  return -1
}

/** Inline markdown to nodes. */
export function inline(text) {
  const out = []
  let plain = ""
  const flush = () => {
    if (plain) out.push(document.createTextNode(plain))
    plain = ""
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const rest = text.slice(i)
    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") {
        flush()
        out.push(h("br"))
        i += 2
        continue
      }
      if (/[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1])) {
        plain += text[i + 1]
        i += 2
        continue
      }
    }
    if (c === "`") {
      const run = /^`+/.exec(rest)[0]
      const end = text.indexOf(run, i + run.length)
      if (end !== -1) {
        flush()
        out.push(h("code", { text: text.slice(i + run.length, end).replace(/^ (.+) $/, "$1") }))
        i = end + run.length
        continue
      }
      plain += run
      i += run.length
      continue
    }
    const img = /^!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
    if (img) {
      flush()
      out.push(link(img[1] || img[2], img[2]))
      i += img[0].length
      continue
    }
    if (c === "[") {
      const m = /^\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (m) {
        flush()
        out.push(link(inline(m[1]), m[2]))
        i += m[0].length
        continue
      }
    }
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s>]+)>/i.exec(rest)
      if (m) {
        flush()
        out.push(link(m[1], m[1]))
        i += m[0].length
        continue
      }
    }
    if ((c === "h" || c === "H") && !/\w/.test(text[i - 1] || "")) {
      const m = /^https?:\/\/[^\s<]+/i.exec(rest)
      if (m) {
        let url = m[0]
        // Trailing punctuation belongs to the sentence, and an unmatched ")" to a parenthesis.
        while (/[.,;:!?'"]$/.test(url) || (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) {
          url = url.slice(0, -1)
        }
        flush()
        out.push(link(url, url))
        i += url.length
        continue
      }
    }
    const strong = rest.startsWith("**") ? "**" : rest.startsWith("__") && !/\w/.test(text[i - 1] || "") ? "__" : ""
    if (strong && text[i + 2] && text[i + 2] !== " ") {
      const end = closing(text, strong, i + 2)
      if (end !== -1) {
        flush()
        out.push(h("strong", null, inline(text.slice(i + 2, end))))
        i = end + 2
        continue
      }
    }
    if (rest.startsWith("~~") && text[i + 2] && text[i + 2] !== " ") {
      const end = closing(text, "~~", i + 2)
      if (end !== -1) {
        flush()
        out.push(h("del", null, inline(text.slice(i + 2, end))))
        i = end + 2
        continue
      }
    }
    if ((c === "*" || (c === "_" && !/\w/.test(text[i - 1] || ""))) && text[i + 1] && !/\s/.test(text[i + 1]) && text[i + 1] !== c) {
      const end = closing(text, c, i + 1)
      if (end !== -1) {
        flush()
        out.push(h("em", null, inline(text.slice(i + 1, end))))
        i = end + 1
        continue
      }
    }
    if (c === "\n") {
      if (plain.endsWith("  ")) {
        plain = plain.replace(/ +$/, "")
        flush()
        out.push(h("br"))
      } else plain += " "
      i += 1
      continue
    }
    plain += c
    i += 1
  }
  flush()
  return out
}
