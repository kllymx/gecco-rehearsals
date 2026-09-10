# Architecture

```text
React console → loopback HTTP API → four-trial rehearsal engine → disposable PGlite databases
                       ↓                         ↓
                 optional AI analysis      actual SQL observations
                       ↓                         ↓
                  risk hypotheses        immutable completed run JSON
```

The frontend reads the specimen and completed runs through the API. A rehearsal selects one
of two trusted source variants and evaluates the same compatibility contract in four independent
trials. Each trial owns a fresh database. Upgrade, writes and rollback within a trial share its
state; a reset cannot erase the marked new-version write before the rollback assertion.

The engine exports structured observations, executed SQL, input digests, timing and scope.
The server persists completed observations for reload and export. AI analysis receives the
public specimen and contract; it has no authority to change the evidence or decide a trial's
outcome. An unavailable provider is a visible analysis state, not fabricated output.

This demo's trust boundary is intentionally narrow: only bundled source variants and fixed
operations are accepted. It does not accept arbitrary repository code, SQL or commands.
The broader Gecco product's isolated execution qualification remains separate.

## Paired application runtimes

The paired view uses a bounded coordinator process per experiment. It owns two PGlite databases
and two child application processes, each executing a selected source version. Application SQL
requests cross IPC to the coordinator, which routes them to the current database and records the
actual result. Baseline versions use separate state. Rollout migrates one database and connects
both app runtimes to it. Rollback preserves writes and replaces the proposed runtime with v1.

Two separately loaded browser documents render application responses through the HTTP API.
An app can open its workspace or save a note only after its selected session reader succeeds.
Read results become stale after relevant database mutations. These are trusted bundled processes,
not an arbitrary-code container sandbox.

The server drives a fixed journey and retains its progress independently of the browser. Polling
reads cached snapshots while commands execute. Pause takes effect after the active operation;
manual reads and note saves are possible before resuming. Each accepted operation uses revisions
and idempotent IDs. Full event evidence is available for download.

## Interactive lab

`Release lab` calls a separate session API. Each lab owns a bounded child process and one
in-memory PGlite database. The server accepts fixed actions only: read as v1, migrate, write
as v2, read as v2 and roll back. Visitor labels are bound SQL parameters. The engine calls
the same bundled readers, writers and migrations as the automated rehearsal.

Every accepted command advances a revision, including a read that observes a compatibility
failure. Commands include a unique ID and the expected revision. An exact retry returns the
original response without executing the action again; conflicting revisions are rejected.
Returned events include executed SQL, parameters, query results or errors, and timing. The
snapshot shows the actual schema and rows. Each experiment retains its database identity
and selected record through migrations and rollback.

The browser retains the lab ID and any unresolved command in session storage. Reload can
reconnect while the worker remains alive. Starting the supplied fix creates a fresh database
and is labeled accordingly. Lab databases expire after 15 idle minutes or 30 total minutes;
they do not survive a server restart. JSON download preserves the observations. Prior read
results are marked stale after a mutation or selected-row change.

At most three lab workers exist, including those initializing. Each operation has a 20-second
limit. Lost child replies, cancellation and timeouts close the uncertain session. A request
already in progress returns a conflict to other commands. Server shutdown closes all labs.

## Change interactions

A separate bounded worker executes the base, change A, change B and A+B against the same
six payment inputs. Expected cents use exact integer arithmetic, independently of the
production functions under test. The original and supplied compatibility variants each
produce 24 observations with source/fixture digests and actual quoted/charged cents.

These fixed TypeScript functions are bundled synthetic PRs. No GitHub merge, payment
service, database or model inference participates in this second matrix. Its observations
can be downloaded as JSON; unlike the release matrix, they are not saved to server history.
