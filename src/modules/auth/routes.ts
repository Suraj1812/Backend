import { Hono } from 'hono';
import type { AppEnv } from '../../core/types';
import { requireBearer } from '../../middleware/auth';
import * as controller from './controller';

export const authRoutes = new Hono<AppEnv>();
authRoutes.post('/register', controller.register);
authRoutes.post('/login', controller.login);
authRoutes.post('/refresh', controller.refresh);
authRoutes.post('/logout', requireBearer, controller.logout);
authRoutes.get('/me', requireBearer, controller.me);
authRoutes.get('/sessions', requireBearer, controller.listSessions);
authRoutes.delete('/sessions/:id', requireBearer, controller.revokeSession);
