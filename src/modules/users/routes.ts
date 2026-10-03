import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../core/types';
import { requireBearer, requireRole } from '../../middleware/auth';
import { success } from '../../core/response';
import { json, text } from '../../core/validation';
import { paginationShape, pageMeta, query } from '../../core/pagination';
import { listUsers, updateProfile } from './service';

export const userRoutes = new Hono<AppEnv>();
userRoutes.use('*', requireBearer);
userRoutes.get('/me', (c) => success(c, c.get('principal').user));
userRoutes.patch('/me', async (c) =>
  success(c, await updateProfile(c, json(c, z.object({ name: text(100) }).strict()).name)),
);
userRoutes.get('/', requireRole('admin'), async (c) => {
  const input = query(
    c,
    z
      .object({
        ...paginationShape,
        sort: z.enum(['createdAt', 'name', 'email']).default('createdAt'),
        role: z.enum(['member', 'admin']).optional(),
      })
      .strict(),
  );
  const result = await listUsers(c, input);
  return success(c, result.data, 200, pageMeta(result.total, input));
});
