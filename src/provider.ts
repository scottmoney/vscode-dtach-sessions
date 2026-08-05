import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DtachSession {
  name: string;
  socket: string;
  mtimeMs: number;
  ctimeMs: number;
}

/** Expand a leading ~ to the home directory. */
export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export type SortBy = 'created' | 'lastAttached' | 'name' | 'status';

const SORT_BY_VALUES: SortBy[] = ['created', 'lastAttached', 'name', 'status'];

export interface DtachConfig {
  socketDir: string;
  socketPrefix: string;
  suggestSessionName: boolean;
  suggestSessionNamePrefix: string;
  redrawMethod: string;
  dtachPath: string;
  startupCommand: string;
  reflectProcessTitle: boolean;
  showClaudeStatus: boolean;
  reapStaleClientsOnAttach: boolean;
  sortBy: SortBy;
}

export function config(): DtachConfig {
  const c = vscode.workspace.getConfiguration('dtachSessions');
  const sortBy = c.get<string>('sortBy', 'created');
  return {
    socketDir: expandHome(c.get<string>('socketDir', '~/.dtach-sessions')),
    socketPrefix: c.get<string>('socketPrefix', ''),
    suggestSessionName: c.get<boolean>('suggestSessionName', false),
    suggestSessionNamePrefix: c.get<string>('suggestSessionNamePrefix', 'new-'),
    redrawMethod: c.get<string>('redrawMethod', 'winch'),
    dtachPath: c.get<string>('dtachPath', 'dtach'),
    startupCommand: c.get<string>('startupCommand', ''),
    reflectProcessTitle: c.get<boolean>('reflectProcessTitle', true),
    showClaudeStatus: c.get<boolean>('showClaudeStatus', true),
    reapStaleClientsOnAttach: c.get<boolean>('reapStaleClientsOnAttach', true),
    sortBy: (SORT_BY_VALUES as string[]).includes(sortBy) ? (sortBy as SortBy) : 'created',
  };
}

/** Live run-state of a Claude inside a session, as written by the status hook.
 * `done` is the calm "finished — your move" resting state written on Stop;
 * unlike `working`/`tool` it does not decay, and unlike `waiting` it is not a
 * block — it persists until the session next leaves it. */
export type SessionState = 'working' | 'tool' | 'waiting' | 'idle' | 'done';

export interface SessionStatus {
  state: SessionState;
  tool?: string;
  ts: number; // epoch ms of the event that produced this state
}

/**
 * A transient state (working/tool) older than this is treated as decayed: a
 * Claude that exited without a clean Stop (crash, kill, lost connection) leaves
 * a stale "working" file behind, and we must never present it as current.
 * `waiting` and `done` do not decay — a block on the user, and a finished turn
 * awaiting the user, are both legitimately long-lived resting states.
 */
const STALE_MS = 120_000;

/** The directory holding per-hash status files, beside the sockets. The hook
 * forwarder derives the same path from the socket it finds via /proc. */
export function statusDir(socketDir: string): string {
  return path.join(socketDir, 'status');
}

/** Remove a session's per-hash status file (best-effort; a missing file is the
 * common case). The status subsystem owns the `<hash>.json` naming, so callers
 * that end a session (e.g. an extension-driven kill, which never fires Claude's
 * SessionEnd hook) express intent — "forget this session's status" — rather
 * than reconstructing the path. */
export function removeStatus(socketDir: string, hash: string): void {
  fs.rmSync(path.join(statusDir(socketDir), `${hash}.json`), { force: true });
}

/**
 * Read per-hash status files written by the hook forwarder, keyed by the
 * session hash (the file basename). The directory sits beside the sockets; a
 * missing directory (status feature unused) yields no statuses, and a torn or
 * malformed file is skipped rather than fatal.
 */
export function readStatuses(socketDir: string): Map<string, SessionStatus> {
  const dir = statusDir(socketDir);
  const out = new Map<string, SessionStatus>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) {
      continue;
    }
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (obj && typeof obj.state === 'string' && typeof obj.ts === 'number') {
        out.set(f.slice(0, -'.json'.length), { state: obj.state, tool: obj.tool, ts: obj.ts });
      }
    } catch {
      // partial read mid-rename, or hand-edited garbage — ignore this file
    }
  }
  return out;
}

