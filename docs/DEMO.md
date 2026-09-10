# Three-minute paired-app demo

## Opening — 15 seconds

“Both versions work on their own. Does the release work while they overlap—and can we get back?”

Open **Release rehearsal**. Use a name from the audience. Start the original change. Gecco
starts two separate application processes and two real databases with the same initial data.

## Watch the apps — 45 seconds

The autonomous journey opens both Fieldnotes workspaces. The same user's note appears in both.
Point to **Before**: each version works independently.

Gecco moves to **Rollout**, migrating a database and routing both versions to that shared state.
The proposed app can open its workspace. The previous app cannot restore its session.

“New instances work. The old instance still serving traffic loses access.”

Gecco writes a new session, then rolls back the database and the proposed application process.
The old code now runs on both sides, but the new session data stays. Both workspaces fail to open.

“Rolling code back didn't restore the old data format. This is the user-visible consequence.”

## Take control — 35 seconds

For audience interaction, pause after a completed operation. Open the workspace, inspect its
Session tab, or edit and save the launch note in either preview. A failed reader prevents saving.

Before rollout, edits belong to each independent database. After rollout, the versions share
state: a compatible reader can refresh to see the other's saved note. Resume the journey when
finished. If running a short slot, demonstrate this during the fix instead of the original.

## Show the fix — 35 seconds

Start a fresh rehearsal with **Compatibility fix** and the same name. Both versions still open
independently; both keep working during rollout; and both work after rollback with new writes.

“The fix keeps both representations readable. That's a concrete deployment constraint, backed
by executing the old and new applications across the transition.”

Pause and change the note if the audience wants to test that the applications are live. The
backend runs actual session reads and parameterized updates for every operation.

## Optional second differentiator — 35 seconds

Open **Change interactions**. Run the two changes together. Base, A alone and B alone pass;
A+B charges fractional cents and fails the same contract. Restore boundary rounding and rerun.

“Some failures live between versions. Others live between independently valid changes.”

## Evidence and close — 15 seconds

Open the collapsed evidence if asked: actual SQL, returned rows or errors, app instance IDs,
database IDs, exact source/fixture digests and event export. The **Database lab** provides a
manual view of the underlying row and schema. **Automated checks** retains the four-scenario
matrix and optional Astra source analysis.

Show the public GitHub repository. Today's paired apps, orchestration, interface, tests and
specimens are public. The older hosted Gecco application predates the hackathon.

## Precise scope and fallback

- This runs a fixed autonomous journey over a trusted synthetic sample application. It does not
  claim live AI browser planning, arbitrary repository import or production authentication.
- App processes are independent Node processes; databases are PostgreSQL through PGlite.
  This is not a hardened container sandbox for executing untrusted code.
- Model inference is optional. The full paired-app demo runs without an AI request.
- Reload reconnects to the running experiment. Server restart or expiry requires a new one.
- The compatibility fix is supplied source, not model-generated code applied automatically.
