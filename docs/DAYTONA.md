# Daytona release rehearsal

The cloud rehearsal runs two complete copies of the public Fieldnotes application in separate,
private Daytona sandboxes. Each gets a Node.js environment, cloned source, installed dependencies,
a filesystem, a running HTTP application and its own native PostgreSQL database. Browser frames
load the real applications from separate Daytona origins.

This is a fixed sample recipe for demonstrating release compatibility. The browser selects a
sample variant and a session label. It cannot submit a repository URL, source path, SQL statement
or shell command. The source, install commands and migrations come from this public project.

## Setup

Requires Node.js 22.12+, pnpm 10, a Daytona account with capacity for two sandboxes, and outbound
access for the public image, GitHub, Debian packages and npm. The pinned SDK is `@daytona/sdk`
0.211.2. No private Gecco repository or operational archive is needed.

1. Create an API key in your Daytona account using the [authentication guide](https://www.daytona.io/docs/en/authentication/).
2. Copy `.env.example` to `.env.daytona`, set its permissions to `600`, and fill in the key. The example already pins the three public sample commits.
3. Install, build and start the coordinator:

```sh
pnpm install --frozen-lockfile
pnpm build
node --env-file=.env.daytona --import tsx server/index.ts
```

Open [the console](http://127.0.0.1:5181), select **Release rehearsal**, enter a session name and
choose **Run cloud rehearsal**. Provisioning returns an accepted response immediately. The console
shows completed setup observations as work progresses; the server continues when you reload.

| Setting | Purpose |
| --- | --- |
| `DAYTONA_API_KEY` | Host-only Daytona API credential. |
| `DAYTONA_API_URL` | API endpoint; normally `https://app.daytona.io/api`. |
| `DAYTONA_TARGET` | Daytona region; this recipe defaults to `us`. |
| `GECCO_CLOUD_BASE_REF` | Full published commit SHA for the previous app. |
| `GECCO_CLOUD_BREAKING_REF` | Full published commit SHA for the original proposed change. |
| `GECCO_CLOUD_COMPATIBLE_REF` | Full published commit SHA for the compatibility fix. |
| `GECCO_PORT` | Local coordinator port; defaults to `5181`. |
| `GECCO_PUBLIC_ORIGIN` | Optional exact HTTPS origin for your Tailscale Serve route. |

The three source refs must identify published commits of
[`kllymx/gecco-rehearsals`](https://github.com/kllymx/gecco-rehearsals). A branch name or an unpublished
working tree is not an execution input. The sample changes the session implementation in
`apps/fieldnotes/release.ts` across the base, breaking and compatible revisions. The coordinator
checks out the selected commits and verifies Git's actual HEAD. The running application loads the
implementation from that checkout.

The published sample refs in `.env.example` are:

| Role | Full commit | Public branch |
| --- | --- | --- |
| Previous | `5b8ecfafce803286e4418bdfb99c369dc9cc90eb` | `codex/demo-previous` |
| Breaking | `f7a4bc447f269513b2f6eacd44b42f2a44fe5633` | `codex/demo-breaking` |
| Compatible | `af4e7c64a154958f8fd858ae402bfec6fdce2274` | `codex/demo-compatible` |

The branches make the changes easy to inspect; execution uses the immutable commit SHAs.

## What runs

The provider creates exactly two private sandboxes from the public `node:22-bookworm` image.
The trusted bootstrap installs PostgreSQL, Git and curl, initializes a database and starts native
PostgreSQL. Setup runs as root inside the sandbox; the database and Fieldnotes process run as
unprivileged users. The clone is installed with `npm ci` from the sample's lockfile.

Fieldnotes serves its interactive workspace on port `3000` and authenticated coordinator routes
on port `4000`. Its session reader and writer execute real SQL. A broken session reader prevents
the actual app from opening the workspace or saving a note; no overlay invents that failure.

The previous app presents a plain launch note. The proposed app adds an interactive launch board
using the same saved note content. The starting fixture contains three items: **Draft release
notes** is checked; **Test the upgrade** and **Announce launch** are unchecked. A successful feature
test must save and read back the updated content through the actual application.

| Stage | Executed behavior |
| --- | --- |
| Independent baseline | The previous checkout uses its own original database. The proposed checkout uses its own migrated database. Both read the same starting fixture. |
| Try the new feature | The proposed app checks **Test the upgrade** and saves it in its independent database. The previous app's note remains unchanged. |
| Rolling deployment | The coordinator migrates the previous sandbox's database. The proposed app connects to that database through the authenticated gateway; the old app still runs. Both read it. |
| New writes and feature check | The proposed app writes a new session, both apps select it, and the proposed app saves a checked launch item in the shared database. Both apps then read the workspace. |
| Main journey complete | The old v1 app and new v2 app remain running side by side for exploration. No automatic rollback replaces the new feature. |
| Optional rollback | **Test rollback** runs the down migration, checks out the base commit in the proposed sandbox and restarts its app process. Both apps read the retained new session and note. |

The gateway forwards only the sample's fixed, allowlisted statements to the previous sandbox's
native PostgreSQL. It checks the configured database identity. This demonstrates shared database
state across two separate running applications without exposing a general SQL endpoint.

The server performs seven actions sequentially: read both apps, check an item in v2, deploy, read
both, write a new session, check the item against shared data, and read both again. It uses
deliberate pauses between completed steps so
the results are readable. Those pauses are presentation time, not simulated execution. **Pause &
explore** waits for an accepted step to finish, then lets you edit notes in the apps. **Resume**
continues from the journey cursor. Compatibility outcomes come from app responses and SQL traces;
missing responses and inconclusive setup operations stop the journey.

The checklist step verifies both the operation result and the exact saved content. If a user has
removed or renamed the expected checklist item, the automated step stops and preserves that note.
It does not replace custom content to manufacture a successful feature check.

## Limits and cleanup

| Bound | Setting |
| --- | --- |
| Active experiments | One pair: two sandboxes, including creation in progress. |
| Resources per sandbox | 1 vCPU, 2 GiB memory, 3 GiB disk. |
| Wall-clock TTL | 60 minutes from sandbox creation. |
| Auto-stop backup | 15 minutes of inactivity, as defined by Daytona. |
| Auto-delete | `0`: delete immediately after stopping. |
| SDK create timeout | 300 seconds per sandbox; local grace and reconciliation can take longer. |
| Trusted command deadline | At most 300 seconds; individual operations use shorter bounds. |
| Retained command output | 64 KiB per result, with original byte count and a truncation flag. |
| Browser preview expiry | At most 60 minutes; the sandbox must still exist and run. |

Daytona's SDK buffers a command response before the provider retains its output excerpt. The
64 KiB limit bounds saved/displayed output, not the SDK's upstream transport memory. The sample's
trusted commands use bounded output. Lifecycle semantics are described in the
[official sandbox documentation](https://www.daytona.io/docs/en/sandboxes/).

Choose **Close sandboxes** after the demo. The coordinator waits for accepted work, asks Daytona
to stop/delete the owned instances, and inspects their identities and state to confirm deletion.
It releases the capacity slot only when cleanup is verified. A stopped process, an accepted
delete request or an elapsed local timeout is not itself proof of remote deletion.

Create intent and operation IDs are retained under gitignored `artifacts/daytona/`. Sandbox names
are deterministic for an experiment, with ownership labels. An uncertain create is reconciled
against its original identity instead of blindly allocating another pair. An uncertain command
is not replayed, and further writes are blocked. Keep the state directory intact until cleanup
is confirmed. A coordinator restart reconciles and closes a saved active pair instead of
restarting its journey or redoing its setup.

If cleanup needs attention, refresh the saved experiment and retry **Close sandboxes** to inspect
the same owned resources. Do not delete the state directory to bypass the capacity check.
The TTL and auto-stop are remote backups; their presence is not a cleanup receipt.

## Credentials and previews

`.env.daytona` and `artifacts/` are gitignored. The Daytona API key stays on the coordinator host;
it is never included in application uploads, browser configuration or evidence. The runtime
creates a separate app admin token, stored in private files for the running apps and coordinator.

Server requests to private app endpoints use Daytona preview headers. Browser frames instead use
expiring signed preview URLs. These URLs authorize access to the sample app and should remain
private. The console hides their raw addresses and excludes them from JSON evidence exports;
the coordinator also omits preview addresses from persisted public snapshot data. See
[Daytona preview authentication](https://www.daytona.io/docs/en/preview/).

For another device on your tailnet, add the exact origin to `.env.daytona` and run Tailscale Serve:

```sh
# In .env.daytona, replace this with your actual device DNS name:
# GECCO_PUBLIC_ORIGIN=https://your-device.your-tailnet.ts.net:10000
node --env-file=.env.daytona --import tsx server/index.ts
```

In another terminal:

```sh
tailscale serve --bg --https=10000 http://127.0.0.1:5181
```

The coordinator still binds to loopback. Its host/origin checks accept the explicitly configured
proxy origin. Tailscale Serve exposes the console to your tailnet. To remove that route:

```sh
tailscale serve --https=10000 off
```

## Validation scope

A live Daytona smoke run on September 10, 2026 used Node.js 22 and native PostgreSQL 15.19.
The breaking specimen produced these observed reads:

| Stage | Previous app | Proposed app |
| --- | --- | --- |
| Independent baseline | Passed | Passed |
| Shared database during rollout | Failed | Passed |
| After rollback, with new data retained | Failed | Failed |

The run confirmed a restarted proposed app process and the same shared database identity after
rollback. An earlier source-install failure caused by Git ownership checks was fixed; deletion
of both sandboxes from that failed setup was verified.

The earlier compatible cloud journey subsequently completed all seven actions successfully using
separate published source commits. Its observed reads passed in both apps at the independent
baseline, during rollout, after new writes and after rollback. Rollback performed an actual Git
checkout of the base source and started a new app instance while retaining the shared database.
Manual browser acceptance also saved a note in the previous app and observed that exact note
after refreshing the proposed app in its real Daytona frame.

These are live cloud observations of the supplied sample. Local PGlite results and mocked
provider tests are recorded separately and do not substitute for cloud acceptance.

The revised launch-board journey ends during rollout and makes rollback optional. Its focused
manager tests verify independent and shared checklist writes, preservation of edited notes,
failed-save evidence, and optional rollback with retained data. Live browser acceptance of that
revised visual flow is recorded separately from the earlier automatic-rollback run above.

The provider and cloud manager have focused mock tests for bounded requests, uncertain outcomes,
restart cleanup, preview handling, autonomous control, HTTP response interpretation and capacity.
The Fieldnotes app also has native PostgreSQL integration tests. Run repository checks with:

```sh
pnpm test
pnpm build
```

The older **Local examples** remain available separately. They use PGlite, PostgreSQL compiled to
WebAssembly; their screenshots and historical acceptance are documented in
[the validation record](VALIDATION.md). The separate **Change interactions** panel runs trusted
local TypeScript payment functions. Neither is presented as a Daytona sandbox.

The supplied defects demonstrate release compatibility, not a benchmark of AI review accuracy.
An observed passing contract covers the source and fixture actually executed; it does not prove
an arbitrary production release is safe.
