import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync('docs/configuration.json', 'utf8'));
if (!/^[a-z]{20}$/.test(config.projectRef ?? '')) throw new Error('Configure projectRef first');
mkdirSync('.secrets', { recursive: true, mode: 0o700 });
const file = '.secrets/supabase-production.env';
if (!existsSync(file)) {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync(
    file,
    `JWT_SECRET=${secret()}\nPASSWORD_PEPPER=${secret()}\nIP_HASH_SECRET=${secret()}\nMAINTENANCE_SECRET=${secret()}\n`,
    { mode: 0o600, flag: 'wx' },
  );
}
// Names/digests may be listed for verification; secret values are never printed.
const result = spawnSync(
  'npx',
  ['supabase', 'secrets', 'set', '--project-ref', config.projectRef, '--env-file', file],
  { stdio: 'inherit' },
);
if (result.status !== 0) throw new Error('Failed to provision production secrets');
console.log('Configured Supabase secrets; private backup preserved under .secrets/.');
