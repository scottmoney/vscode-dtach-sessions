import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import {
  DtachTreeProvider,
  DetachedRowDecorations,
  DtachSession,
  SessionItem,
  SortBy,
  config,
  findTerminalForSocket,
  registerTerminal,
  unregisterTerminal,
  rekeyTerminal,
  hashOf,
  statusDir,
  removeStatus,
  readStatuses,
  statusFor,
  statusLabel,
} from './provider';

const SHELL = process.env.SHELL || '/bin/bash';

// Used to relabel the dtach process via `exec -a` (a bash builtin) so the tab's
// fallback name reads the session, not "dtach". Absent on some minimal hosts;
// we fall back to launching dtach directly there.
const HAS_BASH = fs.existsSync('/bin/bash');

// Persisted socket -> pid map. Survives a window reload (which strips a restored
// terminal's shellArgs but keeps its pid) and is rebuilt into the in-memory
// reattach registry on activate. Lives in workspaceState — per-window, no need
// to outlast a full editor restart, which does not restore terminals anyway.
const PID_MAP_KEY = 'dtachSessions.socketPids';
let mementoState: vscode.Memento | undefined;

function pidMap(): Record<string, number> {
  return mementoState?.get<Record<string, number>>(PID_MAP_KEY, {}) ?? {};
}

/** Read-modify-write the persisted socket->pid map: set a pid, or clear it (pid null). */
function updatePidMap(socket: string, pid: number | null): void {
  if (!mementoState) {
    return;
  }
  const map = pidMap();
  if (pid === null) {
    delete map[socket];
  } else {
    map[socket] = pid;
  }
  void mementoState.update(PID_MAP_KEY, map);
}

function persistPid(socket: string, term: vscode.Terminal): void {
  void term.processId.then((pid) => {
    if (pid) {
      updatePidMap(socket, pid);
    }
  });
}

function dropPid(socket: string): void {
  updatePidMap(socket, null);
}

// Creation time of each terminal WE created (keyed by the terminal itself), for
// the launch-failure heuristic. A terminal that dies within this window of its
// creation looks like dtach failing to launch. VS Code fires onDidCloseTerminal
// for both launch paths (bash `exec` exiting 127, and a bad direct shellPath),
// so the fast close is the only trustworthy signal — an extension-host PATH
// probe would false-negative because the host does not source .bashrc (see the
// change design, decision D1). Reload-restored terminals are reconciled via
// registerTerminal, not trackTerminal, so they carry no stamp and never warn.
const LAUNCH_FAIL_WINDOW_MS = 1500;
const terminalCreatedAt = new Map<vscode.Terminal, number>();

/** Record a freshly created terminal for reattach: in-memory registry + persisted pid. */
function trackTerminal(socket: string, term: vscode.Terminal): void {
  registerTerminal(socket, term);
  persistPid(socket, term);
  terminalCreatedAt.set(term, Date.now());
}

/**
 * If a closing terminal is one we created that died within the fast-close
 * window, warn that dtach likely failed to launch and offer to open the
 * dtachSessions.dtachPath setting. Always clears the terminal's creation stamp.
 * Keys on ownership + timing only (not exit code): the direct launch path may
 * report no code, and a genuine session lives far longer than the window, so a
 * normal exit, Kill, detach, or reload-restored terminal never trips it.
 */
function maybeWarnLaunchFailure(term: vscode.Terminal): void {
  const created = terminalCreatedAt.get(term);
  terminalCreatedAt.delete(term);
  if (created === undefined || Date.now() - created >= LAUNCH_FAIL_WINDOW_MS) {
    return;
  }
  const { dtachPath } = config();
  void vscode.window
    .showWarningMessage(
      `dtach Sessions: the session terminal closed immediately — dtach could not launch. Check the dtachSessions.dtachPath setting (currently "${dtachPath}").`,
      'Open Settings'
    )
    .then((choice) => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'dtachSessions.dtachPath');
      }
    });
}

/**
 * Rebuild the reattach registry after a window reload. Restored terminals have
 * lost their shellArgs but kept their processId, so match live terminals' pids
 * against the persisted socket->pid map; prune entries whose terminal is gone.
 */
async function reconcileTerminals(provider: DtachTreeProvider): Promise<void> {
  if (!mementoState) {
    return;
  }
  const byPid = new Map<number, string>();
  for (const [socket, pid] of Object.entries(pidMap())) {
    byPid.set(pid, socket);
  }
  const terminals = vscode.window.terminals;
  const pids = await Promise.all(terminals.map((t) => t.processId));
  const survivors: Record<string, number> = {};
  terminals.forEach((t, i) => {
    const pid = pids[i];
    if (pid && byPid.has(pid)) {
      const socket = byPid.get(pid)!;
      registerTerminal(socket, t);
      survivors[socket] = pid;
    }
  });
  await mementoState.update(PID_MAP_KEY, survivors);
  provider.refresh();
}

function redrawArgs(redraw: string): string[] {
  return redraw && redraw !== 'none' ? ['-r', redraw] : [];
}

