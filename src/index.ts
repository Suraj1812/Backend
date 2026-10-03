import { Hono } from 'hono';
import type { AppEnv } from './core/types';
import { security, boundedBody } from './middleware/security';
import { errorHandler } from './core/error-handler';
import { ApiError } from './core/errors';
import { success } from './core/response';
import { apiReference, referenceCss } from './core/api-reference';
import { openApiDocument } from './openapi';
import { authRoutes } from './modules/auth/routes';
import { apiKeyRoutes } from './modules/api-keys/routes';
import { fileRoutes } from './modules/files/routes';
import { projectRoutes } from './modules/projects/routes';
import { taskRoutes } from './modules/tasks/routes';
import { userRoutes } from './modules/users/routes';
import { auditRoutes } from './modules/audit/routes';

export const app = new Hono<AppEnv>({
  strict: true,
  getPath: (request) => {
    const path = new URL(request.url).pathname;
    return path.replace(/^\/(?:functions\/v1\/)?backend(?=\/|$)/, '') || '/';
  },
});
app.use('*', security, boundedBody);
app.onError(errorHandler);
app.get('/health', (c) => success(c, { status: 'ok', version: '1.0.0' }));
app.get('/ready', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The database is temporarily unavailable');
  }
  return success(c, { status: 'ready' });
});
app.get('/openapi.json', (c) => c.json(openApiDocument));
app.get('/docs', (c) => c.html(apiReference()));
app.get('/docs.css', (c) =>
  c.body(referenceCss, 200, { 'Content-Type': 'text/css; charset=utf-8' }),
);
app.get('/api/v1', async (c) => {
  const data = {
    version: 'v1',
    documentation: '/docs',
    openapi: '/openapi.json',
    resources: ['auth', 'users', 'projects', 'tasks', 'files', 'api-keys', 'audit-logs'],
  };
  return success(c, data);
});
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/api-keys', apiKeyRoutes);
app.route('/api/v1/files', fileRoutes);
app.route('/api/v1/projects', projectRoutes);
app.route('/api/v1/tasks', taskRoutes);
app.route('/api/v1/users', userRoutes);
app.route('/api/v1/audit-logs', auditRoutes);
app.notFound(() => {
  throw new ApiError(404, 'NOT_FOUND', 'The endpoint was not found');
});

export default app;
