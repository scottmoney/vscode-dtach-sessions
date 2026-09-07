# dtach Sessions

Minimal VS Code extension: lists [dtach](https://github.com/crigler/dtach)
sockets in a sidebar and attaches to them in native integrated terminals (no
webview/PTY proxy). Runs on the **remote** extension host (Remote-SSH), where
the sockets and binary live. See `README.md` for features, config, and
acceptance checks.

## Commands
```sh
npm run compile   # tsc -p ./  ->  out/   (also runs on vscode:prepublish)
npm run watch     # tsc -watch
npx @vscode/vsce package   # -> dtach-sessions-<version>.vsix
```
No test suite; verify against the acceptance checks in `README.md`.

## Architecture
- `src/extension.ts` — command handlers + orchestration (create/attach/rename/
  kill/detach/copy), terminal creation, `activate()` command registration.
- `src/provider.ts` — `DtachTreeProvider` (tree rendering), `config()`, and the
  socket/name utilities: `displayName`, `hashOf`, `findTerminalForSocket`,
  `socketFromTerminal`, `relativeAge`. Also the Claude-status read side:
  `readStatuses` and `statusLabel` (with staleness decay).
- `scripts/claude-status-hook.py` — the bundled Claude hook forwarder (shipped in
  the `.vsix`; copied to `~/.dtach-sessions/hook` on install). Stand-alone; no
  knowledge of VS Code config.
Shared helpers belong in `provider.ts`; command flow stays in `extension.ts`.

## Workflow
- Feature work is spec-first via **OpenSpec**: proposals/specs/tasks live in
  `openspec/changes/<change>/`. Use the `opsx:*` skills (propose/apply/archive).
- Git: branch session work, squash-merge onto the feature branch before upstream.
- **One commit per change on `main`.** Each archived OpenSpec change lands as a
  single squashed commit (subject = the change's headline, `openspec: <change>`
  footer folding in its propose/impl/refactor/archive steps). `chore(release)`
  bumps stay as standalone commits so version boundaries remain legible.

## Gotchas
- The extension host does **not** source `.bashrc` — `dtach` may not be on PATH;
  that's why `dtachSessions.dtachPath` exists.
- Socket names are `<prefix><name>_<hash>.dtach`. The `_<hash>` is a
  rename-invariant id: rename moves the socket keeping the hash; kill resolves
  the process by hash so renamed sessions aren't orphaned.
- `findTerminalForSocket` queries `vscode.window.terminals` live (not an
  in-memory map) so it survives a window reload, which restarts the extension
  host but restores terminals. A reload **strips a restored terminal's
  `shellArgs`** (the socket-in-args match then fails) but keeps its `processId`,
  so reattach falls back to a socket→terminal registry rebuilt on activate by
  matching live pids against a persisted `socket→pid` map (`workspaceState`).
- `dtachSessions.reflectProcessTitle` (default on) creates attach terminals
  **without** a fixed name so the program's title drives the tab; an API name's
  title source would otherwise override it. VS Code only honours an escape-set
  title from a detected agent CLI, so we can't seed the tab — instead dtach is
  launched via `bash -c 'exec -a "$0" "$@"' <name> <dtachPath> <args…>` so its
  `argv[0]` is the session name (VS Code reads `argv[0]` for the pre-title
  fallback). The socket stays a standalone `.dtach` arg so `socketFromTerminal`
  still matches. With no API name to match on after a reload, the pid-keyed
  registry above is what keeps reattach working.
- VS Code has no terminal-rename API. With `reflectProcessTitle` on, rename only
  re-keys the registry (the live attach survives the socket move by inode); with
  it off, rename disposes and recreates the terminal under the new name.
- Attached rows use a baked-green SVG (`media/terminal-green.svg`), not a
  recoloured codicon: VS Code washes codicon colour out on row selection. The
  blue detach/pause inline icon (`media/pause-blue.svg`) is baked for the same
  reason — inline action icons aren't per-command themeable.
- `SessionItem.contextValue` encodes attach state (`dtachSession-attached` /
  `dtachSession-detached`) so the per-row inline icons can swap: play (attach)
  on detached rows, pause (detach) on attached rows. Restart and Kill show on
  both via a `viewItem =~ /^dtachSession-/` clause. Existing context-menu
  entries gate on `view ==` (not `viewItem`), so they're unaffected by the split.
- Restart = confirm → `killOne` → `createSession(name)`: it composes the kill
  and create paths (fresh hash, fresh terminal, re-runs `startupCommand`); the
  dtach server and its scrollback do not survive.
- Stale-client reaping (`reapStaleClientsOnAttach`, default on): a dtach master
  tees its pty to **every** client under one shared winsize with no retained
  buffer, so a client orphaned when its terminal died (window close, SSH drop)
  wedges on the socket and a later attach gets a cursor on a blank screen. Kills
  must be **`SIGKILL`** — a wedged client blocks `SIGTERM` (it only polls for it
  inside the `select()` loop that never wakes without a tty); this is why
  `killOne` uses `kill -9`. Detection is by pid identity: `staleClientPids`
  takes the socket's `-a` clients (via `resolvePidsCommand`, then filtered on a
  bare `-a` in `/proc/<pid>/cmdline` so the `-A` master is never touched) minus
  this window's live terminal pid (`findTerminalForSocket` → `term.processId`,
  which **is** the client pid because `exec -a` replaces bash in place). It
  returns `undefined` (skip) when a matched terminal's pid hasn't resolved, so a
  live client is never killed mid-spawn — and this pid-diff is what spares a
  reload-restored client (its pid survives and re-matches) where a blind
  "kill every client on the socket" would not. Reap fires only on the
  create-fresh branch of `showOrCreateTerminal` (making it and the attach path
  async), never on reuse; `createSession` passes `reapOnCreate` false since a new
  socket can't have clients. Reaping only kills clients — master and socket
  survive. Manual `Reap Stale Clients` (row) / `Reap All Stale Clients` (view
  title) cover the already-attached blind spot. Linux `/proc` only.
