import type { PreparedStatement } from './database';
import type { AppContext } from './types';
import type { PageQuery } from './pagination';
import { ApiError } from './errors';
import { auditStatement } from './audit';
import { ResourceRepository, type ResourceDefinition, type Scalar } from './resource-repository';

export class ResourceService<Row extends Record<string, unknown>, Dto> {
  protected repository: ResourceRepository<Row>;
  constructor(
    protected c: AppContext,
    protected definition: ResourceDefinition,
    protected dto: (row: Row) => Dto,
  ) {
    this.repository = new ResourceRepository(c.env.DB, definition, c.get('principal').user.id);
  }
  async list(input: PageQuery & Record<string, unknown>) {
    const { total, rows } = await this.repository.list(input);
    return { total, data: rows.map(this.dto) };
  }
  async get(id: string) {
    const row = await this.repository.find(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'The resource was not found');
    return this.dto(row);
  }
  protected async validateRelations(_data: Record<string, Scalar>) {}
  protected beforeDelete(_id: string): PreparedStatement[] {
    return [];
  }

  async create(data: Record<string, Scalar>) {
    await this.validateRelations(data);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const [result] = await this.c.env.DB.batch([
      this.repository.createStatement(id, data, now),
      auditStatement(this.c, `${this.definition.table}.create`, this.definition.table, id),
    ]);
    return this.dto(result.results[0] as Row);
  }
  async update(id: string, data: Record<string, Scalar>) {
    await this.get(id);
    await this.validateRelations(data);
    const [result] = await this.c.env.DB.batch([
      this.repository.updateStatement(id, data, new Date().toISOString()),
      auditStatement(this.c, `${this.definition.table}.update`, this.definition.table, id),
    ]);
    if (!result.results[0]) throw new ApiError(404, 'NOT_FOUND', 'The resource was not found');
    return this.dto(result.results[0] as Row);
  }
  async delete(id: string) {
    await this.get(id);
    const results = await this.c.env.DB.batch([
      ...this.beforeDelete(id),
      this.repository.deleteStatement(id),
      auditStatement(this.c, `${this.definition.table}.delete`, this.definition.table, id),
    ]);
    if (!results[results.length - 2].results[0])
      throw new ApiError(404, 'NOT_FOUND', 'The resource was not found');
    return { id, deleted: true };
  }
}
