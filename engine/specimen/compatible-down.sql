-- The old column includes new-version writes, so a rollback can read them.
ALTER TABLE sessions DROP COLUMN identity_payload;
