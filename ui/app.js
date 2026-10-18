// The first-run page. It talks to the app over Tauri's IPC — the commands in src-tauri/src/lib.rs.
// The server's own pages never get this: they are remote content with no capability.
// Every word shown goes through `t` (i18n.js, loaded before this), in the system's language.
"use strict"

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const $ = (id) => document.getElementById(id)

const AGENT = {
  off: () => [t("The agent is off."), ""],
  not_linked: () => [t("This computer is not linked to the server yet."), ""],
  starting: () => [t("The agent is starting…"), ""],
  running: () => [t("The agent is running: agent chats can use this computer."), "is-ok"],
  elsewhere: (pid) => [t("A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.", { pid }), "is-ok"],
  failed: (why) => [t("The agent stopped: %(why)s. Trying again shortly.", { why }), "is-error"],
}

function render(s) {
  window.lembasTheme.apply(s.theme)
  $("version").textContent = s.version
  if (s.server && !$("address").value) $("address").value = s.server
  $("agent-section").hidden = !s.server
  const noFolders = s.remote && !(s.remote.enabled && s.remote.roots.length)
  const [text, cls] =
    s.agent.state === "running" && noFolders
      ? [t("The agent is connected, but may open no folder yet: add one below."), "is-error"]
      : (AGENT[s.agent.state] ?? AGENT.off)(s.agent.detail)
  const status = $("agent-status")
  status.textContent = text
  status.className = `status ${cls}`
  $("link").textContent = s.linked ? t("Link again") : t("Link this computer")
  $("toggle").textContent = s.agent_wanted ? t("Stop the agent") : t("Start the agent")
  $("toggle").disabled = !s.linked && !s.agent_wanted
  renderFolders(s)
}

function renderFolders(s) {
  const r = s.remote
  $("folders-section").hidden = !s.server || !s.linked || !r
  if (!r) return
  const list = $("folders")
  list.replaceChildren()
  if (!r.enabled || !r.roots.length) {
    const li = document.createElement("li")
    li.className = "empty"
    li.textContent = t("No folder yet: the agent can open nothing. Add the folder of a project.")
    list.append(li)
  }
  for (const dir of r.enabled ? r.roots : []) {
    const li = document.createElement("li")
    const path = document.createElement("span")
    path.className = "path"
    path.title = dir
    const inner = document.createElement("bdi")
    inner.textContent = dir
    path.append(inner)
    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = "btn"
    remove.textContent = t("Remove")
    remove.setAttribute("aria-label", t("Remove %(dir)s", { dir }))
    remove.addEventListener("click", () => invoke("remote_remove", { dir }))
    li.append(path, remove)
    list.append(li)
  }
  if (r.max_mode) $("max-mode").value = r.max_mode
  $("terminal").checked = !!r.terminal
  $("folders-status").className = "status"
  $("folders-status").textContent = ""
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
  hint.textContent = t("Looking for a LLeMbas server there…")
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

$("add-folder").addEventListener("click", () => invoke("remote_add"))
$("max-mode").addEventListener("change", (e) => invoke("remote_mode", { mode: e.target.value }))
$("terminal").addEventListener("change", (e) => invoke("remote_terminal", { on: e.target.checked }))

listen("remote-error", (e) => {
  $("folders-status").className = "status is-error"
  $("folders-status").textContent = String(e.payload)
})
listen("status", (e) => render(e.payload))
refresh()
invoke("remote_refresh")
