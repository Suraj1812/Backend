import { Hono } from 'hono';
import type { AppEnv } from '../../core/types';
import { requireAuth, requireScope } from '../../middleware/auth';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from './controller';
export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use('*', requireAuth);
projectRoutes.get('/', requireScope('resources:read'), listProjects);
projectRoutes.get('/:id', requireScope('resources:read'), getProject);
projectRoutes.post('/', requireScope('resources:write'), createProject);
projectRoutes.patch('/:id', requireScope('resources:write'), updateProject);
projectRoutes.delete('/:id', requireScope('resources:write'), deleteProject);
