# Gecco Rehearsals — September 10, 2026

## Demo thesis

Old code passes. New code passes. Shipping still breaks production.

Show the transition: current release → migration → mixed versions → new writes → rollback.
Run a declared compatibility contract against real, disposable PostgreSQL fixtures and expose
the query, observed rows/error, versions and preserved write behind each result. Then select
a compatibility fix and rerun the same contract.

## Today's public deliverable

This repository contains newly written hackathon code, a runnable specimen, a visual console,
an executable reproduction and documentation. It is separate from Gecco's pre-existing private
product repository. No private source, operational data, credentials or historical archives are
required to run it. The first implementation uses PGlite (PostgreSQL in WASM) for trusted bundled
specimens. It does not execute arbitrary repository scripts or claim production isolation.

## Priorities

1. Real four-trial upgrade/rollback execution with independent fixtures between trials and state
   retained within each trial. Old-reader and post-write rollback failures must be observed.
2. Visual transition matrix, step-by-step SQL evidence, source comparison, fix/rerun, JSON export.
3. Live AI analysis of the supplied change and contract, clearly separated from database evidence.
   Unavailable AI is shown explicitly; no canned response is presented as live inference.
4. Reproducible public install, CLI, meaningful regression tests and a three-minute demo script.
5. Completed stretch: parallel-PR interaction matrix. Started after the primary demo passed tests, public
   Linux CI, real inference and the browser walkthrough. Retained regression protection remains
   future work.

## Owners and boundaries

- Coordinator: scaffold, shared API/types, integration, public repository, acceptance and demo story.
- Engine: `engine/**` and engine tests; real database transitions and CLI.
- Interface: `src/**`; visual console using shared contracts and server endpoints.
- Server/AI: `server/**`; loopback API, bounded AI invocation, execution concurrency and persistence.
- Existing Gecco runnable-recipes/evidence tasks: recover and finish prior private qualification;
  do not block this clean public vertical slice or publish private archives.

## API contract

- `GET /api/health` — status and AI availability.
- `GET /api/specimen` — `Specimen` from shared/contracts.ts.
- `POST /api/rehearse` with `{ "variant": "breaking" | "compatible" }` — actual `RehearsalRun`.
- `POST /api/analyze` with `{ "variant": "breaking" | "compatible" }` — actual `AnalysisResult`.
- `GET /api/runs` — previous completed runs, newest first.
- `GET /api/runs/:id` — saved run for reload/export.

Engine exports `getSpecimen(): Specimen` and `runRehearsal(variant: Variant): Promise<RehearsalRun>`.
Shared types are owned by the coordinator; propose changes before altering them.

Interaction extension: `GET /api/interactions/specimen` and `POST /api/interactions` with the same
fixed variant input. Base, PR A, PR B and their combined behavior run the same declared integer-cent
contract. This uses trusted local TypeScript functions and synthetic inputs, not a GitHub merge or
a payment service. Completed observations can be exported as JSON.

## Acceptance

- Breaking change: control and upgrade pass; mixed versions and rollback fail for demonstrated causes.
- Compatible fix: all four pass under the same expectation.
- Rollback reads a marked row created by the new version; no reset erases it inside that trial.
- Failed setup is inconclusive rather than a regression verdict. Every trial closes its database.
- Interface renders actual API results, discloses scope and can replay/export recorded observations.
- AI rationale never controls or fabricates execution outcomes; provider failures remain visible.
- Tests, build, browser walkthrough, clean public clone instructions and public commit readback.

## Working schedule

Planning target: 5:00 p.m. New York time, pending the user's exact deadline.
First runnable vertical slice before noon; integrate and verify around 1 p.m.; polish and rehearse
by 3 p.m.; reserve the remaining time for a live demo, submission and unexpected failures.

## Claims

Positioning: “See what happens when this change ships.” This demonstrates transition-aware code
review; it does not claim competitors lack every related feature, that synthetic defects establish
model accuracy, or that a passing rehearsal proves a release is safe.

## Current checkpoint

At 11:20 a.m. New York time, the primary public demo is runnable and pushed at `6901c54`.
16 implementation tests and the production build pass. Public Linux CI passed `def40b9`, and
actual Astra inference completed for both variants. Browser acceptance verified breaking result,
rollback rows, compatible rerun, saved history, recorded analysis after reload and JSON download.
The stable local build serves at http://127.0.0.1:5181. Screenshots and validation are in docs/.

The old Gecco qualification tasks are progressing independently. Their private test receipts do
not establish the public demo's results, and their remaining work does not block this demo.

At 11:32 a.m., the interaction extension also passes browser acceptance: three independent
configurations pass, the combined changes fail, and the supplied boundary fix makes all
four pass. The integrated suite has 24 passing tests. JSON download preserves all 24
observations. Both demonstrations are complete; demo rehearsal and old runtime qualification
are the remaining focus.
