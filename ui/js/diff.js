// What changed between two texts, by line: for a selection the model rewrote (accepted or
// rejected piece by piece before anything is put into the file) and for an edit the agent asks
// to make. Every line of either text is drawn as text; nothing here reads a line as anything else.

import { h } from "./dom.js"

/** The most lines compared line by line; past it the two texts are one piece, replaced whole. */
export const DIFF_LINES = 4000
/** The most pairs of lines weighed against each other (the table's size). */
const DIFF_CELLS = 4_000_000
/** The lines kept around a change, so it is seen where it stands. */
const CONTEXT = 2

/** A text's lines; a line break at its end closes the last line and makes no empty one. */
export function linesOf(text) {
  const s = String(text ?? "")
  if (s === "") return []
  const lines = s.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * The steps from `a` to `b` (arrays of lines): [{ op: "same" | "del" | "add", line }], in order.
 * The longest common run of lines is kept; what is beside it is taken out and put in.
 */
export function lineDiff(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--
  const head = a.slice(0, start).map((line) => ({ op: "same", line }))
  const tail = a.slice(endA).map((line) => ({ op: "same", line }))
  const [x, y] = [a.slice(start, endA), b.slice(start, endB)]
  let mid
  if (x.length * y.length > DIFF_CELLS || x.length > DIFF_LINES || y.length > DIFF_LINES) {
    mid = [...x.map((line) => ({ op: "del", line })), ...y.map((line) => ({ op: "add", line }))]
  } else {
    // The lengths of the longest common run from each pair of places on (a table, filled from the end).
    const w = y.length + 1
    const t = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    mid = []
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) mid.push({ op: "same", line: x[i] }), i++, j++
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) mid.push({ op: "del", line: x[i++] })
      else mid.push({ op: "add", line: y[j++] })
    }
    while (i < x.length) mid.push({ op: "del", line: x[i++] })
    while (j < y.length) mid.push({ op: "add", line: y[j++] })
  }
  return [...head, ...mid, ...tail]
}

/**
 * The changes between two texts, each a piece that can be taken or left by itself:
 * [{ at, del: [lines], add: [lines], before: [lines], after: [lines] }] -- `at` the line of the
 * old text (from 0) the piece begins at, `before` and `after` a few unchanged lines around it.
 */
export function hunksOf(oldText, newText) {
  const steps = lineDiff(linesOf(oldText), linesOf(newText))
  const out = []
  let line = 0
  let open = null
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k]
    if (s.op === "same") {
      open = null
      line++
      continue
    }
    if (!open) {
      const before = []
      for (let b = k - 1; b >= 0 && before.length < CONTEXT && steps[b].op === "same"; b--) before.unshift(steps[b].line)
      open = { at: line, del: [], add: [], before, after: [] }
      out.push(open)
    }
    if (s.op === "del") open.del.push(s.line), line++
    else open.add.push(s.line)
    // The unchanged lines after the piece, once it is known where it ends.
    if (steps[k + 1]?.op === "same" || k === steps.length - 1) for (let n = k + 1; n < steps.length && open.after.length < CONTEXT && steps[n].op === "same"; n++) open.after.push(steps[n].line)
  }
  return out
}

/**
 * The old text with only the pieces `taken` (a Set of indexes into `hunks`) put in: what the
 * file holds once the person has said which changes they want.
 */
export function applyHunks(oldText, hunks, taken) {
  const old = String(oldText ?? "")
  const lines = linesOf(old)
  const out = []
  let line = 0
  hunks.forEach((hunk, i) => {
    while (line < hunk.at) out.push(lines[line++])
    if (taken.has(i)) out.push(...hunk.add)
    else out.push(...hunk.del)
    line += hunk.del.length
  })
  while (line < lines.length) out.push(lines[line++])
  const ended = old.endsWith("\n") || (old === "" && out.length > 0)
  return out.join("\n") + (ended && out.length ? "\n" : "")
}

/** The sign of a line that stays: a space that keeps its room, so an empty line is still a line. */
const SAME = "\u00a0"

/** One piece drawn: the lines around it, what goes (-) and what comes (+), each line its own row of three tracks. */
export function hunkBlock(hunk) {
  const row = (cls, sign, text) => h("div", { class: `dline ${cls}` }, h("span", { class: "dline__sign", "aria-hidden": "true", text: sign }), h("span", { class: "dline__text", text }))
  return h(
    "div",
    { class: "dhunk__lines", role: "group" },
    hunk.before.map((l) => row("is-same", SAME, l)),
    hunk.del.map((l) => row("is-del", "−", l)),
    hunk.add.map((l) => row("is-add", "+", l)),
    hunk.after.map((l) => row("is-same", SAME, l)),
  )
}

/** How many lines a set of pieces takes out and puts in: `{ del, add }`. */
export const countOf = (hunks) => hunks.reduce((n, k) => ({ del: n.del + k.del.length, add: n.add + k.add.length }), { del: 0, add: 0 })
