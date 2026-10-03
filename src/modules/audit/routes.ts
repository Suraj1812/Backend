import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../core/types';
import { requireBearer, requireRole } from '../../middleware/auth';
import { idSchema, text } from '../../core/validation';
import { pageMeta, paginationShape, query } from '../../core/pagination';
import { success } from '../../core/response';
import { auditStatement } from '../../core/audit';

const { q: _q, ...auditPagination } = paginationShape;
const schema = z
  .object({
    ...auditPagination,
    sort: z.literal('createdAt').default('createdAt'),
    actorId: idSchema.optional(),
    action: text(100).optional(),
  })
  .strict();
interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string;
  metadata: string;
  created_at: string;
}
export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use('*', requireBearer, requireRole('admin'));
auditRoutes.get('/', async (c) => {
  const input = query(c, schema);
  const filters = ['1 = 1'];
  const params: (string | number)[] = [];
  if (input.action) {
    filters.push('action = ?');
    params.push(input.action);
  }
  if (input.actorId) {
    filters.push('actor_id = ?');
    params.push(input.actorId);
  }
  const where = filters.join(' AND ');
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs WHERE ${where}`).bind(...params),
    c.env.DB.prepare(
      `SELECT id, actor_id, action, resource_type, resource_id, request_id, metadata, created_at FROM audit_logs WHERE ${where} ORDER BY created_at ${input.order === 'asc' ? 'ASC' : 'DESC'}, id ASC LIMIT ? OFFSET ?`,
    ).bind(...params, input.limit, (input.page - 1) * input.limit),
    auditStatement(c, 'audit.list', 'audit_logs'),
  ]);
  const data = (rows.results as unknown as AuditRow[]).map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    metadata: JSON.parse(row.metadata) as unknown,
    createdAt: row.created_at,
  }));
  return success(
    c,
    data,
    200,
    pageMeta(Number((count.results[0] as { total: number }).total), input),
  );
});
