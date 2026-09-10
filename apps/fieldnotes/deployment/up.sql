ALTER TABLE sessions RENAME COLUMN session_payload TO identity_payload;

UPDATE sessions SET identity_payload = jsonb_build_object(
  'principal', jsonb_build_object(
    'id', identity_payload->>'userId', 'role', identity_payload->>'role'
  ), 'writeMarker', identity_payload->>'writeMarker'
);
