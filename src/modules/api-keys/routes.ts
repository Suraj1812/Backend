import { Hono } from 'hono';
import type { AppEnv } from '../../core/types';
import { requireBearer } from '../../middleware/auth';
import * as controller from './controller';

export const apiKeyRoutes = new Hono<AppEnv>();
apiKeyRoutes.use('*', requireBearer);
apiKeyRoutes.get('/', controller.list);
apiKeyRoutes.post('/', controller.create);
apiKeyRoutes.delete('/:id', controller.revoke);
