// What a session is doing, as one line: the harness's `progress` object (spec 3.4.0,
// harness/progress.md in the LLeMbas CLI) drawn the way every client draws it --
// `{{text}} · {{elapsed}}`, with the shared texts (`loop.json` progress.texts) as this page's
// sentences. The server sends the object beside the old `status` text in a chat's stream; where it
// sends none (an older server), the status text is drawn as before.
//
// The texts are the spec's, word for word with their `{{field}}`s: the server's catalogues
// translate them under the same keys (scripts/gen-i18n.py takes them from there).

/** The thirteen phases: a text for each, and a variant where a field may be missing. */
const TEXTS = {
  queued: "Queued",
  "queued.ahead": "Queued: {{ahead}} ahead",
  waiting_for_model: "Waiting for {{model}}: {{reason}}",
  loading_model: "Loading {{model}}",
  reading_prompt: "Reading the prompt: {{done}} / {{total}} tokens ({{percent}}%)",
  "reading_prompt.bare": "Reading the prompt",
  thinking: "Thinking",
  writing: "Writing: {{rate}} tok/s",
  "writing.bare": "Writing",
  running_tool: "Running {{tool}}: {{what}}",
  "running_tool.bare": "Running {{tool}}",
  waiting_for_person: "Waiting for you: {{what}}",
  waiting_for_subagents: "Waiting for subagents: {{running}} running",
  compacting: "Compacting the conversation",
  retrying: "Retrying in {{in}} s: {{reason}}",
  stopped: "Stopped",
  "stopped.reason": "Stopped: {{reason}}",
  failed: "Failed: {{reason}}",
}

/** The words a field stands for. */
const REASONS = {
  busy: "it serves one request at a time and is answering another",
  slots: "all its slots are in use",
  group: "its server holds another model now",
}
const WHAT = {
  approval: "allow {{tool}}?",
  "approval.bare": "an approval",
  question: "a question",
  plan: "the plan",
}
const STOPPED = { person: "by you", steps: "step limit", budget: "budget" }

/** Every sentence above, for scripts/gen-i18n.py to find (it reads `t("…")` calls by hand). */
export const PROGRESS_SENTENCES = [...Object.values(TEXTS), ...Object.values(REASONS), ...Object.values(WHAT), ...Object.values(STOPPED)]

const NO_ELAPSED = ["stopped", "failed"]

const has = (p, k) => p[k] !== undefined && p[k] !== null && p[k] !== ""

/** A sentence in the page's language (the spec's text is the key, as in the server's
 * catalogues), its `{{field}}`s filled -- after the lookup, so a field's own text is never read
 * as a template. */
function say(text, fields = {}) {
  return t(text).replace(/\{\{(\w+)\}\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(fields, name) ? String(fields[name]) : all))
}

/** An integer as it is; a rate with one decimal, in the page's language (12.5, 12,5). */
function rate(n) {
  try {
    return new Intl.NumberFormat(document.documentElement.lang || "en", { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n)
  } catch {
    return Number(n).toFixed(1)
  }
}
const int = (n) => String(Math.trunc(Number(n) || 0))

/** Whole seconds, as a ticking clock writes them: 5s, 1m 05s, 1h 02m. */
export function elapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** Whether `p` is a progress object this page can draw (one of the thirteen phases). */
export function isProgress(p) {
  return !!p && typeof p === "object" && Object.prototype.hasOwnProperty.call(TEXTS, p.phase)
}

/** The phase's text, its fields filled; "" for nothing this page knows. */
export function progressText(p, now = Date.now()) {
  if (!isProgress(p)) return ""
  switch (p.phase) {
    case "queued":
      return has(p, "ahead") ? say(TEXTS["queued.ahead"], { ahead: int(p.ahead) }) : say(TEXTS.queued)
    case "waiting_for_model":
      return say(TEXTS.waiting_for_model, { model: p.model || "", reason: REASONS[p.reason] ? say(REASONS[p.reason]) : p.reason || "" })
    case "loading_model":
      return say(TEXTS.loading_model, { model: p.model || "" })
    case "reading_prompt":
      if (!has(p, "done") || !(Number(p.total) > 0)) return say(TEXTS["reading_prompt.bare"])
      return say(TEXTS.reading_prompt, { done: int(p.done), total: int(p.total), percent: int(Math.floor((Number(p.done) * 100) / Number(p.total))) })
    case "writing":
      return has(p, "rate") ? say(TEXTS.writing, { rate: rate(p.rate) }) : say(TEXTS["writing.bare"])
    case "running_tool":
      return has(p, "what") ? say(TEXTS.running_tool, { tool: p.tool || "", what: p.what }) : say(TEXTS["running_tool.bare"], { tool: p.tool || "" })
    case "waiting_for_person": {
      const what = p.what === "approval" ? (has(p, "tool") ? say(WHAT.approval, { tool: p.tool }) : say(WHAT["approval.bare"])) : WHAT[p.what] ? say(WHAT[p.what]) : p.what || ""
      return say(TEXTS.waiting_for_person, { what })
    }
    case "waiting_for_subagents":
      return say(TEXTS.waiting_for_subagents, { running: int(p.running) })
    case "retrying": {
      const left = Math.max(0, Math.trunc(Number(p.in) || 0) - Math.floor((now - Number(p.since || now)) / 1000))
      return say(TEXTS.retrying, { in: String(left), reason: p.reason || "" })
    }
    case "stopped":
      return has(p, "reason") ? say(TEXTS["stopped.reason"], { reason: STOPPED[p.reason] ? say(STOPPED[p.reason]) : p.reason }) : say(TEXTS.stopped)
    case "failed":
      return say(TEXTS.failed, { reason: p.reason || "" })
    default:
      return say(TEXTS[p.phase])
  }
}

/**
 * The line: `{{text}} · {{elapsed}}`, the text alone for stopped and failed (and where `bare`:
 * a row with no room for the clock).
 */
export function progressLine(p, now = Date.now(), { bare = false } = {}) {
  const text = progressText(p, now)
  if (!text || bare || NO_ELAPSED.includes(p.phase) || !has(p, "since")) return text
  // progress.line, `{{text}} · {{elapsed}}`: the same in every language.
  return `${text} · ${elapsed(now - Number(p.since))}`
}

/** Whether the line changes by itself as time passes (it has a clock, or a countdown). */
export function progressTicks(p) {
  return isProgress(p) && !NO_ELAPSED.includes(p.phase) && has(p, "since")
}
