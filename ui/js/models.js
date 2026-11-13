// Models as the person picks them: each with its avatar. A model with a picture (`image` in
// /api/v2/models) shows it, read through the bridge with the app's token and handed to the page
// as a `data:` URL; until it arrives, and for a model without one, the avatar is what the
// server's web interface draws then -- its initial on a colour of its own, the hue worked out
// from the model's id exactly as the server does it (`stable_hue`: the first two bytes of the
// id's MD5, modulo 360), so a model looks the same in the app and in the browser. Saturation and
// lightness are the theme's (app.css), only the hue is the model's.

import { h } from "./dom.js"
import { invoke } from "./bridge.js"

// Each picture once per run: its path -> a promise of its `data:` URL (null when it cannot be had,
// so a missing picture is not asked for again with every redraw).
const pictures = new Map()

export function picture(path) {
  if (!pictures.has(path)) pictures.set(path, invoke("model_image", { path }).catch(() => null))
  return pictures.get(path)
}

/** MD5 of a string's UTF-8 bytes (RFC 1321), as 16 bytes. For a colour, not for security. */
function md5(text) {
  const bytes = new TextEncoder().encode(text)
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
  const len = bytes.length
  const words = (((len + 8) >>> 6) + 1) * 16
  const w = new Uint32Array(words)
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8)
  w[len >> 2] |= 0x80 << ((len % 4) * 8)
  w[words - 2] = (len * 8) >>> 0
  w[words - 1] = Math.floor((len * 8) / 2 ** 32)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let off = 0; off < words; off += 16) {
    let [A, B, C, D] = [a0, b0, c0, d0]
    for (let i = 0; i < 64; i++) {
      let F
      let g
      if (i < 16) [F, g] = [(B & C) | (~B & D), i]
      else if (i < 32) [F, g] = [(D & B) | (~D & C), (5 * i + 1) % 16]
      else if (i < 48) [F, g] = [B ^ C ^ D, (3 * i + 5) % 16]
      else [F, g] = [C ^ (B | ~D), (7 * i) % 16]
      F = (F + A + K[i] + w[off + g]) >>> 0
      const s = S[(i >> 4) * 4 + (i % 4)]
      A = D
      D = C
      C = B
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }
  return [a0, b0, c0, d0].flatMap((v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])
}

/** The server's `stable_hue`: 0-359, the same for the same id everywhere. */
export function stableHue(id) {
  const d = md5(String(id))
  return ((d[0] << 8) | d[1]) % 360
}

/** A model's avatar: its picture, or its initial on its own colour while there is none. */
export function avatar(model) {
  const label = String(model?.name || model?.id || "?").trim() || "?"
  const el = h("span", { class: "avatar", "aria-hidden": "true", text: label[0].toUpperCase() })
  el.style.setProperty("--avatar-hue", String(stableHue(model?.id || label)))
  if (typeof model?.image === "string" && model.image) {
    picture(model.image).then((url) => {
      if (!url || !url.startsWith("data:image/")) return
      el.classList.add("avatar--image")
      el.replaceChildren(h("img", { src: url, alt: "", draggable: "false" }))
    })
  }
  return el
}

// --- How hard a model thinks, and how many subagents a chat may have --------------------------------
//
// The levels are the harness spec's (3.2.0, `models/schema.json`), as /api/v2/models gives them:
// `levels` in offering order (`off` first where the model can switch thinking off, then its
// efforts, or the one level `default`), `effort` the start level and `control` how a chat draws
// them -- `none` (one level: nothing to choose), `switch` (off and one effort: thinking on or
// off) or `slider` (more: a choice of each). The chat says the level in force as its `effort`.

/** A model's levels: { levels, start, control }, read the server's way when a field is missing. */
export function levelsOf(model) {
  const given = Array.isArray(model?.levels) && model.levels.length ? model.levels : null
  const levels = given || (model?.efforts?.length ? model.efforts : ["default"])
  const control =
    ["none", "switch", "slider"].includes(model?.control) ? model.control
    : levels.length < 2 ? "none"
    : levels.length === 2 && levels.includes("off") ? "switch"
    : "slider"
  const start = levels.includes(model?.effort) ? model.effort : levels[0]
  return { levels, start, control }
}

/** A level as the person reads it: `off` and `default` in their language, an effort as it is. */
export function levelWord(level) {
  return level === "off" ? t("off") : level === "default" ? t("default") : String(level)
}

/**
 * Whether a new chat on `model` is offered subagents: the model's `subagents.offered` in `/models`
 * (server 2.0.0-beta.7: subagents on for the model and the instance, and at least one model could
 * serve as one -- the model itself with room for two requests at once, or a usable model outside
 * its one-model-at-a-time server). A server that does not say it: a model that calls tools and
 * serves two requests at once (`parallel` null is a hosted API with no stated limit). The server
 * decides again; this only keeps the chip away where it could never apply. An open chat has its
 * own `subagents` (chat.js).
 */
