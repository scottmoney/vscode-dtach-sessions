## Context

`listSessions` (`src/provider.ts:521`) treats every prefix-matching `.dtach`
entry that passes `st.isSocket()` as a session. That test asks whether the file
is a socket, not whether anything is listening on it — and a dtach master that
dies without unlinking (host reboot, OOM kill, `kill -9`) leaves the file behind.
A clean dtach exit *does* unlink, so this only affects abnormal deaths; reboot is
the bulk case.

Measured on a Linux remote host, comparing a live master against one `SIGKILL`ed:

| Probe | Live master | Master killed |
| --- | --- | --- |
| `st.isSocket()` | yes | **yes** — what the tree checks today |
| entry in `/proc/net/unix` | yes (`St 01`, listener) | **gone** |
| `ss -lx` LISTEN row | yes | gone |
| `lsof -t <socketpath>` | **empty, exit 1** | empty, exit 1 |
| `dtach -a <socket>` | attaches | `Connection refused`, exit **0** |
| `dtach -A <socket>` | attaches | **binds a fresh master on the same path** |

Three rows drive this design. `/proc/net/unix` separates the states exactly.
`dtach -a` on a dead socket exits ~instantly with status 0, which is why
`maybeWarnLaunchFailure` (`src/extension.ts:96`) — ownership plus a 1500 ms
window, deliberately exit-code-blind — misfires and blames `dtachPath`. And
`dtach -A` re-binds a stale path, which is what makes restart-in-place possible.

Constraints: the extension host runs on the remote (Remote-SSH) where the sockets
and `/proc` live; there is no polling timer, but the status-file watch refreshes
the tree on every Claude hook event (150 ms debounce), so a tree rebuild can
happen many times a minute.

## Goals / Non-Goals

**Goals:**
- Clicking a session listed in the tree works, or explains itself accurately.
- No ghost waiting bell or inflated badge count after a host restart.
- Zero effect on live sessions: detection must not touch a running master.
- No new UI surface — the fix should be invisible until it is needed.

**Non-Goals:**
- A distinct dead row state, a Revive command, or Remove Dead commands. See D3.
- Preserving scrollback across a restart. It lived in the master; it is gone.
- Non-Linux liveness. `/proc` is the mechanism, as with stale-client reaping.

## Decisions

### D1: Liveness comes from `/proc/net/unix`, read in-process

A dtach master `bind()`s and `listen()`s on the socket path, so the kernel lists
it in `/proc/net/unix` with its path; when the master dies the entry disappears
while the file remains. One `fs.readFileSync('/proc/net/unix')` yields a
`Set<string>` of bound paths, and `listSessions` joins on the socket path exactly
as it already joins `readStatuses` by hash.

Alternatives considered:

- **`connect()` probe.** Definitive, but it opens a real connection to a live
  master. A dtach master tees one pty to every client under a shared winsize with
  no retained buffer; a connect-and-drop is *probably* inert, but "probably", on
  every refresh, against the user's live Claude session, is a bad trade when a
  file read is exact.
- **`ss -lx`.** Correct, but a subprocess and an iproute2 dependency for
  information `/proc/net/unix` hands over directly.
- **`pgrep -f`.** Unsound as a liveness oracle: it matches any process whose
  cmdline merely mentions the path — during development every probe matched the
  probing shell itself. It stays correct for its existing job (choosing pids to
  kill, after the arg-exact `/proc/<pid>/cmdline` filter in `clientPidsOnSocket`).
- **`lsof -t <socketpath>`.** Does not work: it returns empty for a *live*
  socket, because a path argument does not match a unix socket (that needs
  `-U`). This also means the `lsof -t … || pgrep …` in `resolvePidsCommand`
  (`src/extension.ts:609`) always falls through to the pgrep branch. Behaviour is
  unaffected — the fallback is the branch that works — so correcting the comment
  is separate tidy-up, not folded into this change.
- **Boot time (`/proc/stat` `btime`) vs socket `mtime`.** Cheap and definitive,
  but catches only reboot-stale, not a mid-session OOM kill. `/proc/net/unix`
  subsumes it.

Caveat, found while verifying: `/proc/net/unix` does **not** always record the
path dtach was given. A unix socket address is capped at 108 bytes (`sun_path`),
and dtach works around that by `chdir`ing to the socket's directory and binding
the bare basename. So a socket under the default `~/.dtach-sessions` is recorded
absolute, while one whose path exceeds the cap — a long `socketDir`, or a long
session name — is recorded as its basename alone. An exact-path match therefore
read *every* session on a long path as dead, and clicking a live one would have
skipped reaping, re-run `startupCommand` into it, and claimed it was restarted.

`socketIsBound` accepts either form. The basename match cannot practically
collide, because socket names carry a `_<hash>` minted per session, and it errs
toward "alive" — which is only ever a return to pre-liveness behaviour.

### D2: Liveness is per-refresh, not resolved once at activation

Folding the read into `listSessions` makes it correct on the first
`getChildren` at activation *and* on every later refresh. An activation-time
snapshot would be stale the moment a master died mid-session, leaving a wrong row
with a cached explanation. The cost is one small file read per rebuild, which the
refresh cadence tolerates easily; an exec-per-row would not.

