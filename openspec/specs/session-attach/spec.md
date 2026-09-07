# session-attach Specification

## Purpose

Attaching to a dtach session by opening a native VS Code integrated terminal whose shell process is `dtach`, with no webview or PTY proxy in between.

## Requirements

### Requirement: Attach on click
The extension SHALL open an integrated terminal attached to a dtach session when the user clicks a tree item. The terminal SHALL be created using `vscode.window.createTerminal` with `shellPath: 'dtach'` and `shellArgs` derived from the socket path and configured redraw method.

Before creating a terminal, the extension SHALL determine whether the session's
socket still has a dtach master. When it does not — the socket outlived its
master, typically because the host restarted — the extension SHALL start a fresh
master on the **same** socket path rather than attaching to a socket that cannot
serve the connection.

The restart SHALL preserve the session's display name and its `_<hash>`
rename-invariant id, and SHALL run the configured startup command as session
creation does. It SHALL NOT mint a new socket path or hash.

The restart SHALL NOT be required to reopen in the previous session's working
directory: that directory was a property of the shell process, which is gone.

The restart SHALL report itself once as information — naming the cause and
stating that the previous session's output is gone — and SHALL NOT ask for
confirmation, since the previous output is unrecoverable either way.

#### Scenario: Attach with winch redraw
- **WHEN** user clicks a session row and `redrawMethod` is `winch`
- **THEN** a terminal opens running `dtach -a <socket> -r winch` and is immediately focused

#### Scenario: Attach with ctrl_l redraw
- **WHEN** user clicks a session row and `redrawMethod` is `ctrl_l`
- **THEN** a terminal opens running `dtach -a <socket> -r ctrl_l`

#### Scenario: Attach with no redraw
- **WHEN** user clicks a session row and `redrawMethod` is `none`
- **THEN** a terminal opens running `dtach -a <socket>` with no `-r` flag

#### Scenario: Clicking a session whose master is gone restarts it in place
- **WHEN** the user clicks a session whose socket has no dtach master
- **THEN** a fresh master is started on the same socket path, a terminal opens attached to it, and the row keeps its name and hash

#### Scenario: An exited terminal is not reused instead of restarting
- **WHEN** the user clicks a session whose socket has no dtach master while a terminal for that session is still open but its process has exited
- **THEN** the exited terminal is not treated as an existing attachment, and the session is restarted in place

#### Scenario: The previous working directory is not recovered
- **WHEN** a session is restarted in place
- **THEN** the terminal opens at the default working directory, because the previous shell's cwd went with its process

#### Scenario: The restart is reported once
- **WHEN** a session is restarted in place because its socket had no master
- **THEN** an information message states that the session was restarted and that the previous output is gone, with no confirmation prompt

#### Scenario: A restarted session runs the startup command
- **WHEN** a session is restarted in place and a startup command is configured
- **THEN** the startup command runs in the restarted session

#### Scenario: No doomed terminal is created
- **WHEN** the user clicks a session whose socket has no dtach master
- **THEN** no terminal is created that attaches to the dead socket, and no warning naming `dtachSessions.dtachPath` is shown

### Requirement: Reflect process title setting
The extension SHALL provide a `dtachSessions.reflectProcessTitle` boolean setting, default `true`. The setting controls terminal naming for attach and create: when `true`, attach/create terminals are created without an API `name` so the attached program's title drives the tab; when `false`, the extension pins the session display name as the terminal name.

#### Scenario: Default value
- **WHEN** the setting is not configured
- **THEN** `reflectProcessTitle` resolves to `true`

#### Scenario: Disabled
- **WHEN** the user sets `dtachSessions.reflectProcessTitle` to `false`
- **THEN** attach/create terminals are named after the session

### Requirement: Terminal name
Terminal naming for an attach SHALL depend on `dtachSessions.reflectProcessTitle`.

When `reflectProcessTitle` is `false`, the terminal SHALL be created with an API `name` equal to the session display name (not the socket path).

When `reflectProcessTitle` is `true` (the default), the terminal SHALL be created **without** an API `name`. Because dtach is pure passthrough, an attached program's title — set via an OSC window-title escape sequence — reaches the VS Code terminal and, with no API name overriding it, drives the tab title and updates live. The session's stable identity remains the sidebar row, not the tab.