/**
 * The state to present after staleness decay, or undefined when nothing should
 * be shown: no status, idle (age alone conveys quietness), or a transient state
 * (working/tool) that has gone stale. `waiting` and `done` are shown as-is and
 * never decay. The single source the badge AND the icon derive from, so they
 * can never disagree.
 */
export function effectiveState(status: SessionStatus | undefined): SessionState | undefined {
  if (!status) {
    return undefined;
  }
  const { state, ts } = status;
  if ((state === 'working' || state === 'tool') && Date.now() - ts > STALE_MS) {
    return undefined;
  }
  return state === 'idle' ? undefined : state;
}

/** The badge text for an already-decayed state, or undefined for none. Split
 *  from `statusLabel` so a caller that already has the effective state (e.g.
 *  `SessionItem`, which also needs it for the icon) need not recompute it. */
function labelForState(state: SessionState | undefined, tool?: string): string | undefined {
  switch (state) {
    case 'working':
      return 'working';
    case 'tool':
      return tool ? `tool: ${tool}` : 'tool';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
    default:
      return undefined;
  }
}

/** The row badge for a status, or undefined when no badge should show. */
export function statusLabel(status: SessionStatus | undefined): string | undefined {
  return labelForState(effectiveState(status), status?.tool);
}

/** Attention-queue priority for the `status` sort order: waiting first, then
 * working/tool, then done, then everything else (idle or no status) — the same
 * grouping the amber-bell/activity-bar attention model already implies. */
function statusPriority(state: SessionState | undefined): number {
  switch (state) {
    case 'waiting':
      return 0;
    case 'working':
    case 'tool':
      return 1;
    case 'done':
      return 2;
    default:
      return 3;
  }
}

/**
 * Strip the configured prefix, the trailing '.dtach', and a trailing '_<hash>'
 * (6 hex chars assigned at create) from a socket basename. Legacy sockets with
 * no hash simply skip the last step.
 */
export function displayName(socketBasename: string, socketPrefix: string): string {
  let s = socketBasename.startsWith(socketPrefix)
    ? socketBasename.slice(socketPrefix.length)
    : socketBasename.replace(/^\./, '');
  s = s.replace(/\.dtach$/, '');
  return s.replace(/_[0-9a-f]{6}$/, '');
}

/** Extract the rename-invariant hash from a socket basename, if present. */
export function hashOf(socketBasename: string): string | undefined {
  const m = socketBasename.replace(/\.dtach$/, '').match(/_([0-9a-f]{6})$/);
  return m ? m[1] : undefined;
}

/** Join a session to its live status from an already-loaded status map (see
 * `readStatuses`), by socket hash. `statuses` undefined (status feature off)
 * always yields undefined. */
export function statusFor(
  session: { socket: string },
  statuses: Map<string, SessionStatus> | undefined
): SessionStatus | undefined {
  if (!statuses) {
    return undefined;
  }
  const hash = hashOf(path.basename(session.socket));
  return hash ? statuses.get(hash) : undefined;
}

/** Extract the dtach socket path from a terminal's launch args, if present. */
export function socketFromTerminal(t: vscode.Terminal): string | undefined {
  const args = (t.creationOptions as vscode.TerminalOptions).shellArgs;
  if (Array.isArray(args)) {
    return args.find((a): a is string => typeof a === 'string' && a.endsWith('.dtach'));
  }
  return undefined;
}

/**
 * Reattach registry: socket -> the terminal attached to it. Within a session it
 * is populated as terminals are created. After a window reload — which restores
 * terminals but strips their shellArgs — it is rebuilt by matching restored
 * terminals' processIds against a persisted socket->pid map (see extension.ts).
 * It is the rename-invariant, name-independent key that `findTerminalForSocket`
 * falls back to when a terminal's launch args are no longer visible.
 */
const terminalRegistry = new Map<string, vscode.Terminal>();

/** Associate a socket with its terminal for reattach lookups. */
export function registerTerminal(socket: string, term: vscode.Terminal): void {
  terminalRegistry.set(socket, term);
}

