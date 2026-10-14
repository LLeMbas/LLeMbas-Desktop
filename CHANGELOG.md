# Changelog

All notable changes to LLeMbas Desktop. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