#### Scenario: Reflect disabled keeps the session name
- **WHEN** `reflectProcessTitle` is `false` and the user attaches to session `api`
- **THEN** the terminal is created with `name: "api"` and the tab title is `api`

#### Scenario: Reflect enabled surfaces the program title
- **WHEN** `reflectProcessTitle` is `true` and the user attaches to a session whose program sets a window title via OSC
- **THEN** the terminal is created without an API name and the tab shows the program's title, updating as the program changes it

#### Scenario: Reflect enabled with a plain shell
- **WHEN** `reflectProcessTitle` is `true` and the attached program is a plain shell that sets no title
- **THEN** the tab shows VS Code's default process/shell title rather than the session name

### Requirement: Configurable dtach binary
The attach command SHALL use the binary named by the `dtachSessions.dtachPath` setting (default `dtach`) as the terminal `shellPath`. The same setting SHALL be used by the create and kill commands.

#### Scenario: Default binary
- **WHEN** `dtachPath` is unset
- **THEN** the terminal `shellPath` is `dtach`, resolved against the extension-host PATH

#### Scenario: Absolute binary path
- **WHEN** `dtachPath` is set to `/home/user/.local/bin/dtach`
- **THEN** the terminal `shellPath` is that absolute path

### Requirement: Reuse existing terminal
Clicking a session that already has a live terminal SHALL focus that terminal rather than opening a second attach. The lookup SHALL query the live `vscode.window.terminals` list rather than an in-memory map, so reuse survives a window reload — which restores terminals but restarts the extension host.

A terminal SHALL be matched to a session by, in order: (1) the socket path in the terminal's launch args (`shellArgs`); then (2) a persisted `socket → processId` association recorded at attach/create time, compared against the terminal's `processId`. The pid fallback is required because a window reload destroys a restored terminal's `shellArgs` while preserving its `processId`, and because — when `reflectProcessTitle` is `true` — there is no API name to match on. When `reflectProcessTitle` is `false`, an additional fallback to `terminal.name === session display name` MAY be used.

A terminal whose process has exited SHALL NOT be matched by any of those rules.
VS Code keeps an exited terminal in `vscode.window.terminals` until its tab is
closed, and such a terminal is not an attachment: its dtach client is gone. This
is load-bearing for restarting a session in place, because a dtach client cannot
outlive its master — so a session whose master died mid-session is certain to
have an exited terminal still matching its socket, and matching it would focus a
dead tab instead of restarting the session.

The persisted association SHALL be recorded in `workspaceState` when a terminal is attached or created, and SHALL be removed when that terminal is closed.

#### Scenario: Repeat click focuses existing terminal
- **WHEN** user clicks a session that already has a live terminal
- **THEN** the existing terminal is shown and no second terminal is created

#### Scenario: Reuse after window reload
- **WHEN** the user reloads the window with a session's terminal open, then clicks that session
- **THEN** the restored terminal is matched by its persisted `processId` and focused, and no second terminal is created

#### Scenario: Click after terminal closed
- **WHEN** the user closed the session's terminal and then clicks the session again
- **THEN** a new terminal is created and attached, and a fresh `socket → processId` association is recorded

#### Scenario: An exited terminal is not matched
- **WHEN** a session's terminal process has exited but its tab is still open, and the user clicks that session
- **THEN** the exited terminal is not matched, and the session is attached (or restarted in place, if its master is gone) in a new terminal

### Requirement: Native terminal features
Because the terminal is an ordinary integrated terminal with dtach as the shell process, the extension SHALL NOT intercept or translate mouse events, clipboard operations, or scroll input. These MUST pass through to the dtach-attached program unchanged.

#### Scenario: Mouse select
- **WHEN** the user drag-selects text in an attached terminal
- **THEN** the selection is handled by the VS Code terminal renderer natively

### Requirement: Quick-switch picker
The extension SHALL provide a command-palette command that opens a quick-pick listing the current sessions (most recent first), with which the user can fuzzy-find and select a session to attach. Selecting a session SHALL attach it using the same reuse-or-create behaviour as clicking its tree row.

#### Scenario: Switch to a session from the palette
- **WHEN** the user runs the quick-switch command and selects `api`
- **THEN** the `api` session is attached, reusing its open terminal if one exists

