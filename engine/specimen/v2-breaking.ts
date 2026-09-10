import { SessionContractError, type Session, type SqlClient } from './types.js';

export async function readSession(db: SqlClient, id: string): Promise<Session> {
  const { rows } = await db.query(
    'SELECT id, identity_payload FROM sessions WHERE id = $1', [id],
  );
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
  await db.query(
    'INSERT INTO sessions (id, identity_payload) VALUES ($1, $2::jsonb)',
    [id, JSON.stringify({ principal: { id: userId, role }, writeMarker })],
  );
}
