UPDATE sessions SET session_payload = session_payload || jsonb_build_object(
  'userId', identity_payload->'principal'->'id',
  'role', identity_payload->'principal'->'role',
  'writeMarker', identity_payload->'writeMarker'
)
WHERE identity_payload IS NOT NULL;

ALTER TABLE sessions DROP COLUMN identity_payload;
