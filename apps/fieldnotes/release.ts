import { SessionContractError, type Session, type SqlClient } from '../../engine/specimen/types.js';

export async function readSession(db: SqlClient, id: string): Promise<Session> {
  const { rows } = await db.query(
    'SELECT id, session_payload FROM sessions WHERE id = $1', [id],
  );
  const payload = rows[0]?.session_payload as Record<string, unknown> | undefined;
  if (typeof payload?.userId !== 'string' || typeof payload?.role !== 'string'
      || typeof payload?.writeMarker !== 'string') {
    throw new SessionContractError(
      `v1 requires flat userId, role and writeMarker fields; observed ${JSON.stringify(payload)}`,
    );
  }
  return { id, userId: payload.userId, role: payload.role, writeMarker: payload.writeMarker };
}

export async function writeSession(db: SqlClient, session: Session): Promise<void> {
  const { id, userId, role, writeMarker } = session;
  await db.query(
    'INSERT INTO sessions (id, session_payload) VALUES ($1, $2::jsonb)',
    [id, JSON.stringify({ userId, role, writeMarker })],
  );
}
