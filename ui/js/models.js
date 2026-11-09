// Models as the person picks them: each with its avatar. A model with a picture (`image` in
// /api/v2/models) shows it, read through the bridge with the app's token and handed to the page
// as a `data:` URL; until it arrives, and for a model without one, the avatar is what the
// server's web interface draws then -- its initial on a colour of its own, the hue worked out
// from the model's id exactly as the server does it (`stable_hue`: the first two bytes of the
// id's MD5, modulo 360), so a model looks the same in the app and in the browser. Saturation and
// lightness are the theme's (app.css), only the hue is the model's.

import { h, icon, ICONS } from "./dom.js"
import { invoke } from "./bridge.js"
import { menu } from "./popup.js"

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

/**
 * A model picker: a button showing the chosen model (avatar and name) that opens the list, each
 * with its avatar. `onChange(id)` when another is chosen. The element's `value` is the id.
 */
export function modelPicker({ id, models, value, onChange, label }) {
  let current = value
  const btn = h("button", { type: "button", class: "picker", id, "aria-haspopup": "menu", "aria-label": label })
  const draw = () => {
    const m = models.find((x) => x.id === current)
    btn.replaceChildren(
      m ? avatar(m) : h("span", { class: "avatar avatar--none", "aria-hidden": "true" }),
      h("span", { class: "picker__name", text: m ? m.name : current || "—" }),
      icon(ICONS.chevronDown),
    )
    btn.title = m ? `${m.name} (${m.id})` : current || ""
  }
  btn.addEventListener("click", () => {
    menu(
      btn,
      models.map((m) => ({
        label: m.name,
        lead: avatar(m),
        checked: m.id === current,
        run: () => {
          if (m.id === current) return
          current = m.id
          draw()
          onChange?.(m.id)
        },
      })),
    )
  })
  Object.defineProperty(btn, "value", {
    get: () => current,
    set: (v) => {
      current = v
      draw()
    },
  })
  draw()
  return btn
}

// --- How hard a model thinks, and how many agents a chat may have --------------------------------
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
 * The control for a model's levels, or null where it has one level: the Thinking switch (a real
 * checkbox with the switch role, the label its tap target) or the selector. `value` is the level
 * in force; `onChange(level)` when the person changes it. The element's `value` is the level.
 */
export function effortControl({ model, value, onChange, id, compact }) {
  const { levels, start, control } = levelsOf(model)
  if (control === "none") return null
  let current = levels.includes(value) ? value : start
  if (control === "switch") {
    const on = levels.find((l) => l !== "off") || start
    const box = h("input", { type: "checkbox", role: "switch", id, checked: current !== "off" })
    const el = h(
      "label",
      { class: `toggle${compact ? " toggle--compact" : ""}`, title: t("Think before answering") },
      box,
      h("span", { class: "toggle__label", text: t("Think before answering") }),
    )
    box.addEventListener("change", () => {
      current = box.checked ? on : "off"
      onChange?.(current)
    })
    Object.defineProperty(el, "value", {
      get: () => current,
      set: (v) => {
        current = v
        box.checked = v !== "off"
      },
    })
    return el
  }
  const el = h(
    "select",
    { id, class: compact ? "head__mode" : null, "aria-label": t("Reasoning effort"), title: t("Reasoning effort") },
    levels.map((l) => h("option", { value: l, text: levelWord(l), selected: l === current })),
  )
  el.addEventListener("change", () => {
    current = el.value
    onChange?.(current)
  })
  return el
}

/**
 * Whether a new chat on `model` may have a team: a chat on the server (an agent chat's team runs
 * on its device), a model that calls tools and serves two requests at once (`parallel` null is a
 * hosted API with no stated limit). The server decides again; this only keeps the fields away
 * where they could never apply. An open chat asks the server (`GET /chats/{chat}/team`).
 */
export function teamPossible(model) {
  return !!model?.tools && (model.parallel === null || model.parallel === undefined || model.parallel >= 2)
}

/**
 * The team's size: the fewest and the most agents, the chat's own agent included, as two number
 * fields on one shared track. `value` is { min, max } (empty fields for a new chat: the person's
 * default for new chats then stands); `onChange({ min, max })` once a field is changed, with the
 * empty one left out. The server checks the pair and says the bounds when it refuses one.
 */
export function agentsControl({ value, onChange, id, compact }) {
  const field = (which, v, label) =>
    h("input", {
      type: "number",
      class: "agents__input",
      id: which === "min" ? id : null,
      min: "1",
      step: "1",
      inputmode: "numeric",
      value: v === undefined || v === null ? "" : String(v),
      placeholder: compact ? null : t("default"),
      "aria-label": label,
      title: label,
    })
  const low = field("min", value?.min, t("Fewest"))
  const high = field("max", value?.max, t("Most"))
  const bounds = () => {
    high.min = low.value || "1"
    if (high.value) low.max = high.value
    else low.removeAttribute("max")
  }
  bounds()
  const read = () => {
    const out = {}
    if (low.value) out.min = Number(low.value)
    if (high.value) out.max = Number(high.value)
    return out
  }
  for (const input of [low, high]) {
    input.addEventListener("change", () => {
      bounds()
      onChange?.(read())
    })
  }
  const el = h(
    "span",
    { class: `agents${compact ? " agents--compact" : ""}`, role: "group", "aria-label": t("Agents"), title: t("Its own agent included. Above one, it can add members that do the work while it leads them.") },
    compact ? h("span", { class: "agents__label", text: t("Agents") }) : null,
    low,
    h("span", { class: "agents__dash", "aria-hidden": "true", text: "–" }),
    high,
  )
  Object.defineProperty(el, "value", {
    get: read,
    set: (v) => {
      low.value = v?.min ?? ""
      high.value = v?.max ?? ""
      bounds()
    },
  })
  return el
}
