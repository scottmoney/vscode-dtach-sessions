## Why

A socket file outlives its dtach master. When the remote host reboots — or a
master is `SIGKILL`ed by the OOM killer or a stray `pkill` — the `.dtach` file
remains in `socketDir` while the process that served it is gone. The tree's only
liveness test is `st.isSocket()`, so clicking such a row runs `dtach -a`, which
prints `Connection refused` and exits within milliseconds; the fast-close
heuristic then blames `dtachSessions.dtachPath`, sending the user to a setting
that is not the problem. Separately, the dead session's `waiting` status file
never decays, so a ghost amber bell inflates the activity-bar count for a session
that cannot be blocked on anyone.

`dtach -A` binds a fresh master on a stale socket path, so the row the user
clicked has a correct answer available: restart the session in place under its
own name and `_<hash>`. Making attach take that path removes the failure instead
of reporting it.

## What Changes

- Sessions carry an `alive` flag, resolved from a single read of
  `/proc/net/unix`: a live dtach master holds a bound listener at the socket
  path, a dead one holds nothing while the file persists. One file read per
  refresh, no subprocess, and no connection to a live master.
- Attaching to a session whose socket has no master restarts it in place with
  `dtach -A` on the same path — same display name, same `_<hash>`,
  `startupCommand` re-run — and says so once, because the previous scrollback
  died with the master and the user should know why it is gone. The old shell's
  working directory went with its process, so the terminal opens at the default.
- A dead session presents no Claude run-state and does not contribute to the
  activity-bar waiting count, so the ghost bell disappears. The deliberate
  no-decay rule for `waiting`/`done` is untouched; suppression happens at read
  time for presentation only.
- The `dtachSessions.dtachPath` misdiagnosis goes away as a consequence: no
  doomed terminal is ever created, so a fast close once again means what the
  warning says it means.

Deliberately not introduced: a distinct "dead" row state, a Revive command, or
Remove Dead Session commands. The distinction stops being load-bearing once
clicking a stale row works, `Kill` already removes a stale socket, and a reboot
adds no rows — it only makes existing ones stale.

## Capabilities

### New Capabilities
- `session-liveness`: determining whether a listed socket still has a dtach
  master, and suppressing the recorded Claude status of one that does not.

### Modified Capabilities
- `session-attach`: attaching to a session whose socket has no master SHALL
  restart it in place rather than launching a terminal that dies immediately.

## Impact

- `src/provider.ts` — `/proc/net/unix` read and the liveness join in
  `listSessions`; `alive` on `DtachSession`; status suppression for dead sessions
  (so the row description, icon, `countWaiting`, and the `status` sort order all
  follow from one place).
- `src/extension.ts` — liveness branch on the attach path, reusing the create
  path's `-A` invocation against the existing socket; the one-line restart
  notice.
- `README.md` — the restart-in-place behaviour and an acceptance check.
- No new commands, menu entries, settings, or row states; `package.json`
  unchanged.
- No new dependencies. Liveness reads `/proc`, so it is Linux-only — the same
  constraint stale-client reaping already carries; where the read fails every
  session is treated as alive and today's behaviour is unchanged.
