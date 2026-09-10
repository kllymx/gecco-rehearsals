-- This reverses the schema rename, but not the format of persisted writes.
ALTER TABLE sessions RENAME COLUMN identity_payload TO session_payload;
