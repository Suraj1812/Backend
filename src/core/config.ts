import { z } from 'zod';
import type { Config, Env } from './types';

const number = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const schema = z.object({
  ENVIRONMENT: z.enum(['development', 'test', 'production']),
  ALLOWED_ORIGINS: z.string().min(1),
  JWT_ISSUER: z.string().min(1).max(200),
  JWT_AUDIENCE: z.string().min(1).max(200),
  JWT_SECRET: z.string().min(43).max(1024),
  PASSWORD_PEPPER: z.string().min(43).max(1024),
  IP_HASH_SECRET: z.string().min(43).max(1024),
  ACCESS_TOKEN_TTL_SECONDS: number(60, 900),
  SESSION_TTL_SECONDS: number(3600, 2592000),
  MAX_JSON_BYTES: number(1024, 1048576),
  MAX_UPLOAD_BYTES: number(1024, 10485760),
  ALLOW_REGISTRATION: z.enum(['true', 'false']),
  AUDIT_RETENTION_DAYS: number(1, 3650),
});

export function getConfig(env: Env): Config {
  const result = schema.safeParse(env);
  // Do not print schema errors: they can contain values of secrets.
  if (!result.success) throw new Error('Invalid environment configuration');
  const v = result.data;
  const allowedOrigins = v.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    const localFrontend =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.origin !== origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      (v.ENVIRONMENT === 'production' &&
        ((!localFrontend && url.protocol !== 'https:') ||
          url.hostname === 'example.com' ||
          url.hostname.endsWith('.example.com')))
    ) {
      throw new Error('Invalid CORS origin configuration');
    }
  }
  if (new Set([v.JWT_SECRET, v.PASSWORD_PEPPER, v.IP_HASH_SECRET]).size !== 3)
    throw new Error('Secrets must be distinct');
  if (v.SESSION_TTL_SECONDS <= v.ACCESS_TOKEN_TTL_SECONDS)
    throw new Error('Session TTL must exceed access TTL');
  return {
    environment: v.ENVIRONMENT,
    allowedOrigins,
    jwtIssuer: v.JWT_ISSUER,
    jwtAudience: v.JWT_AUDIENCE,
    jwtSecret: v.JWT_SECRET,
    passwordPepper: v.PASSWORD_PEPPER,
    ipHashSecret: v.IP_HASH_SECRET,
    accessTokenTtl: v.ACCESS_TOKEN_TTL_SECONDS,
    sessionTtl: v.SESSION_TTL_SECONDS,
    maxJsonBytes: v.MAX_JSON_BYTES,
    maxUploadBytes: v.MAX_UPLOAD_BYTES,
    allowRegistration: v.ALLOW_REGISTRATION === 'true',
    auditRetentionDays: v.AUDIT_RETENTION_DAYS,
  };
}