### D3: Attach restarts in place; there is no dead row state

The earlier shape of this change surfaced dead sessions as a third row state —
a `dead` badge, a `dtachSession-dead` context value, menu variants, a Revive
command, and paired Remove Dead commands. That state was only load-bearing
because attach could not handle a stale socket. Since `dtach -A` re-binds the
path, attach *can*, so the whole surface was cut:

- The dead/detached distinction stops mattering to the user once clicking either
  one produces a working session.
- `Kill` already removes a stale socket — `session-kill` specs that case
  explicitly — so Remove Dead commands would duplicate it.
- A reboot adds no rows; it makes existing ones stale. There is no tombstone
  accumulation to manage.
- Revive would be a second command that does what clicking the row does.

What remains is one branch on the attach path: alive → `-a` as today; dead →
the create path's `-A` against the **existing** socket, preserving the display
name and the `_<hash>` rename-invariant id, so the status file and the persisted
socket-to-pid key stay associated with the row. `restart` cannot be reused: it
mints a fresh hash and socket, orphaning the status file.

The working directory is **not** preserved, and cannot be: `sessionCwd` reads it
off a still-live process (the master's shell child, via `lsof`), and a dead
session has no such process. `restart` can reopen in place because it kills a
*live* session; this path has nothing to read. The terminal opens at the default,
and the spec says so rather than promising otherwise.

### D4: The restart is announced, not silent

Restart-in-place is the right action but it discards scrollback, and the user
clicked *attach* expecting to see their session. Since the scrollback is
unrecoverable by any means, a confirmation prompt would offer no real choice — so
the restart proceeds and reports itself once, naming the cause (host restart or a
killed dtach process) and the consequence (previous output is gone). An
information message, not a warning: nothing is wrong, and nothing needs fixing.

### D5a: `refreshWhenReady` waits on liveness, not existence

`refreshWhenReady` polled `fs.existsSync(socket)`, which is exactly the condition
that is already true on the restart path — the socket file is what survived the
dead master — so it would have refreshed before dtach re-bound and left the row
reading dead. It now polls `socketIsBound`, which is the condition both callers
actually want (a new socket appears and binds near-simultaneously, so the create
path is unaffected), retiring the existence proxy rather than special-casing the
new caller.

### D5: Status suppression, not status deletion

A dead session resolves to no effective run-state, so its row description, its
icon, its `countWaiting` contribution, and its position under the `status` sort
order all follow from the single `effectiveState` seam they already share. The
status file is left on disk: `removeStatus` fires on kill, where the user has
expressed intent, and the deliberate rule that `waiting` and `done` never decay
stays untouched.

### D6: The `dtachPath` misdiagnosis needs no spec change, but the attach path is not the only one

With the attach guard in place no doomed terminal is created there, so a fast
close once again means what `launch-diagnostics` says it means. Its requirements
stay true as written and need no delta.

The guard on `attach` alone is not enough, though. Review traced every path that
reaches `trackTerminal` — the only setter of the fast-close stamp — and found a
second unguarded `-a` launch: `rename`, when `reflectProcessTitle` is off,
disposes the matched terminal and relaunches `-a` against the moved socket. A
matched terminal does not prove a live master, so renaming a dead session could
still produce the exact misdiagnosis this change exists to remove. `rename` now
skips the relaunch when the master is gone, leaving the row detached rather than
resurrecting it — a rename should not start a process.

`copyAttachCommand` shares the root at much lower stakes: it hands over
`dtach -a <dead socket>`, which fails in the user's own shell with the honest
`Connection refused`. Left alone deliberately — it copies an *attach* command,
and silently handing back a `-A` that creates a session would misrepresent what
was copied.

The reviewed alternative was a single liveness-aware `attachArgs(session,
redrawMethod)` behind all three `-a` constructions. Rejected: it would make
`rename` and a copied command silently start processes, which is a bigger
behaviour change than the misdiagnosis it fixes.

## Risks / Trade-offs

- [A live session is misread as dead and gets restarted, losing a running
  program] → The oracle is the kernel's own listener table, not a heuristic. The
  residual case is a master that dies between the liveness read and the launch,
  which is a genuinely dead socket by the time `-A` runs.
- [`/proc/net/unix` unreadable or absent (non-Linux remote, hardened container)]
  → Treat every session as alive: the read failure collapses to today's exact
  behaviour, including today's `dtachPath` warning. No new failure mode.
- [A user expects attach to resume and gets a fresh shell] → D4's message names
  the cause and the loss; the scrollback was unrecoverable regardless.
- [Restart-in-place re-runs `startupCommand` in a session the user expected to
  resume] → Same semantics as Restart, which already re-runs it, and the message
  says the session was restarted.
- [Reading `/proc/net/unix` on every refresh during an active Claude turn] → One
  small sequential read against a debounced rebuild that already does a `readdir`
  of `socketDir`, a `readdir` of `status/`, and a `statSync` per row.
- [Stale rows are now indistinguishable from detached ones in the tree] →
  Accepted, and the point of D3: the distinction only mattered when clicking
  failed.
