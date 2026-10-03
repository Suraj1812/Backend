import type { AppContext } from './types';

export function success(
  c: AppContext,
  data: unknown,
  status: 200 | 201 | 202 = 200,
  meta?: unknown,
) {
  return c.json(
    { success: true as const, data, ...(meta ? { meta } : {}), requestId: c.get('requestId') },
    status,
  );
}

export function apiLocation(c: AppContext, path: string) {
  const rawPath = new URL(c.req.url).pathname;
  const prefix = rawPath.match(/^\/(?:functions\/v1\/)?backend(?=\/|$)/)?.[0] ?? '';
  return (prefix === '/backend' ? '/functions/v1/backend' : prefix) + path;
}
