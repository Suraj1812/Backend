export type SqlValue = string | number | null;
export interface QueryResult<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: { changes: number };
}
export interface SqlExecutor {
  query(
    sql: string,
    values: SqlValue[],
  ): Promise<{ rows: Record<string, unknown>[]; count: number }>;
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

// Translate placeholders in source-controlled SQL, respecting SQL string literals.
// SQL identifiers never come from request values; bind() carries values separately.
export function postgresSql(source: string): string {
  let quoted = false,
    index = 0,
    result = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "'") {
      result += char;
      if (quoted && source[i + 1] === "'") {
        result += source[++i];
        continue;
      }
      quoted = !quoted;
    } else result += char === '?' && !quoted ? `$${++index}` : char;
  }
  return result;
}

export class PreparedStatement {
  constructor(
    readonly database: Database,
    readonly sql: string,
    readonly values: SqlValue[] = [],
  ) {}
  bind(...values: SqlValue[]) {
    return new PreparedStatement(this.database, this.sql, values);
  }
  async execute(executor: SqlExecutor): Promise<QueryResult> {
    const result = await executor.query(postgresSql(this.sql), this.values);
    return { results: result.rows, success: true, meta: { changes: result.count } };
  }
  async all<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    return (await this.execute(this.database.executor)) as QueryResult<T>;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (await this.all<T>()).results[0] ?? null;
  }
  run() {
    return this.execute(this.database.executor);
  }
}

export class Database {
  constructor(readonly executor: SqlExecutor) {}
  prepare(sql: string) {
    return new PreparedStatement(this, sql);
  }
  async batch(statements: PreparedStatement[]): Promise<QueryResult[]> {
    if (statements.some((statement) => statement.database !== this))
      throw new Error('Mixed databases');
    return this.executor.transaction(async (transaction) => {
      const results: QueryResult[] = [];
      for (const statement of statements) results.push(await statement.execute(transaction));
      return results;
    });
  }
}
