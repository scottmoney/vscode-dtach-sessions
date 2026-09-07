## MODIFIED Requirements

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