export function teamPossible(model) {
  const said = model?.subagents
  if (said !== undefined && said !== null) return typeof said === "object" ? !!said.offered : !!said
  return !!model?.tools && (model.parallel === null || model.parallel === undefined || model.parallel >= 2)
}

/** Whether only a model the person names in the chat could serve its subagents (`named_only`). */
export function namedOnly(said) {
  return !!(said && typeof said === "object" && said.named_only)
}

// The instance's most, as `/models` said it last (`subagents_cap`); 32 where it says nothing.
export const SUBAGENTS_CAP = 32
let knownCap = null
export function noteSubagentsCap(n) {
  knownCap = Number(n) >= 1 ? Number(n) : null
}
/** The most subagents a chat may have: the first of `sources` that says it (`cap`), else the instance's. */
export function subagentsCap(...sources) {
  for (const s of sources) {
    const n = Number(s?.cap)
    if (Number.isFinite(n) && n >= 1) return n
  }
  return knownCap || SUBAGENTS_CAP
}
// The numbers count the chat's own agent: 1 is the agent alone.
export const SUBAGENTS_HINT = () => t("The numbers count this chat's own agent: 1 is the agent alone, with no subagents; Max 4 is the agent and up to 3 subagents. A subagent runs on the chat's model, or on another only when you name it in the chat.")
// The spec's `subagents.setting.own`: beside the setting where the chat's model cannot serve them.
export const SUBAGENTS_OWN = () => t("This model serves one request at a time: subagents need another model, on another server, named in the chat.")

// A new chat's setting as the harness spec seeds it (`loop.json` agents): 1 to 4.
export const AGENTS_DEFAULT = { min: 1, max: 4 }

/**
 * The agents a chat may run, its own agent counted: one range from 1 to `cap` with two handles,
 * Min and Max -- two range inputs overlaid on one track, the span between them filled. Each is a
 * real slider (arrow keys, Home/End, Page Up/Down), and Min never passes Max. `value` is
 * { min, max } (empty for a new chat: the spec's defaults are shown, and left to the server
 * unless a handle moves); `el.value` the pair. The server checks it again.
 */
export function agentsControl({ value, onChange, id, cap = SUBAGENTS_CAP }) {
  const top = Math.max(1, Number(cap) || SUBAGENTS_CAP)
  const clamp = (n, d) => Math.min(top, Math.max(1, Number.isFinite(Number(n)) && n !== null && n !== "" ? Number(n) : d))
  let given = value || {}
  let touched = false
  const handle = (which, label) =>
    h("input", {
      type: "range",
      class: `range2__input range2__input--${which}`,
      id: which === "min" ? id : null,
      min: "1",
      max: String(top),
      step: "1",
      "aria-label": label,
      title: label,
    })
  const low = handle("min", t("Min"))
  const high = handle("max", t("Max"))
  const said = h("output", { class: "range2__said", "aria-live": "polite", for: id || null })
  const fill = h("span", { class: "range2__fill", "aria-hidden": "true" })
  const box = h("span", { class: "range2__box" }, h("span", { class: "range2__track", "aria-hidden": "true" }, fill), low, high)
  const draw = () => {
    const lo = Number(low.value)
    const hi = Number(high.value)
    const at = (n) => (top > 1 ? ((n - 1) / (top - 1)) * 100 : 0)
    box.style.setProperty("--lo", `${at(lo)}%`)
    box.style.setProperty("--hi", `${at(hi)}%`)
    // Where the two meet, the one that can still move is on top: Min at the far end, else Max.
    low.classList.toggle("is-top", lo === hi && hi === top)
    low.setAttribute("aria-valuetext", `${t("Min")} ${lo}`)
    high.setAttribute("aria-valuetext", `${t("Max")} ${hi}`)
    said.textContent = `${t("Min")} ${lo} · ${t("Max")} ${hi}`
  }
  const set = (v) => {
    const hi = clamp(v?.max, Math.min(AGENTS_DEFAULT.max, top))
    const lo = Math.min(hi, clamp(v?.min, AGENTS_DEFAULT.min))
    high.value = String(hi)
    low.value = String(lo)
    draw()
  }
  low.addEventListener("input", () => {
    if (Number(low.value) > Number(high.value)) low.value = high.value
    touched = true
    draw()
  })
  high.addEventListener("input", () => {
    if (Number(high.value) < Number(low.value)) high.value = low.value
    touched = true
    draw()
  })
  for (const input of [low, high]) input.addEventListener("change", () => onChange?.(read()))
  const read = () => (touched || given.min || given.max ? { min: Number(low.value), max: Number(high.value) } : {})
  set(given)
  const el = h(
    "span",
    { class: "range2", role: "group", "aria-label": t("Subagents") },
    said,
    box,
    h("span", { class: "range2__ends", "aria-hidden": "true" }, h("span", { text: "1" }), h("span", { text: String(top) })),
  )
  Object.defineProperty(el, "value", {
    get: read,
    set: (v) => {
      given = v || {}
      touched = false
      set(given)
    },
  })
  return el
}
