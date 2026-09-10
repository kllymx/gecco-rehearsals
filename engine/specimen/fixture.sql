CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  session_payload JSONB NOT NULL
);

INSERT INTO sessions (id, session_payload) VALUES
  ('seed-session', '{"userId":"demo-user-1","role":"viewer","writeMarker":"fixture-seed"}'::jsonb);
