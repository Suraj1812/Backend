import { auditStatement } from '../../core/audit';
import { randomToken, sha256 } from '../../core/crypto';
import { ApiError } from '../../core/errors';
import type { AppContext, Scope } from '../../core/types';
import { insertApiKey, listApiKeys, type ApiKeyRow } from './repository';
import type { CreateApiKeyInput } from './validation';

const keyDto = (row: ApiKeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: JSON.parse(row.scopes) as Scope[],
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export async function list(c: AppContext) {
  const rows = await listApiKeys(c.env.DB, c.get('principal').user.id, new Date().toISOString());
  return { items: rows.results.map(keyDto) };
}

export async function create(c: AppContext, input: CreateApiKeyInput) {
  const now = new Date();
  const key = `ak_${randomToken()}`;
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    user_id: c.get('principal').user.id,
    name: input.name,
    token_hash: await sha256(key),
    prefix: key.slice(0, 11),
    scopes: JSON.stringify(input.scopes),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString(),
    revoked_at: null,
  };
  // The conditional insert enforces the cap even under concurrent requests.
  // The audit event records the creation attempt atomically, including cap failures.
  const result = await c.env.DB.batch([
    c.env.DB.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').bind(
      `api-keys:${row.user_id}`,
    ),
    insertApiKey(c.env.DB, row),
    auditStatement(c, 'api_key.create_requested', 'api_key', row.id, { scopes: input.scopes }),
  ]);
  if (result[1]?.meta.changes !== 1)
    throw new ApiError(
      409,
      'API_KEY_LIMIT',
      'Revoke an existing key before creating another; at most 20 active keys are allowed',
    );
  return { ...keyDto(row), key };
}

export async function revoke(c: AppContext, id: string) {
  const userId = c.get('principal').user.id;
  const row = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'API key was not found');
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?',
    ).bind(new Date().toISOString(), id, userId),
    auditStatement(c, 'api_key.revoked', 'api_key', id),
  ]);
  return { revoked: true as const };
}
