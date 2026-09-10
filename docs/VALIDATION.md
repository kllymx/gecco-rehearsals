# Demo validation — September 10, 2026

## Implementation and tests

Initial integrated UI revision: `def40b9db21bb012eb4354ea75dc0a13d62065ad`.
Node 22.22.3 / pnpm 10.27.0 on macOS arm64.

- `pnpm test`: 16 passed, zero skipped, about 15.5 seconds. Real engine tests exercise both
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
