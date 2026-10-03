import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const config = JSON.parse(readFileSync('docs/configuration.json', 'utf8')),
  base = config.baseUrl;
if (!/^https:\/\/[a-z]{20}\.supabase\.co\/functions\/v1\/backend$/.test(base))
  throw new Error('Configure a deployed Supabase URL');
const email = `smoke-${crypto.randomUUID()}@example.test`,
  password = randomBytes(24).toString('base64url');
const call = async (path, method = 'GET', body, token, extra = {}, expected) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: 'http://localhost:5173',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
  });
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : new Uint8Array(await response.arrayBuffer());
  console.log(
    path,
    response.status,
    data?.error?.code ?? (data instanceof Uint8Array ? 'binary' : data?.success),
  );
  if (expected !== undefined ? response.status !== expected : !response.ok)
    throw new Error(`Live smoke failed:${path}:${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== 'http://localhost:5173')
    throw new Error('Live CORS contract failed');
  return { response, data };
};
await call('/health');
await call('/ready');
const registration = await call(
  '/api/v1/auth/register',
  'POST',
  { email, name: 'Deployment verification', password },
  undefined,
  {},
  201,
);
let tokens = registration.data.data;
mkdirSync('.secrets', { recursive: true, mode: 0o700 });
writeFileSync('.secrets/live-smoke.json', JSON.stringify({ email, password, ...tokens }), {
  mode: 0o600,
});
await call(
  '/api/v1/auth/register',
  'POST',
  { email, name: 'Duplicate', password },
  undefined,
  {},
  409,
);
const project = (
  await call(
    '/api/v1/projects',
    'POST',
    { name: 'Deployment smoke project' },
    tokens.accessToken,
    {},
    201,
  )
).data.data;
const task = (
  await call(
    '/api/v1/tasks',
    'POST',
    { title: 'Verify local frontend', projectId: project.id },
    tokens.accessToken,
    {},
    201,
  )
).data.data;
await call(
  '/api/v1/tasks?page=1&limit=1&q=frontend&sort=title&order=asc',
  'GET',
  undefined,
  tokens.accessToken,
);
await call(`/api/v1/tasks/${task.id}`, 'PATCH', { status: 'done' }, tokens.accessToken);
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const file = (
  await call(
    '/api/v1/files',
    'POST',
    png,
    tokens.accessToken,
    { 'Content-Type': 'image/png', 'X-File-Name': 'smoke.png' },
    201,
  )
).data.data;
const downloaded = await call(file.downloadUrl, 'GET', undefined, tokens.accessToken);
if (Buffer.compare(Buffer.from(downloaded.data), Buffer.from(png)))
  throw new Error('Storage bytes differed');
const key = (
  await call(
    '/api/v1/api-keys',
    'POST',
    { name: 'Smoke read only', scopes: ['resources:read'], expiresInDays: 1 },
    tokens.accessToken,
    {},
    201,
  )
).data.data;
await call('/api/v1/projects', 'GET', undefined, undefined, { 'X-API-Key': key.key });
await call(
  '/api/v1/projects',
  'POST',
  { name: 'Forbidden write' },
  undefined,
  { 'X-API-Key': key.key },
  403,
);
await call(`/api/v1/api-keys/${key.id}`, 'DELETE', undefined, tokens.accessToken);
await call('/api/v1/projects', 'GET', undefined, undefined, { 'X-API-Key': key.key }, 401);
await call(`/api/v1/files/${file.id}`, 'DELETE', undefined, tokens.accessToken);
await call(`/api/v1/tasks/${task.id}`, 'DELETE', undefined, tokens.accessToken);
await call(`/api/v1/projects/${project.id}`, 'DELETE', undefined, tokens.accessToken);
tokens = (await call('/api/v1/auth/refresh', 'POST', { refreshToken: tokens.refreshToken })).data
  .data;
writeFileSync('.secrets/live-smoke.json', JSON.stringify({ email, password, ...tokens }), {
  mode: 0o600,
});
await call('/api/v1/auth/logout', 'POST', undefined, tokens.accessToken);
await call('/api/v1/projects', 'GET', undefined, tokens.accessToken, {}, 401);
console.log(
  'Live auth,CRUD,pagination/search,Storage bytes,scoped key/revocation,refresh/logout verified. Resource fixtures deleted; verification account remains private.',
);
