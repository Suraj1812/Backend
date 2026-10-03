import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  console.log('.env.local already exists; existing secrets preserved.');
} else {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync(
    '.env.local',
    `JWT_SECRET=${secret()}\nPASSWORD_PEPPER=${secret()}\nIP_HASH_SECRET=${secret()}\nMAINTENANCE_SECRET=${secret()}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created .env.local with four distinct random secrets. Run npm run db:migrate next.');
}