/** Single-quote a string for safe use inside a shell command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape regex metacharacters so a path matches literally in pgrep -f. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A fresh 6-hex-char rename-invariant session id. */
function sessionHash(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * dtach creates the socket file asynchronously after its process starts, so an
 * immediate refresh misses it. Poll briefly until the socket appears, then
 * refresh; give up (and refresh anyway) after ~3s.
 */
function refreshWhenReady(provider: DtachTreeProvider, socket: string): void {
  let tries = 0;
  const tick = (): void => {
    if (fs.existsSync(socket) || ++tries >= 15) {
      provider.refresh();
      return;
    }
    setTimeout(tick, 200);
  };
  tick();
}

/**
 * Show the terminal already attached to this session if one is open; otherwise
 * launch a fresh dtach terminal with the given args. Returns the new terminal,
 * or undefined when an existing one was reused.
 *
 * When `reapOnCreate` is set (the attach path), any stale clients on the socket
 * are reaped — and the reap awaited — before the fresh client is created, so the
 * new client is the sole one on the master and redraws cleanly. Reuse of an
 * existing terminal skips the reap entirely.
 */
async function showOrCreateTerminal(
  session: { name: string; socket: string },
  args: string[],
  dtachPath: string,
  cwd?: string,
  reapOnCreate = false
): Promise<vscode.Terminal | undefined> {
  const existing = findTerminalForSocket(session);
  if (existing) {
    existing.show();
    return undefined;
  }
  if (reapOnCreate && config().reapStaleClientsOnAttach) {
    await reapStaleClients(session);
  }
  // With reflectProcessTitle off, pin the session name as the tab title.
  //
  // With it on, omit the API name so the attached program's title drives the tab
  // (VS Code honours an escape-set title only from a process it detects as an
  // agent CLI, so we cannot seed one ourselves — the shell/dtach would be
  // ignored). Until the program emits its title, VS Code falls back to the
  // process name, which is "dtach". So launch dtach with argv[0] set to the
  // session name via bash `exec -a` (VS Code reads argv[0] for that fallback):
  // the tab reads the session name instead of "dtach", and the program's own
  // title takes over once it sets one. The socket stays a standalone, dtach
  // arg so socketFromTerminal still matches it. Where bash is unavailable we
  // launch dtach directly and accept the "dtach" fallback.
  const reflect = config().reflectProcessTitle;
  let options: vscode.TerminalOptions;
  if (!reflect) {
    options = { name: session.name, shellPath: dtachPath, shellArgs: args, cwd };
  } else if (HAS_BASH) {
    options = {
      shellPath: '/bin/bash',
      shellArgs: ['-c', 'exec -a "$0" "$@"', session.name, dtachPath, ...args],
      cwd,
    };
  } else {
    options = { shellPath: dtachPath, shellArgs: args, cwd };
  }
  const term = vscode.window.createTerminal(options);
  trackTerminal(session.socket, term);
  term.show();
  return term;
}

async function attach(session: { name: string; socket: string }): Promise<void> {
  const { redrawMethod, dtachPath } = config();
  const args = ['-a', session.socket, ...redrawArgs(redrawMethod)];
  await showOrCreateTerminal(session, args, dtachPath, undefined, true);
}

/**
 * Expand the supported subset of VS Code variables in a session-name-prefix
 * template. Only editor-independent variables are resolvable at create time (the
 * "+" command isn't scoped to a file), so we support `${workspaceFolder}`,
 * `${workspaceFolderBasename}` (both from the first workspace folder),
 * `${userHome}`, and `${env:NAME}`. Any other or unresolvable token — an
 * unsupported variable, a missing env var, or a workspace variable with no folder
 * open — expands to the empty string, so the result is always clean (the caller
 * still runs it through `sanitizeName`). Literal `$` not in `${...}` is left as-is.
 */
function expandVariables(template: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return template.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (name === 'workspaceFolder') {
      return folder ?? '';
    }
    if (name === 'workspaceFolderBasename') {
      return folder ? path.basename(folder) : '';
    }
    if (name === 'userHome') {
      return os.homedir();
    }
    const env = name.match(/^env:(.+)$/);
    if (env) {
      return process.env[env[1]] ?? '';
    }
    return '';
  });
}

/** Turn an arbitrary string (e.g. a folder name) into a valid session name. */
function sanitizeName(raw: string): string {
  return raw.trim().replace(/[/\s]+/g, '-');
}

/** A family sibling's name is the base plus this suffix pattern — shared by
 * `sessionFamily` (matching) and `familyBase` (stripping) so the numeric-suffix
 * convention lives in one place. */
const FAMILY_SUFFIX = '-\\d+';

/** Sessions in `base`'s name family: `base` itself and any `base-N` numeric
 * siblings, in `sessions`' given order (callers pass listSessions()'s
 * newest-first order through unchanged). Deliberately broader than
 * `uniqueName`'s own generation range (which only ever mints `-2`, `-3`, ...):
 * a sibling can also arise from a manual create or rename, so family
 * membership matches any numeric suffix, not just the ones `uniqueName` would
 * pick next. */
function sessionFamily(sessions: DtachSession[], base: string): DtachSession[] {
  const suffixed = new RegExp(`^${escapeRegex(base)}${FAMILY_SUFFIX}$`);
  return sessions.filter((s) => s.name === base || suffixed.test(s.name));
}

/** The family base of a display name: the name with a trailing `-N` numeric
 * suffix removed, matching `sessionFamily`'s notion of membership. So the base
 * of both `api` and `api-2` is `api` — cloning a sibling rejoins the family
 * (`api-2` → `api-3`) rather than nesting (`api-2-2`). */
function familyBase(name: string): string {
  return name.replace(new RegExp(`${FAMILY_SUFFIX}$`), '');
}

/** Return `base`, or `base-2`, `base-3`, ... — the first display name that is free. */
function uniqueName(existing: Set<string>, base: string): string {
  if (!existing.has(base)) {
    return base;
  }
  let n = 2;
  while (existing.has(`${base}-${n}`)) {
    n++;
  }
  return `${base}-${n}`;
}

