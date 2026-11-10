# Changelog

All notable changes to LLeMbas Desktop. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Approvals show again.** An agent asking to run a command, edit a file or carry out a plan
  stopped with "Waiting for you to allow bash…" and no card to answer it: drawing the card's
  buttons failed, and the space for it stayed empty. Stopping and asking again gave the same.
  Now the card shows, with the command in the box to correct before it runs (it used to show the
  words "Run a command" there instead), what the model says it is for, why it is asking, and which
  subagent asks when one does. A card already on the screen is kept as it is while the reply goes
  on, so a command being corrected or an option picked is no longer lost when the server sends
  the list again; a card that cannot be drawn says why instead of leaving an empty space.
- **Subagents after they are switched on.** The app read which models a new chat is offered
  subagents on only when it signed in, so subagents switched on (or a model added) on the server
  while the app stayed open in the tray never showed on a new chat until it was restarted. A new
  chat now asks the server again. (An agent chat has no Subagents setting: its subagents run on
  the computer, and the server offers none for it.)

### Added

- **Terminal.** An agent chat has a Terminal panel: a shell on the computer the chat works on, in
  its folder, beside the chat (over it in a narrow window). A new agent chat offers it as soon as
  the folder is chosen, before the first message -- and the chat that message makes carries on in
  the same shell. An open agent chat opens its own from the header, the same shell the web
  interface shows. **Send to chat** puts the selection, or the last command and its output, into
  the message box to read before sending; the panel copies them too, and steps between commands
  where the shell marks them. The terminal and the activity panel take turns beside the chat;
  closing either keeps the shell. Offered where the computer allows a terminal (needs the server's
  2.0.0-beta.8). The app opens the connection itself, with its sign-in: the page never holds it.
  "Continue in a terminal" is now in the chat's menu only.
- **What a reply is doing, the same way everywhere.** The line under a reply being written now
  says it in the words every LLeMbas client uses (harness spec 3.4.0): queued, waiting for a
  model and why, loading it, reading the prompt (with how far), thinking, writing (with its
  speed), running a tool and what it runs, waiting for you, waiting for subagents, compacting,
  retrying (counting down), stopped or failed -- each with how long it has lasted, kept moving
  every second. From a server that sends no such line (before 2.0.0-beta.8), the app shows the
  server's own words as before. Translations come with the server's.
- `tests/ui/`: the page under a headless browser against a stand-in for the app's bridge, with
  the server's answers as a table (`node tests/ui/run.mjs`, needs Playwright and a Chromium). CI
  runs it on every push (the `ui` job), with Playwright and its Chromium installed for the run.

## [1.0.0-beta.5] — 2026-11-09

Carries LLeMbas CLI 2.0.0-beta.5 and the look of LLeMbas 2.0.0-beta.7, which the Subagents
setting and the panel's compaction need.

### Changed

- **Subagents**, by that name everywhere. The chip under the message box says **Subagents** with the
  least and the most agents a chat runs ("Subagents 1–4"), and opens one slider with two handles,
  **Min** and **Max**, from 1 to the server's cap -- Min never passes Max, and both move with the
  arrow keys as well. The numbers count the chat's own agent: **1 is the agent alone**, with no
  subagents; Max 4 is the agent and up to 3 subagents. The chip shows where the
  server offers subagents for the chat (for a new chat, for its model), and the most is the
  server's cap. Where the chat's model serves one request at a time, it says that subagents need
  another model, on another server, named in the chat. Subagents work on the chat's own model
  unless you name another one in the chat -- there is no setting for a subagent's model. A
  scheduled task's field is **Subagents** too. Needs LLeMbas 2.0.0-beta.7 for the server's word on
  all of this; with an older one the app guesses as before.
