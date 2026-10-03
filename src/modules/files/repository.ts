import type { Database } from '../../core/database';
import type { FileContentType } from './validation';
import { likePattern } from '../../core/pagination';

export interface FileRow {
  id: string;
  owner_id: string;
  object_key: string;
  filename: string;
  content_type: FileContentType;
  size: number;
  created_at: string;
  status: 'ready' | 'deleting';
}

export interface FileQuery {
  page: number;
  limit: number;
  order: 'asc' | 'desc';
  sort: 'createdAt' | 'filename' | 'size';
  q?: string;
  contentType?: FileContentType;
}

export function insertFile(db: Database, file: FileRow) {
  return db
    .prepare(
      `INSERT INTO files (id,owner_id,object_key,filename,content_type,size,created_at,status)
    VALUES (?,?,?,?,?,?,?,'ready')`,
    )
    .bind(
      file.id,
      file.owner_id,
      file.object_key,
      file.filename,
      file.content_type,
      file.size,
      file.created_at,
    );
}

export function findFile(db: Database, id: string, ownerId: string, includeDeleting = false) {
  return db
    .prepare(
      `SELECT * FROM files WHERE id = ? AND owner_id = ?${includeDeleting ? '' : " AND status = 'ready'"}`,
    )
    .bind(id, ownerId)
    .first<FileRow>();
}

export async function listFiles(db: Database, ownerId: string, input: FileQuery) {
  const filters = ['owner_id = ?', "status = 'ready'"];
  const params: (string | number)[] = [ownerId];
  if (input.q) {
    filters.push("filename ILIKE ? ESCAPE '\\'");
    params.push(likePattern(input.q));
  }
  if (input.contentType) {
    filters.push('content_type = ?');
    params.push(input.contentType);
  }
  const where = filters.join(' AND ');
  const columns = { createdAt: 'created_at', filename: 'filename', size: 'size' } as const;
  // SQL identifiers only come from the validated allowlist; values are always bound.
  const sort = columns[input.sort];
  const order = input.order === 'asc' ? 'ASC' : 'DESC';
  const [rows, count] = await db.batch([
    db
      .prepare(
        `SELECT * FROM files WHERE ${where} ORDER BY ${sort} ${order}, id ASC LIMIT ? OFFSET ?`,
      )
      .bind(...params, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS total FROM files WHERE ${where}`).bind(...params),
  ]);
  return {
    rows: rows!.results as unknown as FileRow[],
    total: Number((count!.results[0] as { total: number }).total),
  };
}

export function markDeleting(db: Database, file: FileRow) {
  return db
    .prepare(
      "UPDATE files SET status = 'deleting' WHERE id = ? AND owner_id = ? AND status = 'ready'",
    )
    .bind(file.id, file.owner_id);
}

export function deleteMetadata(db: Database, file: FileRow) {
  return db
    .prepare("DELETE FROM files WHERE id = ? AND owner_id = ? AND status = 'deleting'")
    .bind(file.id, file.owner_id);
}

export function finishDeletion(
  db: Database,
  file: FileRow,
  actor: { id: string | null; requestId: string; ipHash: string | null },
  action = 'file.deleted',
) {
  return [
    // Audit only the request that wins the metadata deletion. Concurrent retries
    // and cron runs can safely delete the same Storage object without duplicate events.
    db
      .prepare(
        `INSERT INTO audit_logs (id,actor_id,action,resource_type,resource_id,request_id,ip_hash,metadata,created_at)
      SELECT ?,?,?,'file',?,?,?,'{}',? FROM files WHERE id = ? AND owner_id = ? AND status = 'deleting'`,
      )
      .bind(
        crypto.randomUUID(),
        actor.id,
        action,
        file.id,
        actor.requestId,
        actor.ipHash,
        new Date().toISOString(),
        file.id,
        file.owner_id,
      ),
    deleteMetadata(db, file),
  ];
}

export const fileDto = (file: FileRow) => ({
  id: file.id,
  filename: file.filename,
  contentType: file.content_type,
  size: file.size,
  createdAt: file.created_at,
  downloadUrl: `/api/v1/files/${file.id}/content`,
});
