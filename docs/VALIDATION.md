# Demo validation — September 10, 2026

## Implementation and tests

Initial integrated UI revision: `def40b9db21bb012eb4354ea75dc0a13d62065ad`.
Node 22.22.3 / pnpm 10.27.0 on macOS arm64.

- Initial `pnpm test`: 16 passed, zero skipped, about 15.5 seconds. Real engine tests exercise both
  variants and repeated clean fixtures; API tests use controlled services for transport and
  cancellation cases. This is implementation verification, not model-accuracy evaluation.
- `pnpm build`: TypeScript and Vite production build pass.
- [Public Linux CI](https://github.com/kllymx/gecco-rehearsals/actions/runs/34494593345)
  passed install, all tests and build on the integrated revision.

## Actual engine and browser observations

The browser at 1440×900 completed the primary flow using actual loopback API requests:

| Run | Variant | Observations |
| --- | --- | --- |
| `2a37b8f4-0d5…` | Breaking | Current and upgraded release passed; mixed versions and rollback failed. 4.1 seconds. |
| `8404223f-d6f…` | Compatible | All four passed under the same contract. 3.8 seconds. |

The rollback evidence drawer showed the actual query result containing the exact v2-created
row and its write marker. The query succeeded, then the old reader rejected the nested payload.
The mixed-version failure was PostgreSQL error 42703 for the renamed column. These are distinct
observed mechanisms. No reset occurred before the rollback read.

Saved history loaded after a browser reload. The interface retains original timestamps and
contracts; it suppresses current-source display if the selected run's digests do not match.
The stable production server on port 5181 rendered the built assets and saved history. Its
browser export downloaded run `2a37b8f4-0d54-4aad-b0b9-fab138a7a477`; parsing the downloaded
JSON confirmed the same original variant and pass/pass/fail/fail matrix.

Screenshots are actual captures of the local application:

- [Breaking matrix](images/rehearsal-breaking.png)
- [Compatible matrix](images/rehearsal-compatible.png)
- [Rollback evidence](images/rehearsal-evidence.png)

## Change-interaction extension

Engine `9806e05`, server `cf143e1`, interface `0af2b0f`: the integrated test suite passes
**24 tests**, zero skipped, in about 17 seconds. TypeScript and the production build pass.
[Integrated public Linux CI](https://github.com/kllymx/gecco-rehearsals/actions/runs/34496198837)
also passed all 24 tests and the build at `346500f`. The six interaction tests exercise the common input corpus, independent exact oracle,
variant behavior and input/source provenance. Nine API tests cover both bounded endpoints.

The production browser ran the original variant at 11:30:05 a.m. New York time: base, A
and B passed; A+B failed on two of six inputs. For 999¢ at 5% discount it charged 949.05¢
instead of 949¢. For 101¢ at 50% it charged 50.5¢ instead of 51¢. The fix ran at
11:30:13 a.m.; all four configurations and all 24 observations passed.

The browser downloaded compatible run `c7a2ae1e-2ba0-4d48-b07e-38924fc4102c`. Parsing that
JSON confirmed four passing cells with six observations each. The UI discloses synthetic
PRs and local TypeScript execution, and describes the combined changes without claiming
to have merged live PRs. This is a constructed demonstration, not a detection benchmark.

- [Original interaction matrix](images/interactions-breaking.png)
- [Compatible interaction matrix](images/interactions-compatible.png)

Independent final review corrected active PR B source presentation and retry intent at
`c82f6e3`. At 11:36 a.m., the browser forced a real connection failure by stopping the
loopback server before requesting the compatible run. After restart, **Try again** ran
the compatible variant and all four cells passed. The source panel displayed the actual
`Math.round(quotedCents)` boundary fix and identified it as active.

## Live inference

Actual `gpt-6-astra` inference completed for both variants using the existing authenticated
Codex app runtime 0.153.4. The global CLI 0.142.4 rejected that model; runtime discovery now
prefers the installed app. No global install or credential copying was performed.

The browser also completed a compatible-variant request at 11:17:46 a.m. New York time.
After reload, selecting that variant restored the same response as **Recorded analysis** with
its original timestamp. The model described the fallback reader, dual writes and rollback
behavior, while identifying deployment ordering and unsupplied update paths as limits.
These are model hypotheses, separate from the database verdicts. The runner never executes
model-generated code, and the compatibility fix is an inspectable supplied variant.

## Remaining qualification

This public vertical slice uses a synthetic trusted specimen on PostgreSQL in WASM. It does
not establish arbitrary repository execution, integration with the hosted Gecco control plane,
full production isolation, mobile-browser acceptance or defect-detection accuracy.

## Simplified product interface — noon redesign

The interface was rebuilt against the actual live gecco.sh product: its public logo,
charcoal surfaces, sidebar, Arial typography and restrained lime controls. The initial
view presents one release example with one primary action. Code, contract details,
Astra explanation and history are collapsed; interaction checks have their own view.
The logo is the user's public brand asset from
https://gecco.sh/brand/scales-v2/svg/gecco-lockup-dark.svg; no private application source
was copied into this implementation.

Actual browser checks through Tailscale verified the original release2/4 result,
compatible4/4 result, retained-write evidence drawer and separate interaction view (original3/4, fixed4/4).
TypeScript and production build pass. Database/worker code is unchanged by this redesign.

## Interactive database lab — September 10 afternoon

The public extension now defaults to a manual experiment, with one retained database and
visitor-supplied session name. Engine `707e9c3`, bounded API `3a58b79`, interface through
`5d91717`. **40 tests pass**, zero skipped, including seven new real database lab tests
and eight new API/worker tests. TypeScript and production build pass.

Tests cover the same database and exact marked v2 row through rollback, SQL parameter
binding, compatibility behavior, setup failure, invalid phases/revisions, immutable retry
responses, concurrent commands, 100-event limit, capacity reservations, expiry, bounded
worker lifetime, cancellation and explicit deletion.

Actual browser execution through the Tailscale HTTPS endpoint at 12:13–12:19 p.m. New York:

- Original lab `93661dec-cdb7-44fe-a714-0826f3f8e853` wrote label `Astra live 12:15`.
  Database `84acf648-2159-403c-8c06-4f62da641e02` remained the same through all eight commands.
  The old reader succeeded initially, failed with PostgreSQL 42703 after migration, and failed
  with its payload-contract error after rollback. The new reader succeeded after migration
  and after writing the selected v2 record. Three rows remained after rollback.
- Reload restored revision 8 with the same database and selected v2 row. Browser JSON download
  was parsed and matched the nine displayed events, custom label, database ID and selected row.
- Setting up the fix closed the original lab and retained the typed name in a fresh setup.
  The compatible experiment used a different database `b0a8ff92-d915-4c09-9fa3-3f0006a26b91`
  (full ID is in its exported event record). Both readers returned the same custom label and
  editor role from the new v2 write. Its old representation remained after rollback and the
  old reader succeeded. No original lab state was reused as a fix result.
- Read cards explicitly became stale after migration, new writes and rollback. Guided actions
  moved above the canvas for the laptop viewport. SQL and event history remained collapsed.

Actual screenshots: [rollback failure](images/lab-rollback.png) and
[both readers using the compatible new write](images/lab-compatible.png).

The manual lab executes fixed trusted specimen code; it does not run a live traffic service
or authenticate a user. Its sessions expire after 15 idle minutes or 30 total minutes and do
not survive a server restart. JSON exports preserve observations, not a restorable database.

## Paired apps — September 10 afternoon

The default view now opens two interactive Fieldnotes browser documents, each backed by a
separate Node app process executing the bundled session code. The original manual lab remains
under **Database lab**. Engine `3226ed2` / `ff16c2e`, API `a36b323`, preview integration `6bfab3c`
and interface through `76e9001` implement the paired journey. **53 tests pass**, zero skipped;
TypeScript and the production build pass. [Public Linux CI at `983074c`](https://github.com/kllymx/gecco-rehearsals/actions/runs/34503907612)
passed all tests and the build before the final completed-state text change.

Four new real-engine tests check distinct live app PIDs, isolated initial databases, shared
database routing during rollout, actual note reads/writes, retained marked rows and notes through
rollback, replacement of the proposed app process, command retries/conflicts, inconclusive worker
failure and cleanup. Nine new API/worker tests check the real coordinator, autonomous completion,
pause/read/save/resume, client disconnect, expiry, bounded concurrency and resource cleanup.

Actual browser execution through the Tailscale HTTPS endpoint at 12:38–12:48 p.m. New York:

- Both versions opened their workspaces independently. During the original rollout, the left
  app failed its session read while the new right app still opened. After rollback, both v1 app
  processes rejected the retained v2 payload and neither workspace opened. These observations
  drive the headline above the previews; no outcome is supplied by a presentation timer.
- Compatible experiment `991912fe-c544-4676-b3c4-1edfff1df365` completed all eight actions. A user
  then saved **Live from NYC: this note survived the release.** through the left app. The right
  app became stale; opening its workspace read that exact note from the same database. Downloaded
  JSON contained 11 events at revision 10, all passing, with separate live app IDs and one shared
  database `731d407a-845c-479a-854c-611ca385a21a`.
- Original experiment `89f872de-e117-4f39-ad65-a2ba22d4eefd` paused after six autonomous actions.
  Reload preserved the pause. Saving **Edited while paused. Keep this note through rollback.**
  through the working right app succeeded. Resume followed by another browser reload completed
  only the two remaining actions. Downloaded JSON confirmed eight autonomous actions plus that
  one manual save (revision 9, ten events including creation), on the same shared database
  `1fbed689-0dcb-4e49-911d-3d011ed139f4`.
- That final export retained both the exact custom note and v2 session
  `twin-v2-54be2492-c31c-4194-8122-d8bf1e2272af`, while both old readers reported their actual
  payload-contract errors. The right application instance changed on rollback. This distinguishes
  data preservation from application compatibility: the note exists, but the old app cannot open it.
- **Try compatibility fix** closed the original experiment and automatically ran a fresh one.
  Both previews opened after rollout and rollback. Source, SQL, history and JSON export remained
  available below the main view. Completed apps remain directly editable.

Actual screenshots: [rollout with one blocked app](images/paired-rollout.png),
[rollback with both blocked](images/paired-rollback.png),
[compatible apps](images/paired-compatible.png), and
[a note saved and read through both apps](images/paired-notes.png).

The backend runs a fixed eight-action journey with short intervals to make completed observations
readable. This is not an AI-generated browser plan. The two app processes run trusted bundled code;
they are not hardened sandboxes for arbitrary repositories. Databases use real PostgreSQL through
PGlite. The paired demo requires no inference request and survives browser reload, but not server
restart or experiment expiry. JSON is an observation export, not a restorable runtime.
