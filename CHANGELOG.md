# Changelog

All notable changes to the **dtach Sessions** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-07

### Added

- **Sessions whose dtach process is gone are restarted in place.** A socket file
  outlives a dtach server that dies without cleaning up — a host reboot, an OOM
  kill, a `kill -9`. Clicking such a session now starts a fresh server on the
  same socket, under the same name and id, re-running `startupCommand`, and says
  so once: the previous output lived in the process that died, and the shell's
  working directory with it, so the terminal opens at the default. Everything
  else about the row is unchanged — there is no new "dead" state to learn, and
  **Kill** already removed a stale socket. Liveness is read from
  `/proc/net/unix`, so this is Linux hosts only; where it cannot be read, every
  session is treated as live and behaviour is exactly as before.

### Fixed

- **A session that outlived its server no longer blames
  `dtachSessions.dtachPath`.** Attaching to such a socket failed within
  milliseconds *with a success exit status*, so it landed inside the
  launch-failure window and was reported as a missing or mis-pathed `dtach`
  binary — sending you to a setting that was never the problem. No doomed
  terminal is created now, so that warning once again means what it says.
- **No more ghost "waiting" bell.** A session that recorded a Claude permission
  prompt before its process died kept showing the amber bell and counting toward
  the activity-bar badge indefinitely, because `waiting` deliberately never
  decays. A session with no server now presents no run-state at all. Its status
  file is left on disk; only an explicit **Kill** removes it.
- **A terminal whose process has exited is no longer treated as an attachment.**
  VS Code keeps exited terminals in its list until their tab is closed, so a
  session killed mid-run showed as **attached** with a green icon — claiming
  this window was driving it — and clicking the row focused the dead tab instead
  of reattaching. Such terminals are now ignored everywhere a session is matched
  to a terminal.
- **Rename no longer relaunches into a dead socket.** With
  `dtachSessions.reflectProcessTitle` off, renaming disposed the terminal and
  reattached; on a session whose server was gone that produced the same
  `dtachSessions.dtachPath` misdiagnosis. It now leaves the row detached — a
  rename does not start a process.

## [0.4.1] - 2026-07-13

### Fixed

- **Detached rows no longer flicker white on updates.** The detached-row dimming
  decoration was invalidated wholesale on every tree refresh, so a Claude status
  update — which never changes attach-state — flashed every dimmed row's label to
  full strength for a frame before re-dimming. The decoration now fires only for
  rows whose attach-state actually changed, and stays silent on status-only
  refreshes.
- Corrected the Explorer context menu label "Open in Detach Session" → "Open in
  dtach Session".

## [0.4.0] - 2026-07-07

### Added

- **Configurable session sort order.** A new `dtachSessions.sortBy` setting and a
  toolbar picker (**Set Sort Order**) order the list by **created** (default —
  unchanged), **last attached**, **name**, or **status** (an attention queue:
  waiting → working → done → idle). The status order reuses the same run-state
  the row icon and activity-bar badge already show, so it can never disagree with
  the rows.

### Changed

- **Multiple sessions per folder from the Explorer.** Right-click a folder →
  **Open in Detach Session** now opens a picker instead of silently reusing or
  creating: attach to any existing session in the folder's name family
  (`<folder>` and its `<folder>-N` siblings, newest-first, each showing live
  Claude status), or create a new numbered one. The prefilled folder name +
  Enter creates by default; attaching to an existing session is an explicit
  choice. **BREAKING**: the folder path no longer opens with zero prompts when
  no session exists yet — accepting the prefilled name is one Enter.
- Corrected the row tooltip and an internal note that claimed a socket's
  modification time moves on attach/detach. Nothing is ever written to a dtach
  socket, so `mtime` is pinned at creation — the tooltip now labels it "created"
  rather than "last modified".

## [0.3.3] - 2026-07-03

### Added

- **Legible dtach launch failures.** If a session's terminal dies the instant it
  opens — the sign of a missing or mis-pathed `dtach` — the extension now says
  so and offers an **Open Settings** button that jumps straight to
  `dtachSessions.dtachPath`, instead of leaving you with VS Code's raw "failed to
  launch" text. It reads the terminal's own launch result rather than probing the
  host, so it never false-warns on a working setup.
- **python3 check when installing Claude hooks.** Installing the status hooks now
  notes if `python3` cannot be found on the extension host, so a "hooks installed
  but no status ever appears" outcome is explained rather than silent.
  Installation still completes either way.

### Changed

- Documented that **Kill** relies on `lsof` or `pgrep` to confirm what it
  removes; without either it removes the socket without confirming the process is
  gone.