/** Drop a terminal from the registry (by value). Returns the socket it held, if any. */
export function unregisterTerminal(term: vscode.Terminal): string | undefined {
  for (const [socket, t] of terminalRegistry) {
    if (t === term) {
      terminalRegistry.delete(socket);
      return socket;
    }
  }
  return undefined;
}

/** Move a terminal's registry entry to a new socket (used by rename). */
export function rekeyTerminal(oldSocket: string, newSocket: string): void {
  const term = terminalRegistry.get(oldSocket);
  if (term) {
    terminalRegistry.delete(oldSocket);
    terminalRegistry.set(newSocket, term);
  }
}

/**
 * Find an open terminal attached to the given session. Queried live from
 * vscode.window.terminals (not an in-memory map) so it survives a window reload,
 * which restores terminals but restarts the extension host.
 *
 * Matched in order: (1) the socket in the terminal's launch args (valid before a
 * reload and for freshly created terminals); (2) the reattach registry, keyed by
 * socket (valid after a reload, once rebuilt from the persisted pid map); and,
 * only when `reflectProcessTitle` is disabled, (3) the pinned terminal name.
 */
export function findTerminalForSocket(session: { name: string; socket: string }): vscode.Terminal | undefined {
  for (const t of vscode.window.terminals) {
    if (socketFromTerminal(t) === session.socket) {
      return t;
    }
  }
  const registered = terminalRegistry.get(session.socket);
  if (registered && vscode.window.terminals.includes(registered)) {
    return registered;
  }
  // When the terminal is named after the session (reflectProcessTitle off), a
  // restored terminal that lost its shellArgs can still be matched by name.
  if (!config().reflectProcessTitle) {
    for (const t of vscode.window.terminals) {
      if (socketFromTerminal(t) === undefined && t.name === session.name) {
        return t;
      }
    }
  }
  return undefined;
}

