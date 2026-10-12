// The first-run page. It talks to the app over Tauri's IPC — four commands, see src-tauri/src/lib.rs.
// The server's own pages never get this: they are remote content with no capability.
"use strict"

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const $ = (id) => document.getElementById(id)

const AGENT = {
  off: () => ["The agent is off.", ""],
  not_linked: () => ["This computer is not linked to the server yet.", ""],
  starting: () => ["The agent is starting…", ""],
  running: () => ["The agent is running: agent chats can use this computer.", "is-ok"],
  elsewhere: (pid) => [`A LLeMbas CLI service already runs here (pid ${pid}); it is this computer's agent.`, "is-ok"],
  failed: (why) => [`The agent stopped: ${why}. Trying again shortly.`, "is-error"],
}

function render(s) {
  $("version").textContent = s.version
  if (s.server && !$("address").value) $("address").value = s.server
  $("agent-section").hidden = !s.server
  const [text, cls] = (AGENT[s.agent.state] ?? AGENT.off)(s.agent.detail)
  const status = $("agent-status")
  status.textContent = text
  status.className = `status ${cls}`
  $("link").textContent = s.linked ? "Link again" : "Link this computer"
  $("toggle").textContent = s.agent_wanted ? "Stop the agent" : "Start the agent"
  $("toggle").disabled = !s.linked && !s.agent_wanted
}

async function refresh() {
  render(await invoke("get_status"))
}

$("server-form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const hint = $("server-hint")
  const button = e.target.querySelector("button")
  button.disabled = true
  hint.className = "hint"
  hint.textContent = "Looking for a LLeMbas server there…"
  try {
    await invoke("set_server", { address: $("address").value })
    // The window now shows the server.
  } catch (err) {
    hint.className = "hint is-error"
    hint.textContent = String(err)
  } finally {
    button.disabled = false
  }
})

$("link").addEventListener("click", async () => {
  try {
    await invoke("link_computer")
  } catch (err) {
    $("agent-status").className = "status is-error"
    $("agent-status").textContent = String(err)
  }
})

$("toggle").addEventListener("click", async () => {
  const s = await invoke("get_status")
  await invoke("set_agent", { on: !s.agent_wanted })
})

$("open").addEventListener("click", async () => {
  const s = await invoke("get_status")
  if (s.server) await invoke("set_server", { address: s.server })
})

listen("status", (e) => render(e.payload))
refresh()
