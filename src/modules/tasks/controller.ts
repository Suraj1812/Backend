import { apiLocation } from '../../core/response';
import type { AppContext } from '../../core/types';
import { json, resourceId } from '../../core/validation';
import { query, pageMeta } from '../../core/pagination';
import { success } from '../../core/response';
import { TaskService } from './service';
import { createTaskSchema, updateTaskSchema, listTaskSchema } from './schema';
export async function listTasks(c: AppContext) {
  const input = query(c, listTaskSchema);
  const result = await new TaskService(c).list(input);
  return success(c, result.data, 200, pageMeta(result.total, input));
}
export async function getTask(c: AppContext) {
  return success(c, await new TaskService(c).get(resourceId(c)));
}
export async function createTask(c: AppContext) {
  const data = await new TaskService(c).create(json(c, createTaskSchema));
  c.header('Location', apiLocation(c, `/api/v1/tasks/${data.id}`));
  return success(c, data, 201);
}
export async function updateTask(c: AppContext) {
  return success(c, await new TaskService(c).update(resourceId(c), json(c, updateTaskSchema)));
}
export async function deleteTask(c: AppContext) {
  return success(c, await new TaskService(c).delete(resourceId(c)));
}
