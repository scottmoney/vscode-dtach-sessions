## 1. Liveness detection

- [x] 1.1 Add `readBoundSockets(): Set<string> | undefined` to `src/provider.ts` — parse `/proc/net/unix` into the set of bound socket paths, returning `undefined` when the file cannot be read so callers treat everything as alive
- [x] 1.2 Add `alive: boolean` to `DtachSession` and set it in `listSessions` from a single `readBoundSockets()` call per invocation, defaulting to `true` when the read failed
- [x] 1.3 Confirm nothing else about listing changes — a session with no master keeps its name, order, icon, and detached presentation

## 2. Status suppression

- [x] 2.1 Resolve a session with no master to no effective run-state, so the row description, row icon, `countWaiting`, and the `status` sort order all follow from the existing `effectiveState` seam
- [x] 2.2 Verify the status file is left on disk and the `waiting`/`done` no-decay rules are untouched
- [x] 2.3 Verify a live session's status, bell, and badge contribution are unchanged

## 3. Restart in place on attach

- [x] 3.1 Branch the attach path on `alive` before any terminal is created: alive keeps today's `-a` invocation, dead runs the create path's `-A` against the **existing** socket path
- [x] 3.2 Preserve name, `_<hash>`, and working directory through the restart, and run `startupCommand`; do not route through `restartSession`, which mints a fresh hash and socket
- [x] 3.3 Skip reap-on-attach for the restart branch — a socket with no master can have no clients
- [x] 3.4 Show the one-line information message naming the cause and the loss of previous output, with no confirmation prompt
- [x] 3.5 Register the restarted terminal through the normal `trackTerminal` path so the socket-to-pid registry and reattach-after-reload keep working
- [x] 3.6 Sole-source the `-A` launch (arg vector + `startupCommand`) in a shared helper used by both the create path and the restart branch
- [x] 3.7 Make `refreshWhenReady` wait on liveness rather than `fs.existsSync`, which is already true on the restart path
- [x] 3.8 Stop `findTerminalForSocket` matching exited terminals, so a dead session's lingering terminal isn't "reused" in place of the restart
- [x] 3.9 Guard `rename`'s dispose-and-relaunch path (`reflectProcessTitle` off) so it never launches `-a` at a dead socket

## 4. Docs

- [x] 4.1 Document restart-in-place in `README.md`, including an acceptance check for a socket whose master was killed
- [x] 4.2 Add a Gotchas entry to `CLAUDE.md` covering the `/proc/net/unix` liveness oracle, why `dtach -A` re-binds a stale path, and why this removes the `dtachPath` misdiagnosis without a `launch-diagnostics` change

## 5. Verification

- [x] 5.1 `npm run compile` clean
- [x] 5.2 Simulate a dead session (`dtach -n <socket> sleep 600`, then `kill -9` the master) and check: no ghost bell, no inflated badge, clicking the row restarts it in place under the same name and hash, the message appears once, and no `dtachPath` warning is shown
- [x] 5.3 Confirm a live attached session with a running Claude is untouched throughout — no spurious restart, no interruption from the liveness read
- [x] 5.5 Confirm a session on a socket path longer than 108 bytes (`sun_path`) reads as alive while its master runs
- [x] 5.4 Confirm behaviour is unchanged where `/proc/net/unix` cannot be read
