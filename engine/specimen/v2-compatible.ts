import { SessionContractError, type Session, type SqlClient } from './types.js';

export async function readSession(db: SqlClient, id: string): Promise<Session> {
  // Old processes can still insert flat payloads during a rolling deploy.
  const { rows } = await db.query(`
    SELECT id, COALESCE(identity_payload, jsonb_build_object(
      'principal', jsonb_build_object(
        'id', session_payload->>'userId', 'role', session_payload->>'role'
      ), 'writeMarker', session_payload->>'writeMarker'
    )) AS identity_payload FROM sessions WHERE id = $1`, [id]);
  const payload = rows[0]?.identity_payload as {
    principal?: { id?: unknown; role?: unknown }; writeMarker?: unknown;
  } | undefined;
  if (typeof payload?.principal?.id !== 'string' || typeof payload?.principal?.role !== 'string'
      || typeof payload?.writeMarker !== 'string') {
    throw new SessionContractError(`v2 requires a principal object; observed ${JSON.stringify(payload)}`);
  }
  return { id, userId: payload.principal.id, role: payload.principal.role, writeMarker: payload.writeMarker };
}

export async function writeSession(db: SqlClient, session: Session): Promise<void> {
  const { id, userId, role, writeMarker } = session;
  // Preserve the v1 representation until old processes and the rollback window retire.
  await db.query(`
    INSERT INTO sessions (id, session_payload, identity_payload)
    VALUES ($1, $2::jsonb, $3::jsonb)`, [
    id, JSON.stringify({ userId, role, writeMarker }),
    JSON.stringify({ principal: { id: userId, role }, writeMarker }),
  ]);
}
