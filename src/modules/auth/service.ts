import { audit, auditStatement } from '../../core/audit';
import { hmac, randomToken, sha256 } from '../../core/crypto';
import { userDto, type UserRow } from '../../core/db';
import { ApiError } from '../../core/errors';
import type { AppContext, User } from '../../core/types';
import { hashPassword, verifyPassword } from './password';
import { issueAccessToken } from './tokens';
import {
  findRefresh,
  findUserByEmail,
  insertUser,
  listSessions,
  reclaimSessionStatements,
  revokeSession,
  rotateStatements,
  rotationAuditStatement,
  sessionStatements,
  type SessionRow,
} from './repository';
import type { LoginInput, RegisterInput } from './validation';

const invalidCredentials = () =>
  new ApiError(
    401,
    'INVALID_CREDENTIALS',
    'Authentication credentials are invalid or expired',
    undefined,
    { 'WWW-Authenticate': 'Bearer' },
  );

async function accountLimit(c: AppContext, email: string) {
  const accountHash = await hmac(email, c.get('config').ipHashSecret);
  let permitted: boolean;
  try {
    permitted = (await c.env.AUTH_RATE_LIMITER.limit({ key: `account:${accountHash}` })).success;
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable');
  }
  if (!permitted)
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'Too many authentication attempts; try again later',
      undefined,
      { 'Retry-After': '60' },
    );
}

function setActor(c: AppContext, user: User, sessionId?: string) {
  c.set('principal', { user, method: 'bearer', sessionId, scopes: [] });
}

async function sessionData(
  c: AppContext,
  user: User,
  sessionId: string,
  refreshToken: string,
  expiresAt: string,
) {
  const token = await issueAccessToken(c.get('config'), user.id, sessionId, expiresAt);
  return {
    user,
    ...token,
    refreshToken,
    tokenType: 'Bearer' as const,
    sessionExpiresAt: expiresAt,
  };
}

async function newSession(c: AppContext, user: User) {
  const now = new Date();
  const session: SessionRow = {
    id: crypto.randomUUID(),
    user_id: user.id,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + c.get('config').sessionTtl * 1000).toISOString(),
    revoked_at: null,
    last_seen_at: now.toISOString(),
  };
  const refreshToken = randomToken();
  return {
    session,
    refreshToken,
    statements: [
      ...reclaimSessionStatements(c, user.id, session.created_at),
      ...sessionStatements(c.env.DB, session, await sha256(refreshToken)),
    ],
  };
}

export async function register(c: AppContext, input: RegisterInput) {
  if (!c.get('config').allowRegistration)
    throw new ApiError(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
  await accountLimit(c, input.email);
  const passwordHash = await hashPassword(input.password, c.get('config').passwordPepper);
  const now = new Date().toISOString();
  const row: UserRow = {
    id: crypto.randomUUID(),
    email: input.email,
    name: input.name,
    password_hash: passwordHash,
    role: 'member',
    disabled: 0,
    created_at: now,
    updated_at: now,
  };
  const user = userDto(row);
  const { session, refreshToken, statements } = await newSession(c, user);
  setActor(c, user, session.id);
  try {
    await c.env.DB.batch([
      insertUser(c.env.DB, row),
      ...statements,
      auditStatement(c, 'auth.register', 'user', user.id),
    ]);
  } catch (error) {
    // Check the specific unique constraint; other database failures remain errors.
    if (
      error instanceof Error &&
      (error as Error & { code?: string; constraint_name?: string }).code === '23505' &&
      ((error as Error & { constraint_name?: string; constraint?: string }).constraint_name ??
        (error as Error & { constraint?: string }).constraint) === 'users_email_key'
    ) {
      throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
    }
    throw error;
  }
  return sessionData(c, user, session.id, refreshToken, session.expires_at);
}

export async function login(c: AppContext, input: LoginInput) {
  await accountLimit(c, input.email);
  const row = await findUserByEmail(c.env.DB, input.email);
  const valid = await verifyPassword(
    input.password,
    row?.password_hash,
    c.get('config').passwordPepper,
  );
  if (!row || !valid || row.disabled !== 0) {
    await audit(c, 'auth.login_failed', 'session', undefined, {
      accountHash: await hmac(input.email, c.get('config').ipHashSecret),
    });
    throw invalidCredentials();
  }
  const user = userDto(row);
  const { session, refreshToken, statements } = await newSession(c, user);
  setActor(c, user, session.id);
  await c.env.DB.batch([...statements, auditStatement(c, 'auth.login', 'session', session.id)]);
  return sessionData(c, user, session.id, refreshToken, session.expires_at);
}

export async function refresh(c: AppContext, token: string) {
  const oldHash = await sha256(token);
  const row = await findRefresh(c.env.DB, oldHash);
  const now = new Date().toISOString();
  if (!row) throw invalidCredentials();
  const user = userDto(row);
  setActor(c, user, row.session_id);
  if (row.consumed_at) {
    await c.env.DB.batch([
      revokeSession(c.env.DB, row.session_id, now),
      auditStatement(c, 'auth.refresh_replay', 'session', row.session_id),
    ]);
    throw invalidCredentials();
  }
  if (
    row.disabled !== 0 ||
    row.session_revoked_at ||
    row.session_expires_at <= now ||
    row.token_expires_at <= now
  )
    throw invalidCredentials();
  const refreshToken = randomToken();
  const newHash = await sha256(refreshToken);
  // PostgreSQL batch is a single transaction. Only a winning compare-and-set creates a
  // new token, so two simultaneous refreshes cannot both rotate the same token.
  const results = await c.env.DB.batch([
    ...rotateStatements(c.env.DB, oldHash, newHash, row.session_id, now),
    rotationAuditStatement(c, oldHash, newHash, row.session_id, now),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    await c.env.DB.batch([
      revokeSession(c.env.DB, row.session_id, now),
      auditStatement(c, 'auth.refresh_replay', 'session', row.session_id),
    ]);
    throw invalidCredentials();
  }
  return sessionData(c, user, row.session_id, refreshToken, row.session_expires_at);
}

export async function logout(c: AppContext) {
  const { sessionId, user } = c.get('principal');
  if (!sessionId) throw invalidCredentials();
  await c.env.DB.batch([
    revokeSession(c.env.DB, sessionId, new Date().toISOString(), user.id),
    auditStatement(c, 'auth.logout', 'session', sessionId),
  ]);
  return { revoked: true as const };
}

export async function sessions(c: AppContext) {
  const principal = c.get('principal');
  const rows = await listSessions(c.env.DB, principal.user.id, new Date().toISOString());
  return {
    sessions: rows.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      current: row.id === principal.sessionId,
    })),
  };
}

export async function revokeOwnedSession(c: AppContext, id: string) {
  const userId = c.get('principal').user.id;
  const found = await c.env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Session was not found');
  await c.env.DB.batch([
    revokeSession(c.env.DB, id, new Date().toISOString(), userId),
    auditStatement(c, 'auth.session_revoked', 'session', id),
  ]);
  return { revoked: true as const };
}
