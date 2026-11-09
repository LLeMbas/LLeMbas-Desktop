// Models as the person picks them: each with its avatar, as the server's web interface draws a
// model without an uploaded image -- its initial on a colour of its own, the hue worked out from
// the model's id exactly as the server does it (`stable_hue`: the first two bytes of the id's
// MD5, modulo 360), so a model looks the same in the app and in the browser. Saturation and
// lightness are the theme's (app.css), only the hue is the model's.

import { h, icon, ICONS } from "./dom.js"
import { menu } from "./popup.js"

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

/** A model's avatar: its initial on its own colour. */
export function avatar(model) {
  const label = String(model?.name || model?.id || "?").trim() || "?"
  const el = h("span", { class: "avatar", "aria-hidden": "true", text: label[0].toUpperCase() })
  el.style.setProperty("--avatar-hue", String(stableHue(model?.id || label)))
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
