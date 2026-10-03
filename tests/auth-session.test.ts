import { env } from './setup';
import { describe, expect, it } from 'vitest';
import { randomToken, sha256 } from '../src/core/crypto';
import type { AppContext } from '../src/core/types';
import {
  insertUser,
  reclaimSessionStatements,
  rotateStatements,
  rotationAuditStatement,
  sessionStatements,
  type SessionRow,
} from '../src/modules/auth/repository';

function context() {
  const requestId = crypto.randomUUID();
  return {
    env,
    get: (name: string) => (name === 'requestId' ? requestId : undefined),
  } as unknown as AppContext;
}

async function fixture(activeCount: number) {
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  await insertUser(env.DB, {
    id: userId,
    email: `${userId}@example.com`,
    name: 'Session learner',
    password_hash: randomToken(),
    role: 'member',
    disabled: 0,
    created_at: now,
    updated_at: now,
  }).run();
  const rows = Array.from(
    { length: activeCount },
    (_, i): SessionRow => ({
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: new Date(Date.now() - 100_000 + i * 1000).toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      revoked_at: null,
      last_seen_at: now,
    }),
  );
  await env.DB.batch(
    (
      await Promise.all(
        rows.map(async (row) => sessionStatements(env.DB, row, await sha256(randomToken()))),
      )
    ).flat(),
  );
  return { userId, rows };
}

async function createSession(userId: string, c: AppContext) {
  const now = new Date().toISOString();
  const row: SessionRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    created_at: now,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    revoked_at: null,
    last_seen_at: now,
  };
  await env.DB.batch([
    ...reclaimSessionStatements(c, userId, now),
    ...sessionStatements(env.DB, row, await sha256(randomToken())),
  ]);
  return row;
}

describe('active session limit', () => {
  it('keeps login usable while revoking and auditing the oldest session at the limit', async () => {
    const { userId, rows } = await fixture(20);
    const newest = await createSession(userId, context());
    const active = await env.DB.prepare(
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
    )
      .bind(userId)
      .all<{ id: string }>();
    expect(active.results).toHaveLength(20);
    expect(active.results.map((row) => row.id)).toContain(newest.id);
    expect(active.results.map((row) => row.id)).not.toContain(rows[0]!.id);
    const event = await env.DB.prepare(
      "SELECT actor_id,resource_id FROM audit_logs WHERE actor_id = ? AND action = 'auth.session_evicted'",
    )
      .bind(userId)
      .first();
    expect(event).toMatchObject({ actor_id: userId, resource_id: rows[0]!.id });
  });

  it('preserves the limit when two requests create sessions concurrently', async () => {
    const { userId } = await fixture(19);
    await Promise.all([createSession(userId, context()), createSession(userId, context())]);
    const count = await env.DB.prepare(
      'SELECT count(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
    )
      .bind(userId)
      .first<{ count: number }>();
    expect(count?.count).toBe(20);
    const audit = await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_logs WHERE actor_id = ? AND action = 'auth.session_evicted'",
    )
      .bind(userId)
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });
});

describe('refresh transaction', () => {
  it('rolls rotation back when its success audit cannot be written', async () => {
    const { userId, rows } = await fixture(1);
    const sessionId = rows[0]!.id;
    const old = await env.DB.prepare('SELECT token_hash FROM refresh_tokens WHERE session_id = ?')
      .bind(sessionId)
      .first<{ token_hash: string }>();
    const nextHash = await sha256(randomToken());
    const now = new Date().toISOString();
    const c = {
      env,
      get: (name: string) =>
        name === 'principal'
          ? { user: { id: userId } }
          : name === 'requestId'
            ? crypto.randomUUID()
            : undefined,
    } as unknown as AppContext;
    await env.DB.prepare(
      `CREATE FUNCTION reject_refresh_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'auth.refresh' THEN RAISE EXCEPTION 'Simulated unavailable audit'; END IF; RETURN NEW; END $$`,
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER reject_refresh_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_refresh_audit_fn()`,
    ).run();
    try {
      await expect(
        env.DB.batch([
          ...rotateStatements(env.DB, old!.token_hash, nextHash, sessionId, now),
          rotationAuditStatement(c, old!.token_hash, nextHash, sessionId, now),
        ]),
      ).rejects.toThrow();
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_refresh_audit ON audit_logs').run();
      await env.DB.prepare('DROP FUNCTION reject_refresh_audit_fn()').run();
    }
    const previous = await env.DB.prepare(
      'SELECT consumed_at FROM refresh_tokens WHERE token_hash = ?',
    )
      .bind(old!.token_hash)
      .first<{ consumed_at: string | null }>();
    expect(previous?.consumed_at).toBeNull();
    expect(
      await env.DB.prepare('SELECT token_hash FROM refresh_tokens WHERE token_hash = ?')
        .bind(nextHash)
        .first(),
    ).toBeNull();
  });
});