/** Shared input validation for create and rename. */
function validateName(value: string, taken?: Set<string>): string | undefined {
  if (value.trim().length === 0) {
    return 'Name cannot be empty';
  }
  if (/[/\s]/.test(value)) {
    return 'Name cannot contain slashes or whitespace';
  }
  if (taken?.has(value)) {
    return `A session named "${value}" already exists`;
  }
  return undefined;
}

/**
 * Create a new session named `name` with a fresh hash id and launch it with
 * `dtach -A`. `cwd` sets the shell's working directory. Runs the configured
 * startup command in the new terminal. Returns false if the socket dir can't be made.
 */
async function createSession(
  provider: DtachTreeProvider,
  name: string,
  cwd?: string
): Promise<boolean> {
  const { socketDir, socketPrefix, redrawMethod, dtachPath, startupCommand } = config();
  try {
    fs.mkdirSync(socketDir, { recursive: true });
  } catch (err) {
    vscode.window.showErrorMessage(
      `dtach Sessions: cannot create socket directory ${socketDir}: ${(err as Error).message}`
    );
    return false;
  }
  // Embed a rename-invariant hash; regenerate on the rare same-name collision.
  let socket: string;
  do {
    socket = path.join(socketDir, `${socketPrefix}${name}_${sessionHash()}.dtach`);
  } while (fs.existsSync(socket));
  // A brand-new socket has no pre-existing clients, so no reap on this path.
  const args = ['-A', socket, ...redrawArgs(redrawMethod), SHELL];
  const term = await showOrCreateTerminal({ name, socket }, args, dtachPath, cwd);
  if (term) {
    if (startupCommand) {
      term.sendText(startupCommand, true);
    }
    refreshWhenReady(provider, socket);
  }
  return true;
}

/**
 * Create a NEW session named `name`, deduping the display name against current
 * sessions: if it's taken, bump a digit (`name-2`, `name-3`, …) so the tree
 * never shows two identical labels. `cwd` sets the shell's working directory.
 *
 * When the name is bumped, `bumpNotice` builds the toast. It defaults to a
 * collision warning — right for a user-chosen name, where a bump means "the name
 * you asked for was taken". Callers whose bump is expected (a family create,
 * where the base always collides with its own source) pass a neutral message so
 * the routine feedback isn't framed as a surprise.
 */
async function createDeduped(
  provider: DtachTreeProvider,
  name: string,
  cwd?: string,
  bumpNotice: (finalName: string) => string = (finalName) =>
    `dtach Sessions: "${name}" already exists; created "${finalName}".`
): Promise<void> {
  const taken = new Set(provider.listSessions().map((s) => s.name));
  const finalName = uniqueName(taken, name);
  if ((await createSession(provider, finalName, cwd)) && finalName !== name) {
    vscode.window.showInformationMessage(bumpNotice(finalName));
  }
}

/** The "+" command: prompt for a name and create a new session (display-name deduped).
 * When `suggestSessionName` is on the box opens pre-filled with a throwaway default
 * `<suggestSessionNamePrefix><hash>` (fresh each time, fully selected) so Enter creates
 * immediately and typing replaces it; when off (the default) the box opens empty — the
 * tool's original behaviour. The hash reuses `sessionHash()`; the suggestion is a
 * display-name convenience only, unrelated to the socket's own `_<hash>` (minted
 * separately by `createSession`) and to `socketPrefix` (the socket-filename prefix). The
 * prefix comes from settings and may be set via the UI or settings.json, so we expand its
 * supported `${...}` variables (see `expandVariables`) and then sanitize the *composed*
 * name at use time — the single guard that covers both input paths — keeping the pre-fill
 * always valid however the prefix was entered (any `/`/whitespace becomes `-`; empty ⇒
 * just the hash). */
async function create(provider: DtachTreeProvider): Promise<void> {
  const cfg = config();
  const defaultName = cfg.suggestSessionName
    ? sanitizeName(`${expandVariables(cfg.suggestSessionNamePrefix)}${sessionHash()}`)
    : undefined;
  const name = await vscode.window.showInputBox({
    value: defaultName,
    valueSelection: defaultName ? [0, defaultName.length] : undefined,
    prompt: 'New dtach session name',
    validateInput: (value) => validateName(value),
  });
  if (!name) {
    return;
  }
  await createDeduped(provider, name);
}

// `role` (not `kind`) is the discriminant: vscode.QuickPickItem already has a
// `kind` field (QuickPickItemKind, for separators), which would collide.
type FolderPickItem =
  | (vscode.QuickPickItem & { role: 'attach'; session: DtachSession })
  | (vscode.QuickPickItem & { role: 'new' });

/** The "New session" row; its label previews the sanitised name that will be
 * created (not the raw input) so the row can't promise a name `sanitizeName`
 * would rewrite. `alwaysShow` keeps it visible under VS Code's value-filter. */
function newSessionItem(value: string): FolderPickItem {
  const name = sanitizeName(value);
  const label = name ? `$(add) New session "${name}"` : '$(add) New session';
  return { role: 'new', label, alwaysShow: true };
}

/**
 * Explorer right-click "Open in Detach Session": show a QuickPick offering
 * every session in the folder's name family (attach) plus a "New session"
 * entry seeded from the folder basename. The "New session" row is the active
 * default, so the prefilled name + Enter creates; attaching to a family member
 * is an explicit choice. The input stays editable; attach rows are marked
 * `alwaysShow` so VS Code's own value-filtering can't hide them as the user
 * types a custom new-session name (design D2).
 */
