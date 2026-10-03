import { createPasswordHelpers } from '../src/modules/auth/password-core';
import { derive as deriveArgon2 } from '../src/core/argon2';
import { randomToken } from '../src/core/crypto';
import { localDatabase, readLocalSecrets } from './local-runtime';
if (process.argv.length > 2) throw new Error('Seed is local only; no remote flags supported');
const pepper = (await readLocalSecrets()).PASSWORD_PEPPER;
if (!pepper || pepper.length < 43) throw new Error('Run npm run setup:local first');
const password = process.env.SEED_PASSWORD ?? randomToken();
if (password.length < 15 || password.length > 128)
  throw new Error('SEED_PASSWORD must have15–128characters');
const hash = await createPasswordHelpers(deriveArgon2).hashPassword(password, pepper);
const { pg, db } = await localDatabase();
const adminId = '10000000-0000-4000-8000-000000000001',
  memberId = '10000000-0000-4000-8000-000000000002',
  projectId = '20000000-0000-4000-8000-000000000001';
const now = new Date().toISOString();
try {
  await db.batch([
    db
      .prepare(
        `INSERT INTO users(id,email,name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,updated_at=excluded.updated_at`,
      )
      .bind(
        adminId,
        'admin@local.test',
        'Local Admin',
        hash,
        'admin',
        now,
        now,
        memberId,
        'learner@local.test',
        'API Learner',
        hash,
        'member',
        now,
        now,
      ),
    db
      .prepare('UPDATE sessions SET revoked_at=? WHERE user_id IN (?,?)')
      .bind(now, adminId, memberId),
    db
      .prepare(
        `INSERT INTO projects(id,owner_id,name,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        projectId,
        memberId,
        'Learn API integration',
        'Practice fetching and updating tasks',
        'active',
        now,
        now,
      ),
    ...['Fetch my projects', 'Update a task', 'Handle pagination'].map((title, i) =>
      db
        .prepare(
          `INSERT INTO tasks(id,owner_id,title,description,status,priority,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `30000000-0000-4000-8000-00000000000${i + 1}`,
          memberId,
          title,
          'Practice with the frontend guide',
          ['todo', 'in_progress', 'done'][i],
          'medium',
          projectId,
          now,
          now,
        ),
    ),
  ]);
  console.log(
    `Local users: learner@local.test (member),admin@local.test (admin)\nGenerated development password: ${password}\nStore privately; rerunning seed rotates local passwords and revokes sessions.`,
  );
} finally {
  await pg.close();
}
