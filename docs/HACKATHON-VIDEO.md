# One-minute Gecco hackathon video

**Positioning: a feature can work alone and still break a release. Gecco reproduces that failure, gives Astra the evidence to repair it, and executes the exact fix again.**

The visual is two real apps, but the distinctive capability is testing the transition between versions: an old reader and a new writer sharing migrated data during deployment. Astra turns the observed failure into a compatibility patch across the application and migrations. Independent execution determines whether that patch works.

## Read this aloud — approximately 60 seconds

> A new feature can pass its tests and still break a release. Gecco shows you why.
>
> This public pull request turns a launch note into an interactive board. Both versions work alone.
>
> But during deployment, old and new code share a database. This recorded original run shows the board working while existing users lose access.
>
> Astra gets the exact source and real failure. It reasons across the old reader, new writer, and migration, then generates a compatibility fix. Gecco validates it and commits it to the same public PR.
>
> That exact commit passed fifteen PostgreSQL checks, including rollback, then all seven checks in fresh Daytona sandboxes.
>
> These repaired apps are live. Tick a task here, and the old app reads the change.
>
> A public change, a reproduced failure, an Astra repair, and verified execution. The hackathon work is open source.

## Screen choreography

| Time | What to show |
| --- | --- |
| 0–8 seconds | The live demo with its public repo/PR links and completed three-step sequence visible. Say the opening sentence and point out the note → board change. |
| 8–23 seconds | Switch to the **recorded original failure image**. Point at the working board and the old app's “Your workspace is out of reach.” Say “recorded original run.” |
| 23–37 seconds | Switch to **Astra's commit** on the same public PR. Briefly show that the reader/writer and migrations changed. Keep the explanation about compatibility, not SQL syntax. |
| 37–48 seconds | Return to the live demo. Point at “Committed to PR” and “Retest Passed.” Mention 15 native checks and seven fresh Daytona checks. |
| 48–60 seconds | Toggle **Announce launch** in the board. Leave the old note editor unfocused; its normal polling shows the stored change. End with the public repo link visible. |

Use just three tabs. Open them before recording:

1. [Live demo](https://maxs-mac-mini.tail94229b.ts.net:10000/) — requires tailnet access.
2. [Recorded original failure image](https://raw.githubusercontent.com/kllymx/gecco-rehearsals/main/docs/images/pr-1-original-failure.png).
3. [Astra's exact repair commit](https://github.com/kllymx/gecco-rehearsals/commit/5eff359d6f0a5fac3d1d814d286539ffb29a1bb8).

For this recording, use the completed run and its live repaired apps. Provisioning and generation took longer than one minute. PR #1 now contains the repair; running it again tests the repaired head. Keep the existing pair running. It is scheduled to expire at **5:49 p.m. New York time on September 10**.

Expand is useful if the app or code is hard to read. For the final checkbox demonstration, keep the apps side by side so the persisted change is obvious. Save any unfinished note draft before refreshing the console to load the new Expand control. Expanding/restoring itself keeps the same iframe mounted.

## What this demonstrates about Astra

- It receives the actual old contract, proposed code and observed error, rather than a supplied compatible solution.
- It produces a real three-file repair that preserves the new UI while restoring compatibility with old readers and retained data.
- The orchestrator validates and publishes that patch, then creates fresh sandboxes at the exact commit. The model's explanation cannot set the pass result.

Say “Gecco orchestrates; Astra reasons and writes the repair.” This example uses a fixed execution journey; Astra did not design the tests, drive the browser or provision the infrastructure. The current implementation supports the public Fieldnotes sample, not arbitrary repositories. The seven cloud checks cover rollout; the separate native validator also exercises rollback.

Avoid claims that another review tool missed this deliberate example, or that passing these checks proves every deployment safe. The useful claim is concrete: **both versions passed alone; deployment broke old users; Astra's repair passed the same scenario.**

## If asked about evidence or CI

- [Public PR #1](https://github.com/kllymx/gecco-rehearsals/pull/1) remains open and unmerged.
- [Complete live run evidence](evidence/pr-1-astra-repair-proof.json).
- [Recorded live interaction](evidence/pr-1-repaired-interaction-proof.json).
- [Independent GitHub validation of the exact repair](https://github.com/kllymx/gecco-rehearsals/actions/runs/34529977675) passed both TypeScript configurations and 15 native checks.

The earlier generic PR CI retains a fixture-wiring failure: it combined a repaired reader with the bundled destructive migration. Main's fixture tests were corrected, and the separate exact-source check passed without changing Astra's commit. This is documented in the PR; do not claim those original failed CI runs became green.

If live interaction is unavailable, use the [recorded verified view](images/pr-review-console.png), label it as recorded, and say “The recorded rerun verifies that both versions retain access after the repair.” Do not start a new provisioning cycle mid-take.