/** A compact relative age such as "2h ago" derived from a mtime. */
function relativeAge(mtimeMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  if (secs < 60) {
    return `${secs}s ago`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** Pre-coloured row icons resolved from the extension's media dir. */
export interface SessionIcons {
  attached?: vscode.Uri; // green terminal (attached, at rest)
  waiting?: vscode.Uri; // amber bell (Claude blocked on the user)
}

/**
 * A per-row synthetic URI used *only* as a `FileDecoration` key (VS Code keys
 * decorations off `TreeItem.resourceUri`). The scheme is deliberately fake: a
 * real socket path here would hijack label/icon derivation (VS Code would apply
 * the file-icon theme and filename). Keyed on the rename-invariant hash, or the
 * socket basename for legacy hashless sockets.
 */
export function sessionResourceUri(session: { socket: string }): vscode.Uri {
  const base = path.basename(session.socket);
  return vscode.Uri.from({ scheme: 'dtach-session', path: '/' + (hashOf(base) ?? base) });
}

/**
 * Dims detached session rows: a `FileDecorationProvider` returning a muted
 * `color` for rows whose session is not attached in this window. It tints the
 * label only (never `iconPath`), so a detached session that needs the user keeps
 * its full-strength run-state icon (e.g. the amber bell) on a dimmed name —
 * making attach-state an always-present row treatment, independent of the icon.
 * Attach detection reuses `findTerminalForSocket` (the pid-registry-backed path),
 * so dimming survives a window reload the same way the icon does.
 */
export class DetachedRowDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private sessions = new Map<string, { name: string; socket: string }>();
  /** URI strings of the rows currently dimmed (detached), from the last sync.
   *  Used to fire only the rows whose dim-state flipped. */
  private dimmed = new Set<string>();

  /** Re-key the uri→session map from the current rows and, *only if* the set of
   *  dimmed (detached) rows changed, notify VS Code to re-query those specific
   *  rows. Called on each tree refresh, riding the same signal as the row icons.
   *
   *  A status-only update (the common refresh) leaves attach-state — and thus
   *  every decoration — unchanged; firing `undefined` ("refresh all") there
   *  would invalidate the whole decoration cache and flash every detached row's
   *  label to full strength for a frame before the dim is re-applied. So we
   *  compute the new dimmed set, fire only the URIs whose state flipped, and
   *  stay silent when nothing changed. Brand-new rows need no fire — VS Code
   *  queries `provideFileDecoration` for them as they render. */
  sync(sessions: { name: string; socket: string }[]): void {
    this.sessions = new Map(sessions.map((s) => [sessionResourceUri(s).toString(), s]));
    const nextDimmed = new Set<string>();
    for (const s of sessions) {
      if (findTerminalForSocket(s) === undefined) {
        nextDimmed.add(sessionResourceUri(s).toString());
      }
    }
    const changed: vscode.Uri[] = [];
    for (const uri of this.dimmed) {
      if (!nextDimmed.has(uri)) {
        changed.push(vscode.Uri.parse(uri));
      }
    }
    for (const uri of nextDimmed) {
      if (!this.dimmed.has(uri)) {
        changed.push(vscode.Uri.parse(uri));
      }
    }
    this.dimmed = nextDimmed;
    if (changed.length > 0) {
      this._onDidChange.fire(changed);
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'dtach-session') {
      return undefined; // cheap bail: VS Code queries this for every decorated uri
    }
    const session = this.sessions.get(uri.toString());
    if (!session || findTerminalForSocket(session) !== undefined) {
      return undefined; // unknown row, or attached in this window → full strength
    }
    return new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('disabledForeground'));
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(public readonly session: DtachSession, icons?: SessionIcons, status?: SessionStatus) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    const attached = findTerminalForSocket(session) !== undefined;
    // Attach-state in the contextValue gates the per-row inline icons: detached
    // rows show play (attach), attached rows show pause (detach). Restart and
    // Kill match both via a `viewItem =~ /^dtachSession-/` clause.
    this.contextValue = attached ? 'dtachSession-attached' : 'dtachSession-detached';
    // Synthetic key for the detached-row dimming decoration (see
    // DetachedRowDecorations). A fake scheme, so it never drives label/icon.
    this.resourceUri = sessionResourceUri(session);

    const state = effectiveState(status); // one decay pass, shared by badge + icon
    const badge = labelForState(state, status?.tool);
    const mtimeAge = relativeAge(session.mtimeMs);
    // The trailing time is activity-relative when a status exists — measured from
    // the last hook event, so it tracks what Claude is doing — and falls back to
    // the socket mtime otherwise (nothing is ever written to a dtach socket, so
    // mtime is pinned at creation and never moves on attach/detach). This keys on
    // the status *existing*, not on `state`: a decayed status (idle, or stale
    // working) still has a meaningful ts (time since Claude last acted), so we
    // keep using it. The tooltip keeps the honest creation-time mtime.
    const shownAge = status ? relativeAge(status.ts) : mtimeAge;
    // Run-state badge in the description (status-state), separate from
    // contextValue (attach-state); the two compose without either suppressing
    // the other. The badge leads so it reads at a glance.
    const base = attached ? `attached · ${shownAge}` : shownAge;
    this.description = badge ? `${badge} · ${base}` : base;
    this.tooltip =
      `${session.socket}\ncreated ${mtimeAge}` +
      `${attached ? '\nattached in this window' : ''}` +
      `${badge ? `\nclaude: ${badge}` : ''}`;

    // Icon by effective run-state: a spinner for busy (motion is the cue, so the
    // codicon-colour wash on selection is moot here), a baked amber bell for
    // waiting (where colour IS the signal and must survive selection — same
    // reason the attached green is a baked SVG, not a recoloured codicon), a
    // green check for done (a check's meaning rides on its shape, so the
    // colour-wash on selection is acceptable and a themed codicon suffices), and
    // the attached/detached terminal icon at rest.
    switch (state) {
      case 'working':
      case 'tool':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        break;
      case 'waiting':
        this.iconPath =
          icons?.waiting ?? new vscode.ThemeIcon('bell', new vscode.ThemeColor('charts.yellow'));
        break;
      case 'done':
        // Green when attached; muted when detached so a finished-and-dormant
        // session recedes with its dimmed label. The waiting bell, by contrast,
        // stays full-strength when detached (urgency must not dim).
        this.iconPath = new vscode.ThemeIcon(
          'check',
          new vscode.ThemeColor(attached ? 'charts.green' : 'disabledForeground')
        );
        break;
      default:
        this.iconPath = attached
          ? icons?.attached ?? new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('terminal');
    }
    this.command = {
      command: 'dtachSessions.attach',
      title: 'Attach',
      arguments: [session],
    };
  }
}

