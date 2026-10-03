import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../core/types';
import { getConfig } from '../core/config';
import { ApiError } from '../core/errors';
import { hmac } from '../core/crypto';
import { log } from '../core/logger';

const allowedHeaders = ['authorization', 'content-type', 'x-api-key', 'x-file-name'];
const allowedMethods = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

export const security = createMiddleware<AppEnv>(async (c, next) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  c.header('Cache-Control', 'no-store');
  const config = getConfig(c.env);
  c.set('config', config);
  if (config.environment === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (new URL(c.req.url).protocol !== 'https:')
      throw new ApiError(400, 'HTTPS_REQUIRED', 'HTTPS is required');
  }
  c.header('Vary', 'Origin');
  const origin = c.req.header('Origin');
  if (origin) {
    if (!config.allowedOrigins.includes(origin))
      throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed');
    c.header('Access-Control-Allow-Origin', origin);
    c.header(
      'Access-Control-Expose-Headers',
      'X-Request-Id, Retry-After, Location, Content-Disposition',
    );
  }
  // The Supabase ingress appends forwarding hops. Use the rightmost address,
  // never a client-supplied prefix. Missing IP shares a conservative fallback.
  const forwarded = c.req.header('X-Forwarded-For')?.split(',').at(-1)?.trim();
  const ip = forwarded && /^[0-9a-f:.]{3,64}$/i.test(forwarded) ? forwarded : 'unknown';
  c.set('ipHash', await hmac(ip, config.ipHashSecret));
  let global: { success: boolean };
  try {
    global = await c.env.API_RATE_LIMITER.limit({ key: `ip:${c.get('ipHash')}` });
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Request protection is temporarily unavailable');
  }
  if (!global.success)
    throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly', undefined, {
      'Retry-After': '60',
    });
  if (c.req.method === 'OPTIONS') {
    const method = c.req.header('Access-Control-Request-Method');
    const headers = (c.req.header('Access-Control-Request-Headers') ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      !origin ||
      !method ||
      !allowedMethods.includes(method) ||
      headers.some((h) => !allowedHeaders.includes(h))
    ) {
      throw new ApiError(
        403,
        'PREFLIGHT_REJECTED',
        'The requested CORS method or headers are not allowed',
      );
    }
    c.header('Access-Control-Allow-Methods', allowedMethods.join(', '));
    c.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
    c.header('Access-Control-Max-Age', '600');
    return c.body(null, 204);
  }
  if (c.req.method === 'POST' && /^\/api\/v1\/auth\/(register|login|refresh)$/.test(c.req.path)) {
    let result: { success: boolean };
    try {
      result = await c.env.AUTH_RATE_LIMITER.limit({ key: `ip:${c.get('ipHash')}` });
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable');
    }
    if (!result.success)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many authentication attempts. Try again shortly',
        undefined,
        { 'Retry-After': '60' },
      );
  }
  try {
    await next();
  } finally {
    log('info', {
      event: 'request',
      requestId,
      method: c.req.method,
      route: c.req.routePath || 'unmatched',
      status: c.res.status,
      durationMs: Date.now() - start,
    });
  }
});

export const boundedBody = createMiddleware<AppEnv>(async (c, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return next();
  if (c.req.header('Content-Encoding') && c.req.header('Content-Encoding') !== 'identity') {
    throw new ApiError(415, 'UNSUPPORTED_ENCODING', 'Compressed request bodies are not supported');
  }
  const upload = c.req.method === 'POST' && c.req.path === '/api/v1/files';
  const limit = upload ? c.get('config').maxUploadBytes : c.get('config').maxJsonBytes;
  const length = c.req.header('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `The request body exceeds ${limit} bytes`);
  const reader = c.req.raw.body?.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `The request body exceeds ${limit} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (
    total > 0 &&
    !upload &&
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(c.req.header('Content-Type') ?? '')
  ) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json');
  }
  if (c.req.method === 'DELETE' && total > 0)
    throw new ApiError(400, 'UNEXPECTED_BODY', 'DELETE requests must not contain a body');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  c.set('bodyBytes', bytes);
  await next();
});
