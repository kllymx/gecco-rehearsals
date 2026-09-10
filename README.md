# Gecco Rehearsals

**See what happens when this change ships.**

A release can pass tests on the old code and the new code, then fail during rollout or rollback.
Gecco Rehearsals makes those transitions visible and executable.

Built as a public hackathon extension on September 10, 2026. This is a standalone vertical slice
of the Rehearsals concept, separate from the pre-existing private Gecco code-review application.
The code in this repository is new hackathon work.

## The demo

A session-storage migration changes a column and the JSON payload it stores. Rehearsals runs
four trials against disposable PostgreSQL databases:

| Trial | Question |
| --- | --- |
| Current release | Does the existing version work with the historical fixture? |
| Upgrade | Does the new version work after migration? |
| Mixed versions | Can an old instance still serve requests during rollout? |
| Rollback after writes | Can the old version read a record the new version created? |

The breaking migration passes the first two and exposes failures in the last two. A compatibility
fix reruns the same contract. Each result retains the actual SQL, observations and state lineage.
AI analysis explains risks in the change; database execution independently establishes outcomes.

## Run locally

Requires Node.js 22.12+ and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [the local console](http://127.0.0.1:5180). The API runs on port 5181.

```sh
pnpm test
pnpm build
pnpm rehearse
```

Implementation is underway; command acceptance and final demo instructions will be recorded
in this repository when the first integrated slice passes.

## Scope

The specimen runs actual PostgreSQL through PGlite (PostgreSQL compiled to WebAssembly).
The runner executes only the trusted bundled specimen. It is not an arbitrary-repository sandbox,
and it does not connect to a production database. Source and fixture digests identify the inputs;
trial databases reset between trials while state persists through each trial's transitions.

The defects are deliberately constructed to demonstrate release compatibility failures. They are
not a benchmark of AI detection accuracy. A passing rehearsal is evidence about its declared
contract and fixture, not a guarantee that a release is safe.

## Project

- [Hackathon plan](docs/HACKATHON-PLAN.md)
- [Demo script](docs/DEMO.md)
- [Architecture](docs/ARCHITECTURE.md)
- [MIT license](LICENSE)

No private Gecco repository, account, operational archive or database is needed for execution.
Live AI analysis is optional and reports unavailability explicitly when no provider is configured.
