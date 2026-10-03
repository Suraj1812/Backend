import { apiLocation } from '../../core/response';
import type { AppContext } from '../../core/types';
import { json, resourceId } from '../../core/validation';
import { query, pageMeta } from '../../core/pagination';
import { success } from '../../core/response';
import { ProjectService } from './service';
import { createProjectSchema, updateProjectSchema, listProjectSchema } from './schema';

export async function listProjects(c: AppContext) {
  const input = query(c, listProjectSchema);
  const result = await new ProjectService(c).list(input);
  return success(c, result.data, 200, pageMeta(result.total, input));
}
export async function getProject(c: AppContext) {
  return success(c, await new ProjectService(c).get(resourceId(c)));
}
export async function createProject(c: AppContext) {
  const data = await new ProjectService(c).create(json(c, createProjectSchema));
  c.header('Location', apiLocation(c, `/api/v1/projects/${data.id}`));
  return success(c, data, 201);
}
export async function updateProject(c: AppContext) {
  return success(
    c,
    await new ProjectService(c).update(resourceId(c), json(c, updateProjectSchema)),
  );
}
export async function deleteProject(c: AppContext) {
  return success(c, await new ProjectService(c).delete(resourceId(c)));
}
