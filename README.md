# LLeMbas Desktop

The [LLeMbas](https://llembas.eu) agent on this computer, and the chats on your LLeMbas server, in
an app of its own.

- **The agent, built in, by default.** LLeMbas Desktop carries the
  [LLeMbas CLI](https://github.com/LLeMbas/LLeMbas-CLI) and runs it in the background as this
  computer's device. Agent chats work in your project folders here, without a terminal -- start
  them, follow them and answer them in the app.
- **Your server's chats** beside them: the same account, models and permissions as in the browser.
- **Two explorers, kept apart**: the agent's working directory on this computer, and your files
  on the server.
- **A viewer** for what you open and for what the agent shows you: Markdown drawn, code
  highlighted, text, and HTML in a sealed frame that can reach neither the app nor the network.
- **Notifications** when a reply or an agent's work finishes while you are elsewhere.
- **Its own window and tray**: close the window and the agent keeps running in the tray.

There are no admin pages: an administrator uses the server's web interface for that.

> **Beta (1.0).** Needs a **LLeMbas 2.0 server** or later; an older one is refused with a message
> saying so. Linux first (`.deb` and AppImage, x86-64). Windows and macOS later.

## Install

Download the `.deb` or the AppImage from the
[latest release](https://github.com/LLeMbas/LLeMbas-Desktop/releases/latest). Check it against
`SHA256SUMS` in the same release.

```sh
sudo apt install ./llembas-desktop_*_amd64.deb      # Debian, Ubuntu
chmod +x llembas-desktop_*.AppImage && ./llembas-desktop_*.AppImage
```

Installing a `.deb` of the version you already have changes nothing (apt calls it "already the
newest version"); `sudo apt reinstall ./llembas-desktop_*_amd64.deb` installs it again. If the app
does not start, the reason is in `~/.local/share/eu.llembas.desktop/logs/desktop.log`.

On GNOME the tray needs the *AppIndicator* extension; without it, the title bar's menu has
everything, and starting the app again brings a hidden window back.

## Updates

LLeMbas Desktop looks for a new release when it starts and every six hours. When there is one, an
**update** button appears in the title bar (and *Install LLeMbas x.y.z…* in its menu; *Check for
updates…* otherwise). Installing asks for your password to update the `.deb` (an AppImage updates
itself), then the app starts again. Every package is checked against the release signing key
built into the app before anything is installed. Betas are not offered as updates.

## Use

1. Start LLeMbas and enter your server's address. **Sign in**: the approval page opens in your
   browser, where you are signed in already; approve the code shown in the app. This sign-in lets
   the app read and write your chats, as the web interface does.
2. Under **Settings**, **Link this computer**: a second approval, which makes this computer a
   device the agent runs on. The agent starts.
3. Choose the folders the agent may work in (Settings, *Add folder…*); a new computer allows none
   until you do.
4. **New agent chat**: pick one of those folders, a mode and a model, and write.

The agent is the LLeMbas CLI's `lembas service`, using the CLI's own configuration
(`~/.config/lembas`). The app's copy of the CLI lives in its own directory
(`/usr/lib/llembas-desktop/`), not on your `PATH`. If you also installed the CLI and run
`lembas service` yourself, the app sees it and does not start a second one: they are the same
device.

### What can reach what

- The app's page is its own (`ui/`), and it is the only content with access to the app. No page
  of the server is ever loaded into the window, and the window goes nowhere else.
- The app's sign-in token stays in the app's Rust half (`account.json` in the app's config
  directory, readable by you only); the page asks for the server's `/api/v2` through it and never
  holds the token.
- The explorer reads only inside the agent's folders.
- HTML is shown in a sealed frame on an address of its own: scripts in it run, but it has no
  access to the app, no network and no way to navigate anywhere.
- Links in a reply open in your browser, and only web and mail links.

## Build

Needs Rust (stable) and, on Linux, WebKitGTK 4.1 and an AppIndicator library:

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
scripts/fetch-cli.sh                 # the bundled CLI, checked against its release signature
scripts/fetch-tokens.sh              # verifies ui/tokens.css against tokens.lock.json
scripts/fetch-vendor.sh              # verifies ui/vendor/ against vendor.lock.json
cargo install tauri-cli --version "^2" --locked
cargo tauri dev                      # or: cargo tauri build
```

There is no Node and no bundler: the app's page is plain HTML, CSS and JavaScript modules in
`ui/`. The version of the CLI it carries is in `lembas-cli.version`.

Three things in `ui/` are copied from the LLeMbas server and committed, each pinned:

- `ui/tokens.css`, the server's design tokens: `scripts/fetch-tokens.sh <server ref>` from a
  checkout of the server beside this repository (`../LLeMbas`, or `LEMBAS_SERVER`), pinned in
  `tokens.lock.json`.
- `ui/vendor/`, the server's vendored CodeMirror build: `scripts/fetch-vendor.sh <server ref>`
  checks every module against the server's own pin before copying it, and records both hashes in
  `vendor.lock.json`. The one change: the modules import each other by file name, since the page
  has no import map.
- `ui/i18n.js`, the page's words in the server's languages: `scripts/gen-i18n.py`, from the
  server's catalogues and the script's own table. Run it when a sentence on the page changes.

`scripts/check-ui.sh` parses the page's scripts and refuses any that sets HTML from a string;
`scripts/hygiene.sh` keeps private names out of this public repository. CI runs both, and starts
the built app under X11 and under Wayland (`scripts/ci-start.sh`).

## Licence

MIT; see [LICENSE](LICENSE). The bundled LLeMbas CLI is MIT too, with its own third-party notices.
CodeMirror and Lezer (in `ui/vendor/`) are MIT.
