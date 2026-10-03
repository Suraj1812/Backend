import type { StoredObjectBody } from '../../core/storage';
import { audit, auditStatement } from '../../core/audit';
import { ApiError } from '../../core/errors';
import { log } from '../../core/logger';
import type { AppContext, Env } from '../../core/types';
import {
  fileDto,
  findFile,
  finishDeletion,
  insertFile,
  markDeleting,
  type FileRow,
} from './repository';
import { validateUpload } from './validation';

export async function uploadFile(c: AppContext) {
  const bytes = c.get('bodyBytes');
  const input = validateUpload(
    bytes,
    c.req.header('Content-Type'),
    c.req.header('X-File-Name'),
    c.get('config').maxUploadBytes,
  );
  const ownerId = c.get('principal').user.id;
  const id = crypto.randomUUID();
  const file: FileRow = {
    id,
    owner_id: ownerId,
    object_key: `uploads/${ownerId}/${id}`,
    filename: input.filename,
    content_type: input.contentType,
    size: bytes.length,
    created_at: new Date().toISOString(),
    status: 'ready',
  };
  try {
    const object = await c.env.FILES.put(file.object_key, bytes, {
      httpMetadata: {
        contentType: file.content_type,
        contentDisposition: `attachment; filename="${file.filename}"`,
      },
      customMetadata: { fileId: id },
    });
    if (!object) throw new Error('Storage did not store the object');
  } catch {
    throw new ApiError(
      503,
      'FILE_STORAGE_UNAVAILABLE',
      'File storage is temporarily unavailable; retry the upload',
    );
  }
  try {
    await c.env.DB.batch([
      insertFile(c.env.DB, file),
      auditStatement(c, 'file.created', 'file', id, {
        contentType: file.content_type,
        size: file.size,
      }),
    ]);
  } catch {
    // An RPC failure can be ambiguous even if PostgreSQL committed the transaction. Recheck
    // before compensating, so we never intentionally remove a committed upload.
    let persisted: FileRow | null;
    try {
      persisted = await findFile(c.env.DB, id, ownerId, true);
    } catch {
      log('error', {
        event: 'file_upload_reconciliation_required',
        requestId: c.get('requestId'),
        fileId: id,
      });
      throw new ApiError(
        503,
        'FILE_STORAGE_UNAVAILABLE',
        'The upload result could not be confirmed; check your file list before retrying',
      );
    }
    if (persisted?.status === 'ready') return fileDto(persisted);
    if (!persisted) {
      try {
        await c.env.FILES.delete(file.object_key);
      } catch {
        log('error', {
          event: 'file_upload_compensation_failed',
          requestId: c.get('requestId'),
          fileId: id,
        });
      }
    }
    throw new ApiError(
      503,
      'FILE_STORAGE_UNAVAILABLE',
      'The upload could not be saved; retry later',
    );
  }
  return fileDto(file);
}

export async function getFile(c: AppContext, id: string, includeDeleting = false) {
  const file = await findFile(c.env.DB, id, c.get('principal').user.id, includeDeleting);
  if (!file) throw new ApiError(404, 'NOT_FOUND', 'File not found');
  return file;
}

export async function downloadFile(c: AppContext, id: string) {
  const file = await getFile(c, id);
  let object: StoredObjectBody | null;
  try {
    object = await c.env.FILES.get(file.object_key);
  } catch {
    throw new ApiError(
      503,
      'FILE_STORAGE_UNAVAILABLE',
      'File storage is temporarily unavailable; retry later',
    );
  }
  if (!object || object.size !== file.size) {
    log('error', { event: 'file_object_inconsistent', requestId: c.get('requestId'), fileId: id });
    throw new ApiError(503, 'FILE_STORAGE_UNAVAILABLE', 'This file is temporarily unavailable');
  }
  await audit(c, 'file.downloaded', 'file', file.id);
  return c.newResponse(object.body, 200, {
    'Content-Type': file.content_type,
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
}

export async function removeFile(c: AppContext, id: string) {
  const file = await getFile(c, id, true);
  if (file.status === 'ready') {
    try {
      await c.env.DB.batch([
        markDeleting(c.env.DB, file),
        auditStatement(c, 'file.delete_requested', 'file', file.id),
      ]);
    } catch {
      throw new ApiError(
        503,
        'FILE_STORAGE_UNAVAILABLE',
        'File deletion could not be confirmed; retry later',
      );
    }
  }
  // A durable tombstone makes objects inaccessible immediately and lets the
  // scheduler finish deletion after Storage or PostgreSQL outages. Storage delete is idempotent.
  try {
    await c.env.FILES.delete(file.object_key);
    await c.env.DB.batch(
      finishDeletion(c.env.DB, file, {
        id: c.get('principal').user.id,
        requestId: c.get('requestId'),
        ipHash: c.get('ipHash') ?? null,
      }),
    );
  } catch {
    log('error', { event: 'file_delete_pending', requestId: c.get('requestId'), fileId: id });
    throw new ApiError(503, 'FILE_DELETION_PENDING', 'File deletion is pending; retry later');
  }
  return { id, deleted: true };
}

export async function cleanupDeletingFiles(env: Env) {
  const pending = await env.DB.prepare(
    "SELECT * FROM files WHERE status = 'deleting' ORDER BY created_at, id LIMIT 100",
  ).all<FileRow>();
  let deleted = 0;
  for (const file of pending.results) {
    try {
      await env.FILES.delete(file.object_key);
      await env.DB.batch(
        finishDeletion(
          env.DB,
          file,
          {
            id: null,
            requestId: crypto.randomUUID(),
            ipHash: null,
          },
          'file.deletion_completed',
        ),
      );
      deleted++;
    } catch {
      log('error', { event: 'file_cleanup_failed', fileId: file.id });
    }
  }
  return deleted;
}
