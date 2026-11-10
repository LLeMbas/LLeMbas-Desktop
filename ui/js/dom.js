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

/** append(el, child, [more], …): children one by one or in arrays, nested as deep as they come. */
export function append(el, ...children) {
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
  chevronDown: "M3.5 6L8 10.5 12.5 6 11.4 4.9 8 8.3 4.6 4.9z",
  more: "M2.5 6.75h2.5v2.5H2.5zM6.75 6.75h2.5v2.5h-2.5zM11 6.75h2.5v2.5H11z",
  edit: "M10.75 1.75l3.5 3.5-8.5 8.5h-3.5v-3.5zM3.75 10.87v1.38h1.38l6.62-6.62-1.38-1.38z",
  copy: "M5 1.5h8.5V11H5zM6.5 3v6.5H12V3zM2.5 5H4v8.5h6.5V15h-8z",
  attach: "M7.25 2.5h1.5v4.75h4.75v1.5H8.75v4.75h-1.5V8.75H2.5v-1.5h4.75z",
  bolt: "M9.5 1L3 9.25h4.25L6.5 15 13 6.75H8.75z",
  stop: "M4.5 4.5h7v7h-7z",
  tasks: "M2 3.25h2v2H2zM5.5 3.5H14V5H5.5zM2 7h2v2H2zM5.5 7.25H14v1.5H5.5zM2 10.75h2v2H2zM5.5 11H14v1.5H5.5z",
  back: "M10 3.5L5.5 8 10 12.5 11.1 11.4 7.7 8 11.1 4.6z",
  terminal: "M1.5 2.5h13v11h-13zM3 4v8h10V4zM4.2 5.4l2.6 2.6-2.6 2.6-1-1L4.8 8 3.2 6.4zM7.5 10h4v1.5h-4z",
  search: "M7 2a5 5 0 013.95 8.07l3.24 3.24-1.06 1.06-3.24-3.24A5 5 0 117 2zm0 1.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z",
  send: "M8 2.25l5.03 5.03-1.06 1.06-3.22-3.22V13.5h-1.5V5.12L4.03 8.34 2.97 7.28z",
  clock: ["M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 3a5 5 0 100 10A5 5 0 008 3z", "M7.25 4.5h1.5v3.19l2.03 2.03-1.06 1.06-2.47-2.47z"],
  chat: "M2 2.5h12v8.5H7l-3.5 3v-3H2zM3.5 4v5.5h1.5v1.25L6.45 9.5h6.05V4z",
  bulb: ["M8 1.5a4.5 4.5 0 012.75 8.06v1.94h-5.5V9.56A4.5 4.5 0 018 1.5zM8 3a3 3 0 00-1.83 5.38l.58.45V10h2.5V8.83l.58-.45A3 3 0 008 3z", "M5.75 12.5h4.5V14h-4.5z"],
  users: ["M6 2.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM6 4a1 1 0 100 2 1 1 0 000-2z", "M1.5 13.5c0-2.5 2-4.25 4.5-4.25s4.5 1.75 4.5 4.25H9c0-1.6-1.3-2.75-3-2.75S3 11.9 3 13.5z", "M11 3.5a2 2 0 110 4 2 2 0 010-4z", "M11.75 9.4c1.65.35 2.75 1.85 2.75 4.1H13c0-1.4-.55-2.4-1.6-2.7z"],
  shield: "M8 1l5.5 2v4.5c0 3.3-2.3 6-5.5 7.5-3.2-1.5-5.5-4.2-5.5-7.5V3zM4 4.05V7.5c0 2.45 1.6 4.6 4 5.85 2.4-1.25 4-3.4 4-5.85V4.05L8 2.6z",
  link: ["M6.47 8.47l2-2 1.06 1.06-2 2z", "M4.6 7.4l1.06 1.06-1.4 1.4a1.5 1.5 0 002.12 2.12l1.4-1.4 1.06 1.06-1.4 1.4a3 3 0 01-4.24-4.24z", "M11.4 8.6l-1.06-1.06 1.4-1.4a1.5 1.5 0 00-2.12-2.12l-1.4 1.4L7.16 4.36l1.4-1.4a3 3 0 014.24 4.24z"],
  pause: ["M4.5 3.5H7v9H4.5z", "M9 3.5h2.5v9H9z"],
  play: "M5 2.75L13 8l-8 5.25z",
  user: ["M8 2a3 3 0 110 6 3 3 0 010-6zm0 1.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z", "M2.5 14c0-2.9 2.4-4.75 5.5-4.75S13.5 11.1 13.5 14H12c0-2-1.65-3.25-4-3.25S4 12 4 14z"],
  check: "M6.5 10.4l6-6 1.06 1.06L6.5 12.53 2.94 8.97 4 7.9z",
  bell: ["M8 1.5a4.5 4.5 0 014.5 4.5v3l1.5 2.5H2L3.5 9V6A4.5 4.5 0 018 1.5zM8 3a3 3 0 00-3 3v3.42l-.35.58h6.7L11 9.42V6a3 3 0 00-3-3z", "M6.25 12.5h3.5a1.75 1.75 0 01-3.5 0z"],
  info: ["M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM8 3a5 5 0 100 10A5 5 0 008 3z", "M7.25 7h1.5v4.5h-1.5zM7.25 4.5h1.5V6h-1.5z"],
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