async function openInFolder(provider: DtachTreeProvider, uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    await create(provider);
    return;
  }
  const base = sanitizeName(path.basename(uri.fsPath));
  const family = sessionFamily(provider.listSessions(), base);

  const { socketDir, showClaudeStatus } = config();
  const statuses = family.length && showClaudeStatus ? readStatuses(socketDir) : undefined;
  const attachItems: FolderPickItem[] = family.map((session) => ({
    role: 'attach',
    session,
    label: `$(plug) Attach: ${session.name}`,
    description: statusLabel(statusFor(session, statuses)),
    alwaysShow: true,
  }));

  const qp = vscode.window.createQuickPick<FolderPickItem>();
  qp.title = uri.fsPath;
  qp.placeholder = 'Session name';

  // Attach rows are offered above, but "New session" is the *active* row, so the
  // prefilled name + Enter creates by default (attaching is an explicit up-arrow
  // choice). Reassigning `items` resets the active row, so re-pin it on every
  // edit — otherwise Enter after typing would land on a leading attach row.
  const render = (value: string) => {
    const newItem = newSessionItem(value);
    qp.items = [...attachItems, newItem];
    qp.activeItems = [newItem];
  };
  qp.value = base;
  render(base);
  qp.onDidChangeValue(render);

  let attachTo: DtachSession | undefined;
  let newName: string | undefined;
  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    if (picked?.role === 'attach') {
      attachTo = picked.session;
      qp.hide();
      return;
    }
    if (picked?.role !== 'new') {
      return;
    }
    const name = sanitizeName(qp.value);
    if (!name) {
      // QuickPick has no InputBox-style validationMessage; keep the picker open,
      // surface create()'s own empty-name message as the item text, and keep it
      // active so a repeat Enter re-shows the error rather than attaching.
      const errorItem: FolderPickItem = {
        role: 'new',
        label: `$(error) ${validateName('')}`,
        alwaysShow: true,
      };
      qp.items = [...attachItems, errorItem];
      qp.activeItems = [errorItem];
      return;
    }
    newName = name;
    qp.hide();
  });
  await new Promise<void>((resolve) => {
    qp.onDidHide(resolve);
    qp.show();
  });
  qp.dispose();

  if (attachTo) {
    await attach(attachTo); // listSessions is newest-first; family preserves that order
    return;
  }
  if (newName) {
    await createDeduped(provider, newName, uri.fsPath);
  }
}

/** Rename a session: move the socket (hash preserved) and relabel any open terminal. */
async function rename(provider: DtachTreeProvider, session: DtachSession): Promise<void> {
  const hash = hashOf(path.basename(session.socket));
  if (!hash) {
    vscode.window.showInformationMessage(
      'dtach Sessions: this session has no id in its socket name and cannot be safely renamed. Kill and recreate it instead.'
    );
    return;
  }
  const { socketDir, socketPrefix, redrawMethod, dtachPath, reflectProcessTitle } = config();
  const others = new Set(
    provider.listSessions().filter((s) => s.socket !== session.socket).map((s) => s.name)
  );
  const newName = await vscode.window.showInputBox({
    prompt: 'Rename dtach session',
    value: session.name,
    validateInput: (value) => validateName(value, others),
  });
  if (!newName || newName === session.name) {
    return;
  }
  const newSocket = path.join(socketDir, `${socketPrefix}${newName}_${hash}.dtach`);
  if (fs.existsSync(newSocket)) {
    vscode.window.showErrorMessage(`dtach Sessions: ${newSocket} already exists.`);
    return;
  }
  const term = findTerminalForSocket(session);
  try {
    fs.renameSync(session.socket, newSocket);
  } catch (err) {
    vscode.window.showErrorMessage(
      `dtach Sessions: rename failed: ${(err as Error).message}`
    );
    return;
  }
  if (term) {
    if (reflectProcessTitle) {
      // The live attach survives the socket move — the unix-socket connection is
      // held by inode, not path — and there is no pinned tab name to rebuild, so
      // just re-point our tracking at the new socket. No dispose/reattach flash.
      rekeyTerminal(session.socket, newSocket);
      dropPid(session.socket);
      persistPid(newSocket, term);
    } else {
      // VS Code has no terminal-rename API; dispose and reattach under the new
      // name (the close handler untracks the old terminal).
      term.dispose();
      await showOrCreateTerminal(
        { name: newName, socket: newSocket },
        ['-a', newSocket, ...redrawArgs(redrawMethod)],
        dtachPath
      );
    }
  }
  provider.refresh();
}

/** Close this window's terminal for a session without killing the dtach server. */
function detach(session: DtachSession): void {
  findTerminalForSocket(session)?.dispose();
}