export class DtachTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly icons: SessionIcons;

  constructor(extensionUri?: vscode.Uri, private readonly decorations?: DetachedRowDecorations) {
    this.icons = extensionUri
      ? {
          attached: vscode.Uri.joinPath(extensionUri, 'media', 'terminal-green.svg'),
          waiting: vscode.Uri.joinPath(extensionUri, 'media', 'state-waiting.svg'),
        }
      : {};
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  /**
   * List sessions joined to their live status by hash, honouring
   * `showClaudeStatus` (off ⇒ every status undefined). The single status-join
   * pass shared by `getChildren` (row rendering) and `countWaiting` (the
   * activity-bar badge), so the two can never disagree about a session's state.
   */
  private sessionsWithStatus(): { session: DtachSession; status?: SessionStatus }[] {
    const cfg = config();
    const statuses = cfg.showClaudeStatus ? readStatuses(cfg.socketDir) : undefined;
    return this.listSessions().map((session) => ({ session, status: statusFor(session, statuses) }));
  }

  getChildren(): SessionItem[] {
    const rows = this.sessionsWithStatus();
    // Re-evaluate detached-row dimming on the same signal as the rows, so
    // attach/detach/reload updates the dim without a manual refresh.
    this.decorations?.sync(rows.map(({ session }) => session));
    return rows.map(({ session, status }) => new SessionItem(session, this.icons, status));
  }

  /**
   * Count sessions whose effective (post-decay) run-state is `waiting` — the
   * attention figure for the activity-bar badge. Returns 0 when the status
   * feature is off (every joined status is then undefined). Shares the join and
   * `effectiveState` source with the per-row badge and icon, so the badge can
   * never disagree with the rows.
   */
  countWaiting(): number {
    return this.sessionsWithStatus().filter(
      ({ status }) => effectiveState(status) === 'waiting'
    ).length;
  }

  /**
   * List sockets in the configured directory: entries matching the prefix that
   * end in `.dtach` and are actually sockets, ordered per `sortBy` (default
   * `created`, i.e. newest by `mtime` first — the historical behaviour).
   */
  listSessions(): DtachSession[] {
    const { socketDir, socketPrefix, sortBy, showClaudeStatus } = config();
    let entries: string[];
    try {
      entries = fs.readdirSync(socketDir);
    } catch (err) {
      // A not-yet-created socket directory is normal (e.g. first run before any
      // session exists) — show nothing rather than an error. Surface real
      // failures such as permission errors.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      vscode.window.showErrorMessage(
        `dtach Sessions: cannot read socket directory ${socketDir}: ${(err as Error).message}`
      );
      return [];
    }
    const sessions: DtachSession[] = [];
    for (const f of entries) {
      if (!f.startsWith(socketPrefix) || !f.endsWith('.dtach')) {
        continue;
      }
      const socket = path.join(socketDir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(socket);
      } catch {
        continue;
      }
      if (!st.isSocket()) {
        continue;
      }
      sessions.push({ name: displayName(f, socketPrefix), socket, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
    }
    switch (sortBy) {
      case 'lastAttached':
        return sessions.sort((a, b) => b.ctimeMs - a.ctimeMs);
      case 'name':
        return sessions.sort((a, b) => a.name.localeCompare(b.name));
      case 'status': {
        // Joins statuses itself (rather than taking a pre-joined list) so
        // listSessions() stays a single self-contained entry point; reuses the
        // same effectiveState the row icon and countWaiting() derive from, so
        // this order can never disagree with what a row shows.
        const statuses = showClaudeStatus ? readStatuses(socketDir) : undefined;
        return sessions.sort((a, b) => {
          const statusA = statusFor(a, statuses);
          const statusB = statusFor(b, statuses);
          const priorityDiff = statusPriority(effectiveState(statusA)) - statusPriority(effectiveState(statusB));
          if (priorityDiff !== 0) {
            return priorityDiff;
          }
          return (statusB?.ts ?? b.mtimeMs) - (statusA?.ts ?? a.mtimeMs);
        });
      }
      case 'created':
      default:
        return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
  }
}
