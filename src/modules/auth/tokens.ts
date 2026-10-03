import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../../core/types';
import { ApiError } from '../../core/errors';

export async function issueAccessToken(config: Config, userId: string, sessionId: string, sessionExpiresAt: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(issuedAt + config.accessTokenTtl, Math.floor(Date.parse(sessionExpiresAt) / 1000));
  if (expiresAt <= issuedAt) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Your session has expired');
  const accessToken = await new SignJWT({ sid: sessionId, kind: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(config.jwtIssuer).setAudience(config.jwtAudience).setSubject(userId)
    .setIssuedAt(issuedAt).setExpirationTime(expiresAt).setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(config.jwtSecret));
  return { accessToken, expiresIn: expiresAt - issuedAt };
}

export async function verifyAccessToken(config: Config, token: string): Promise<{ userId: string; sessionId: string }> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), {
      algorithms: ['HS256'], issuer: config.jwtIssuer, audience: config.jwtAudience,
      typ: 'at+jwt', requiredClaims: ['sub', 'exp', 'iat', 'jti'], maxTokenAge: config.accessTokenTtl,
    });
    if (payload.kind !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(payload.sub) || !/^[0-9a-f-]{36}$/i.test(payload.sid)) throw new Error('Invalid access claims');
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Authentication credentials are invalid or expired', undefined, { 'WWW-Authenticate': 'Bearer' });
  }
}
