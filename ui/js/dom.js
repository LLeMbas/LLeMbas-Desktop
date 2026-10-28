// Building the page: elements made in code, text always as text. Nothing here ever parses a
// string as HTML -- what the server sends (a reply, a file, a title) is model output or the
// person's own words, and is set with textContent, never innerHTML.

export const $ = (id) => document.getElementById(id)

/**
 * h("button", { class: "btn", onclick: fn, "aria-label": "…" }, "text", child, [more])
 * Attributes: `class`, `text`, `hidden`, `on<event>` (a function), `dataset` (an object), any
 * other as an attribute (false/null/undefined leave it out, true sets it empty).
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === "class") el.className = value
    else if (key === "text") el.textContent = value
    else if (key === "dataset") Object.assign(el.dataset, value)
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value)
    else if (key === "hidden") el.hidden = !!value
    else if (key === "value") el.value = value
    else if (key === "checked") el.checked = !!value
    else if (key === "disabled") el.disabled = !!value
    else el.setAttribute(key, value === true ? "" : String(value))
  }
  append(el, children)
  return el
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function clear(el) {
  el.replaceChildren()
  return el
}

/** An inline SVG icon from a path list, drawn in currentColor. */
export function icon(d, label) {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("aria-hidden", "true")
  svg.classList.add("icon")
  for (const one of [].concat(d)) {
    const p = document.createElementNS(ns, "path")
    p.setAttribute("d", one)
    p.setAttribute("fill-rule", "evenodd")
    svg.append(p)
  }
  if (label) {
    svg.removeAttribute("aria-hidden")
    svg.setAttribute("role", "img")
    svg.setAttribute("aria-label", label)
  }
  return svg
}

export const ICONS = {
  plus: "M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25z",
  close: "M4.5 3.4L8 6.9l3.5-3.5 1.1 1.1L9.1 8l3.5 3.5-1.1 1.1L8 9.1l-3.5 3.5-1.1-1.1L6.9 8 3.4 4.5z",
  folder: "M1.5 3h5l1.5 1.5h6.5v8.5h-13zM3 6v5.5h10V6z",
  file: "M3 1.5h6.5L13 5v9.5H3zM4.5 3v10h7V6H8.5V3z",
  chevron: "M6 3.5L10.5 8 6 12.5 4.9 11.4 8.3 8 4.9 4.6z",
  menu: "M3 4h10v1.5H3zM3 7.25h10v1.5H3zM3 10.5h10V12H3z",
  side: "M2 3h12v10H2zM3.5 4.5v7H6v-7z",
  gear: "M7 1.5h2l.4 1.8 1.1.5 1.6-1 1.4 1.4-1 1.6.5 1.1 1.8.4v2l-1.8.4-.5 1.1 1 1.6-1.4 1.4-1.6-1-1.1.5L9 14.5H7l-.4-1.8-1.1-.5-1.6 1-1.4-1.4 1-1.6-.5-1.1-1.8-.4v-2l1.8-.4.5-1.1-1-1.6 1.4-1.4 1.6 1 1.1-.5zM8 5.75a2.25 2.25 0 100 4.5 2.25 2.25 0 000-4.5z",
  refresh: "M8 2.5a5.5 5.5 0 015.2 3.7H11.5v1.5H15V4.2h-1.5v1A7 7 0 001 8h1.5A5.5 5.5 0 018 2.5zM2.5 11.8v-1h1.7A5.5 5.5 0 0013.5 8H15A7 7 0 012.5 11.8z",
  min: "M4 10h8v1.5H4z",
  max: "M4 4h8v8H4zM5.5 5.5v5h5v-5z",
  restore: "M5.5 3h7.5v7.5h-2.5V13H3V5.5h2.5zM7 4.5v1h3.5V9h1V4.5zM4.5 7v4.5H9V7z",
}

/** "3 min ago"-style, in the system's language, for a stamp the server sent. */
export function when(stamp) {
  if (!stamp) return ""
  const then = new Date(stamp)
  if (Number.isNaN(then.getTime())) return ""
  const seconds = Math.round((then.getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: "auto" })
  const steps = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Infinity, "year"],
  ]
  let value = seconds
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit)
    value /= size
  }
  return ""
}

/** A size in bytes, as a person reads it. */
export function bytes(n) {
  if (!Number.isFinite(n)) return ""
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
