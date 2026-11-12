// What stays on the screen after a tool call or a reply, said the way every LLeMbas client says
// it: the harness's display rules (spec 3.7.0, harness/display.md in the LLeMbas CLI) over the
// spec's own data (ui/js/spec.js `DISPLAY`). A call's one short title, its four states, how long
// it took, the facts after the title (+3 −1, exit 2, 14 hits), and the line a reply that did not
// finish ends with. Pure: tests/ui holds every function to the spec's conformance/display.json.
//
// The server sends a call's `block` (kind, title, chips, added, removed) in /api/v2; where it says
// a thing, the page draws what it says. These functions are for what it does not say, and for a
// server from before the spec.

import { DISPLAY, PROGRESS } from "./spec.js"
import { isProgress, progressText } from "./progress.js"

const D = DISPLAY

/** A sentence of the spec in the page's language, its `{{field}}`s filled after the lookup. */
function say(text, fields = {}) {
  return t(text).replace(/\{\{(\w+)\}\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(fields, name) ? String(fields[name]) : all))
}

/** A count as the page's language writes it (display.md §6); `plain` for the spec's own format. */
export function count(n, plain = false) {
  if (plain) return String(n)
  try {
    return new Intl.NumberFormat(document.documentElement.lang || "en").format(n)
  } catch {
    return String(n)
  }
}

/** One line, cut to the title's length in code points (79 and an ellipsis); "" for none. */
export function shortTitle(s) {
  if (typeof s !== "string") return ""
  const line = (s.trim().split("\n")[0] || "").trim()
  const max = PROGRESS.what_max
  const points = [...line]
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : line
}

function patchFiles(patch) {
  const lines = patch.split("\n")
  const named = lines.flatMap((l) => {
    const head = D.title.patch_files.find((x) => l.startsWith(x))
    return head ? [l.slice(head.length).trim()] : []
  })
  if (named.length) return named.filter(Boolean)
  return lines
    .filter((l) => l.startsWith("+++ "))
    .map((l) => l.slice(4).split("\t")[0].trim().replace(/^b\//, ""))
    .filter((f) => f && f !== "/dev/null")
}

/** A call's one short title from its arguments alone (§1), or null where it has none. */
export function callTitle(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  if (Array.isArray(args.questions)) {
    const headers = args.questions.map((q) => (q && typeof q === "object" ? q.header : null)).filter((x) => typeof x === "string" && x.trim())
    const title = shortTitle(headers.map((x) => x.trim()).join(D.title.questions_join))
    if (title) return title
  }
  if (typeof args.patch === "string") {
    const title = shortTitle(patchFiles(args.patch).join(D.title.patch_join))
    if (title) return title
  }
  for (const k of D.title.keys) {
    const v = args[k]
    if (typeof v === "string" && v.trim()) return shortTitle(v) || null
  }
  return null
}

/** A finished call's time (§2): 0.4s, 8.4s, 1m 05s, 2h 03m. Always with `.`: not a locale number. */
export function duration(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < D.duration.tenths_under_seconds * 1000) return `${(Math.floor(n / 100) / 10).toFixed(1)}s`
  const total = Math.floor(n / 1000)
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** The duration beside a call's title: none while it runs, when it was denied, or when not kept. */
export function callDuration(state, ms) {
  if (D.no_duration.includes(state) || ms === undefined || ms === null || !Number.isFinite(Number(ms))) return null
  return duration(ms)
}

/** The lines a unified diff adds and removes, counted by its hunks (§2). */
export function diffCounts(diff) {
  let added = 0
  let removed = 0
  let old = 0
  let fresh = 0
  for (const l of String(diff || "").split("\n")) {
    if (old <= 0 && fresh <= 0) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l)
      if (m) {
        old = m[1] === undefined ? 1 : Number(m[1])
        fresh = m[2] === undefined ? 1 : Number(m[2])
      }
      continue
    }
    if (l.startsWith("+")) {
      added++
      fresh--
    } else if (l.startsWith("-")) {
      removed++
      old--
    } else if (l.startsWith("\\")) continue
    else {
      old--
      fresh--
    }
  }
  return { added, removed }
}

/** `+3 −1` for an edit. */
export function changeText({ added, removed }, plain = false) {
  return say(D.change, { added: count(added, plain), removed: count(removed, plain) })
}

/** The facts after a finished call's title (§2): an edit's change, an exit code that is not 0, a search's hits. */
export function callFacts({ block, diff, exit, hits }, plain = false) {
  const out = []
  if (block === "edit" && diff) out.push(changeText(diffCounts(diff), plain))
  if (block === "shell" && typeof exit === "number" && exit !== 0) out.push(say(D.exit, { code: String(exit) }))
  if (block === "search" && typeof hits === "number") out.push(say(hits === 1 ? D.hit : D.hits, { count: count(hits, plain) }))
  return out
}

/** Whether a block is drawn as a call at all (§3): a plan change and a hidden tool are not. */
export function drawn(block) {
  return !D.not_drawn.includes(block)
}

/** The line that stays on a reply that did not finish (§4): the progress's text alone; null otherwise. */
export function endLine(progress, now = Date.now()) {
  if (!isProgress(progress) || !D.end.includes(progress.phase)) return null
  return progressText(progress, now) || null
}

/** Every sentence of the spec's display this page says, for the cards and the calls. */
export const ACTIONS = D.actions
