import type { Env } from './types';
import { getConfig } from './config';
import { cleanupDeletingFiles } from '../modules/files/service';
import { log } from './logger';

export async function maintenance(env: Env) {
  const config = getConfig(env);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - config.auditRetentionDays * 86400000).toISOString();
  // Bounded batches avoid a long-running cron as the installation grows.
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM rate_limits WHERE (bucket,key_hash,window_start) IN (SELECT bucket,key_hash,window_start FROM rate_limits WHERE window_start < ? LIMIT 1000)',
    ).bind(Math.floor(Date.now() / 1000) - 120),
    env.DB.prepare(
      'DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT 1000)',
    ).bind(now),
    env.DB.prepare(
      'DELETE FROM api_keys WHERE id IN (SELECT id FROM api_keys WHERE expires_at < ? LIMIT 1000)',
    ).bind(now),
    env.DB.prepare(
      'DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < ? LIMIT 1000)',
    ).bind(cutoff),
  ]);
  await cleanupDeletingFiles(env);
  const cursorRow = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'orphan-cursor'",
  ).first<{ value: string }>();
  const cursor = cursorRow?.value;
  const objects = await env.FILES.list({ prefix: 'uploads/', limit: 100, cursor });
  const orphanCutoff = Date.now() - 86400000;
  for (const object of objects.objects) {
    if (object.uploaded.getTime() >= orphanCutoff) continue;
    const row = await env.DB.prepare('SELECT id FROM files WHERE object_key = ?')
      .bind(object.key)
      .first();
    if (!row) await env.FILES.delete(object.key);
  }
  if (objects.truncated)
    await env.DB.prepare(
      "INSERT INTO app_settings(key,value) VALUES ('orphan-cursor',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(objects.cursor)
      .run();
  else await env.DB.prepare("DELETE FROM app_settings WHERE key = 'orphan-cursor'").run();
  log('info', { event: 'maintenance_complete' });
}
