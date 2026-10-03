import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync('docs/configuration.json', 'utf8'));
const vars = readFileSync('.secrets/supabase-production.env', 'utf8');
const secret = vars.match(/^MAINTENANCE_SECRET=(.+)$/m)?.[1]?.trim();
if (!secret || !/^[A-Za-z0-9_-]{43,128}$/.test(secret))
  throw new Error('Run setup:production-secrets first');
const url = `https://${config.projectRef}.supabase.co/functions/v1/maintenance`;
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
// Secrets are kept in Vault, outside cron SQL. Never print the generated SQL.
const sql = `DO $setup$ DECLARE sid uuid; BEGIN
 SELECT id INTO sid FROM vault.secrets WHERE name='foundation_maintenance_token';
 IF sid IS NULL THEN PERFORM vault.create_secret(${quote(secret)},'foundation_maintenance_token','Private maintenance function credential');
 ELSE PERFORM vault.update_secret(sid,${quote(secret)}); END IF;
 SELECT id INTO sid FROM vault.secrets WHERE name='foundation_maintenance_url';
 IF sid IS NULL THEN PERFORM vault.create_secret(${quote(url)},'foundation_maintenance_url','Maintenance endpoint');
 ELSE PERFORM vault.update_secret(sid,${quote(url)}); END IF;
END $setup$;
SELECT cron.schedule('foundation-maintenance','*/15 * * * *',$cron$
 SELECT net.http_post(
  url:=(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='foundation_maintenance_url'),
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='foundation_maintenance_token')),
  body:='{}'::jsonb,timeout_milliseconds:=60000);
$cron$);
SELECT jobname,schedule,active FROM cron.job WHERE jobname='foundation-maintenance';`;
const folder = mkdtempSync(join(tmpdir(), 'foundation-cron-'));
const file = join(folder, 'setup.sql');
try {
  writeFileSync(file, sql, { mode: 0o600 });
  const result = spawnSync(
    'npx',
    ['supabase', 'db', 'query', '--linked', '--project-ref', config.projectRef, '--file', file],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error((result.stderr || result.stdout).replaceAll(secret, '[REDACTED]'));
    process.exitCode = result.status ?? 1;
  } else console.log('Configured private Supabase maintenance Cron every15minutes.');
} finally {
  rmSync(folder, { recursive: true, force: true });
}
