-- Expand now. Defer removing the legacy representation until the rollback window closes.
ALTER TABLE sessions ADD COLUMN identity_payload JSONB;

UPDATE sessions SET identity_payload = jsonb_build_object(
  'principal', jsonb_build_object(
    'id', session_payload->>'userId', 'role', session_payload->>'role'
  ), 'writeMarker', session_payload->>'writeMarker'
);