- Live Claude status (`showClaudeStatus`, default on) is hook-driven, not from
  PTY/transcript scraping. The bundled `scripts/claude-status-hook.py` forwarder
  is merged into every lifecycle event in `~/.claude/settings.json` by the
  Install command (idempotent; ours is recognised by the `HOOK_PATH` substring,
  so Uninstall is surgical). It runs host-global for **every** Claude on the box;
  it correlates to a session by walking `/proc` ppids to the dtach master and
  reading the `*.dtach` socket from its cmdline (the same standalone-arg the
  `exec -a` launcher preserves — `argv[0]` relabelling doesn't hide it), then
  writes `<socketDir>/status/<hash>.json` atomically. No `.dtach` ancestor ⇒
  cheap no-op. Status is carried in the row **description**, separate from the
  `contextValue` attach-state split above — run-state and attach-state compose
  on a row without either suppressing the other. Provider decays stale
  `working`/`tool` (not `waiting`/`done`) to age so a crashed Claude doesn't
  stick. The install **nudge** is gated on `~/.claude/` existing (the "runs
  Claude" signal — PATH is unreliable on the extension host) + not-installed + a
  `globalState` dismissal flag.
- The forwarder's event→state decision lives in one pure `resolve(event,
  payload)` (testable without `/proc`): `Stop`→`done`, `SessionStart`→`idle`,
  prompts/tool as before. **`Notification` is classified by its stdin
  `notification_type`** — only `permission_prompt` raises `waiting` (the amber
  bell); `idle_prompt` (auto-fires ~60s after a finished turn) and every other
  subtype return `None`, leaving the recorded state untouched so a finished
  session stays `done`. This keeps the bell = "genuinely blocked", so the
  activity-bar waiting count is trustworthy. Reads the subtype from the stdin
  payload (single hook registration — no per-matcher entries, so install/
  uninstall are unchanged). An extension upgrade needs **Install Claude Hooks
  re-run** to copy the new forwarder to `~/.dtach-sessions/hook`.
- Status presentation derives from one `effectiveState(status)` (decay applied
  once) so the badge, icon, and time can't disagree. Icon: `loading~spin`
  codicon for working/tool (motion is the cue, so the codicon-colour wash on
  selection is moot — that's *why* a spinner works where a coloured codicon
  wouldn't); baked amber bell `media/state-waiting.svg` for waiting (colour IS
  the signal, so it must be a baked SVG like `terminal-green.svg`); `$(check)`
  themed codicon for `done` — here colour is *not* load-bearing (a check's
  meaning rides on its shape), so a themed codicon is fine despite the selection
  wash, keeping `media/` lean; it is `charts.green` when attached and
  `disabledForeground` when **detached**, so a finished-and-dormant row recedes
  with its dimmed label — whereas the urgent waiting bell stays full-strength
  when detached; the attached/plain terminal icon at rest. `waiting` and `done` don't decay (both are legitimate resting states —
  `done` persists until the next prompt). The row's relative time is
  `relativeAge(status.ts)` when a status exists (activity-relative — tracks the
  agent), falling back to socket `mtimeMs` otherwise; the tooltip keeps the
  honest mtime "last modified".
- Session **liveness** (`alive` on `DtachSession`) comes from one in-process read
  of `/proc/net/unix` (`readBoundSockets`), joined per row in `listSessions`:
  `st.isSocket()` only asks whether the file is a socket, and a master that dies
  abnormally (host reboot, OOM, `kill -9`) leaves it behind — a clean exit
  unlinks. Only listening rows (`St 01`) count, since a path is also recorded for
  each accepted connection and a client wedged on a dead socket would otherwise
  read as alive. It is read per-refresh, not once at activate, or it goes stale
  the moment a master dies mid-session. An unreadable table ⇒ everything alive,
  collapsing to pre-liveness behaviour (Linux `/proc` only, like the reaper).
  Rejected: a `connect()` probe (touches a live master, which tees one pty to
  every client under a shared winsize, on every refresh); `pgrep -f` (matches any
  cmdline mentioning the path — including the shell doing the match); `ss -lx`
  (an exec and an iproute2 dep for what `/proc` hands over); `/proc/stat` `btime`
  vs socket mtime (catches only reboot-stale, not a mid-session OOM kill).
  A path is **not** always recorded as dtach was given it: `sun_path` caps a unix
  address at 108 bytes, so dtach `chdir`s to the socket's directory and binds the
  bare basename when the path is longer. Short paths (the default socketDir) show
  absolute, long ones show basename-only — hence `socketIsBound` matching either
  form; matching only the absolute path read every session under a long
  `socketDir` as dead. Basename matching is safe because socket names carry a
  per-session `_<hash>`, and it errs toward "alive" (pre-liveness behaviour).
  Related: `lsof -t <socketpath>` returns **empty for a live unix socket** (a
  path arg doesn't match one — that needs `-U`), so the `lsof -t … || pgrep …` in
  `resolvePidsCommand` always falls through to pgrep; the comment there claiming
  lsof is primary is wrong, behaviour is not.
- A dead socket is **restarted in place** on attach, not reported: `dtach -A`
  re-binds a stale path, so the session keeps its name and `_<hash>` — and with
  them its status file and pid-registry key. Deliberately not routed through
  `restart`, which mints a fresh hash and socket and would orphan the status
  file; and cwd is *not* preserved, because `sessionCwd` reads it off a live
  process (the master's shell child, via `lsof`) and there isn't one. Branching
  **before** the terminal is created is also what fixes the
  `dtachSessions.dtachPath` misdiagnosis: `dtach -a` on a dead socket exits in
  milliseconds with `Connection refused` *and* status 0, so it fell inside
  `maybeWarnLaunchFailure`'s exit-code-blind fast-close window. With no doomed
  terminal, that warning needs no change to mean what it says. There is
  deliberately **no** dead row state, Revive command, or Remove Dead command:
  the distinction stopped being load-bearing once clicking worked, `Kill` already
  removes a stale socket, and a reboot adds no rows.
- The `-A` master launch is sole-sourced in **`launchMaster`** (arg vector +
  `startupCommand` replay), shared by `createSession` and attach's restart
  branch; neither reaps (a new socket has no clients, a masterless one can't
  either). `refreshWhenReady` polls **`socketIsBound`**, not `fs.existsSync` —
  on the restart path the socket file is what *survived*, so an existence probe
  passes instantly and refreshes before dtach re-binds.
- `attach` is not the only `-a` launch: **`rename`** with `reflectProcessTitle`
  off disposes and relaunches `-a`, and a terminal matched by
  `findTerminalForSocket` does **not** prove a live master — so it skips the
  relaunch when the session is dead (a rename must not start a process). Those
  two, plus `createSession`, are every path reaching `trackTerminal`, i.e. every
  path that can trip the fast-close warning. `copyAttachCommand` still hands out
  `-a` for a dead socket on purpose: it copies an *attach* command, and a `-A`
  would silently create a session instead.
- `findTerminalForSocket` ignores terminals whose **process has exited**
  (`exitStatus !== undefined`) — VS Code keeps those in `window.terminals` until
  the tab is closed. A dtach client cannot outlive its master, so a session
  OOM-killed mid-session is guaranteed to have an exited terminal still matching
  its socket, and reusing it would `show()` a dead tab and skip the
  restart-in-place. Every other caller wants this too: an exited terminal isn't
  "attached", holds no reapable client pid, and can't be renamed into.
- Status suppression for a dead session happens in **`statusFor`** — the one join
  every consumer passes through — so the row badge, row icon, `countWaiting`
  badge, and `status` sort order cannot disagree, and a pre-reboot `waiting` can't
  leave a bell nothing is waiting on. It leaves the status *file* alone
  (`removeStatus` fires on kill, where intent is explicit), so the deliberate
  no-decay rule for `waiting`/`done` is untouched.
- Detached rows are dimmed via a `FileDecorationProvider`
  (`DetachedRowDecorations`), **not** a `TreeItem` treatment (VS Code has none):
  it tints the row **label** only and leaves `iconPath` untouched — so a detached
  session that needs you keeps its full-strength amber bell on a dimmed name.
  Decorations key off `TreeItem.resourceUri`, so each row gets a **synthetic**
  `dtach-session://<hash>` URI (`sessionResourceUri`) used purely as a key — a
  real socket path would hijack label/icon derivation (file-icon theme +
  filename). The provider holds a uri→session map re-keyed in `getChildren` via
  `sync()`, which fires `onDidChangeFileDecorations` for every row so dimming
  tracks attach-state on the same refresh signal as the icons; attach detection
  reuses `findTerminalForSocket` (pid-registry-backed), so it survives a reload.
