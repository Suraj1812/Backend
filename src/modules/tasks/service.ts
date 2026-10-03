import type { AppContext } from '../../core/types';
import { ResourceService } from '../../core/resource-service';
import { ApiError } from '../../core/errors';
import type { ResourceDefinition, Scalar } from '../../core/resource-repository';

interface TaskRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  project_id: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}
const definition: ResourceDefinition = {
  table: 'tasks',
  columns: {
    title: 'title',
    description: 'description',
    status: 'status',
    priority: 'priority',
    projectId: 'project_id',
    dueDate: 'due_date',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  searchColumns: ['title', 'description'],
  filters: { status: 'status', priority: 'priority', projectId: 'project_id' },
};
const dto = (row: TaskRow) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  projectId: row.project_id,
  dueDate: row.due_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export class TaskService extends ResourceService<TaskRow, ReturnType<typeof dto>> {
  constructor(c: AppContext) {
    super(c, definition, dto);
  }
  protected async validateRelations(data: Record<string, Scalar>) {
    if (data.projectId) {
      const project = await this.c.env.DB.prepare(
        'SELECT id FROM projects WHERE id = ? AND owner_id = ?',
      )
        .bind(data.projectId, this.c.get('principal').user.id)
        .first();
      if (!project) throw new ApiError(404, 'NOT_FOUND', 'The project was not found');
    }
  }
}
