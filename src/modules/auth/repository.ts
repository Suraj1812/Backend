import type { Database } from '../../core/database';
import type { UserRow } from '../../core/db';
import type { AppContext } from '../../core/types';

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
}
export interface RefreshRow extends UserRow {
  session_id: string;
  session_expires_at: string;
  session_revoked_at: string | null;
  token_expires_at: string;
  consumed_at: string | null;
}

export const findUserByEmail = (db: Database, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();

export function insertUser(db: Database, row: UserRow) {
  return db
    .prepare(
      'INSERT INTO users (id,email,name,password_hash,role,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .bind(
      row.id,
      row.email,
      row.name,
      row.password_hash,
      row.role,
      row.disabled,
      row.created_at,
      row.updated_at,
    );
}

export function sessionStatements(db: Database, session: SessionRow, tokenHash: string) {
  return [
    db
      .prepare(
        'INSERT INTO sessions (id,user_id,created_at,expires_at,revoked_at,last_seen_at) VALUES (?,?,?,?,NULL,?)',
      )
      .bind(
        session.id,
        session.user_id,
        session.created_at,
        session.expires_at,
        session.last_seen_at,
      ),
    db
      .prepare(
        'INSERT INTO refresh_tokens (token_hash,session_id,created_at,expires_at) VALUES (?,?,?,?)',
      )
      .bind(tokenHash, session.id, session.created_at, session.expires_at),
  ];
}

export function reclaimSessionStatements(c: AppContext, userId: string, now: string) {
  // These run immediately before session insertion inside the same PostgreSQL transaction.
  // Evicting the oldest active session keeps login usable if all old tokens
  // have been lost, and concurrent logins still preserve the 20-session bound.
  return [
    c.env.DB.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').bind(
      `sessions:${userId}`,
    ),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id,actor_id,action,resource_type,resource_id,request_id,ip_hash,metadata,created_at)
      SELECT ?,?,'auth.session_evicted','session',id,?,?, '{"reason":"active_session_limit","limit":20}',?
      FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      AND (SELECT count(*) FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) >= 20
      ORDER BY created_at ASC,id ASC LIMIT 1`,
    ).bind(
      crypto.randomUUID(),
      userId,
      c.get('requestId'),
      c.get('ipHash') ?? null,
      now,
      userId,
      now,
      userId,
      now,
    ),
    c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE id = (
      SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      AND (SELECT count(*) FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) >= 20
      ORDER BY created_at ASC,id ASC LIMIT 1)`,
    ).bind(now, userId, now, userId, now),
  ];
}

export function findRefresh(db: Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at,
    s.revoked_at AS session_revoked_at, r.expires_at AS token_expires_at, r.consumed_at
    FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id JOIN users u ON u.id = s.user_id
    WHERE r.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<RefreshRow>();
}

export function revokeSession(db: Database, sessionId: string, now: string, userId?: string) {
  return db
    .prepare(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?${userId ? ' AND user_id = ?' : ''}`,
    )
    .bind(...(userId ? [now, sessionId, userId] : [now, sessionId]));
}

export function rotateStatements(
  db: Database,
  oldHash: string,
  newHash: string,
  sessionId: string,
  now: string,
) {
  return [
    db
      .prepare(
        `UPDATE refresh_tokens SET consumed_at = ?, replacement_hash = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = refresh_tokens.session_id AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0)`,
      )
      .bind(now, newHash, oldHash, now, now),
    // Bind each new token to the unique winning compare-and-set update. A second
    // request cannot create a child even if both initial SELECTs saw an unused token.
    db
      .prepare(
        `INSERT INTO refresh_tokens (token_hash,session_id,created_at,expires_at)
      SELECT ?,session_id,?,expires_at FROM refresh_tokens WHERE token_hash = ? AND replacement_hash = ?`,
      )
      .bind(newHash, now, oldHash, newHash),
    db
      .prepare(
        `UPDATE sessions SET last_seen_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND replacement_hash = ?)`,
      )
      .bind(now, sessionId, oldHash, newHash),
  ];
}

export function rotationAuditStatement(
  c: AppContext,
  oldHash: string,
  newHash: string,
  sessionId: string,
  now: string,
) {
  // The generic audit helper inserts unconditionally. Rotation needs an audit
  // in its transaction only for the winning compare-and-set, so token loss on
  // a separate audit failure cannot leave the client with an unusable token.
  return c.env.DB.prepare(
    `INSERT INTO audit_logs (id,actor_id,action,resource_type,resource_id,request_id,ip_hash,metadata,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND replacement_hash = ?)`,
  ).bind(
    crypto.randomUUID(),
    c.get('principal').user.id,
    'auth.refresh',
    'session',
    sessionId,
    c.get('requestId'),
    c.get('ipHash') ?? null,
    '{}',
    now,
    oldHash,
    newHash,
  );
}

export function listSessions(db: Database, userId: string, now: string) {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC, id ASC LIMIT 20`,
    )
    .bind(userId, now)
    .all<SessionRow>();
}
