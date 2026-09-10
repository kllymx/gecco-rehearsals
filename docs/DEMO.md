# Three-minute demo

## Opening — 15 seconds

“What happens to a release between the old version working and the new version working?
Let's keep one database alive and find out.”

Open **Release lab**. Ask someone for a name and enter it. Start with the original change.
That name is written into a real session record, with a new row ID and write marker.

## Run the experiment — 60 seconds

Read with the old app. Point to the returned name and the flat session payload in the database.

Apply the migration. The column changes and the payload becomes nested. Read with the new
app: it works. Read with the old app: the actual query fails on the renamed column.

“New instances work. Old instances still serving traffic don't. The problem is the rollout.”

Create a session with the new app, then roll back. Point to the unchanged selected row ID
and the restored column name. Read with the old app again. Now the column exists, but the
old decoder cannot read the nested payload.

“Rolling code back doesn't roll your data back. We kept the new write, so this isn't hidden
by a clean test fixture.”

## Repair — 40 seconds

Start a fresh experiment with the supplied compatibility fix and the same name. Deploy the
migration. Both columns are present. Write a new session and read it with both versions.
Roll back, then read with the old app: the old representation remains readable.

“This gives us a concrete release constraint: keep writing the old representation until old
instances have drained and the rollback window has closed.”

The fix is bundled source that can be inspected. Model-generated text is never executed.
If challenged, open the actual SQL or download the event record. The **Automated checks**
view runs all four independent scenarios and includes optional Astra analysis.

## Two changes, one failure — 45 seconds

Choose **Change interactions**. Select **Test them together**. The shared base, PR A alone
and PR B alone pass. The combination charges 949.05¢ instead of 949¢.

“One change preserves precision in price quotes. Another removes rounding at the charge
boundary. Either works alone. Together they break the same contract.”

Restore boundary rounding and rerun. All 24 observations pass. These are synthetic bundled
changes executed locally, not a live GitHub merge. Skip this segment for a shorter slot.

## Close — 20 seconds

“Gecco's distinctive idea is to review the transition and the interaction: what happens during
rollout, after new writes, during rollback, or when separately valid changes land together.”

Show the public GitHub repository. Today's runner, interface, specimens and reproduction are
public. The earlier Gecco application predates the hackathon.

## Fallback and scope

- The database lab runs locally without model or network access. Other devices need Tailscale.
- Reopening the browser restores an active lab until it expires; server restart requires a new lab.
- Completed automated runs remain in history. Recorded AI responses carry their original timestamp.
- Real PostgreSQL execution of trusted constructed examples; no production database or arbitrary repository execution.
- Results establish only the declared contract and inputs, not a blanket safe-to-deploy verdict.
