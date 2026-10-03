import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from './setup';
import { app } from '../src/index';
import { LearningApi } from '../examples/frontend';
import { PostgresRateLimiter } from '../src/runtime/rate-limit';
import { postgresSql } from '../src/core/database';
afterEach(() => vi.unstubAllGlobals());
describe('Supabase runtime integration', () => {
  it('preserves the function prefix in a local frontend client and resource Location', async () => {
    const origin = 'https://project.supabase.co/functions/v1/backend';
    const locations: string[] = [];
    const transport = vi.fn(async (input: URL, init: RequestInit) => {
      const response = await app.request(input.toString(), init, env);
      const location = response.headers.get('Location');
      if (location) locations.push(location);
      return response;
    });
    vi.stubGlobal('fetch', transport);
    const client = new LearningApi(origin);
    await client.register({
      email: `${crypto.randomUUID()}@example.test`,
      name: 'Browser learner',
      password: crypto.randomUUID(),
    });
    const project = await client.createProject({ name: 'Mounted endpoint' });
    expect(locations).toContain(`/functions/v1/backend/api/v1/projects/${project.id}`);
    expect((await client.projects({ q: 'mounted' })).items[0].id).toBe(project.id);
    expect(
      transport.mock.calls.every(([url]) => url.toString().startsWith(origin + '/api/v1/')),
    ).toBe(true);
    const raw = await app.request(
      origin + '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'missing@example.test', password: crypto.randomUUID() }),
      },
      env,
    );
    expect(raw.status).toBe(401);
    await client.deleteProject(project.id);
    await client.logout();
  });
  it('shares an atomic rate ceiling across concurrent calls', async () => {
    const limiter = new PostgresRateLimiter(env.DB, 'test-concurrency', 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => limiter.limit({ key: 'same-key' })),
    );
    expect(results.filter((item) => item.success)).toHaveLength(3);
  });
  it('translates only value placeholders outside SQL string literals', () => {
    expect(
      postgresSql("SELECT '?' AS marker, ? AS value, 'can''t ?' AS literal WHERE id = ?"),
    ).toBe("SELECT '?' AS marker, $1 AS value, 'can''t ?' AS literal WHERE id = $2");
  });
});
