# Three-minute demo

## Opening — 20 seconds

“AI code review usually shows you a suspicious line. I want to see what happens when that
change ships. This migration passes on the old version and on the new version. Watch the rollout.”

Show the small session-storage change and the declared contract: sessions written by a deployed
version must remain readable by instances still serving traffic and after a rollback.

## Run — 45 seconds

Select **Rehearse this change**. Show four actual outcomes: current passes, upgrade passes,
mixed versions fails, rollback after new writes fails. Open the mixed-version query/error.

“The new application is fine. An old instance still serving traffic cannot read the renamed column.”

Open rollback evidence and the marked new-version write.

“A simple rollback test can miss this if it resets the database. We keep the new writes and
switch the application back. The old reader cannot understand this record.”

## Explain and repair — 50 seconds

If live analysis is available, show the model's interpretation and its connection to the observed
steps. Explain that the model proposes risks; actual queries establish the result.

Select **Test compatibility fix**. Show the dual representation/dual write change. Rerun the same
contract and show all four trials passing. Compare the exact earlier failure against this run.

## Two changes, one failure — 40 seconds

Choose **Change interactions** in the sidebar. On “Two changes. One broken checkout.”,
select **Test them together**. The shared base,
PR A alone and PR B alone pass. Their combination fails with 949.05¢ charged instead of 949¢.

“A preserves precision in price quotes. B removes rounding at the charge boundary. Either
change alone works. Together they violate the same contract. The problem lives between changes.”

Restore boundary rounding and rerun. All four combinations pass. Explain that these are two
synthetic bundled changes executed locally, demonstrating the interaction check rather than
a live GitHub merge. Skip this segment if the slot is under three minutes.

## Evidence and close — 25 seconds

If the audience asks for proof, open a result card for SQL and the retained write,
or download **Export result**. Keep the main story on the compact result and fix.

“The useful output is a release constraint: keep the old representation readable until old
instances have drained and rollback is no longer needed. This is the beginning of code review
that reviews the path into production.”

Show the public GitHub repository. Explain that today's demo, specimen, runner, interface and
reproduction are public; the earlier Gecco application predates the hackathon.

## Fallback

Keep one completed breaking run and one compatible run in local history. If the network or
AI provider fails, execute the database rehearsal locally and show the saved AI response only
if clearly identified with its original timestamp. Never present a replay as fresh execution.

## Claims to keep precise

- Real PostgreSQL execution of a deliberately constructed specimen; no production access.
- A standalone hackathon vertical slice; hosted arbitrary-repository execution is future work.
- Observed compatibility failures, not a blanket “safe to deploy” verdict or accuracy benchmark.
