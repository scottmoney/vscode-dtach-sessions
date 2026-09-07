## ADDED Requirements

### Requirement: Liveness detection for listed sessions

The extension SHALL determine, for every listed session, whether a dtach master
is still serving its socket, and SHALL make that determination available to the
attach path and to status presentation.

Detection SHALL read the kernel's bound-unix-socket table (`/proc/net/unix`) and
treat a session as alive when its absolute socket path appears there. Detection
SHALL NOT open a connection to the socket, and SHALL NOT spawn a subprocess, so
that a live master and its attached clients are never disturbed by the check.

Detection SHALL be performed as part of listing sessions, so that it is current
on every tree refresh rather than resolved once per activation.

When the liveness source cannot be read (a non-Linux remote host, or a restricted
environment), every session SHALL be treated as alive, preserving the behaviour
that existed before liveness detection.

Liveness SHALL NOT introduce a distinct presentation of its own: a session with
no master remains listed, keeps its name, and continues to present as detached.
Its recorded Claude status is suppressed as required below, which is the only
way liveness reaches the row's badge, icon, or status ordering.

#### Scenario: Socket with a live master

- **WHEN** the tree is refreshed and a session's socket path appears in the kernel's bound-socket table
- **THEN** the session is treated as alive

#### Scenario: Socket left behind by a host reboot

- **WHEN** the tree is refreshed after the remote host has restarted, so socket files remain but no dtach master is running
- **THEN** every such session is treated as dead, while still being listed

#### Scenario: Master killed without unlinking its socket

- **WHEN** a dtach master is terminated with `SIGKILL` (e.g. by the OOM killer) so its socket file survives
- **THEN** that session is treated as dead on the next refresh

#### Scenario: Detection does not disturb a live session

- **WHEN** liveness is evaluated for a session that is attached and running
- **THEN** no connection is made to its socket and no subprocess is spawned, and the attached terminal is unaffected

#### Scenario: Liveness source unavailable

- **WHEN** the kernel bound-socket table cannot be read
- **THEN** all sessions are treated as alive and behaviour matches that of the extension before liveness detection existed

### Requirement: A session with no master presents no recorded status

A session whose socket has no dtach master SHALL NOT present a Claude
run-state, and SHALL NOT contribute to the activity-bar waiting count, regardless
of what its status file records — a recorded state cannot be current when the
process that recorded it is gone.

Suppression SHALL occur where status is resolved for presentation, so that the
row description, the row icon, the waiting count, and the status sort order agree
without separate handling.

Suppression SHALL NOT delete the status file, and SHALL NOT alter the decay rules
for recorded states, including the rule that `waiting` and `done` do not decay.

#### Scenario: Ghost waiting bell is suppressed

- **WHEN** a session recorded `waiting` before the host restarted and its socket now has no master
- **THEN** the row shows no waiting bell and the activity-bar waiting count excludes it

#### Scenario: Suppression does not delete the status file

- **WHEN** a session with no master has its status suppressed during a refresh
- **THEN** its status file remains on disk

#### Scenario: Status order treats it as statusless

- **WHEN** sessions are ordered by status and one of them has no master but a recorded `waiting` state
- **THEN** it is ordered as a session with no status, not as a waiting session

#### Scenario: Live session status is unaffected

- **WHEN** a live session has a recorded `waiting` status
- **THEN** it shows the waiting bell and counts toward the badge as before
