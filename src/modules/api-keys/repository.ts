import type { Database } from '../../core/database';
import type { UserRow } from '../../core/db';

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}
export interface ApiKeyUserRow extends UserRow {
  api_key_id: string;
  api_key_scopes: string;
  api_key_expires_at: string;
  api_key_revoked_at: string | null;
}

export function findApiKeyUser(db: Database, hash: string) {
  return db
    .prepare(
      `SELECT u.*, k.id AS api_key_id, k.scopes AS api_key_scopes,
    k.expires_at AS api_key_expires_at, k.revoked_at AS api_key_revoked_at
    FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?`,
    )
    .bind(hash)
    .first<ApiKeyUserRow>();
}

export function insertApiKey(db: Database, row: ApiKeyRow) {
  return db
    .prepare(
      `INSERT INTO api_keys (id,user_id,name,token_hash,prefix,scopes,created_at,expires_at,revoked_at)
    SELECT ?,?,?,?,?,?,?,?,NULL
    WHERE (SELECT count(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 20`,
    )
    .bind(
      row.id,
      row.user_id,
      row.name,
      row.token_hash,
      row.prefix,
      row.scopes,
      row.created_at,
      row.expires_at,
      row.user_id,
      row.created_at,
    );
}

export function listApiKeys(db: Database, userId: string, now: string) {
  return db
    .prepare(
      `SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC, id ASC LIMIT 20`,
    )
    .bind(userId, now)
    .all<ApiKeyRow>();
}
