// Voice: a message dictated in the composer, and a reply read aloud. Both are the instance's own
// speech services on the OpenAI-compatible routes, which the app's token reaches through its
// `models` scope (src-tauri/src/server.rs):
//
//   POST /v1/audio/transcriptions   the recording -> { text }       (Rust: `transcribe`)
//   POST /v1/audio/speech           { input } -> the audio           (Rust: `speak`, a data: URL)
//
// Each is offered only where `GET /me` says the instance has it for this account (`services.stt`,
// `services.tts`) and the token holds `models` (`scopes`), so no button is there that can only fail.
// The microphone is asked for only when Dictate is pressed: Rust allows it for that moment alone.

import { $, h, icon, ICONS } from "./dom.js"
import { invoke, why } from "./bridge.js"

let me = null

const hasModels = () => !Array.isArray(me?.scopes) || me.scopes.includes("models")
/** Whether a message can be dictated here. */
export const canDictate = () => !!me?.services?.stt && hasModels() && me?.permissions?.["audio.transcribe"] !== false
/** Whether a reply can be read aloud here. */
export const canSpeak = () => !!me?.services?.tts && hasModels() && me?.permissions?.["audio.listen"] !== false

function say(text) {
  const box = $("thread-note")
  if (!box) return
  box.textContent = text
  box.hidden = !text
}

// --- Dictate --------------------------------------------------------------------------------------

let recorder = null // the recording in progress
let busy = false // a recording being turned into words

function drawMic() {
  const b = $("dictate")
  if (!b) return
  b.hidden = !canDictate()
  const on = !!recorder
  b.classList.toggle("is-recording", on)
  b.classList.toggle("is-busy", busy)
  b.disabled = busy
  b.setAttribute("aria-pressed", String(on))
  const label = busy ? t("Writing down…") : on ? t("Stop dictating") : t("Dictate a message")
  b.setAttribute("aria-label", label)
  b.title = label
}

async function start() {
  say("")
  let stream
  try {
    await invoke("voice_arm")
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    say(t("The microphone could not be opened: %(why)s", { why: err?.message || why(err) }))
    return
  }
  const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((x) => window.MediaRecorder?.isTypeSupported?.(x))
  let rec
  try {
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  } catch (err) {
    stream.getTracks().forEach((x) => x.stop())
    say(t("The microphone could not be opened: %(why)s", { why: err?.message || why(err) }))
    return
  }
  const chunks = []
  rec.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data))
  rec.addEventListener("stop", async () => {
    stream.getTracks().forEach((x) => x.stop())
    recorder = null
    const blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" })
    if (!blob.size) return drawMic()
    busy = true
    drawMic()
    try {
      const text = await invoke("transcribe", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-type": blob.type } })
      intoComposer(text)
    } catch (err) {
      say(why(err))
    }
    busy = false
    drawMic()
  })
  recorder = rec
  rec.start()
  drawMic()
}

/** The words heard, where the cursor is in the message box, a space either side where needed. */
function intoComposer(text) {
  text = String(text || "").trim()
  if (!text) return
  const box = $("composer-text")
  const at = box.selectionStart ?? box.value.length
  const end = box.selectionEnd ?? at
  const before = box.value.slice(0, at)
  const after = box.value.slice(end)
  const words = `${before && !/\s$/.test(before) ? " " : ""}${text}${after && !/^\s/.test(after) ? " " : ""}`
  box.value = before + words + after
  box.selectionStart = box.selectionEnd = before.length + words.length
  box.dispatchEvent(new Event("input"))
  box.focus()
}

/** Stop a recording (a chat closed, the window hidden): what was said is still written down. */
export function stopDictating() {
  if (recorder?.state === "recording") recorder.stop()
}

// --- Read aloud -----------------------------------------------------------------------------------

let playing = null // { id, audio, button }

/** A reply's words without the markdown around them, and without its code. */
export function plain(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function stopReading() {
  if (!playing) return
  playing.audio?.pause()
  playing.button.setAttribute("aria-pressed", "false")
  playing.button.classList.remove("is-busy")
  playing = null
}

/** The Read aloud button of a reply (`id`), reading `text()` when pressed; null where it cannot. */
export function readAloudButton(id, text) {
  if (!canSpeak()) return null
  const label = t("Read this aloud")
  const b = h("button", { type: "button", class: "msg__act msg__speak", "aria-label": label, title: label, "aria-pressed": "false" }, icon(ICONS.speaker))
  b.addEventListener("click", async () => {
    if (playing?.id === id) return stopReading()
    stopReading()
    const words = plain(text())
    if (!words) return
    const mine = { id, audio: null, button: b }
    playing = mine
    b.setAttribute("aria-pressed", "true")
    b.classList.add("is-busy")
    try {
      const url = await invoke("speak", { text: words })
      if (playing !== mine) return
      // Only audio the app's own server sent, as Rust read it: a data: URL of an audio type.
      if (!/^data:audio\/[a-z0-9.+-]+;base64,/i.test(url)) throw new Error(t("The server's answer was not audio."))
      mine.audio = new Audio(url)
      b.classList.remove("is-busy")
      mine.audio.addEventListener("ended", () => playing === mine && stopReading())
      await mine.audio.play()
    } catch (err) {
      if (playing === mine) stopReading()
      say(why(err?.message ? { detail: err.message } : err))
    }
  })
  return b
}

/** What the account may use, from `GET /me`: the composer's Dictate button is drawn by it. */
export function voiceFor(account) {
  me = account
  drawMic()
}

export function initVoice() {
  const b = $("dictate")
  b.replaceChildren(icon(ICONS.mic))
  b.addEventListener("click", () => {
    if (busy) return
    if (recorder) recorder.stop()
    else start()
  })
  drawMic()
}
