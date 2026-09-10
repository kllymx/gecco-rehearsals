# Gecco Rehearsals

**See what happens when this change ships.**

A release can pass tests on the old code and the new code, then fail during rollout or rollback.
Gecco Rehearsals makes those transitions visible and executable.

Built as a public hackathon extension on September 10, 2026. This is a standalone vertical slice
of the Rehearsals concept, separate from the pre-existing private Gecco code-review application.
The code in this repository is new hackathon work.

![Two live app previews during rollout: the previous version loses its workspace while the proposed version still opens it](docs/images/paired-rollout.png)

## The demo

The default **Release rehearsal** opens two interactive copies of a sample workspace application.
Gecco automatically opens both versions, puts them through a rolling deployment, writes a session
with the new code, and rolls back with that data retained. You see the application itself lose
access to its workspace when its session reader stops working.

Each browser preview is backed by a separate Node app process executing the actual bundled code.
The first stage uses separate PostgreSQL databases; the rollout stage uses shared migrated data.
Pause to take control of either app: open its workspace, inspect the session, or edit and save a
note. Resume to continue the autonomous journey. The failure blocks a real application operation.

The original change passes when each version is tested independently. During rollout, the old
version loses its session column. After rollback, the column is restored but contains data its
old decoder cannot read. A fresh rehearsal with the supplied compatibility fix preserves both
representations. The fix is inspectable source; the demo does not apply model-generated code.

**Database lab** remains available for stepping through the underlying row and schema manually.

For a complete execution in one action, **Automated checks** runs four independent trials:

| Trial | Question |
| --- | --- |
| Current release | Does the existing version work with the historical fixture? |
| Upgrade | Does the new version work after migration? |
| Mixed versions | Can an old instance still serve requests during rollout? |
| Rollback after writes | Can the old version read a record the new version created? |

The original passes the first two and exposes failures in the last two. Source, SQL,
optional Astra analysis and previous completed runs are available on demand. AI analysis
explains risks in the change; database execution independently establishes outcomes.

The second demonstration asks what happens when two changes land together. Two bundled synthetic
PRs each pass the same payment contract independently, while their combined behavior charges
fractional cents. Four configurations execute six shared inputs; restoring rounding at the payment
boundary makes all 24 observations pass. This panel runs local TypeScript functions with an
independent integer-arithmetic oracle.

![Two individual changes pass while their combined behavior fails](docs/images/interactions-breaking.png)

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

The default CLI intentionally exits with code 1 when it observes the breaking specimen's failures.
Run the compatible variant and export either result:

```sh
pnpm rehearse breaking --output artifacts/breaking.json
pnpm rehearse compatible --output artifacts/compatible.json
```

For a stable local production build, run `pnpm build` then `pnpm start` and open
[the built console](http://127.0.0.1:5181). The API and built frontend share one loopback port.
`GECCO_PORT` can change that port.

To access the demo from another device on your Tailscale network, configure an explicit
HTTPS origin when starting the server, then proxy the loopback port with Tailscale Serve:

```sh
GECCO_PUBLIC_ORIGIN=https://your-device.your-tailnet.ts.net:10000 pnpm start
tailscale serve --bg --https=10000 http://127.0.0.1:5181
```

Use your device's actual Tailscale DNS name. The server still listens only on loopback;
the configured HTTPS host and origin are accepted through the local proxy. Tailscale Serve
is accessible within your tailnet. Disable this route with `tailscale serve --https=10000 off`.

## Live AI analysis

Install the [Codex CLI](https://developers.openai.com/codex/cli/) and run `codex login` if you
want live analysis. The server uses your existing CLI authentication; credentials are not
copied into this repository. `GECCO_AI_MODEL` overrides the model, otherwise the configured
Codex model is used. This hackathon instance is configured for `gpt-6-astra`.
On macOS, the adapter prefers the runtime bundled in the installed Codex app, because older
global CLIs may not support the configured model. `GECCO_CODEX_BIN` selects an explicit binary.

Only the fixed public specimen and contract enter the model prompt. Analysis uses noninteractive
Codex with a read-only sandbox, structured output and a bounded lifetime. AI requests may consume
your provider usage. The database demo works without an AI account or network connection.

Successful analyses are cached in this browser against the exact specimen inputs. Restored
responses are labeled **Recorded analysis** with the original timestamp. A fresh request always
calls the configured model. The fix button selects the supplied compatible code; AI text is
never executed.

## Verified demo

- 53 engine/API regression tests pass, covering real PostgreSQL trials, retained writes,
  setup failure, independent fixtures, cancellation, persisted evidence and change interactions.
- Production build and public Linux CI pass.
- Paired app tests verify live process independence, database routing, note writes, process replacement,
  retained data, autonomous execution, pause/resume, revision checks and cleanup.
- Actual `gpt-6-astra` inference has been exercised on both source variants.
- Browser acceptance covers breaking run, SQL evidence, compatibility rerun, live analysis and
  recorded-analysis restoration after reload, plus both interaction variants and JSON export.
- The interactive lab has been exercised through the original and compatible transitions,
  including personalized records, stale reads, reload restoration and matching JSON exports.

See the [validation record](docs/VALIDATION.md) for scope and provenance.

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
- [Interactive lab behavior](docs/INTERACTIVE-LAB.md)
- [Paired applications and autonomous journey](docs/PAIRED-APPS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [MIT license](LICENSE)

No private Gecco repository, account, operational archive or database is needed for execution.
Live AI analysis is optional and reports unavailability explicitly when no provider is configured.
