import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { localDatabase } from './local-runtime';
const args = process.argv.slice(2),
  email = args[0]?.trim().toLowerCase(),
  production = args[1] === '--production';
if (
  !email ||
  !/^[^\s@'<>]+@[^\s@'<>]+\.[^\s@'<>]+$/.test(email) ||
  args.length !== (production ? 2 : 1)
)
  throw new Error('Usage: npm run admin:promote -- email [--production]');
const now = new Date().toISOString(),
  id = crypto.randomUUID(),
  requestId = crypto.randomUUID();
if (!production) {
  const { pg, db } = await localDatabase();
  try {
    const results = await db.batch([
      db
        .prepare(
          "UPDATE users SET role='admin',updated_at=? WHERE email=? AND disabled=0 RETURNING id,email,role",
        )
        .bind(now, email),
      db
        .prepare(
          "INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,request_id,metadata,created_at) SELECT ?,NULL,'operator.admin_promoted','users',id,?,'{}',? FROM users WHERE email=? AND role='admin' AND disabled=0",
        )
        .bind(id, requestId, now, email),
    ]);
    if (!results[0].results.length) throw new Error('No active account matched; no admin created');
    console.log(results[0].results[0]);
  } finally {
    await pg.close();
  }
} else {
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const config = JSON.parse(readFileSync('docs/configuration.json', 'utf8'));
  const sql = `BEGIN; DO $operator$ DECLARE uid text; BEGIN
 SELECT id INTO uid FROM users WHERE email=${quote(email)} AND disabled=0 FOR UPDATE;
 IF uid IS NULL THEN RAISE EXCEPTION 'No active account matched'; END IF;
 UPDATE users SET role='admin',updated_at=${quote(now)} WHERE id=uid;
 INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,request_id,metadata,created_at)
 VALUES(${quote(id)},NULL,'operator.admin_promoted','users',uid,${quote(requestId)},'{}',${quote(now)});
 END $operator$; COMMIT; SELECT id,email,role FROM users WHERE email=${quote(email)};`;
  const folder = mkdtempSync(join(tmpdir(), 'foundation-admin-'));
  try {
    const file = join(folder, 'promote.sql');
    writeFileSync(file, sql, { mode: 0o600 });
    const result = spawnSync(
      'npx',
      ['supabase', 'db', 'query', '--linked', '--project-ref', config.projectRef, '--file', file],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('Promotion failed');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
