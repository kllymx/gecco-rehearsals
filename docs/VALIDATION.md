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
