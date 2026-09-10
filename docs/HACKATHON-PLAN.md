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

1. Two usable app previews backed by independent app processes. Automatically run the old and
   new versions separately, then together during rollout, then roll back while preserving writes.
2. Let the audience pause, edit a note through either app, inspect its session and resume.
   Show the actual loss of workspace access, followed by a fresh compatibility-fix rehearsal.
3. Preserve underlying four-trial checks, the manual database lab, SQL/source evidence and export.
4. Live AI analysis of the supplied change and contract, clearly separated from database evidence.
   Unavailable AI is shown explicitly; no canned response is presented as live inference.
5. Reproducible public install, CLI, meaningful regression tests and a three-minute demo script.
6. Change-interaction matrix as a second story: individually passing changes can fail together.
   Retained regression protection remains future work.

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

The paired application demo is implemented and browser verified. The integrated suite has
53 passing tests, with a successful production build and public Linux CI. Actual browser
acceptance covers autonomous original and compatible runs, pause and a real note edit,
resume across reload, shared-note reads and matching JSON exports. A failed rollback preserves
the new session and custom note while both old application readers reject the session format.
The stable build serves at http://127.0.0.1:5181 with configurable Tailscale Serve access.
Screenshots and exact validation records are in docs/.

The separate change-interaction story, original four-trial checks and manual database lab
remain available. Actual Astra analysis was exercised earlier on both source variants; the
complete paired journey works without an inference request. Its autonomous sequence is fixed.

The older Gecco qualification tasks have separate private evidence and recovery checkpoints.
Their results do not establish this public demo's outcomes. Recovery does not require copying
private implementation or operational archives into this repository.

## Presentation priorities

- Lead with two live apps. Let both work independently before showing the rollout failure.
- Use an audience-supplied name and note to make the retained state visible.
- Show that rollback restores the old code but does not repair the newly written data.
- Run the compatibility variant; open the actual SQL and retained write if asked for evidence.
- Use the second matrix to show why teams running multiple coding agents need to reason
  about interactions between otherwise passing changes.
- Treat AI explanation as a hypothesis grounded by execution. Show Astra live if available,
  but keep the execution flow usable offline.
- End on the public repository and one reproducible command. The broader private application
  integration and arbitrary-repository execution remain follow-on work.

## Product design

The shell follows the current gecco.sh charcoal surfaces, typography, public logo and lime
controls. Two warm Fieldnotes workspaces occupy the main canvas. The headline reports the
currently observed user impact; a small stage row follows Before, Rollout and Rollback.
One primary action starts the autonomous journey. Pause enables direct interaction; completed
apps remain editable. Technical evidence stays collapsed below the application previews.
