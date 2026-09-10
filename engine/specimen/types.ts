export interface SqlClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Session {
  id: string;
  userId: string;
  role: string;
  writeMarker: string;
}

export interface Release {
  readSession(db: SqlClient, id: string): Promise<Session>;
  writeSession(db: SqlClient, session: Session): Promise<void>;
}

export class SessionContractError extends Error {}
