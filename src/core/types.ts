import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  API_RATE_LIMITER: RateLimit;
  AUTH_RATE_LIMITER: RateLimit;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  JWT_SECRET: string;
  PASSWORD_PEPPER: string;
  IP_HASH_SECRET: string;
  ACCESS_TOKEN_TTL_SECONDS: string;
  SESSION_TTL_SECONDS: string;
  MAX_JSON_BYTES: string;
  MAX_UPLOAD_BYTES: string;
  ALLOW_REGISTRATION: string;
  AUDIT_RETENTION_DAYS: string;
}

export interface Config {
  environment: 'development' | 'test' | 'production';
  allowedOrigins: string[];
  jwtIssuer: string;
  jwtAudience: string;
  jwtSecret: string;
  passwordPepper: string;
  ipHashSecret: string;
  accessTokenTtl: number;
  sessionTtl: number;
  maxJsonBytes: number;
  maxUploadBytes: number;
  allowRegistration: boolean;
  auditRetentionDays: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'member' | 'admin';
  createdAt: string;
  updatedAt: string;
}

export type Scope = 'resources:read' | 'resources:write' | 'files:read' | 'files:write';
export interface Principal {
  user: User;
  method: 'bearer' | 'api-key';
  sessionId?: string;
  apiKeyId?: string;
  scopes: Scope[];
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    config: Config;
    principal: Principal;
    bodyBytes: Uint8Array;
    ipHash: string;
  };
};
export type AppContext = Context<AppEnv>;
