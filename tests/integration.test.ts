import { env, createExecutionContext, waitOnExecutionContext } from './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { getConfig } from '../src/core/config';
import { issueAccessToken } from '../src/modules/auth/tokens';
import { maintenance } from '../src/core/maintenance';
import { openApiDocument } from '../src/openapi';
import { randomToken, sha256 } from '../src/core/crypto';
import type { Env } from '../src/core/types';

type Json = {
  success: boolean;
  data: any;
  error: { code: string; details?: unknown };
  requestId: string;
  meta: { total: number; hasNext: boolean; limit: number };
};
let ipCounter = 0;
let testIp = '192.0.2.1';
// This deliberately dynamic JSON helper checks the wire contract at runtime.
async function call(path: string, options: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const headers = new Headers(options.headers);
  if (!headers.has('X-Forwarded-For')) headers.set('X-Forwarded-For', testIp);
  const response = await app.request(
    `http://localhost${path}`,
    {
      ...options,
      headers,
      ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit,
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function jsonCall(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
  extra: Record<string, string> = {},
) {
  const response = await call(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: (await response.json()) as Json };
}

async function identity(role: 'member' | 'admin' = 'member') {
  const id = crypto.randomUUID(),
    session = crypto.randomUUID(),
    now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users(id,email,name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).bind(id, `${id}@example.test`, 'Test User', 'intentionally-no-login-hash', role, now, now),
    env.DB.prepare(
      'INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)',
    ).bind(session, id, now, expiresAt, now),
  ]);
  const { accessToken } = await issueAccessToken(getConfig(env), id, session, expiresAt);
  return { id, session, token: accessToken };
}
const png = () =>
  Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
    (c) => c.charCodeAt(0),
  );

