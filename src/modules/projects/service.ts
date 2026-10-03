import type { AppContext } from '../../core/types';
import { ResourceService } from '../../core/resource-service';
import type { ResourceDefinition } from '../../core/resource-repository';

interface ProjectRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}
const definition: ResourceDefinition = {
  table: 'projects',
  columns: {
    name: 'name',
    description: 'description',
    status: 'status',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  searchColumns: ['name', 'description'],
  filters: { status: 'status' },
};
const dto = (row: ProjectRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export class ProjectService extends ResourceService<ProjectRow, ReturnType<typeof dto>> {
  constructor(c: AppContext) {
    super(c, definition, dto);
  }
  protected beforeDelete(id: string) {
    // Clear references inside the same PostgreSQL transaction; tasks survive project deletion.
    return [
      this.c.env.DB.prepare(
        'UPDATE tasks SET project_id = NULL, updated_at = ? WHERE project_id = ? AND owner_id = ?',
      ).bind(new Date().toISOString(), id, this.c.get('principal').user.id),
    ];
  }
}
