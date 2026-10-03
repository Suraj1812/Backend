import type { Database } from '../core/database';
import type { RateLimiter } from '../core/storage';

// A database UPSERT makes limits consistent across isolates and simultaneous requests.
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private db: Database,
    private bucket: string,
    private maximum: number,
  ) {}
  async limit({ key }: { key: string }) {
    const window = Math.floor(Date.now() / 60000) * 60;
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limits(bucket,key_hash,window_start,hits)
      VALUES (?,?,?,1) ON CONFLICT (bucket,key_hash,window_start)
      DO UPDATE SET hits = rate_limits.hits + 1 WHERE rate_limits.hits < ? RETURNING hits`,
      )
      .bind(this.bucket, key, window, this.maximum)
      .first();
    return { success: row !== null };
  }
}
