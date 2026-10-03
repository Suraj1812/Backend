import type { AppContext } from './types';

export function success(c: AppContext, data: unknown, status: 200 | 201 | 202 = 200, meta?: unknown) {
  return c.json({ success: true as const, data, ...(meta ? { meta } : {}), requestId: c.get('requestId') }, status);
}
