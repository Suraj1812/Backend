import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync('docs/configuration.json', 'utf8'));
if (!/^[a-z]{20}$/.test(config.projectRef ?? ''))
  throw new Error('Configure the Supabase projectRef');
if (config.baseUrl !== `https://${config.projectRef}.supabase.co/functions/v1/backend`)
  throw new Error('Invalid production API URL');
for (const origin of config.variables.ALLOWED_ORIGINS.split(',')) {
  const url = new URL(origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.origin !== origin ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new Error('Invalid production frontend origin');
}
const result = spawnSync(
  'npx',
  ['supabase', 'secrets', 'list', '--project-ref', config.projectRef, '--output-format', 'json'],
  { encoding: 'utf8' },
);
if (result.status !== 0) throw new Error('Supabase authentication/project access is required');
const secrets = JSON.parse(result.stdout).secrets ?? JSON.parse(result.stdout);
const names = new Set(secrets.map((item) => item.name));
for (const name of ['JWT_SECRET', 'PASSWORD_PEPPER', 'IP_HASH_SECRET', 'MAINTENANCE_SECRET'])
  if (!names.has(name)) throw new Error(`Missing Supabase secret: ${name}`);
console.log('Production project, URL, origins and required secret names verified.');
