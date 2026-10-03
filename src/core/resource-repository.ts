import type { Database } from './database';
import type { PageQuery } from './pagination';
import { likePattern } from './pagination';

export type Scalar = string | number | null;
export interface ResourceDefinition {
  table: 'projects' | 'tasks';
  columns: Record<string, string>;
  searchColumns: string[];
  filters: Record<string, string>;
}
// SQL identifiers come exclusively from source-controlled definitions. All user values are bound.
export class ResourceRepository<Row extends Record<string, unknown>> {
  constructor(
    private db: Database,
    private definition: ResourceDefinition,
    private ownerId: string,
  ) {}

  find(id: string) {
    return this.db
      .prepare(`SELECT * FROM ${this.definition.table} WHERE id = ? AND owner_id = ?`)
      .bind(id, this.ownerId)
      .first<Row>();
  }

  async list(input: PageQuery & Record<string, unknown>) {
    const where = ['owner_id = ?'];
    const bindings: Scalar[] = [this.ownerId];
    for (const [field, column] of Object.entries(this.definition.filters)) {
      if (input[field] !== undefined) {
        where.push(`${column} = ?`);
        bindings.push(input[field] as Scalar);
      }
    }
    if (input.q) {
      where.push(
        `(${this.definition.searchColumns.map((col) => `${col} ILIKE ? ESCAPE '\\'`).join(' OR ')})`,
      );
      this.definition.searchColumns.forEach(() => bindings.push(likePattern(input.q!)));
    }
    const clause = where.join(' AND ');
    const sort = this.definition.columns[input.sort];
    if (!sort) throw new Error('Unconfigured resource sort field');
    const [count, page] = await this.db.batch([
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM ${this.definition.table} WHERE ${clause}`)
        .bind(...bindings),
      this.db
        .prepare(
          `SELECT * FROM ${this.definition.table} WHERE ${clause} ORDER BY ${sort} ${input.order === 'asc' ? 'ASC' : 'DESC'}, id ASC LIMIT ? OFFSET ?`,
        )
        .bind(...bindings, input.limit, (input.page - 1) * input.limit),
    ]);
    return {
      total: Number((count.results[0] as { total: number }).total),
      rows: page.results as Row[],
    };
  }

  createStatement(id: string, data: Record<string, Scalar>, now: string) {
    const entries = Object.entries(data);
    return this.db
      .prepare(
        `INSERT INTO ${this.definition.table} (id, owner_id, ${entries.map(([key]) => this.definition.columns[key]).join(', ')}, created_at, updated_at) VALUES (?, ?, ${entries.map(() => '?').join(', ')}, ?, ?) RETURNING *`,
      )
      .bind(id, this.ownerId, ...entries.map(([, value]) => value), now, now);
  }

  updateStatement(id: string, data: Record<string, Scalar>, now: string) {
    const entries = Object.entries(data);
    return this.db
      .prepare(
        `UPDATE ${this.definition.table} SET ${entries.map(([key]) => `${this.definition.columns[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND owner_id = ? RETURNING *`,
      )
      .bind(...entries.map(([, value]) => value), now, id, this.ownerId);
  }

  deleteStatement(id: string) {
    return this.db
      .prepare(`DELETE FROM ${this.definition.table} WHERE id = ? AND owner_id = ? RETURNING id`)
      .bind(id, this.ownerId);
  }
}
