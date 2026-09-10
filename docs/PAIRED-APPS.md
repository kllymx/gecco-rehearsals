# Paired application rehearsal

The default view runs two copies of a small, usable sample application called Fieldnotes.
Each preview is an independent browser document backed by its own Node application process.
The application processes execute the bundled v1/v2 session readers and writers. The browser
only renders their observed response. A successful session read opens a workspace with a
persisted note; a failed session read prevents the workspace from opening or saving.

## Autonomous journey

1. Open both versions against separate databases initialized with the same session and note.
   The proposed version has its migration applied. Both can work independently.
2. Migrate the previous version's database and point both app processes at that shared state.
   This rehearses the overlap during a rolling deployment.
3. Read through both versions. In the original variant, the old app cannot query its column.
4. Create a new session using the proposed version. Both previews now select that exact record.
5. Read it with each version. The new application can open the workspace; the old one cannot.
6. Apply the down migration to the same database and replace the proposed app process with v1.
   Keep the newly created session and note. Both old readers now encounter the nested payload.
7. Repeat the journey in a fresh experiment with the supplied compatibility variant. Both
   representations remain available, including in new writes, so rollout and rollback reads work.

The backend drives a fixed eight-action journey. A short presentation interval between completed
operations makes the actual observations readable. It is not model-generated browser planning.
The demo itself needs no inference request, and browser reload does not restart the journey.

## Taking control

Pause after the current operation, then use either application. Open the workspace, inspect the
session or edit and save the note. Save invokes the selected runtime's real session reader before
issuing a parameterized database update. A compatibility failure therefore blocks a real action.
Read/save interactions can be followed by resuming the autonomous journey.

Before rollout, edits are independent because the apps have separate databases. During rollout,
they share the same database. A successful save can be read by the other version when its session
reader is compatible. Each preview invalidates its displayed observation after relevant mutations.

## Evidence and bounds

Each event records its action, phase, SQL and parameters, returned rows or errors, actual timings,
application observations, and database identity. App instance IDs change when a process is replaced.
Source and fixture digests describe the executed specimen and personalized inputs. JSON export
preserves the event record. The supplied fix is source controlled; generated model text is never run.

There are two application processes, browser documents and disposable PostgreSQL databases per
experiment. The databases use PGlite. These are bounded trusted sample runtimes, not hardened
containers for arbitrary third-party code. No production repository, credentials or database is used.

The HTTP API accepts only declared actions and bounded user text. Commands use expected revisions
and unique IDs; exact retries return their original response. The server bounds live experiments,
operation duration and total lifetime, and closes child processes when the experiment ends.
