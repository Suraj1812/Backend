import { describe, expect, it } from 'vitest';
import { createMaintenanceHandler } from '../src/runtime/handler';
const secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const handler = createMaintenanceHandler({ MAINTENANCE_SECRET: secret });
const request = (options: RequestInit = {}) =>
  new Request('https://project.supabase.co/functions/v1/maintenance', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...options,
  });
describe('private maintenance boundary', () => {
  it('rejects missing credentials before creating any server connection', async () => {
    expect((await handler(request({ headers: {} }))).status).toBe(401);
  });
  it('rejects browser origins and non-POST requests', async () => {
    expect(
      (
        await handler(
          request({
            headers: { Authorization: `Bearer ${secret}`, Origin: 'http://localhost:5173' },
          }),
        )
      ).status,
    ).toBe(403);
    const response = await handler(request({ method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
  it('requires an empty JSON object and bounds its body before server work', async () => {
    expect((await handler(request({ body: '{"unexpected":true}' }))).status).toBe(422);
    expect((await handler(request({ body: 'x'.repeat(1025) }))).status).toBe(413);
  });
  it('reports missing runtime configuration without exposing credentials', async () => {
    const response = await handler(request({ body: '{}' }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(secret);
  });
});