/** Command-palette quick-switch: pick a session and attach it. */
async function quickSwitch(provider: DtachTreeProvider): Promise<void> {
  const sessions = provider.listSessions();
  if (!sessions.length) {
    vscode.window.showInformationMessage('dtach Sessions: no sessions.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    sessions.map((s) => ({ label: s.name, session: s })),
    { placeHolder: 'Attach dtach session' }
  );
  if (pick) {
    await attach(pick.session);
  }
}

const SORT_ORDERS: { value: SortBy; label: string; description: string }[] = [
  { value: 'created', label: 'Created', description: 'Newest first (default)' },
  { value: 'lastAttached', label: 'Last Attached', description: 'Most recently attached first' },
  { value: 'name', label: 'Name', description: 'Alphabetical' },
  { value: 'status', label: 'Status', description: 'Waiting, then working, then done' },
];

/** View-title command: QuickPick the four session orders, marking the active
 * one, and persist the choice to `dtachSessions.sortBy` (global). */
async function setSortOrder(provider: DtachTreeProvider): Promise<void> {
  const current = config().sortBy;
  const pick = await vscode.window.showQuickPick(
    SORT_ORDERS.map((o) => ({
      value: o.value,
      description: o.description,
      label: o.value === current ? `$(check) ${o.label}` : o.label,
    })),
    { placeHolder: 'Sort sessions by...' }
  );
  if (!pick || pick.value === current) {
    return;
  }
  await vscode.workspace
    .getConfiguration('dtachSessions')
    .update('sortBy', pick.value, vscode.ConfigurationTarget.Global);
  provider.refresh();
}

function copySocketPath(session: DtachSession): void {
  vscode.env.clipboard.writeText(session.socket);
  vscode.window.showInformationMessage(`dtach Sessions: copied socket path for "${session.name}".`);
}

function copyAttachCommand(session: DtachSession): void {
  const { redrawMethod, dtachPath } = config();
  const cmd = [dtachPath, '-a', session.socket, ...redrawArgs(redrawMethod)].join(' ');
  vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(`dtach Sessions: copied attach command for "${session.name}".`);
}

/**
 * Shell snippet that prints the pids holding a session's socket — the dtach
 * master plus any attached clients. Resolved by lsof on the current path,
 * falling back to a pgrep on the hash anchor (rename-safe), or the escaped full
 * path for legacy hashless sockets. Shared by killOne (which kills them) and
 * sessionCwd (which walks the master to its shell).
 */
/** Shell expression listing pids whose argv references the socket (master AND
 *  connected clients), by rename-invariant hash anchor when present, else the
 *  regex-escaped path. Unlike `lsof -t`, this sees connected clients, not just
 *  the process bound to the socket path. */
function pgrepSocketCommand(session: { socket: string }): string {
  const hash = hashOf(path.basename(session.socket));
  return hash
    ? `pgrep -f ${shellEscape(`_${hash}\\.dtach`)}`
    : `pgrep -f ${shellEscape(escapeRegex(session.socket))}`;
}

function resolvePidsCommand(session: { socket: string }): string {
  const sock = shellEscape(session.socket);
  return `lsof -t ${sock} 2>/dev/null || ${pgrepSocketCommand(session)} 2>/dev/null`;
}

// --- Stale client reaping -----------------------------------------------------
//
// A dtach master tees its pty to every attached client under one shared winsize
// with no retained buffer, and a client wedged after its tty died (window close,
// SSH drop) blocks SIGTERM and lingers. A second client then joins the same
// master and gets a live cursor on a blank screen. We reap orphaned clients by
// pid identity: a client is stale when its pid is not this window's live
// terminal for the socket. See openspec/changes/reap-stale-clients.

/** Run a shell command and resolve to its stdout ('' on error). */
function execCapture(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => resolve(err ? '' : stdout || ''));
  });
}

/**
 * The attach-client (`dtach -a`) pids currently on a socket — never the `-A`
 * master. Candidates are the processes whose argv references the socket
 * (`pgrepSocketCommand`, which — unlike `lsof -t` — sees connected clients, not
 * just the process bound to the socket path); each is kept only if its
 * `/proc/<pid>/cmdline` carries a bare `-a` and no `-A`, so the master is
 * excluded even if a session name happens to look like a flag. Linux `/proc`
 * only.
 */
async function clientPidsOnSocket(session: { socket: string }): Promise<number[]> {
  const cmd =
    `${pgrepSocketCommand(session)} 2>/dev/null | ` +
    `while read p; do ` +
    `tr '\\0' '\\n' < /proc/$p/cmdline 2>/dev/null | ` +
    `awk '$0=="-A"{m=1} $0=="-a"{c=1} END{exit !(c && !m)}' && echo $p; ` +
    `done`;
  const out = await execCapture(cmd);
  return out
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The stale client pids for a session: the socket's `-a` clients minus this
 * window's live terminal for it. Returns `undefined` — meaning "do not reap" —
 * when a matched terminal's processId has not resolved yet, so a client that
 * might be our own is never killed mid-spawn. With no live terminal (the
 * create-fresh branch), every client is stale.
 */
async function staleClientPids(
  session: { name: string; socket: string }
): Promise<number[] | undefined> {
  const clients = await clientPidsOnSocket(session);
  if (clients.length === 0) {
    return [];
  }
  const term = findTerminalForSocket(session);
  if (!term) {
    return clients;
  }
  const myPid = await term.processId;
  if (!myPid) {
    return undefined; // conservative: cannot identify our own client
  }
  return clients.filter((p) => p !== myPid);
}

/**
 * Terminate the session's stale clients with SIGKILL (wedged clients block
 * SIGTERM). Never touches the master or the socket file, so the session and its
 * program survive. Returns the number of clients reaped.
 */
async function reapStaleClients(session: { name: string; socket: string }): Promise<number> {
  const stale = await staleClientPids(session);
  if (!stale || stale.length === 0) {
    return 0;
  }
  await execCapture(`kill -9 ${stale.join(' ')} 2>/dev/null`);
  return stale.length;
}

/**
 * Terminate one session's dtach server and remove its socket. The owning process
 * is resolved by resolvePidsCommand (lsof, falling back to a rename-safe pgrep).
 */
async function killOne(session: DtachSession): Promise<void> {
  const sock = shellEscape(session.socket);
  // SIGKILL, not SIGTERM: a wedged attach client blocks SIGTERM and would
  // otherwise outlive the kill, orphaned on the socket.
  const cmd =
    `pids=$(${resolvePidsCommand(session)}); ` +
    `[ -n "$pids" ] && kill -9 $pids 2>/dev/null; ` +
    `rm -f ${sock}`;

  await new Promise<void>((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        vscode.window.showErrorMessage(
          `dtach Sessions: kill failed for ${session.name}: ${err.message}`
        );
      }
      resolve();
    });
  });

  // Remove the session's per-hash status file. An extension-driven kill never
  // fires Claude's SessionEnd hook, so without this the status/<hash>.json
  // orphans. Best-effort: a missing file (no Claude ran here) is the common
  // case; a legacy hashless socket has no status file to remove.
  const hash = hashOf(path.basename(session.socket));
  if (hash) {
    removeStatus(config().socketDir, hash);
  }

  // Close the now-dead terminal so a stale tab does not linger.
  findTerminalForSocket(session)?.dispose();
}

