# Changelog

All notable changes to LLeMbas Desktop. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
