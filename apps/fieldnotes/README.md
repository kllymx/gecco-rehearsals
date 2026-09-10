# Fieldnotes

A standalone HTTP application for the public Gecco release demo. Run a separate copy in each sandbox, with separate native PostgreSQL instances. Each copy serves its own HTML, JavaScript and business API. Its browser UI makes requests only to that application's origin.

From a checkout of this repository:

```sh
cd apps/fieldnotes
npm ci
export GECCO_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/gecco
export GECCO_ADMIN_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export GECCO_RELEASE=v1
npm start
```

PostgreSQL must already be running and the database must exist. Default ports are **3000** for the application and **4000** for its authenticated experiment control API. `PORT`, `GECCO_ADMIN_PORT`, `GECCO_HOST` and `GECCO_STATE_FILE` override ports, bind address and state path. State defaults to `.state/config.json` and is written with mode 0600. Keep this state file across process restarts.

`GECCO_RELEASE` selects `v1`, `v2-breaking`, or `v2-compatible` at process startup. These import the actual original public modules from `engine/specimen`. Changing release requires restarting the app process; its `instanceId` changes. The database identity and selected row remain. No PGlite or parent preview state is used.

## Application API · port 3000

| Route | Result |
| --- | --- |
| `GET /` | Independent workspace and session UI. |
| `GET /health` | Process readiness only; does not imply session compatibility. |
| `GET /api/state` | Current release/process/database/session metadata and last actual observation. Contains no control credentials. |
| `GET /api/workspace` | Executes this release's session reader, then loads the user's note. |
| `POST /api/note` | `{note, commandId}`. Executes the session reader before saving the note. Same command retry returns its original response. |

The public application is a trusted synthetic demo, not an authentication product. The selected synthetic session is controlled by the experiment runner. Labels are 1–48 Unicode code points; notes are at most 280, permitting tabs and newlines. Saves reject while autonomous mode is enabled. The browser remains interactive independently; the outer runner can pause autonomous mode.

## Control API · port 4000

Every route requires `Authorization: Bearer <GECCO_ADMIN_TOKEN>`. POST bodies are JSON objects. Control credentials never appear in app HTML, public snapshots, traces or exported results.

| Route | Input / behavior |
| --- | --- |
| `GET /admin/state` | Plain snapshot, including before initialization. |
| `POST /admin/initialize` | `{label, sessionId, writeMarker, note}`. Creates the bundled fixture plus a personalized v1 session and note transactionally in the local database. Use identical input on both apps. |
| `POST /admin/config` | Optional `{selectedSessionId, autonomous, database}`. Database is `{kind:"local"}` or `{kind:"gateway",url,token,databaseId,previewToken?}`. Gateway URL is an HTTPS origin; localhost HTTP is accepted for tests. |
| `POST /admin/read` | `{}`. Executes the same real workspace read as the browser. |
| `POST /admin/note` | `{note,commandId}`. Executes the same read-before-save business action; the control runner may save during autonomous mode. |
| `POST /admin/migrate` | `{direction:"up"\|"down",variant:"breaking"\|"compatible"}`. Runs a bundled SQL migration in the initialized local database, retaining rows. Rejects the wrong schema phase. |
| `POST /admin/write-session` | `{session:{id,userId,role,writeMarker}}`. Uses this process's actual release writer against its active database, then selects that new row. |
| `GET /admin/rows` | `{databaseId,columns,rows,notes,trace}` from the active database. |
| `POST /admin/query` | `{statement,parameters}`. Fixed-statement gateway, always targeting this app's **local** native PostgreSQL. No arbitrary SQL input. |

Read/save/mutation results are `{snapshot,trace,outcome,error?}`. Inspect `outcome` before advancing a rehearsal: HTTP 200 can carry **failed** for a compatibility observation or **inconclusive** for infrastructure/setup failure. Input/phase errors use HTTP 400/409. SQL traces retain actual statement, parameters, rows/error, database identity and duration. A session read failure prevents note access/save. Successful process health alone is not a successful session read.

The fixed gateway catalog is captured from the original release functions plus fixed note/inspection statements. IDs are `v1.read`, `v1.write`, `v2-breaking.read`, `v2-breaking.write`, `v2-compatible.read`, `v2-compatible.write`, `note.read`, `note.save`, `db.identity`, `db.columns`, `db.rows`, `db.notes`. The application forwards its private Daytona preview token using `x-daytona-preview-token` when configured; only the app process stores this credential. The gateway never forwards requests elsewhere.

For the rollout, migrate the left local database up, route the right app through the left gateway, and select the same session on both. The right app's original database remains separate. Write a uniquely marked new session with the right app, select it on both, migrate the left database down, and restart the right app as v1 with its same state file. Both apps then attempt that exact new row. The breaking version fails on a missing column during rollout and on the persisted nested payload after rollback; the compatible writer keeps the v1 representation.

## Validation

```sh
npm run typecheck
npm test
```

Tests start two disposable native PostgreSQL servers and independent app HTTP processes, verify both variants, baseline independence, shared writes, exact-row rollback, process replacement, note actions, duplicate save behavior, control authentication and cleanup. Tests skip explicitly if `initdb` is unavailable. They use local temporary databases only; no cloud allocation is performed.
