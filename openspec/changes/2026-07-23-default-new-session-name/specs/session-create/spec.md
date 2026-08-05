## MODIFIED Requirements

### Requirement: Create session command
The extension SHALL provide a "+" command in the view title bar. Activating it
SHALL prompt the user for a session name via an input box, then open an
integrated terminal running `dtach -A <socket> -r <redraw> <shell>`.

When `dtachSessions.suggestSessionName` is disabled (the default), the input box
SHALL open **empty** — the tool's original create behaviour. When it is enabled,
the box SHALL open **pre-filled** with a suggested default name of the form
`<prefix><hash>` (see "Session name suggestion toggle" and "Default new-session
name prefix"), with the text fully selected so that typing replaces it and
accepting the input unchanged creates a session with that name.

#### Scenario: Suggestions disabled — empty box (default)
- **WHEN** `suggestSessionName` is at its default (`false`) and the user activates the create command
- **THEN** the input box opens empty

#### Scenario: Suggestions enabled — default name pre-filled
- **WHEN** `suggestSessionName` is `true`, `suggestSessionNamePrefix` is `new-`, and the user activates the create command
- **THEN** the input box opens pre-filled with `new-<hash>` (a 6-hex suffix) and the whole value is selected

#### Scenario: Accept the suggested name
- **WHEN** `suggestSessionName` is `true` and the user accepts the pre-filled value unchanged
- **THEN** a session named `<prefix><hash>` is created and the tree refreshes

#### Scenario: Successful create
- **WHEN** the user activates the create command, enters `api` (into an empty box, or over the selected suggestion), and `redrawMethod` is `winch`
- **THEN** a terminal opens running `dtach -A <socket> -r winch /bin/bash` (or `$SHELL`) for session `api` and the tree refreshes

#### Scenario: User cancels input
- **WHEN** user activates the create command but dismisses the input box
- **THEN** no terminal is opened and the tree is unchanged

## ADDED Requirements

### Requirement: Session name suggestion toggle
The extension SHALL provide a `dtachSessions.suggestSessionName` boolean setting,
default `false`. When `false`, the New Session (`+`) input box SHALL open empty,
preserving the tool's original create behaviour. When `true`, the box SHALL open
pre-filled with the sanitised suggested name `<prefix><hash>` (see "Default
new-session name prefix"), fully selected. The setting SHALL gate only the
pre-filled value; name validation, collision dedup, and the rest of the create
flow are identical in both states.

#### Scenario: Disabled by default
- **WHEN** a user who has never changed the setting activates the create command
- **THEN** the input box opens empty, exactly as before this feature

#### Scenario: Enabled
- **WHEN** `suggestSessionName` is `true` and the user activates the create command
- **THEN** the input box opens pre-filled with the sanitised `<prefix><hash>`, fully selected

### Requirement: Default new-session name prefix
The extension SHALL provide a `dtachSessions.suggestSessionNamePrefix` string setting
(default `new-`) supplying the prefix of the suggested name pre-filled in the New
Session (`+`) input box when `suggestSessionName` is enabled (see "Create session
command"). It is distinct from `socketPrefix`: `suggestSessionNamePrefix` affects only
the suggested display name offered on create, never the socket filename, and has
no effect while `suggestSessionName` is off.

The prefix MAY contain a supported subset of VS Code predefined variables,
expanded at the point of use before sanitisation: `${workspaceFolder}` and
`${workspaceFolderBasename}` (resolved from the first workspace folder),
`${userHome}`, and `${env:NAME}`. Editor-dependent variables and any other
unsupported or unresolvable token — including a workspace variable with no folder
open or a missing environment variable — SHALL expand to the empty string.
Expansion happens first; the sanitisation below then applies to the expanded
result.

Because the setting can be edited through both the Settings UI and
`settings.json`, and neither path can be relied on to reject an invalid value,
the extension SHALL guard the value at the point of use: the composed
`<prefix><hash>` SHALL be sanitised (the same transformation applied to a folder
basename — `/` and whitespace runs collapse to `-`, surrounding whitespace
trimmed) so the input box never opens pre-filled with a name that would fail
validation. An empty prefix SHALL yield a suggested name of just the hash. The
setting SHALL NOT constrain a name the user then types over.

#### Scenario: Configured prefix used
- **WHEN** `suggestSessionName` is `true`, `suggestSessionNamePrefix` is `wip-`, and the user activates the create command
- **THEN** the input box opens pre-filled with `wip-<hash>`

#### Scenario: Empty prefix
- **WHEN** `suggestSessionName` is `true`, `suggestSessionNamePrefix` is empty, and the user activates the create command
- **THEN** the input box opens pre-filled with just the 6-hex `<hash>`

#### Scenario: Prefix with invalid characters is sanitised
- **WHEN** `suggestSessionName` is `true` and `suggestSessionNamePrefix` is `my proj/` (set via the UI or `settings.json`) and the user activates the create command
- **THEN** the input box opens pre-filled with `my-proj-<hash>` (slash and whitespace collapsed to `-`) and is immediately valid

#### Scenario: Workspace folder name in prefix
- **WHEN** `suggestSessionName` is `true`, `suggestSessionNamePrefix` is `${workspaceFolderBasename}-`, and the first workspace folder is `/home/u/vscode-dtach-sessions`
- **THEN** the input box opens pre-filled with `vscode-dtach-sessions-<hash>`

#### Scenario: Path variable is sanitised after expansion
- **WHEN** `suggestSessionName` is `true`, `suggestSessionNamePrefix` is `${workspaceFolder}-`, and the first workspace folder is `/srv/api`
- **THEN** the expanded path's slashes collapse and the box opens pre-filled with `-srv-api-<hash>`

#### Scenario: Unsupported or missing variable expands to empty
- **WHEN** `suggestSessionName` is `true` and `suggestSessionNamePrefix` is `${file}-${env:NOPE}wip-` (an editor-dependent variable and a missing env var)
- **THEN** both tokens expand to empty and the box opens pre-filled with `wip-<hash>`
