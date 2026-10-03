import type { Database } from '../core/database';
import type { ObjectStore, StoredObject, StoredObjectBody } from '../core/storage';

export class SupabaseObjectStore implements ObjectStore {
  constructor(
    private url: string,
    private secret: string,
    private db: Database,
    private bucket = 'foundation-files',
  ) {}
  private path(key: string) {
    if (!/^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid object key');
    return `${this.url}/storage/v1/object/${this.bucket}/${key}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.secret, Authorization: `Bearer ${this.secret}`, ...extra };
  }
  async put(key: string, bytes: Uint8Array, options: Parameters<ObjectStore['put']>[2]) {
    const response = await fetch(this.path(key), {
      method: 'POST',
      headers: this.headers({
        'Content-Type': options.httpMetadata.contentType,
        'x-upsert': 'false',
      }),
      body: bytes as BodyInit,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Storage upload failed');
    }
    await response.body?.cancel();
    return { key, size: bytes.byteLength, uploaded: new Date() };
  }
  async get(key: string): Promise<StoredObjectBody | null> {
    const response = await fetch(this.path(key), {
      headers: this.headers(),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Storage download failed');
    }
    const size = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(size) || size < 1) {
      await response.body.cancel();
      throw new Error('Invalid storage length');
    }
    return {
      key,
      size,
      uploaded: new Date(response.headers.get('Last-Modified') ?? Date.now()),
      body: response.body,
    };
  }
  async head(key: string): Promise<StoredObject | null> {
    const row = await this.db
      .prepare(
        'SELECT metadata,created_at::text AS created_at FROM storage.objects WHERE bucket_id = ? AND name = ?',
      )
      .bind(this.bucket, key)
      .first<{ metadata: { size: number }; created_at: string }>();
    return row
      ? { key, size: Number(row.metadata.size), uploaded: new Date(row.created_at) }
      : null;
  }
  async delete(key: string) {
    this.path(key);
    const response = await fetch(`${this.url}/storage/v1/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [key] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      throw new Error('Storage delete failed');
    }
    await response.body?.cancel();
  }
  async list({ prefix, limit, cursor = '' }: Parameters<ObjectStore['list']>[0]) {
    if (prefix !== 'uploads/' || limit < 1 || limit > 1000) throw new Error('Invalid object scan');
    const rows = await this.db
      .prepare(
        `SELECT name,metadata,created_at::text AS created_at FROM storage.objects
      WHERE bucket_id = ? AND name LIKE 'uploads/%' AND name > ? ORDER BY name LIMIT ?`,
      )
      .bind(this.bucket, cursor, limit + 1)
      .all<{ name: string; metadata: { size: number }; created_at: string }>();
    const objects = rows.results.slice(0, limit).map((row) => ({
      key: row.name,
      size: Number(row.metadata.size),
      uploaded: new Date(row.created_at),
    }));
    return { objects, truncated: rows.results.length > limit, cursor: objects.at(-1)?.key ?? '' };
  }
}