// Tests share one isolated PostgreSQL database per file; reset application rows.
beforeEach(async () => {
  // Rate counters outlive application-row resets. Model independent clients per case.
  testIp = `192.0.2.${++ipCounter}`;
  await env.DB.batch(
    [
      'refresh_tokens',
      'sessions',
      'api_keys',
      'tasks',
      'projects',
      'files',
      'audit_logs',
      'users',
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

describe('HTTP security and response conventions', () => {
  it('documents every implemented endpoint and only implemented endpoints', () => {
    const routes = app.routes
      .filter((route) => route.method !== 'ALL')
      .map(
        (route) => `${route.method.toLowerCase()} ${route.path.replace(/:([a-zA-Z]+)/g, '{$1}')}`,
      );
    const documented = Object.entries(openApiDocument.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((method) => ['get', 'post', 'patch', 'delete'].includes(method))
        .map((method) => `${method} ${path}`),
    );
    expect([...new Set(routes)].sort()).toEqual(documented.sort());
  });
  it('returns health, readiness, docs and metadata using real bindings', async () => {
    const health = await jsonCall('/health');
    expect(health.response.status).toBe(200);
    expect(health.body).toMatchObject({ success: true, data: { status: 'ok', version: '1.0.0' } });
    expect(health.response.headers.get('x-request-id')).toBe(health.body.requestId);
    expect(health.response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.response.headers.get('cache-control')).toBe('no-store');
    expect((await jsonCall('/ready')).body.data.status).toBe('ready');
    expect((await jsonCall('/api/v1')).body.data.resources).toContain('tasks');
    expect((await call('/docs')).headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(await (await call('/docs')).text()).toContain('Download OpenAPI 3.1');
    expect((await call('/docs.css')).headers.get('content-type')).toContain('text/css');
  });
  it('handles missing and invalid authentication and unknown routes consistently', async () => {
    expect((await jsonCall('/api/v1/projects')).response.status).toBe(401);
    expect((await jsonCall('/api/v1/projects', 'GET', undefined, 'bad')).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    const missing = await jsonCall('/missing');
    expect(missing.response.status).toBe(404);
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });
  it('uses exact CORS allowlists and validates preflight', async () => {
    const allowed = await call('/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const denied = await call('/health', {
      headers: { Origin: 'http://localhost:5173.evil.test' },
    });
    expect(denied.status).toBe(403);
    const preflight = await call('/api/v1/tasks', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    const rejected = await call('/api/v1/tasks', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'x-admin',
      },
    });
    expect(rejected.status).toBe(403);
  });

  it('allows local frontend origins to consume an HTTPS production Edge Function', async () => {
    const ctx = createExecutionContext();
    const production = {
      ...env,
      ENVIRONMENT: 'production',
      ALLOWED_ORIGINS: 'http://localhost:5173,https://app.real.test',
    };
    const response = await app.request(
      'https://api.real.test/health',
      { headers: { Origin: 'http://localhost:5173', 'X-Forwarded-For': testIp } },
      production,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(() => getConfig({ ...production, ALLOWED_ORIGINS: 'http://app.real.test' })).toThrow(
      'CORS',
    );
    await waitOnExecutionContext(ctx);
  });
  it('bounds actual streamed bytes even without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40000));
        controller.enqueue(new Uint8Array(40000));
        controller.close();
      },
    });
    const response = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
    });
    expect(response.status).toBe(413);
  });
  it('rejects compressed and non-JSON bodies before parsing', async () => {
    expect(
      (
        await call('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Encoding': 'gzip' },
          body: 'x',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
  });
  it('fails closed on rate limits and missing configuration', async () => {
    const rateEnv = { ...env, API_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const response = await call('/health', {}, rateEnv);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect((await call('/health', {}, { ...env, JWT_SECRET: '' })).status).toBe(503);
    const responseText = await (await call('/health', {}, { ...env, JWT_SECRET: '' })).text();
    expect(responseText).not.toContain(env.PASSWORD_PEPPER);
  });
});

describe('Authentication lifecycle', () => {
  it('allows one concurrent refresh winner and revokes the replayed session', async () => {
    const user = await identity(),
      refreshToken = randomToken(),
      now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO refresh_tokens(token_hash,session_id,created_at,expires_at) VALUES (?,?,?,?)',
    )
      .bind(
        await sha256(refreshToken),
        user.session,
        now,
        new Date(Date.now() + 3600000).toISOString(),
      )
      .run();
    const results = await Promise.all([
      jsonCall('/api/v1/auth/refresh', 'POST', { refreshToken }),
      jsonCall('/api/v1/auth/refresh', 'POST', { refreshToken }),
    ]);
    expect(results.map((r) => r.response.status).sort()).toEqual([200, 401]);
    const winner = results.find((r) => r.response.status === 200)!;
    expect(
      (await jsonCall('/api/v1/auth/me', 'GET', undefined, winner.body.data.accessToken)).response
        .status,
    ).toBe(401);
    const successfulAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action='auth.refresh' AND resource_id=?",
    )
      .bind(user.session)
      .first<{ n: number }>();
    expect(successfulAudit?.n).toBe(1);
  });
  it('registers, authenticates, rotates once and revokes a replayed session', async () => {
    const input = {
      email: 'learner@example.test',
      password: crypto.randomUUID(),
      name: ' Learner ',
    };
    const result = await jsonCall('/api/v1/auth/register', 'POST', input);
    expect(result.response.status).toBe(201);
    expect(result.body.data.user).toMatchObject({ role: 'member', name: 'Learner' });
    expect(result.body.data.user.password_hash).toBeUndefined();
    const stored = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?')
      .bind(result.body.data.user.id)
      .first<{ password_hash: string }>();
    expect(stored?.password_hash).toContain('$m=19456,t=2,p=1$');
    expect(
      (await jsonCall('/api/v1/auth/me', 'GET', undefined, result.body.data.accessToken)).response
        .status,
    ).toBe(200);
    const rotated = await jsonCall('/api/v1/auth/refresh', 'POST', {
      refreshToken: result.body.data.refreshToken,
    });
    expect(rotated.response.status).toBe(200);
    expect(rotated.body.data.refreshToken).not.toBe(result.body.data.refreshToken);
    expect(
      (
        await jsonCall('/api/v1/auth/refresh', 'POST', {
          refreshToken: result.body.data.refreshToken,
        })
      ).response.status,
    ).toBe(401);
    expect(
      (await jsonCall('/api/v1/auth/me', 'GET', undefined, rotated.body.data.accessToken)).response
        .status,
    ).toBe(401);
    expect(
      (
        await jsonCall('/api/v1/auth/refresh', 'POST', {
          refreshToken: rotated.body.data.refreshToken,
        })
      ).response.status,
    ).toBe(401);
  });
  it('rejects role mass assignment and duplicate users, then logs out immediately', async () => {
    const input = { email: 'normal@example.test', password: crypto.randomUUID(), name: 'Normal' };
    expect(
      (await jsonCall('/api/v1/auth/register', 'POST', { ...input, role: 'admin' })).response
        .status,
    ).toBe(422);
    const created = await jsonCall('/api/v1/auth/register', 'POST', input);
    expect(created.response.status).toBe(201);
    expect((await jsonCall('/api/v1/auth/register', 'POST', input)).response.status).toBe(409);
    const login = await jsonCall('/api/v1/auth/login', 'POST', {
      email: input.email,
      password: input.password,
    });
    expect(login.response.status).toBe(200);
    expect(
      (await jsonCall('/api/v1/auth/logout', 'POST', undefined, login.body.data.accessToken))
        .response.status,
    ).toBe(200);
    expect(
      (await jsonCall('/api/v1/auth/me', 'GET', undefined, login.body.data.accessToken)).response
        .status,
    ).toBe(401);
    const failed = await jsonCall('/api/v1/auth/login', 'POST', {
      email: input.email,
      password: crypto.randomUUID(),
    });
    expect(failed.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('Owned resources, validation and reusable pagination', () => {
  it('supports CRUD, filtering, sorting, literal search and stable PATCH behavior', async () => {
    const user = await identity();
    const create = await jsonCall(
      '/api/v1/projects',
      'POST',
      { name: ' Zeta 100% ', status: 'archived' },
      user.token,
    );
    expect(create.response.status).toBe(201);
    const id = create.body.data.id;
    expect(create.response.headers.get('location')).toBe(`/api/v1/projects/${id}`);
    await jsonCall('/api/v1/projects', 'POST', { name: 'Alpha' }, user.token);
    const list = await jsonCall(
      '/api/v1/projects?limit=1&sort=name&order=asc',
      'GET',
      undefined,
      user.token,
    );
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.data[0].name).toBe('Alpha');
    expect(list.body.meta).toMatchObject({ total: 2, limit: 1, hasNext: true });
    const searched = await jsonCall(
      '/api/v1/projects?q=100%25&status=archived',
      'GET',
      undefined,
      user.token,
    );
    expect(searched.body.data).toHaveLength(1);
    const update = await jsonCall(
      `/api/v1/projects/${id}`,
      'PATCH',
      { name: 'Renamed' },
      user.token,
    );
    expect(update.body.data.status).toBe('archived');
    expect(
      (await jsonCall(`/api/v1/projects/${id}`, 'DELETE', undefined, user.token)).body.data,
    ).toEqual({ id, deleted: true });
    expect(
      (await jsonCall(`/api/v1/projects/${id}`, 'GET', undefined, user.token)).response.status,
    ).toBe(404);
    const audit = await env.DB.prepare(
      'SELECT action FROM audit_logs WHERE resource_id=? ORDER BY created_at',
    )
      .bind(id)
      .all();
    expect(audit.results.map((row) => row.action)).toEqual([
      'projects.create',
      'projects.update',
      'projects.delete',
    ]);
  });
  it('enforces ownership for members, admins and nested project relations', async () => {
    const owner = await identity(),
      other = await identity('admin');
    const project = await jsonCall('/api/v1/projects', 'POST', { name: 'Private' }, owner.token);
    const id = project.body.data.id;
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      expect(
        (
          await jsonCall(
            `/api/v1/projects/${id}`,
            method,
            method === 'PATCH' ? { name: 'Stolen' } : undefined,
            other.token,
          )
        ).response.status,
      ).toBe(404);
    }
    expect(
      (
        await jsonCall(
          '/api/v1/tasks',
          'POST',
          { title: 'Cross-owner', projectId: id },
          other.token,
        )
      ).response.status,
    ).toBe(404);
    const task = await jsonCall(
      '/api/v1/tasks',
      'POST',
      { title: 'Owned task', projectId: id, dueDate: '2028-02-29' },
      owner.token,
    );
    expect(task.response.status).toBe(201);
    const patched = await jsonCall(
      `/api/v1/tasks/${task.body.data.id}`,
      'PATCH',
      { title: 'Renamed only' },
      owner.token,
    );
    expect(patched.body.data).toMatchObject({ projectId: id, dueDate: '2028-02-29' });
    await jsonCall(`/api/v1/projects/${id}`, 'DELETE', undefined, owner.token);
    expect(
      (await jsonCall(`/api/v1/tasks/${task.body.data.id}`, 'GET', undefined, owner.token)).body
        .data.projectId,
    ).toBeNull();
  });
  it('rejects invalid dates, markup, unknown properties, duplicate queries and arbitrary sorts', async () => {
    const user = await identity();
    for (const body of [
      { title: 'Test', dueDate: '2027-02-29' },
      { title: '<script>x</script>' },
      { title: 'Test', ownerId: crypto.randomUUID() },
    ]) {
      expect((await jsonCall('/api/v1/tasks', 'POST', body, user.token)).response.status).toBe(422);
    }
    for (const query of [
      'limit=101',
      'page=0',
      'sort=owner_id',
      'limit=1&limit=2',
      'surprise=true',
    ]) {
      expect(
        (await jsonCall(`/api/v1/tasks?${query}`, 'GET', undefined, user.token)).response.status,
      ).toBe(422);
    }
    const task = await jsonCall('/api/v1/tasks', 'POST', { title: 'Test' }, user.token);
    expect(
      (await jsonCall(`/api/v1/tasks/${task.body.data.id}`, 'PATCH', {}, user.token)).response
        .status,
    ).toBe(422);
    expect(
      (await jsonCall('/api/v1/tasks/not-a-uuid', 'GET', undefined, user.token)).response.status,
    ).toBe(422);
  });
});

describe('RBAC, API keys and private Storage', () => {
  it('honors API-key scopes and immediate revocation without granting user/admin endpoints', async () => {
    const user = await identity('admin');
    const created = await jsonCall(
      '/api/v1/api-keys',
      'POST',
      { name: 'Trusted server', scopes: ['resources:read'] },
      user.token,
    );
    expect(created.response.status).toBe(201);
    const apiKey = created.body.data.key;
    const keyHeader = { 'X-API-Key': apiKey };
    expect(
      (await jsonCall('/api/v1/projects', 'GET', undefined, undefined, keyHeader)).response.status,
    ).toBe(200);
    expect(
      (await jsonCall('/api/v1/projects', 'POST', { name: 'No write' }, undefined, keyHeader))
        .response.status,
    ).toBe(403);
    expect(
      (await jsonCall('/api/v1/users', 'GET', undefined, undefined, keyHeader)).response.status,
    ).toBe(401);
    expect(
      (await jsonCall('/api/v1/audit-logs', 'GET', undefined, undefined, keyHeader)).response
        .status,
    ).toBe(401);
    expect(
      (await jsonCall('/api/v1/projects', 'GET', undefined, user.token, keyHeader)).response.status,
    ).toBe(400);
    const keys = await jsonCall('/api/v1/api-keys', 'GET', undefined, user.token);
    expect(JSON.stringify(keys.body)).not.toContain(apiKey);
    await jsonCall(`/api/v1/api-keys/${created.body.data.id}`, 'DELETE', undefined, user.token);
    expect(
      (await jsonCall('/api/v1/projects', 'GET', undefined, undefined, keyHeader)).response.status,
    ).toBe(401);
  });
  it('checks current PostgreSQL roles, protects audit logs and allows only profile name changes', async () => {
    const user = await identity();
    expect((await jsonCall('/api/v1/users', 'GET', undefined, user.token)).response.status).toBe(
      403,
    );
    await env.DB.prepare("UPDATE users SET role='admin' WHERE id=?").bind(user.id).run();
    expect((await jsonCall('/api/v1/users', 'GET', undefined, user.token)).response.status).toBe(
      200,
    );
    const audit = await jsonCall('/api/v1/audit-logs?limit=5', 'GET', undefined, user.token);
    expect(audit.response.status).toBe(200);
    expect(audit.body.data[0].ipHash).toBeUndefined();
    expect(
      (await jsonCall('/api/v1/users/me', 'PATCH', { name: 'New name', role: 'admin' }, user.token))
        .response.status,
    ).toBe(422);
    expect(
      (await jsonCall('/api/v1/users/me', 'PATCH', { name: 'New name' }, user.token)).body.data
        .name,
    ).toBe('New name');
    await env.DB.prepare('UPDATE users SET disabled=1 WHERE id=?').bind(user.id).run();
    expect((await jsonCall('/api/v1/users/me', 'GET', undefined, user.token)).response.status).toBe(
      401,
    );
  });
  it('uploads, streams, owner-checks and deletes a validated private object', async () => {
    const user = await identity(),
      other = await identity();
    const bytes = png();
    const response = await call('/api/v1/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'image/png',
        'X-File-Name': 'avatar.png',
      },
      body: bytes,
    });
    const body = (await response.json()) as Json;
    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      filename: 'avatar.png',
      contentType: 'image/png',
      size: bytes.length,
    });
    expect(body.data.object_key).toBeUndefined();
    expect(
      (await jsonCall(`/api/v1/files/${body.data.id}`, 'GET', undefined, other.token)).response
        .status,
    ).toBe(404);
    const download = await call(body.data.downloadUrl, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="avatar.png"');
    expect(download.headers.get('x-request-id')).toBeTruthy();
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(
      (await jsonCall(`/api/v1/files/${body.data.id}`, 'DELETE', undefined, user.token)).response
        .status,
    ).toBe(200);
    expect(
      (await jsonCall(`/api/v1/files/${body.data.id}`, 'GET', undefined, user.token)).response
        .status,
    ).toBe(404);
  });
  it('finishes deletion tombstones and removes expired sessions in maintenance', async () => {
    const user = await identity();
    const id = crypto.randomUUID(),
      key = `uploads/${user.id}/${id}`,
      now = new Date().toISOString();
    await env.FILES.put(key, png(), {
      httpMetadata: { contentType: 'image/png', contentDisposition: 'attachment' },
      customMetadata: { fileId: id },
    });
    await env.DB.prepare(
      "INSERT INTO files(id,owner_id,object_key,filename,content_type,size,created_at,status) VALUES (?,?,?,?,?,?,?,'deleting')",
    )
      .bind(id, user.id, key, 'pending.png', 'image/png', png().length, now)
      .run();
    await env.DB.prepare('UPDATE sessions SET expires_at=? WHERE id=?')
      .bind('2000-01-01T00:00:00.000Z', user.session)
      .run();
    await maintenance(env);
    expect(await env.FILES.head(key)).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first()).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM sessions WHERE id=?').bind(user.session).first(),
    ).toBeNull();
  });
});
