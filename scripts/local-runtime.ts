import { PGlite } from '@electric-sql/pglite';
import { readFile, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Database, type SqlExecutor } from '../src/core/database';
import type { Env } from '../src/core/types';
import type { ObjectStore, StoredObject, StoredObjectBody } from '../src/core/storage';
import { PostgresRateLimiter } from '../src/runtime/rate-limit';
import configuration from '../docs/configuration.json';

export function pgliteDatabase(pg: PGlite): Database {
  const executor = (client: Pick<PGlite, 'query'>): SqlExecutor => ({
    async query(sql, values) {
      const result = await client.query<Record<string, unknown>>(sql, values);
      const rows = result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            ['count', 'total'].includes(key) && typeof value === 'string' ? Number(value) : value,
          ]),
        ),
      );
      return { rows, count: result.affectedRows ?? rows.length };
    },
    transaction: (work) => pg.transaction((transaction) => work(executor(transaction))),
  });
  return new Database(executor(pg));
}

export async function localDatabase(memory = false) {
  if (!memory) await mkdir('.local', { recursive: true });
  const pg = memory ? new PGlite() : new PGlite('.local/database');
  await pg.waitReady;
  await pg.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
  const migration = '20261003000001_foundation.sql';
  const applied = await pg.query('SELECT name FROM local_migrations WHERE name = $1', [migration]);
  if (!applied.rows.length) {
    const sql = await readFile(`supabase/migrations/${migration}`, 'utf8');
    await pg.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO local_migrations(name) VALUES ($1)', [migration]);
    });
  }
  return { pg, db: pgliteDatabase(pg) };
}

export class MemoryObjectStore implements ObjectStore {
  protected objects = new Map<string, StoredObject & { bytes: Uint8Array }>();
  async put(key: string, bytes: Uint8Array, _options: Parameters<ObjectStore['put']>[2]) {
    const object = { key, size: bytes.length, uploaded: new Date(), bytes: bytes.slice() };
    this.objects.set(key, object);
    return object;
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
  async get(key: string): Promise<StoredObjectBody | null> {
    const object = this.objects.get(key);
    return object ? { ...object, body: new Blob([object.bytes as BlobPart]).stream() } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list({ prefix, limit, cursor = '' }: Parameters<ObjectStore['list']>[0]) {
    const all = [...this.objects.values()]
      .filter((obj) => obj.key.startsWith(prefix) && obj.key > cursor)
      .sort((a, b) => a.key.localeCompare(b.key));
    const objects = all.slice(0, limit);
    return { objects, truncated: all.length > limit, cursor: objects.at(-1)?.key ?? '' };
  }
}

export class LocalObjectStore implements ObjectStore {
  private path(key: string) {
    if (!/^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key))
      throw new Error('Invalid local object path');
    return join('.local/files', key);
  }
  async put(key: string, bytes: Uint8Array, _options: Parameters<ObjectStore['put']>[2]) {
    const path = this.path(key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return (await this.head(key))!;
  }
  async head(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(this.path(key));
      return { key, size: info.size, uploaded: info.mtime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async get(key: string): Promise<StoredObjectBody | null> {
    const object = await this.head(key);
    if (!object) return null;
    const bytes = await readFile(this.path(key));
    return { ...object, body: new Blob([bytes]).stream() };
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async list({ prefix, limit, cursor = '' }: Parameters<ObjectStore['list']>[0]) {
    let entries: string[];
    try {
      entries = await readdir('.local/files', { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries = [];
    }
    const objects: StoredObject[] = [];
    for (const key of entries.sort()) {
      if (
        key.startsWith(prefix) &&
        key > cursor &&
        /^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)
      ) {
        const object = await this.head(key);
        if (object) objects.push(object);
        if (objects.length > limit) break;
      }
    }
    const page = objects.slice(0, limit);
    return { objects: page, truncated: objects.length > limit, cursor: page.at(-1)?.key ?? '' };
  }
}

export function localEnvironment(
  db: Database,
  files: ObjectStore,
  secrets: Record<string, string>,
): Env {
  return {
    ...configuration.variables,
    ...secrets,
    JWT_SECRET: secrets.JWT_SECRET,
    PASSWORD_PEPPER: secrets.PASSWORD_PEPPER,
    IP_HASH_SECRET: secrets.IP_HASH_SECRET,
    ENVIRONMENT: 'development',
    DB: db,
    FILES: files,
    API_RATE_LIMITER: new PostgresRateLimiter(db, 'api', 120),
    AUTH_RATE_LIMITER: new PostgresRateLimiter(db, 'auth', 10),
  } as Env;
}
export async function readLocalSecrets() {
  const text = await readFile('.env.local', 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const position = line.indexOf('=');
        return [line.slice(0, position), line.slice(position + 1).trim()];
      }),
  );
}
