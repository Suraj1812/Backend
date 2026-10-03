import { describe, expect, it } from 'vitest';
import { decodeJwt, SignJWT } from 'jose';
import { randomToken } from '../src/core/crypto';
import type { Config } from '../src/core/types';
import { hashPassword, verifyPassword } from '../src/modules/auth/password';
import { issueAccessToken, verifyAccessToken } from '../src/modules/auth/tokens';
import { registerSchema } from '../src/modules/auth/validation';
import { createApiKeySchema } from '../src/modules/api-keys/validation';

const config = (): Config => ({
  environment: 'test',
  allowedOrigins: [],
  jwtIssuer: 'auth-tests',
  jwtAudience: 'test-client',
  jwtSecret: randomToken(),
  passwordPepper: randomToken(),
  ipHashSecret: randomToken(),
  accessTokenTtl: 900,
  sessionTtl: 604800,
  maxJsonBytes: 65536,
  maxUploadBytes: 5242880,
  allowRegistration: true,
  auditRetentionDays: 90,
});

describe('password verification', () => {
  it('uses a unique salt and verifies without accepting a different password or pepper', async () => {
    const password = randomToken();
    const pepper = randomToken();
    const first = await hashPassword(password, pepper);
    const second = await hashPassword(password, pepper);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first, pepper)).toBe(true);
    expect(await verifyPassword(`${password}!`, first, pepper)).toBe(false);
    expect(await verifyPassword(password, first, randomToken())).toBe(false);
  });

  it('fails closed for missing hashes, malformed hashes, and unrecognized work factors', async () => {
    const password = randomToken();
    const pepper = randomToken();
    expect(await verifyPassword(password, undefined, pepper)).toBe(false);
    expect(await verifyPassword(password, 'invalid', pepper)).toBe(false);
    const hash = await hashPassword(password, pepper);
    expect(
      await verifyPassword(
        password,
        hash.replace('m=19456,t=2,p=1', 'm=999999999,t=2,p=1'),
        pepper,
      ),
    ).toBe(false);
  });
});

describe('access JWT policy', () => {
  it('issues and verifies a session-bound access token without embedding mutable roles', async () => {
    const settings = config();
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const result = await issueAccessToken(
      settings,
      userId,
      sessionId,
      new Date(Date.now() + 3600_000).toISOString(),
    );
    expect(result.expiresIn).toBe(900);
    expect(await verifyAccessToken(settings, result.accessToken)).toEqual({ userId, sessionId });
    expect(decodeJwt(result.accessToken)).not.toHaveProperty('role');
  });

  it('caps access expiry at the absolute session expiry and rejects expired sessions', async () => {
    const settings = config();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = await issueAccessToken(
      settings,
      crypto.randomUUID(),
      crypto.randomUUID(),
      expiresAt,
    );
    expect(result.expiresIn).toBeLessThanOrEqual(60);
    expect(decodeJwt(result.accessToken).exp).toBe(Math.floor(Date.parse(expiresAt) / 1000));
    await expect(
      issueAccessToken(
        settings,
        crypto.randomUUID(),
        crypto.randomUUID(),
        new Date(0).toISOString(),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token signed with another secret', async () => {
    const settings = config();
    const token = await issueAccessToken(
      settings,
      crypto.randomUUID(),
      crypto.randomUUID(),
      new Date(Date.now() + 3600_000).toISOString(),
    );
    await expect(
      verifyAccessToken({ ...settings, jwtSecret: randomToken() }, token.accessToken),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(['audience', 'issuer', 'type', 'algorithm', 'session', 'nonce', 'expired'] as const)(
    'rejects an invalid %s',
    async (invalid) => {
      const settings = config();
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        sid: invalid === 'session' ? 'not-a-session' : crypto.randomUUID(),
        kind: 'access',
      })
        .setProtectedHeader({
          typ: invalid === 'type' ? 'JWT' : 'at+jwt',
          alg: invalid === 'algorithm' ? 'HS384' : 'HS256',
        })
        .setIssuer(invalid === 'issuer' ? 'another-issuer' : settings.jwtIssuer)
        .setAudience(invalid === 'audience' ? 'another-client' : settings.jwtAudience)
        .setSubject(crypto.randomUUID())
        .setJti(invalid === 'nonce' ? 'not-a-token-id' : crypto.randomUUID())
        .setIssuedAt(now - 10)
        .setExpirationTime(invalid === 'expired' ? now - 1 : now + 60)
        .sign(new TextEncoder().encode(settings.jwtSecret));
      await expect(verifyAccessToken(settings, token)).rejects.toMatchObject({
        status: 401,
        code: 'INVALID_CREDENTIALS',
      });
    },
  );
});

describe('authentication input boundaries', () => {
  it('requires at least 15 password characters for this single-factor flow', () => {
    const input = { email: 'learner@example.com', name: 'Learner', password: 'a'.repeat(14) };
    expect(registerSchema.safeParse(input).success).toBe(false);
    expect(registerSchema.safeParse({ ...input, password: 'a'.repeat(15) }).success).toBe(true);
  });

  it('normalizes email but preserves the exact password and rejects role mass assignment', () => {
    const input = {
      email: '  Learner@Example.com ',
      name: 'Learner',
      password: ` ${randomToken()} `,
    };
    const parsed = registerSchema.parse(input);
    expect(parsed.email).toBe('learner@example.com');
    expect(parsed.password).toBe(input.password);
    expect(registerSchema.safeParse({ ...input, role: 'admin' }).success).toBe(false);
  });

  it('rejects API-key privilege injection, duplicates, and unbounded expiration', () => {
    expect(createApiKeySchema.safeParse({ name: 'Server', scopes: ['admin:*'] }).success).toBe(
      false,
    );
    expect(
      createApiKeySchema.safeParse({ name: 'Server', scopes: ['files:read', 'files:read'] })
        .success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: 'Server', scopes: ['files:read'], expiresInDays: 91 })
        .success,
    ).toBe(false);
  });
});
