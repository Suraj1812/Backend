import postgres from 'postgres';
import { Database, type SqlExecutor, type SqlValue } from '../core/database';

export function postgresDatabase(url: string) {
  // Bounded pool; statements execute sequentially in each transaction. No server
  // prepared statements, which are incompatible with transaction pooling.
  const client = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: 'frontend-foundation-api', statement_timeout: 15000 },
    ssl: 'require',
  });
  const executor = (sql: Pick<typeof client, 'unsafe'>): SqlExecutor => ({
    async query(query: string, values: SqlValue[]) {
      const rows = await sql.unsafe(query, values);
      return { rows: [...rows], count: rows.count };
    },
    async transaction(work) {
      return (await client.begin(async (transaction) => work(executor(transaction)))) as Awaited<
        ReturnType<typeof work>
      >;
    },
  });
  return { db: new Database(executor(client)), close: () => client.end({ timeout: 5 }) };
}