- **The activity panel, reshaped.** A button in the chat's header opens it at any time, and the
  line above the message box shows only while something runs ("3 running · 1 queued · 2
  finished"). An agent chat's **Environment** (its folder, and where it is) comes first. **Context**
  says how far it is to the automatic compaction ("80.6k until auto-compact") beside a **Compact**
  button that summarises the earlier turns now (greyed while there is nothing to summarise). **Background tasks** lists subagents, a team's
  members and background commands under **Running**, each with how long it has run and a stop
  square, unfolding to what it is, its latest step, what it is writing and its conversation; the
  tasks under one fold beneath it ("Tasks: 2"), and the finished ones fold away under **Finished**.
  The team's **Room** and the **Plan** have sections of their own.

## [1.0.0-beta.4] — 2026-11-09

Carries LLeMbas CLI 2.0.0-beta.3 and the look of LLeMbas 2.0.0-beta.6. Scheduled tasks need LLeMbas
2.0.0-beta.6 or later.

### Fixed

- **An agent that could not link now gets its link.** Signing in asked the server for the agent's
  token only when the built-in LLeMbas CLI had no login for that server on file -- so a computer
  with an old login the server no longer takes got the app's own token alone, and the agent stayed
  refused. The sign-in now asks for the agent's token unless the agent's link works right now, and
  the CLI's new login replaces the old one. **Link this computer** (and **Link again**) is now its
  own approval for the agent's token, handed to the CLI the same way; before, it ran the CLI's own
  login, which for a server it was logged in to only refreshed the login it had.
- **"Refused" means the server refused**, and says the server's reason. A service that stopped for
  want of a login says *not linked*; any other reason, *stopped* with the reason.

### Changed

- **A new look, the shape of an AI desktop app.** A slim sidebar: **New chat**, a search line,
  **Scheduled**, **Files**, then your chats of both kinds -- agent chats and chats on the server --
  under *Today* and *Earlier*, an agent chat with its folder's name; **Settings** with your account
  at the foot. The sidebar folds away (its button in the title bar, or Ctrl+B) and is a drawer on a
  narrow window.
- **A new chat is a chat page.** A greeting, the choice of **Agent** (on this computer) or **Chat**
  (on the server), and the message box ready -- no form. What the chat starts with sits under the
  text as small chips, each opening a menu: the folder and the mode for an agent chat, the model
  with its picture, how hard it thinks (as the model offers it), and the team's size where a team
  is offered. An open chat has the same chips, and changing one changes the chat.
- **The conversation** in a centred column: your messages in bubbles on the right, with attached
  pictures as thumbnails and other files as tiles; replies full width; thinking and each tool call
  a compact row that unfolds. **Send** is a round button that **Stop** replaces while a reply is
  written.
- **The activity panel** opens from a chip above the message box, on every open chat; while
  agents work, the chip says what they are doing.
- **The agent's status** is a chip in the title bar that opens what the agent says and the one
  thing to do about it. When this computer is not linked -- or the server refused its link -- a
  new agent chat says so right above the message box, with **Link this computer** (or **Link
  again**) there, not only in Settings; while the approval waits, the code to compare is shown
  with Cancel.
- **Files** is a page of its own, with this computer's folders and your files on the server as
  two tabs. **Settings** is grouped -- Account, Agent, Project folders, Notifications, About --
  with the groups listed beside them.

### Added

- **Scheduled tasks** (with a server that has them, LLeMbas 2.0.0-beta.6 or later): the list
  with each task's next run, how its last run went and a switch to pause it, kept up to date as
  the server runs them; a task's page with what it does, when (and in which time zone), its
  model, effort, team and how it tells you, the next runs, and its history -- each run's status,
  time, whether it was late, caught up or run by hand, the model it ran on (and that it switched
  from a busy one), and its result to unfold in place, with its chat to open; earlier runs on
  request. **Run now**, **Edit**, pause and resume, and delete. A new task is said in your own
  words: the server reads them into a rule, a title and an instruction and shows the next five
  runs before you save; the title and instruction can be changed, and where the words give no
  time the days and the time can be set by hand. Each task's settings: when to tell you
  (*when it matters*, *always*, *never*), a new chat for each run or one that grows, its model
  (or the first free one of the scheduling models), its effort and its team. **Models** on the
  list chooses which models scheduled tasks may run on, each shown free or busy.
- **A scheduled task's result comes as a system notification** while the app runs, by the
  task's own setting: a result, never a run with nothing to report unless the task says
  *always*, nothing for *never*; a failure the first time, and on the third in a row the
  question whether to pause it. The app follows the server's event stream for this rather than
  asking every few seconds.

## [1.0.0-beta.3] — 2026-11-09

Carries LLeMbas CLI 2.0.0-beta.3 and the look of LLeMbas 2.0.0-beta.5. Needs a LLeMbas 2.0 server
(2.0.0-beta.5 or later for the activity panel, the Thinking switch and team sizes).

### Added

- **Attachments.** A message can carry files: the attach button beside the composer (the
  system's file dialog), files dropped anywhere on the window, or an image pasted into the
  composer. Each is sent to the server at once and shown above the composer with its size, or
  with the server's reason when it refused it; one taken off before sending is deleted on the
  server. The app sends only files you chose, dropped or pasted -- the page never names a path.
  Agent chats get them too.
- **Edit a message, regenerate a reply, copy either.** Under your messages, *Edit message*
  rewrites one in place and starts the reply again from there (everything after it is dropped,
  as the app says before you save; on the agent's device too); under the last reply,
  *Regenerate reply*. *Copy* puts a message, or a reply's text as Markdown, on the clipboard.
- **The chat's own menu** (⋯ in its header, or a right click on it in the sidebar): rename it,
  open it in the web interface in your browser, archive it, delete it (asked first).
- **Change a chat's model** from its header, and how hard it thinks as the model offers it: a
  model with one level shows nothing to choose; one that can switch thinking off and has one
  effort shows a **Think before answering** switch; more levels keep the selector. A new chat
  starts at the model's own start level, and the control follows the model you pick.
- **Agents, fewest and most**, beside it where the chat can have a team (a chat on the server,
  on a model that serves at least two requests at once, with subagents on): how many agents the
  chat's team may have, its own agent included. Saved at once in the header; on a new chat,
  left empty, your default stands. A pair the server will not take is said in its words, and the
  fields go back.
- **Model pictures**: a model the server has a picture for shows it in the pickers and under
  each reply; the others show their initial on a colour of their own -- the same colour the web
  interface gives them.
- **The activity panel** beside a chat (the header's bolt button, the strip above the message
  box, or the palette): what is in the chat's context, by category, against the model's window;
  the files the chat and its agents wrote, with lines added and removed, each opening in the
  viewer; every background agent -- a team's members as a tree, helpers and commands -- with what
  it was asked, its state, how long it has run, its model, its latest step and what it is
  writing, its whole conversation to read and a button to stop it (a member after you confirm,
  for those under it stop with it); the team's room, who wrote to whom and which messages are
  reports; and the plan. It keeps up by itself while the chat is open. The strip above the
  message box says what the agents are doing ("2 agents working · 1 queued") and opens it. On a
  narrow window the panel covers the chat; at phone width it fills the window.
- **Continue an agent chat in a terminal**: its menu and its header show the command that opens
  the agent's session in a terminal (`lembas -s …`, in the chat's folder), to copy. On this
  computer it names the LLeMbas CLI as it starts here -- the one on your PATH, else the app's own.
- **A command palette** (Ctrl+K): new chats, settings, the agent and updates by name, and every
  chat of both kinds by its title (accents optional). Ctrl+N starts a new chat of the tab you are
  on; Ctrl+, opens the settings.

### Changed

- **The agent's status is the CLI's own word.** The title bar and Settings no longer say
  *running* because a process runs: they say what the built-in LLeMbas CLI says of its link to
  the server -- connecting, running (linked), waiting and why (the server cannot be reached, the
  link dropped, a terminal on this computer holds the link), or refused and why. The same for a
  `lembas service` you run yourself. When the CLI says trying again will not help (the server
  refused this computer's token), the app no longer restarts it every second: it waits until you
  link the computer again. When the agent stops with an error, its last words are the reason
  shown, not just an exit status.

### Fixed

- A Czech sentence in the viewer was in Slovak; "Server files" and the composer's placeholder
  were not translated.

## [1.0.0-beta.2] — 2026-11-07

Carries LLeMbas CLI 2.0.0-beta.2 and the look of LLeMbas 2.0.0-beta.4.

### Changed

- **The agent keeps what its model has read** (LLeMbas CLI 2.0.0-beta.2, harness spec 3.1.0): the
  system prompt is made once per session and sent unchanged, so a local model's server reuses the
  whole conversation instead of reading it again; the date and anything that changes during a
  session come as a short note on your next message; the tools stay the same for the session;
  compaction is the next turn of the same conversation.

### Fixed

- **The editor highlights code again.** One of the editor's modules imported a file the app does
  not have, so every language that parses failed to load and files opened as plain text.

## [1.0.0-beta.1] — 2026-11-03

LLeMbas Desktop 1.0 becomes an app of its own: the agent on this computer by default, your
server's chats, two explorers and a viewer -- no longer a window onto the web interface. It needs a
LLeMbas 2.0 server.


Carries LLeMbas CLI 2.0.0-beta.1. Needs a LLeMbas 2.0 server (2.0.0-beta.1 or later).

### Changed

- **The app's own interface replaces the server's web pages.** The window shows the app's page
  (`ui/`, plain HTML, CSS and JavaScript modules, no build step): the chats, the transcript with
  its steps and tool calls, the reply as it is written, the questions and approvals that wait for
  an answer, and a composer. It talks to the server's `/api/v2`.
- **Agent chats first.** The sidebar opens on agent chats, those on this computer above those on
  your other devices; a new agent chat is started on this computer, in one of the agent's
  folders, with its mode and model. Chats on the server are the second tab.
- **One approval signs the app in and links this computer.** The app asks the server's device
  login for its own token (your chats, as the web interface reads and writes them, and dictation)
  and, in the same approval, for the agent's; the approval opens in your browser. The agent's
  token goes straight to the built-in LLeMbas CLI on its standard input (`lembas login
  --token-stdin`), which keeps it in its own configuration as `lembas login` does; the app never
  stores it. A computer linked already keeps its link, and **Link again** under Settings is still
  there. A server that cannot give both tokens from one approval gets the old two steps.
- The app's own token is not a device: the server lists it under *Apps*, and only the agent's
  link is among the devices an agent chat can start on.
- The look is still the server's: its design tokens, now copied from the 2.0 server, and its
  CodeMirror build for code (`scripts/fetch-vendor.sh`, pinned in `vendor.lock.json`). The
  window takes the account's theme.
- One window with one page: the second webview, and the Linux workaround it needed, are gone. The
  window still has the app's own title bar, and its edges resize it.
- The page's words, old and new, are in all nine of the server's languages.

### Added

- **Two explorers, kept apart**: this computer's -- the open agent chat's folder, or one of the
  agent's folders -- read only inside the agent's folders, and the server's files, through
  `/api/v2/files` with your own access. A server file that is not text, or too large, says so in
  your language instead of failing.
- **A viewer** beside the chat: Markdown drawn, code highlighted (read-only CodeMirror), text,
  and HTML in a sealed frame on its own address, with no access to the app, no network and no way
  to navigate. A file the agent shows (`show`) opens in it: from this computer for an agent chat
  running here, otherwise as the server keeps it (`/api/v2/chats/…/show`), checked against the
  chat's access when it is opened. A file that is gone, too large or not text says so.
- **Native notifications** when a reply or an agent chat finishes while you are elsewhere (on by
  default; Settings, Notifications).
- **A server older than LLeMbas 2.0 is refused** with a message saying which side to update, and so
  is a server whose app interface is newer than this app knows. What counts is the link protocol
  (3) and the app interface (`app_api` 2), not the server's version number.
- **Settings in the app**: the server and the sign-in, the agent and its folders, notifications
  and updates. There are no admin pages.
- When the app cannot start, it says why in `desktop.log` in its log directory, not only on a
  terminal nobody sees. A missing tray no longer stops it from starting.
- With NVIDIA's own driver, WebKitGTK's DMA-BUF renderer is turned off before the window opens
  (unless you have set `WEBKIT_DISABLE_DMABUF_RENDERER`): that renderer leaves the window blank or
  ends the app there, on Wayland most of all.

### Removed

- The server's web interface in the window, the microphone permission it needed, and the theme
  report the window read from it. The web interface stays in the browser, and as an installable
  web app.

### Fixed

- A release can no longer be quietly replaced under the same version: installing the same version
  again does nothing, so people with the broken copy never got the fix. The release workflow now
  refuses a tag that has a release already, unless it is run by hand to replace it.
- A beta's `.deb` sorts below the release that follows it (`1.0.0~beta.1` before `1.0.0`), so apt
  does not keep a beta over its release.

## [0.7.2] — 2026-10-25

Linking this computer again leaves one device, and LLeMbas CLI 1.5.2 inside.

### Changed

- Carries LLeMbas CLI 1.5.2. Linking this computer again no longer leaves an offline copy of it on
  the server holding its agent chats: the old link is signed out, and a LLeMbas server 1.7.2 or
  later moves its chats to the new one. When the agent cannot connect, its log (`agent.log` in the
  app's log directory) now says why -- a certificate that is not trusted, for instance -- instead
  of only "could not reach the instance".

## [0.7.1] — 2026-10-24

The microphone works, and LLeMbas CLI 1.5.1 inside.

### Fixed

- **Dictation said the microphone was blocked, with no way to allow it.** The server's page asks
  for the microphone, and a webview grants it only if the app answers: WebKitGTK refuses whatever
  it is not answered on, and shows no prompt of its own. Desktop now allows the microphone -- the
  microphone only, and only for the server's page in the content view; a camera or a screen still
  gets the platform's refusal.

### Changed

- Carries LLeMbas CLI 1.5.1: an image counts by its size, so a screenshot no longer makes the
  agent compact.

## [0.7.0] — 2026-10-20

Carries LLeMbas CLI 1.5.0: harness spec 2.0.0 — background work as jobs the person can see,
enter and stop, and subagents that run in the background and talk back.

### Changed

- Carries LLeMbas CLI 1.5.0. The agent on this computer runs subagents in the background, keeps
  every background command and subagent as a job of its session, and reports them to a LLeMbas
  server 1.6.0, which shows them in the chat with Stop and a message box.

## [0.6.0] — 2026-10-20

Carries LLeMbas CLI 1.4.0: harness spec 1.2.0, so the agent's memory, notes and skills are the
same tools as the server's.

### Changed

- Carries LLeMbas CLI 1.4.0. The agent on this computer and a LLeMbas server 1.5.0 now send a
  model the same library tools — `memory`, `note_view`, `note_manage`, `skills_list`,
  `skill_view`, `skill_manage` — whether the agent uses its own library or the server's.

## [0.5.0] — 2026-10-18

Carries LLeMbas CLI 1.3.0: a plan in every agent chat, the instance's instructions and
knowledge scope on the device, Edit and Regenerate on agent chats. The app's look comes from
the server's tokens and follows the page's theme; its own pages speak nine languages.

### Changed

- The app's own pages take their look from the server's `tokens.css`, copied by
  `scripts/fetch-tokens.sh` from a server tag and pinned in `tokens.lock.json` (the script with
  no argument verifies the copy). The hand copy had drifted: `--danger`, `--control-h` and
  `--text-xl` were not the server's. The pages name no colour, size or space of their own, and
  no font is bundled: the font rules are left out of the copy, so the title bar and the
  first-run page are set in the system's monospace face.
- The window's frame is painted in the theme's border colour read out of `tokens.css` at build
  time (`build.rs`), not a value written in Rust, and it changes with the theme.
- The first-run page and the title bar speak the system's language when it is one of the
  server's nine (Czech, German, Spanish, French, Hungarian, Italian, Polish, Slovak; English
  otherwise). `ui/i18n.js` is generated by `scripts/gen-i18n.py`: the sentences the server also
  has are translated as the server translates them, the app's own are in the script.

### Fixed

- The title bar followed the desktop's light or dark setting, not the account's theme, so it
  could be dark over the parchment (Shire) page. It now follows the server page: a script in the
  content view reports the page's theme to the app, which paints the frame, the title bar and
  the first-run page in it and remembers it for the next start. The server's pages still get no
  IPC; the report is a navigation attempt the app reads and refuses.
- The close button's hover colour was a literal white; it is the theme's inverse ink.

## [0.4.0] — 2026-10-14

Carries LLeMbas CLI 1.2.0, whose agent stays linked before any folder is allowed and follows
changes to its folders without a restart.

### Added

- **Project folders**: Settings… (in the title bar's and the tray's menu) lists the folders the
  agent may work in, with *Add folder…* (the system's folder dialog), *Remove*, the most an agent
  chat may do there, and whether the server may open a terminal. Turning the agent on with no
  folder chosen opens this page. Changes go through the bundled CLI (`lembas remote`).
- The server is told it is shown in LLeMbas Desktop and on which computer, so it lists this
  computer's device as **Local**, first.

### Fixed

- The title bar's menu opens under the button, not in the middle of the window.
- The agent no longer shows a green light while it may open no folder: the title bar says
  *agent: no folders*.

## [0.3.0] — 2026-10-14

### Added

- Updates: the app looks for a new release at start and every six hours, shows an **update**
  button in the title bar when there is one, and installs it (the .deb with the system's password
  prompt, an AppImage in place) after checking its signature. The menu can also check by hand.

### Fixed

- On Linux the server's page took only the lower half of the window, under an empty title bar
  area. The title bar is now its fixed height and the page takes the rest; the frame you resize
  the window by is drawn around both.

## [0.2.0] — 2026-10-14

### Added

- The window is LLeMbas's own: a title bar in the LLeMbas look with the server's address, the
  agent's state, a menu (the tray's items, plus Reload) and the window buttons. Closing still keeps
  the app in the tray. The server's pages stay in a view of their own, with no access to the app.

### Fixed

- The app icon is the leaf alone, on a transparent background, instead of a dark square tile.
- The window shows the app's icon instead of a generic one (the window, the menu entry and the
  package now share one name, `llembas-desktop`).
- The package is called `llembas-desktop` (it was `l-le-mbas`) and replaces the old one.
- The bundled LLeMbas CLI is installed in the app's own directory instead of as `/usr/bin/lembas`,
  where it could hide, or be hidden by, a `lembas` installed by hand.
- `SHA256SUMS` on the GitHub release no longer lists itself.

## [0.1.0] — 2026-10-14

The first alpha, for Linux. It carries LLeMbas CLI 1.1.0.

### Added

- The app: the server's web UI in a window of its own, a first-run page to choose the server, and a
  tray menu (open, start and stop the agent, link this computer, change server, quit).
- The agent: the bundled LLeMbas CLI runs as `lembas service` while the app runs, restarted when
  it fails and stopped cleanly on quit. A CLI service already running on the computer is used
  instead of starting a second one.
- Linking: `lembas login --json` with the approval page shown in the window.
- Linux packages (`.deb`, AppImage) built by GitHub Actions from a tag.