## [0.3.2] - 2026-07-02

### Added

- **`done` run-state.** When a Claude finishes its turn and hands back to you,
  its row now shows a calm green check and a "done" badge — "finished, your
  move" — instead of rendering as nothing. The state persists until the session
  is next prompted (it does not decay on age).
- **Detached rows are dimmed.** A session that is not attached in this window
  has its row label dimmed, so attach-state is always legible — even when a
  run-state icon owns the row icon. The urgent amber waiting bell stays
  full-strength on a dimmed row, so "dormant but needs you" stands out; the calm
  done check is muted to match the label, keeping a finished-and-detached row
  quiet.

### Changed

- **The amber "waiting" bell now means a genuine permission block only.** The
  status forwarder classifies Claude's `Notification` events by subtype: a
  permission request rings the bell; an idle prompt (which auto-fires ~60s after
  a finished turn) no longer does. The activity-bar waiting badge likewise counts
  only genuinely blocked sessions. *(Requires re-running "Install Claude Hooks"
  to pick up the updated forwarder.)*

## [0.3.1] - 2026-07-02

### Added

- **Attention badge on the activity-bar icon.** When one or more sessions are
  waiting on you, the dtach Sessions icon shows a count, so a session that
  needs your attention is visible even with the view collapsed. Only waiting
  sessions count; the badge clears once they are resolved. Follows
  `dtachSessions.showClaudeStatus`.

### Fixed

- Killing a session from the panel now also removes its leftover Claude status
  file, so status files no longer accumulate after kills. Covers single kills,
  multi-select, Kill All, and Restart.

## [0.3.0] - 2026-07-01

### Added

- **Stale client reaping.** A dtach client orphaned when its terminal died
  (window close, SSH drop) can wedge on the socket, leaving a later reattach
  with a live cursor on a blank screen. Attaching now reaps these orphans first
  so the new attach is the sole client and redraws cleanly
  (`dtachSessions.reapStaleClientsOnAttach`, on by default; disable if you
  deliberately attach one session from multiple windows). Reap on demand with
  **Reap Stale Clients** (row) or **Reap All Stale Clients** (view title).
  Reaping only ever kills clients — the session and its program keep running.
  Linux remote hosts only.

### Changed

- Kill now terminates sessions with `SIGKILL`, so a wedged client that blocks
  `SIGTERM` no longer survives a kill orphaned on the socket.

## [0.2.0] - 2026-06-29

### Added

- **Live Claude status on session rows.** Each row shows the run-state of a
  Claude Code instance running inside it — working, running a tool, waiting on
  you, or idle. State appears as a text badge and a row icon: a spinner while
  busy and an amber bell when Claude needs your attention. Enable it with the
  **dtach Sessions: Install Claude Status Hooks** command (or the one-time
  prompt); toggle with `dtachSessions.showClaudeStatus` (on by default). Linux
  remote hosts only.
- **Install Claude Status Hooks** and **Uninstall Claude Status Hooks**
  commands. Install wires a small forwarder into `~/.claude/settings.json`,
  merged alongside any hooks you already have; uninstall removes only its
  entries.

### Changed

- When live status is available, a row's relative time is measured from
  Claude's last activity (time in the current state, or since it last acted)
  instead of the socket's mtime.

## [0.1.6] - 2026-06-29

First public release on the Visual Studio Marketplace. Packaging and metadata
only — no behaviour changes.

### Added

- Marketplace gallery icon.

### Changed

- Search-friendly description and expanded keywords for discoverability.
- Repository, bugs, and homepage metadata.

## [0.1.5] - 2026-06-29

### Added

- Reflect the attached program's title in the terminal tab, so an agent CLI's
  live status drives the tab name (`dtachSessions.reflectProcessTitle`, on by
  default).
- Inline detach / attach / restart row actions on each session in the sidebar.

## [0.1.4] - 2026-06-28

### Added

- Panel quality-of-life: rename, quick-switch, copy socket path / attach
  command, detach, and kill-all.

## [0.1.3] - 2026-06-28

### Changed

- Open-or-create semantics for the folder context-menu command.

## [0.1.2] - 2026-06-28

### Fixed

- Dedupe session names on collision.

## [0.1.1] - 2026-06-28

### Added

- Folder context-menu command to create a session.

## [0.1.0] - 2026-06-28

### Added

- Initial release: list `dtach` sockets in a sidebar and attach to them in
  native integrated terminals on the remote extension host, with terminal
  reuse that survives a window reload.

[0.5.0]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jjsmackay/vscode-dtach-sessions/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jjsmackay/vscode-dtach-sessions/releases/tag/v0.1.0