#### Scenario: No sessions
- **WHEN** the user runs the quick-switch command and no sessions exist
- **THEN** the quick-pick reports that there are no sessions and nothing is attached

#### Scenario: User dismisses the picker
- **WHEN** the user opens the quick-switch picker and dismisses it
- **THEN** no session is attached

### Requirement: Copy socket path and attach command
The extension SHALL provide context-menu commands to copy a session's socket path, and its full attach command (`dtach -a <socket> -r <redraw>`), to the clipboard.

#### Scenario: Copy socket path
- **WHEN** the user right-clicks a session and selects "Copy Socket Path"
- **THEN** the absolute socket path is placed on the clipboard

#### Scenario: Copy attach command
- **WHEN** the user right-clicks a session and selects "Copy Attach Command"
- **THEN** the clipboard contains the attach command for that socket using the configured redraw method and dtach binary

### Requirement: Detach command
The extension SHALL provide a "Detach" command that closes the current window's terminal for a session without terminating the dtach server, leaving the session alive for later reattachment. If no terminal is open for the session, the command SHALL be a no-op.

#### Scenario: Detach an open session
- **WHEN** the user invokes Detach on a session whose terminal is open in this window
- **THEN** the terminal is disposed, the dtach session remains alive, and the session still appears in the tree

#### Scenario: Detach with no open terminal
- **WHEN** the user invokes Detach on a session with no open terminal in this window
- **THEN** nothing happens and no error is shown

### Requirement: Inline attach and detach row actions
Each session row SHALL expose a single inline icon for its primary attach-state
action, gated on whether a terminal for the session is open in this window. A
row that is attached SHALL show a pause icon that invokes the Detach command; a
row that is not attached SHALL show a play icon that invokes the Attach command.
A row SHALL never show both at once. The pause icon SHALL be rendered in a
distinct colour (blue), using a baked-colour image asset rather than a recoloured
codicon, so its colour survives row selection — mirroring the green
terminal-open indicator. The detach inline action SHALL share the semantics of
the existing Detach command (no-op when no terminal is open).

#### Scenario: Attached row shows a blue pause action
- **WHEN** a session has a live terminal open in this window and the user hovers its row
- **THEN** a blue pause inline icon is shown and no play icon is shown

#### Scenario: Pause detaches without killing the server
- **WHEN** the user clicks the pause inline icon on an attached row
- **THEN** this window's terminal for the session is disposed, the dtach server remains alive, and the row updates to show the play icon

#### Scenario: Detached row shows a play action
- **WHEN** a session has no terminal open in this window and the user hovers its row
- **THEN** a play inline icon is shown and no pause icon is shown

#### Scenario: Play attaches the session
- **WHEN** the user clicks the play inline icon on a detached row
- **THEN** a terminal attaching to the session opens and the row updates to show the pause icon

### Requirement: Reap stale clients before creating a fresh attach
The extension SHALL, when an attach would create a new terminal for a session —
i.e. this window has no live terminal matched to the socket — and
`dtachSessions.reapStaleClientsOnAttach` is enabled, reap the socket's stale
clients and wait for the reap to complete before creating the terminal. This
SHALL apply to every path that creates a fresh attach terminal (row click,
inline play action, quick-switch, and open-in-folder attaching to an existing
session). Reuse of an already-open terminal SHALL NOT trigger a reap. Reaping
here SHALL follow the `stale-client-reaping` capability: clients only, never the
master, terminated with `SIGKILL`, non-destructive to the session.

#### Scenario: Fresh attach reaps first
- **WHEN** the setting is enabled and the user attaches to a session with a stale
  client but no live terminal in this window
- **THEN** the stale client is terminated, and only then is the new attach
  terminal created, so the new client is the sole client on the socket

#### Scenario: Reuse skips reaping
- **WHEN** the user attaches to a session that already has a live terminal in this window
- **THEN** the existing terminal is focused and no reap occurs

#### Scenario: Opt-out disables reap-on-attach
- **WHEN** `reapStaleClientsOnAttach` is `false` and the user attaches to a
  session with a stale client
- **THEN** the fresh terminal is created without reaping and the new client joins
  the existing clients
