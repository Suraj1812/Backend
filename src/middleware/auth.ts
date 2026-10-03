import { createMiddleware } from 'hono/factory';
import { ApiError } from '../core/errors';
import { sha256 } from '../core/crypto';
import { userDto, type UserRow } from '../core/db';
import type { AppContext, AppEnv, Principal, Scope } from '../core/types';
import { findApiKeyUser } from '../modules/api-keys/repository';
import { scopeSchema } from '../modules/api-keys/validation';
import { verifyAccessToken } from '../modules/auth/tokens';

const unauthorized = () =>
  new ApiError(
    401,
    'INVALID_CREDENTIALS',
    'Authentication credentials are invalid or expired',
    undefined,
    { 'WWW-Authenticate': 'Bearer' },
  );

async function authenticateBearer(c: AppContext, header: string): Promise<Principal> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  if (!match || header.length > 4096) throw unauthorized();
  const { userId, sessionId } = await verifyAccessToken(c.get('config'), match[1]!);
  // Roles are read from PostgreSQL for every request. JWT claims cannot preserve an old
  // admin role, bypass a disabled account, or outlive session revocation.
  const user = await c.env.DB.prepare(
    `SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id
    WHERE u.id = ? AND s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0`,
  )
    .bind(userId, sessionId, new Date().toISOString())
    .first<UserRow>();
  if (!user) throw unauthorized();
  return { user: userDto(user), method: 'bearer', sessionId, scopes: [] };
}

async function authenticateApiKey(c: AppContext, key: string): Promise<Principal> {
  if (!/^ak_[A-Za-z0-9_-]{43}$/.test(key)) throw unauthorized();
  const row = await findApiKeyUser(c.env.DB, await sha256(key));
  if (
    !row ||
    row.disabled !== 0 ||
    row.api_key_revoked_at ||
    row.api_key_expires_at <= new Date().toISOString()
  )
    throw unauthorized();
  let scopes: Scope[];
  try {
    const values: unknown = JSON.parse(row.api_key_scopes);
    scopes = scopeSchema.array().min(1).max(4).parse(values);
  } catch {
    throw unauthorized();
  }
  return { user: userDto(row), method: 'api-key', apiKeyId: row.api_key_id, scopes };
}

async function authenticate(c: AppContext, bearerOnly: boolean) {
  const authorization = c.req.header('Authorization');
  const apiKey = c.req.header('X-API-Key');
  if (authorization && apiKey)
    throw new ApiError(400, 'AMBIGUOUS_CREDENTIALS', 'Use one authentication method per request');
  if (!authorization && (!apiKey || bearerOnly)) throw unauthorized();
  const principal = authorization
    ? await authenticateBearer(c, authorization)
    : await authenticateApiKey(c, apiKey!);
  c.set('principal', principal);
  let allowed: boolean;
  try {
    allowed = (await c.env.API_RATE_LIMITER.limit({ key: `user:${principal.user.id}` })).success;
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable');
  }
  if (!allowed)
    throw new ApiError(429, 'RATE_LIMITED', 'Too many requests; try again later', undefined, {
      'Retry-After': '60',
    });
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  await authenticate(c, false);
  await next();
});
export const requireBearer = createMiddleware<AppEnv>(async (c, next) => {
  await authenticate(c, true);
  await next();
});

export const requireRole = (...roles: Array<'member' | 'admin'>) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw unauthorized();
    if (!roles.includes(principal.user.role))
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    await next();
  });

export const requireScope = (scope: Scope) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw unauthorized();
    if (principal.method === 'api-key' && !principal.scopes.includes(scope))
      throw new ApiError(403, 'INSUFFICIENT_SCOPE', `This API key requires the ${scope} scope`);
    await next();
  });
