import type { AppContext } from './types';

export function auditStatement(c: AppContext, action: string, resourceType: string, resourceId?: string, metadata: Record<string, unknown> = {}) {
  const principal = c.get('principal');
  return c.env.DB.prepare(`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, request_id, ip_hash, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), principal?.user.id ?? null, action, resourceType, resourceId ?? null, c.get('requestId'), c.get('ipHash') ?? null, JSON.stringify(metadata), new Date().toISOString());
}

export async function audit(c: AppContext, action: string, resourceType: string, resourceId?: string, metadata: Record<string, unknown> = {}) {
  await auditStatement(c, action, resourceType, resourceId, metadata).run();
}
