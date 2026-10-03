import { afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { localDatabase, localEnvironment, MemoryObjectStore } from '../scripts/local-runtime';
const { pg, db } = await localDatabase(true);
const secret = () => randomBytes(32).toString('base64url');
export const env = localEnvironment(db, new MemoryObjectStore(), {
  JWT_SECRET: secret(),
  PASSWORD_PEPPER: secret(),
  IP_HASH_SECRET: secret(),
});
env.ENVIRONMENT = 'test';
afterAll(() => pg.close());
export function createExecutionContext() {
  return { waitUntil(_promise: Promise<unknown>) {}, passThroughOnException() {}, props: {} };
}
export async function waitOnExecutionContext(_context: unknown) {}
