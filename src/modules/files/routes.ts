import { apiLocation } from '../../core/response';
import { Hono } from 'hono';
import { z } from 'zod';
import { pageMeta, paginationShape, query } from '../../core/pagination';
import { success } from '../../core/response';
import type { AppEnv } from '../../core/types';
import { resourceId } from '../../core/validation';
import { requireAuth, requireScope } from '../../middleware/auth';
import { fileDto, listFiles } from './repository';
import { downloadFile, getFile, removeFile, uploadFile } from './service';
import { acceptedContentTypes } from './validation';

const listSchema = z
  .object({
    ...paginationShape,
    sort: z.enum(['createdAt', 'filename', 'size']).default('createdAt'),
    contentType: z.enum(acceptedContentTypes).optional(),
  })
  .strict();

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use('*', requireAuth);
fileRoutes.get('/', requireScope('files:read'), async (c) => {
  const input = query(c, listSchema);
  const result = await listFiles(c.env.DB, c.get('principal').user.id, input);
  return success(c, result.rows.map(fileDto), 200, pageMeta(result.total, input));
});
fileRoutes.post('/', requireScope('files:write'), async (c) => {
  const data = await uploadFile(c);
  c.header('Location', apiLocation(c, `/api/v1/files/${data.id}`));
  return success(c, data, 201);
});
fileRoutes.get('/:id', requireScope('files:read'), async (c) =>
  success(c, fileDto(await getFile(c, resourceId(c)))),
);
fileRoutes.get('/:id/content', requireScope('files:read'), async (c) =>
  downloadFile(c, resourceId(c)),
);
fileRoutes.delete('/:id', requireScope('files:write'), async (c) =>
  success(c, await removeFile(c, resourceId(c))),
);