/** Kill one or more selected sessions behind a single confirmation. */
async function killSelected(provider: DtachTreeProvider, sessions: DtachSession[]): Promise<void> {
  if (!sessions.length) {
    return;
  }
  const msg =
    sessions.length === 1
      ? `Kill dtach session "${sessions[0].name}"? This terminates the session and removes its socket.`
      : `Kill ${sessions.length} dtach sessions? This terminates them and removes their sockets.`;
  const choice = await vscode.window.showWarningMessage(msg, { modal: true }, 'Kill');
  if (choice !== 'Kill') {
    return;
  }
  for (const s of sessions) {
    await killOne(s);
  }
  provider.refresh();
}

/** Kill every listed session. */
async function killAll(provider: DtachTreeProvider): Promise<void> {
  const sessions = provider.listSessions();
  if (!sessions.length) {
    vscode.window.showInformationMessage('dtach Sessions: no sessions to kill.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Kill all ${sessions.length} dtach sessions? This terminates them and removes their sockets.`,
    { modal: true },
    'Kill All'
  );
  if (choice !== 'Kill All') {
    return;
  }
  for (const s of sessions) {
    await killOne(s);
  }
  provider.refresh();
}

/** "reaped N stale client(s)" — shared by the manual reap commands. */
function reapedCount(n: number): string {
  return `reaped ${n} stale client${n === 1 ? '' : 's'}`;
}

/** Manually reap one session's stale clients and report the count. */
async function reapSession(session: DtachSession): Promise<void> {
  const n = await reapStaleClients(session);
  vscode.window.showInformationMessage(
    n === 0
      ? `dtach Sessions: no stale clients on "${session.name}".`
      : `dtach Sessions: ${reapedCount(n)} on "${session.name}".`
  );
}

/** Manually reap stale clients across every listed session and report the total. */
async function reapAll(provider: DtachTreeProvider): Promise<void> {
  const sessions = provider.listSessions();
  let total = 0;
  for (const s of sessions) {
    total += await reapStaleClients(s);
  }
  vscode.window.showInformationMessage(
    total === 0
      ? 'dtach Sessions: no stale clients found.'
      : `dtach Sessions: ${reapedCount(total)}.`
  );
}

/**
 * Best-effort working directory of a session's shell, so a restart or a "New
 * Session Here" clone can reopen there rather than at $HOME. The processes
 * holding the socket are the dtach master plus any attached clients (same set
 * killOne resolves); only the master has a child (the shell), so find that
 * child and read its cwd via lsof. Returns undefined when it can't be
 * determined (no proc found, lsof missing, etc.).
 */
function sessionCwd(session: DtachSession): Promise<string | undefined> {
  const cmd =
    `pids=$(${resolvePidsCommand(session)}); ` +
    `for p in $pids; do ` +
    `c=$(pgrep -P "$p" 2>/dev/null | head -1); ` +
    `if [ -n "$c" ]; then ` +
    `lsof -a -p "$c" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; break; ` +
    `fi; done`;
  return new Promise((resolve) => {
    exec(cmd, (_err, stdout) => {
      const dir = stdout.trim();
      resolve(dir.length ? dir : undefined);
    });
  });
}

/**
 * Restart a session in place: terminate the dtach server (and dispose its dead
 * terminal), then create a fresh session under the same name, reopening in the
 * old shell's working directory when it can be resolved. Goes through
 * createSession, so it mints a new hash, opens a new terminal, and runs the
 * configured startupCommand — exactly as a create would. Confirmed first, since
 * it destroys whatever the session was running.
 */
async function restart(provider: DtachTreeProvider, session: DtachSession): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Restart dtach session "${session.name}"? This terminates the running session and starts a fresh shell.`,
    { modal: true },
    'Restart'
  );
  if (choice !== 'Restart') {
    return;
  }
  const cwd = await sessionCwd(session); // capture before kill; the proc is gone after
  await killOne(session); // remove the old socket first so the name is free to reuse
  await createSession(provider, session.name, cwd);
  provider.refresh();
}

/**
 * "New Session Here": create a fresh family sibling rooted in `session`'s
 * working directory — the pane-side counterpart to the Explorer's folder create.
 * Composes the existing pieces: probe the live cwd (as restart does; resolves
 * for detached sessions too, since detach kills only the client), take the
 * family base so a sibling rejoins the family rather than nesting, then
 * `createDeduped` to mint the next free numbered name. An unresolved cwd is left
 * undefined, so `createSession` roots the shell at $HOME — the same silent
 * fallback as restart.
 */
async function newSessionHere(provider: DtachTreeProvider, session: DtachSession): Promise<void> {
  const cwd = await sessionCwd(session);
  await createDeduped(
    provider,
    familyBase(session.name),
    cwd,
    (finalName) => `dtach Sessions: created "${finalName}".`
  );
}

// --- Claude status hooks ------------------------------------------------------
//
// The status feature shows each session's live Claude run-state on its row. A
// bundled python3 forwarder, registered as a Claude hook, walks /proc to the
// dtach master and writes per-hash status files the provider reads. See
// scripts/claude-status-hook.py and the provider's readStatuses/statusLabel.

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
// Stable install location for the forwarder, independent of the versioned
// extension dir so an update can't break the wiring in ~/.claude/settings.json.
const HOOK_PATH = path.join(os.homedir(), '.dtach-sessions', 'hook');
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
];
const NUDGE_DISMISSED_KEY = 'dtachSessions.claudeNudgeDismissed';

/** The forwarder's installed extension path; set on activate. */
let extensionPath = '';

/** The command string registered for a Claude event. The HOOK_PATH substring is
 * how we recognise our own entries for idempotent install and surgical uninstall. */
function hookCommand(event: string): string {
  return `python3 ${shellEscape(HOOK_PATH)} ${event}`;
}

function isOurHook(h: unknown): boolean {
  return (
    typeof (h as { command?: unknown })?.command === 'string' &&
    (h as { command: string }).command.includes(HOOK_PATH)
  );
}

/** Read ~/.claude/settings.json as an object; {} if absent. Throws on invalid JSON. */
function readClaudeSettings(): Record<string, any> {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    return {};
  }
  const obj = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  return obj && typeof obj === 'object' ? obj : {};
}

/** True if our forwarder is registered under any event in Claude's settings. */
function hooksInstalled(): boolean {
  try {
    const hooks = readClaudeSettings().hooks;
    if (!hooks || typeof hooks !== 'object') {
      return false;
    }
    return Object.values(hooks).some(
      (groups) =>
        Array.isArray(groups) &&
        groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurHook))
    );
  } catch {
    return false;
  }
}

/** True if python3 is resolvable on the extension host. Best-effort and
 * advisory only: the ext-host PATH may differ from the host that runs Claude
 * (see the change design, decision D3), so this never blocks install — it only
 * decides whether to append a note. Never throws. */
async function python3Available(): Promise<boolean> {
  return (await execCapture('command -v python3')).trim().length > 0;
}

/** Install command: copy the forwarder to a stable path and merge it into each
 * Claude lifecycle event without disturbing the user's other hooks. Idempotent. */
async function installClaudeHooks(): Promise<void> {
  const src = path.join(extensionPath, 'scripts', 'claude-status-hook.py');
  try {
    fs.mkdirSync(path.dirname(HOOK_PATH), { recursive: true });
    fs.copyFileSync(src, HOOK_PATH);
    fs.chmodSync(HOOK_PATH, 0o755);
  } catch (err) {
    vscode.window.showErrorMessage(
      `dtach Sessions: could not install the status forwarder: ${(err as Error).message}`
    );
    return;
  }

  let settings: Record<string, any>;
  try {
    settings = readClaudeSettings();
  } catch {
    vscode.window.showErrorMessage(
      `dtach Sessions: ${CLAUDE_SETTINGS} is not valid JSON; aborting so your settings are not clobbered.`
    );
    return;
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  for (const event of HOOK_EVENTS) {
    const groups: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const already = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurHook));
    if (!already) {
      // Tool-scoped events take a matcher ('*' = all tools); the rest match implicitly.
      const entry = { type: 'command', command: hookCommand(event) };
      groups.push(
        event === 'PreToolUse' || event === 'PostToolUse'
          ? { matcher: '*', hooks: [entry] }
          : { hooks: [entry] }
      );
    }
    settings.hooks[event] = groups;
  }

  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    vscode.window.showErrorMessage(
      `dtach Sessions: could not write ${CLAUDE_SETTINGS}: ${(err as Error).message}`
    );
    return;
  }
  const note = (await python3Available())
    ? ''
    : ' Note: python3 was not found on the extension host, so status will not appear until it is available (this check runs on the extension host, whose PATH may differ from the host running Claude).';
  vscode.window.showInformationMessage(
    'dtach Sessions: Claude status hooks installed. Sessions already running Claude will report status only after they are restarted (hooks are read at session start).' +
      note
  );
}

/** Uninstall command: remove only our forwarder entries, leaving other hooks intact. */
async function uninstallClaudeHooks(): Promise<void> {
  let settings: Record<string, any>;
  try {
    settings = readClaudeSettings();
  } catch {
    vscode.window.showErrorMessage(`dtach Sessions: ${CLAUDE_SETTINGS} is not valid JSON.`);
    return;
  }
  const hooks = settings.hooks;
  if (hooks && typeof hooks === 'object') {
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) {
        continue;
      }
      const kept = hooks[event]
        .map((g: any) =>
          Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: unknown) => !isOurHook(h)) } : g
        )
        .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
      if (kept.length) {
        hooks[event] = kept;
      } else {
        delete hooks[event];
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }
    try {
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    } catch (err) {
      vscode.window.showErrorMessage(
        `dtach Sessions: could not write ${CLAUDE_SETTINGS}: ${(err as Error).message}`
      );
      return;
    }
  }
  fs.rmSync(HOOK_PATH, { force: true });
  vscode.window.showInformationMessage('dtach Sessions: Claude status hooks removed.');
}

/** One-time offer to install, gated on Claude being present, hooks not already
 * installed, and no prior dismissal (persisted per-host in globalState). */
async function maybeNudgeInstall(context: vscode.ExtensionContext): Promise<void> {
  if (
    !config().showClaudeStatus ||
    context.globalState.get<boolean>(NUDGE_DISMISSED_KEY) ||
    !fs.existsSync(CLAUDE_DIR) || // the "this host runs Claude" signal (not PATH)
    hooksInstalled()
  ) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'dtach Sessions: show live Claude status (working / waiting / idle) on session rows?',
    'Install',
    'Not now',
    "Don't ask again"
  );
  if (choice === 'Install') {
    await installClaudeHooks();
  } else if (choice === "Don't ask again") {
    await context.globalState.update(NUDGE_DISMISSED_KEY, true);
  }
}

/** Watch the status directory and refresh the tree as status files change. */
function watchClaudeStatus(provider: DtachTreeProvider): vscode.Disposable | undefined {
  if (!config().showClaudeStatus) {
    return undefined;
  }
  const dir = statusDir(config().socketDir);
  let watcher: fs.FSWatcher;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => {
      // fs.watch can fire several events per write (tmp create, rename); debounce.
      if (statusDebounce) {
        clearTimeout(statusDebounce);
      }
      statusDebounce = setTimeout(() => provider.refresh(), 150);
    });
  } catch {
    return undefined;
  }
  return {
    dispose: () => {
      if (statusDebounce) {
        clearTimeout(statusDebounce);
      }
      watcher.close();
    },
  };
}
let statusDebounce: ReturnType<typeof setTimeout> | undefined;

/** Resolve a command argument (a tree node or session) to a DtachSession. */
function toSession(item: SessionItem | DtachSession): DtachSession {
  return item instanceof SessionItem ? item.session : item;
}

/**
 * Set the activity-bar attention badge to the count of waiting sessions, so a
 * Claude blocked on the user is visible even with the view collapsed. A zero
 * count clears the badge. countWaiting() already returns 0 when the status
 * feature is off, so this naturally shows nothing then.
 */
function updateBadge(view: vscode.TreeView<SessionItem>, provider: DtachTreeProvider): void {
  const value = provider.countWaiting();
  view.badge = value
    ? { value, tooltip: `${value} session${value === 1 ? '' : 's'} waiting` }
    : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  mementoState = context.workspaceState;
  extensionPath = context.extensionPath;
  const decorations = new DetachedRowDecorations();
  const provider = new DtachTreeProvider(context.extensionUri, decorations);
  const view = vscode.window.createTreeView('dtachSessionsView', {
    treeDataProvider: provider,
    canSelectMany: true,
  });

  // Rebuild the reattach registry from the persisted pid map for terminals that
  // a window reload restored before this activation.
  void reconcileTerminals(provider);

  // Keep the activity-bar waiting badge in sync. Every state transition that
  // matters already fires onDidChangeTreeData (status-file watch, terminal
  // open/close, visibility), so riding that one event keeps the badge correct
  // without threading updates through each command.
  updateBadge(view, provider);

  context.subscriptions.push(
    view,
    vscode.window.registerFileDecorationProvider(decorations),
    provider.onDidChangeTreeData(() => updateBadge(view, provider)),
    view.onDidChangeVisibility((e) => {
      if (e.visible) {
        provider.refresh();
      }
    }),
    // Keep the attached-state icon honest: re-render when a terminal opens
    // (attach), closes, or is disposed (detach, kill, rename).
    vscode.window.onDidOpenTerminal(() => provider.refresh()),
    vscode.window.onDidCloseTerminal((t) => {
      const socket = unregisterTerminal(t);
      if (socket) {
        dropPid(socket);
      }
      maybeWarnLaunchFailure(t);
      provider.refresh();
    }),
    vscode.commands.registerCommand('dtachSessions.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('dtachSessions.create', () => create(provider)),
    vscode.commands.registerCommand('dtachSessions.openInFolder', (uri?: vscode.Uri) =>
      openInFolder(provider, uri)
    ),
    vscode.commands.registerCommand('dtachSessions.attach', (item: SessionItem | DtachSession) =>
      attach(toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.rename', (item: SessionItem | DtachSession) =>
      rename(provider, toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.detach', (item: SessionItem | DtachSession) =>
      detach(toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.restart', (item: SessionItem | DtachSession) =>
      restart(provider, toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.newSessionHere', (item: SessionItem | DtachSession) =>
      newSessionHere(provider, toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.quickSwitch', () => quickSwitch(provider)),
    vscode.commands.registerCommand('dtachSessions.setSortOrder', () => setSortOrder(provider)),
    vscode.commands.registerCommand('dtachSessions.copySocketPath', (item: SessionItem | DtachSession) =>
      copySocketPath(toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.copyAttachCommand', (item: SessionItem | DtachSession) =>
      copyAttachCommand(toSession(item))
    ),
    vscode.commands.registerCommand(
      'dtachSessions.kill',
      (item: SessionItem | DtachSession, items?: SessionItem[]) => {
        const selection = items && items.length ? items : [item];
        return killSelected(provider, selection.map(toSession));
      }
    ),
    vscode.commands.registerCommand('dtachSessions.killAll', () => killAll(provider)),
    vscode.commands.registerCommand('dtachSessions.reapStaleClients', (item: SessionItem | DtachSession) =>
      reapSession(toSession(item))
    ),
    vscode.commands.registerCommand('dtachSessions.reapAllStaleClients', () => reapAll(provider)),
    vscode.commands.registerCommand('dtachSessions.installClaudeHooks', () => installClaudeHooks()),
    vscode.commands.registerCommand('dtachSessions.uninstallClaudeHooks', () => uninstallClaudeHooks())
  );

  const statusWatcher = watchClaudeStatus(provider);
  if (statusWatcher) {
    context.subscriptions.push(statusWatcher);
  }
  void maybeNudgeInstall(context);
}

export function deactivate(): void {
  // no-op
}
