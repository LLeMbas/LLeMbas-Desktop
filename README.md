# LLeMbas Desktop

Your [LLeMbas](https://llembas.eu) server in a window of its own, with the agent on this computer.

- **The whole web UI**: chats, agent chats, the library, reports, settings. Same account, models,
  permissions and credits as in the browser; the app is a front end to the server you already run.
- **The agent, built in.** LLeMbas Desktop carries the [LLeMbas CLI](https://github.com/LLeMbas/LLeMbas-CLI)
  and runs it in the background as this computer's device, so agent chats started on the server
  can work in your projects here, without a terminal.
- **Its own window**: a LLeMbas title bar with the agent's state and a menu (start and stop the
  agent, link the computer, reload, change server, quit). Close the window and the agent keeps
  running in the tray, which has the same menu.

> **Alpha.** Linux first (`.deb` and AppImage, x86-64). Windows and macOS later.

## Install

Download the `.deb` or the AppImage from the
[latest release](https://github.com/LLeMbas/LLeMbas-Desktop/releases/latest). Check it against
`SHA256SUMS` in the same release.

```sh
sudo apt install ./llembas-desktop_*_amd64.deb      # Debian, Ubuntu (replaces 0.1.0's l-le-mbas)
chmod +x llembas-desktop_*.AppImage && ./llembas-desktop_*.AppImage
```

On GNOME the tray needs the *AppIndicator* extension; without it, the title bar's menu has
everything, and starting the app again brings a hidden window back.

## Updates

LLeMbas Desktop looks for a new release when it starts and every six hours. When there is one, an
**update** button appears in the title bar (and *Install LLeMbas x.y.z…* in its menu; *Check for
updates…* otherwise). Installing asks for your password to update the `.deb` (an AppImage updates
itself), then the app starts again. Every package is checked against the release signing key
built into the app before anything is installed.

## Use

1. Start LLeMbas and enter your server's address. Sign in there as you would in a browser.
2. From the tray, **Link this computer**. The approval page opens in the window; approve it.
3. The agent starts. In the server's new-chat screen, choose this computer for an agent chat.

The agent is the LLeMbas CLI's `lembas service`, using the CLI's own configuration
(`~/.config/lembas`). The app's copy of the CLI lives in its own directory
(`/usr/lib/llembas-desktop/`), not on your `PATH`. If you also installed the CLI and run `lembas service` yourself, the app sees
it and does not start a second one: they are the same device.

## Build

Needs Rust (stable) and, on Linux, WebKitGTK 4.1 and an AppIndicator library:

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
scripts/fetch-cli.sh                 # the bundled CLI, checked against its release signature
cargo install tauri-cli --version "^2" --locked
cargo tauri dev                      # or: cargo tauri build
```

There is no Node and no bundler: the app's one local page is plain HTML, CSS and JavaScript in
`ui/`. Everything else on screen is the server's own web UI. The version of the CLI it carries is
in `lembas-cli.version`.

## Licence

MIT; see [LICENSE](LICENSE). The bundled LLeMbas CLI is MIT too, with its own third-party notices.
