# Three-minute Daytona demo

## Prepare before presenting

Use the [Daytona setup guide](DAYTONA.md), the published sample refs and a working API key.
Open **Release rehearsal** and rehearse both candidates once. Save their evidence exports.
Close each finished pair and wait for verified cleanup before creating another.

The talk track below takes about three minutes; cloud provisioning, package installation and
switching to a fresh pair take additional time. Start the original candidate before your slot
and use **Pause & explore** to hold it before deployment. For a strict three-minute slot, show
the earlier compatible run's saved evidence as recorded evidence; allow extra time to provision
a fresh compatible pair for a second live demonstration. Only one pair can be active at a time.

Confirm the previous pane shows the plain launch note and the proposed pane shows the interactive
launch board. Both must be actual apps loaded from their Daytona sandboxes. Keep raw signed
preview addresses and private credentials out of slides and exports.

## 0:00–0:15 · Show what changed

“This release turns a plain launch note into a useful interactive board. The question is whether
that improvement still works while old and new versions run together.”

Point to v1 on the left and v2 on the right. Both contain the same three launch items. Each has
its own source checkout, dependencies, Node server and native PostgreSQL inside a full Daytona
sandbox. The app frames are interactive.

## 0:15–1:00 · Prove the new feature works on its own

During **Try v2**, Gecco opens both apps and checks **Test the upgrade** in the proposed version.
The board saves the checked item through its app API into its database. The old app's separate
note remains unchanged.

“The new feature works. Its own test passes. That evidence alone says nothing about an old app
instance that is still serving users during deployment.”

Show **The new launch board works on its own** in the execution evidence. Its save result and
SQL trace come from the running app. This is an executed feature test, not a model prediction.

## 1:00–1:45 · Show the rollout failure

Resume. Gecco migrates the previous sandbox's database and connects the new app to that shared
state through the sample's authenticated SQL gateway. The old app keeps running.

The original migration breaks the old session reader. The previous app cannot open the workspace,
while the new board still can. Gecco writes a session with v2 and checks the item again against
the shared database. The new feature can still save while the old app has lost access.

“The proposed feature works, but this rollout breaks existing users. Testing only the new version
would miss that failure.”

The main journey stops here with **v1 and v2 still visible side by side**. It does not automatically
replace the new board with old code.

## 1:45–2:20 · Show the compatibility fix

Choose **Rehearse the compatibility fix** when time allows for verified cleanup and fresh provisioning.
For the short talk track, explicitly identify any previously saved compatible evidence as recorded.

“The fix keeps the same new board. It changes the migration and session writes so both versions
can read the data during rollout.”

Show the same feature save working independently, then working against the shared database while
the previous app continues to open its workspace. A passing result applies to these source commits,
this fixture and these executed operations; it is not a universal approval to ship.

For live audience interaction, pause and check or edit an item in v2, then refresh the previous
app to see the same saved note. After rollout, both versions are using the same database.

## 2:20–2:40 · Offer rollback as a separate check

**Test rollback** is optional. It runs the down migration, checks out the base source in the
proposed sandbox and starts a new v1 process. Data written by v2 stays in the database. Both apps
then read it.

“Rolling back code is another transition to test. It does not erase the records the new version
already wrote.”

The original specimen exposes the decoder failure after rollback; the compatible sample preserves
the representation the old code needs. Skip this action in the short demonstration if keeping the
new board visible communicates the main finding better.

## 2:40–3:00 · Show the evidence and public code

Open the evidence: exact source refs and diff, sandbox identities, app instance identities,
database identities, and returned SQL rows or errors. Export the result without preview bearer
URLs. Show the [public repository](https://github.com/kllymx/gecco-rehearsals).

“Gecco executes the feature and the release transition. The result explains which operation
broke, which version ran it, and what the database actually returned.”

Close the sandbox pair when finished and confirm deletion. TTL is a backup, not proof that cleanup
already happened.

## Optional second demonstration

**Change interactions** runs two trusted local TypeScript changes against a payment contract.
Base, A alone and B alone pass; their combination charges fractional cents. Restoring rounding at
the payment boundary makes the supplied observations pass. This is a separate local execution
mode, useful when discussing failures caused by independently valid changes interacting.

## Precise scope

- Cloud execution uses the fixed public Fieldnotes recipe and published sample commits. There is
  no arbitrary-repository import, arbitrary shell/SQL input or autonomous browser planner.
- The Daytona apps run native PostgreSQL. The **Local examples** menu contains the earlier Node
  and PGlite demonstrations, including the database lab and automated scenario matrix.
- Live AI analysis is optional and separate. Model text does not decide database outcomes or
  automatically implement the supplied compatibility fix.
- Reload reconnects to accepted server work. Coordinator restart reconciles and closes its saved
  active pair; it does not blindly replay setup or resume an uncertain operation.
- The checklist step preserves custom notes: if the expected item has been removed or renamed,
  the automation stops rather than replacing the user's content.
- See [validation scope](DAYTONA.md#validation-scope) for the distinction between completed live
  acceptance, focused mocks and earlier local results.
