import { serve } from '@hono/node-server';
import { app } from '../src/index';
import {
  localDatabase,
  localEnvironment,
  LocalObjectStore,
  readLocalSecrets,
} from './local-runtime';
const { pg, db } = await localDatabase();
const env = localEnvironment(db, new LocalObjectStore(), await readLocalSecrets());
const server = serve({
  fetch: (request) => app.fetch(request, env),
  hostname: '127.0.0.1',
  port: 8787,
});
console.log(
  'Local PostgreSQL API: http://localhost:8787/docs (PGlite; no Docker or account required)',
);
process.on('SIGINT', () =>
  server.close(async () => {
    await pg.close();
    process.exit(0);
  }),
);
