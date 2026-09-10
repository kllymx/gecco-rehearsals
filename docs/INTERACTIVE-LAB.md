# Hands-on release lab

The lab makes the release transition visible one operation at a time. A session name supplied
by the visitor is written to a real disposable PostgreSQL database. The visitor controls the
migration, reads by old and new application code, the new-version write, and rollback.

The center of the interface shows the actual columns and stored row. Each read displays the
actual decoded session or error. The displayed data comes from the same database across the
experiment, including rollback. There is no timed playback of a prepared result sequence.

## Demo sequence

1. Name the session something the audience chooses. Start with the original migration.
2. Read it using the old app. The returned name is the value just entered.
3. Deploy the migration. Watch the column change and the flat data become a nested object.
4. Read with each version. The new reader works; the old reader requests the removed column.
5. Create a new session using the new app. Point to its new row ID and write marker.
6. Roll back. The column name returns, but the nested payload and new row remain.
7. Read with the old app. The query now succeeds, but the old decoder rejects the payload.
8. Start a fresh experiment using the supplied compatibility fix. Repeat the actions. The
   old representation stays available alongside the new one, including after new writes.

The first failure is a missing schema field. The second is an incompatible data format.
These distinct mechanisms are visible in the row, read result and expandable SQL evidence.

## Relationship to the automated rehearsal

The **Automated checks** view runs all four scenarios on independent fixtures. The hands-on
lab instead holds one database while the visitor chooses actions. It shows causality and
lets the audience inspect the same row through the transition. Neither view connects to
production or executes arbitrary repository scripts.

The compatibility fix is an inspectable bundled variant. Optional Astra analysis remains in
the automated view; model prose does not decide or fabricate the database observations.
