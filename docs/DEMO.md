# Three-minute PR review and repair demo

The main demonstration is **PR review & fix**: a public pull request, two real Daytona apps,
a reproduced rollout failure, a live Astra repair commit on that same PR, and a fresh retest.
See [PR repair setup and validation](PR-REPAIR.md) and [Daytona setup](DAYTONA.md).

**Live acceptance of this complete repair flow is pending.** The earlier supplied compatibility
fixture is separate evidence; it does not establish that Astra generated or verified a repair.
Use the validation record in [PR-REPAIR.md](PR-REPAIR.md#validation-record) for the current result.

## Prepare before the presentation

Open [public PR #1](https://github.com/kllymx/gecco-rehearsals/pull/1). Its original proposal turns
a plain launch note into an interactive launch board. The original source commits are:

- [Base app and schema](https://github.com/kllymx/gecco-rehearsals/tree/cac6057e2798e99905b91977fbfd9705f2c17758).
- [Original proposed app and migration](https://github.com/kllymx/gecco-rehearsals/tree/f4d4178e5686b1a22ea36c47ee7f62a4211d10a6).
- [Original change](https://github.com/kllymx/gecco-rehearsals/compare/cac6057e2798e99905b91977fbfd9705f2c17758...f4d4178e5686b1a22ea36c47ee7f62a4211d10a6).

Confirm the current PR head before starting. After a repair is published, that same PR contains
the fix; repeating it should test the repaired head, not reproduce the original failure. Use a
new permitted sample PR at the original proposal for another complete demonstration. Preserve
the repaired PR's history.

Choose **Run PR rehearsal** with the public PR URL. Provisioning, installation, model generation,
validation, cleanup and fresh provisioning take additional time beyond the three-minute talk
track. Start early and use **Pause & explore** before deployment if needed. Allow several extra
minutes to perform the whole repair live; the timestamps and progress are actual operations.

For a strict three-minute slot, use completed evidence prepared in advance once available.
Label it **Recorded run**, include its timestamp and source commits, and distinguish it from
any apps currently running. A saved result or screenshot is not a fresh execution.
Keep signed app URLs and credentials out of slides and exported materials.

## 0:00–0:30 · Start with the real change

“This PR turns a plain launch note into a useful launch board. Gecco tests the proposed code
alongside the version that existing users are still running.”

Show the public PR and recorded base/head SHAs. Point to the previous note on the left and the
proposed board on the right. Each runs in a full Daytona sandbox with its own Git checkout,
dependencies, Node server and native PostgreSQL. Open an app directly if useful.

## 0:30–1:00 · Show that the feature works alone

Gecco reads both independent apps and checks **Test the upgrade** in the proposed board. The
board saves the item through its real app API and database. The previous app's separate note
remains unchanged.

“The new feature works on its own. This successful feature test does not yet exercise an old
instance sharing the database after deployment.”

Show **The new launch board works on its own** in **Patch, source & execution evidence**.
Use its completed save receipt as the proof.

## 1:00–1:35 · Reproduce the release failure

Resume the rehearsal. Gecco applies the exact proposed migration to the previous database and
connects the new app to that shared state through the fixed SQL gateway. The old app keeps its
base source and continues running. The journey also writes a new session and saves the checklist.

“The board still works, but the original PR breaks the old session reader. A feature can pass
its own test while its rollout locks existing users out.”

Show the actual failed old-reader receipt beside the successful new-reader and feature-save
receipts. Both apps stay visible after the seven-step journey. This is the distinctive proof:
the same feature is exercised independently and during a mixed-version release.

## 1:35–2:15 · Ask Astra to commit a repair

After the completed failure, choose **Ask Astra to fix & rerun**. This publishes a change to the
same public PR branch after validation; it does not merge the PR.

“Astra receives the exact old contract, the proposed reader and migrations, and the observed
failure. It generates a repair from that evidence.”

Show the generation and validation stages. Astra can edit only the reader/writer and the up/down
migrations. The supplied compatible solution is excluded from its input. A separate, immutable
native PostgreSQL validator checks the generated code before publication.

When publication is confirmed, open **View [commit]** or **Astra's patch**. Show the actual commit
diff and model provenance. If generation or validation fails, show that state honestly; do not
substitute a prewritten fix or describe a local, unpublished commit as published.

## 2:15–2:45 · Test the published commit from scratch

“The repair's explanation is a proposal. The next execution determines whether it worked.”

Gecco verifies deletion of the original pair before creating two fresh sandboxes. The base SHA
stays fixed; the proposed SHA is the exact published Astra commit. The same seven checks run again.

Show **Original PR test**, **Astra fix** and **Retest** together. Claim success only if the retest
is verified. If it passes, interact with the new board, then refresh the old note to show the
same persisted change. If it fails or is inconclusive, retain that result and explain the limit.

## 2:45–3:00 · Finish with inspectable evidence

“This connects a public code change, a reproduced release failure, a generated repair commit,
and a fresh execution of that exact commit. The database observations determine the result.”

Open the source and execution evidence or download the review record. Show the PR, fix commit,
original and retest identities, and completed operation receipts. The project and today's work
are in the [public repository](https://github.com/kllymx/gecco-rehearsals).
Close the final pair when finished and confirm cleanup; expiry is a backup, not a deletion receipt.

## Scope to state accurately

- This is the pinned public Fieldnotes recipe, with a deliberate compatibility failure. It does
  not accept arbitrary repositories or arbitrary shell/SQL input.
- A pass applies to the recorded commits, fixture and executed checks. It is not universal
  approval to ship, and Gecco does not merge the PR.
- The cloud journey leaves v1 and v2 running together after rollout. Native validation also
  checks rollback; a seven-step cloud pass does not claim cloud rollback was executed.
- Reload reconnects to accepted server work. Uncertain inference, publication or allocation is
  not blindly repeated; inspect the saved state rather than repeatedly submitting the action.
- **Daytona fixtures** uses supplied candidates. Earlier local examples use Node and PGlite.
  Neither is evidence of an Astra-authored repair in the PR flow.
