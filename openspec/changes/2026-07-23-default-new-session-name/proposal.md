## Why

The view-title **New Session** (`+`) command opens an empty input box, so every
create forces the user to invent and type a name first — even for a quick,
throwaway session. Offering a sensible, always-valid suggested name lets Enter
create immediately, while anyone who wants a real name just types over it. The
suggestion is **opt-in** so the tool's current behaviour is preserved for users
who don't want it, and the prefix is tunable to a user's own convention
(e.g. `wip-`, `claude-`) or droppable entirely.

## What Changes

- Add a `dtachSessions.suggestSessionName` boolean setting, **default `false`**.
  While off, the New Session (`+`) box opens empty (unchanged behaviour); while
  on, it opens pre-filled with a suggested default name.
- The suggested name has the form `<prefix><hash>` (e.g. `new-a1b2c3`), where
  `<hash>` is a freshly generated 6-character lowercase-hex string from the
  existing `sessionHash()` generator, and the pre-filled text is fully selected
  so typing replaces it and Enter accepts it unchanged.
- The prefix is a new `dtachSessions.suggestSessionNamePrefix` string setting, default
  `new-`. It is distinct from the existing `socketPrefix` (which prefixes the
  socket *filename* for every session); `suggestSessionNamePrefix` only seeds the
  suggested *display name* on create, and has no effect while
  `suggestSessionName` is off.
- The prefix MAY contain a supported subset of VS Code predefined variables,
  expanded at the point of use: `${workspaceFolderBasename}` and
  `${workspaceFolder}` (first workspace folder), `${userHome}`, and
  `${env:NAME}`. Editor-dependent variables (`${file}`, `${lineNumber}`, …) and
  any other unsupported or unresolvable token expand to the empty string. This
  lets a user name sessions after the project, e.g. `${workspaceFolderBasename}-`.
- The prefix can be entered two ways — the Settings UI and `settings.json` —
  and neither is guaranteed to reject a malformed value. The extension SHALL
  therefore guard at the point of use: after variable expansion, sanitise the
  composed `<prefix><hash>` (the same transform folder basenames already get —
  `/` and whitespace collapse to `-`, so an expanded path stays valid too) so the
  pre-fill is always a valid session name. An empty prefix yields a suggestion of
  just the hash.
- Scope is the view-title `+` command only. The Explorer "Open in Detach
  Session" QuickPick keeps its folder-name default; "New Session Here" keeps
  auto-naming from the source session's family. Neither changes.
- The suggestion is a **display-name** convenience only; it is independent of the
  socket's own `_<hash>` id, which `createSession` still mints separately on
  create. The two hex values will differ, by design.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `session-create`: the "Create session command" requirement is generalised to
  an empty box by default with an opt-in pre-filled suggestion; a new "Session
  name suggestion toggle" requirement adds the default-off boolean, and a new
  "Default new-session name prefix" requirement adds the configurable,
  use-time-sanitised prefix.

## Impact

- `src/extension.ts`: a new pure `expandVariables()` helper resolves the
  supported variable subset; `create()` pre-fills `showInputBox` only when
  `suggestSessionName` is on, composing
  `<expandVariables(suggestSessionNamePrefix)><sessionHash()>` and sanitising it
  via the existing `sanitizeName`; otherwise the box opens empty. `prompt` and
  `validateInput` are unchanged.
- `src/provider.ts`: `DtachConfig` gains `suggestSessionName` and
  `suggestSessionNamePrefix`; `config()` reads both (defaults `false` / `new-`).
- `package.json`: new `dtachSessions.suggestSessionName` and
  `dtachSessions.suggestSessionNamePrefix` configuration properties.
- No new dependencies or persisted state.
