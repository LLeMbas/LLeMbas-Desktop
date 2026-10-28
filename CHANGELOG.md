# Changelog

All notable changes to LLeMbas Desktop. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

LLeMbas Desktop 1.0 becomes an app of its own: the agent on this computer by default, your
server's chats, two explorers and a viewer -- no longer a window onto the web interface. It needs a
LLeMbas 2.0 server.

### Changed

- **The app's own interface replaces the server's web pages.** The window shows the app's page
  (`ui/`, plain HTML, CSS and JavaScript modules, no build step): the chats, the transcript with
  its steps and tool calls, the reply as it is written, the questions and approvals that wait for
  an answer, and a composer. It talks to the server's `/api/v2`.
- **Agent chats first.** The sidebar opens on agent chats, those on this computer above those on
  your other devices; a new agent chat is started on this computer, in one of the agent's
  folders, with its mode and model. Chats on the server are the second tab.
- **The app signs in on its own**, with the server's device login for one permission: to read and
  write your chats, as the web interface does. The approval opens in your browser. Linking this
  computer for the agent stays a separate step, and its approval opens in the browser too.
- The look is still the server's: its design tokens, now copied from the 2.0 server, and its
  CodeMirror build for code (`scripts/fetch-vendor.sh`, pinned in `vendor.lock.json`). The
  window takes the account's theme.
- One window with one page: the second webview, and the Linux workaround it needed, are gone. The
  window still has the app's own title bar, and its edges resize it.
- The page's words, old and new, are in all nine of the server's languages.

### Added

- **Two explorers, kept apart**: this computer's -- the open agent chat's folder, or one of the
  agent's folders -- read only inside the agent's folders, and the server's files.
- **A viewer** beside the chat: Markdown drawn, code highlighted (read-only CodeMirror), text,
  and HTML in a sealed frame on its own address, with no access to the app, no network and no way
  to navigate. A file the agent shows (`show`) opens in it.
- **Native notifications** when a reply or an agent chat finishes while you are elsewhere (on by
  default; Settings, Notifications).
- **A server older than LLeMbas 2.0 is refused** with a message saying which side to update, and so
  is a server whose app interface is newer than this app knows.
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
