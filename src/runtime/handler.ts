import { app } from '../index';
import type { Env } from '../core/types';
import { getConfig } from '../core/config';
import { hmac } from '../core/crypto';
import { maintenance } from '../core/maintenance';
import { postgresDatabase } from './postgres';
import { PostgresRateLimiter } from './rate-limit';
import { SupabaseObjectStore } from './supabase-storage';
import publicConfiguration from '../../docs/configuration.json';

function environment(values: Record<string, string>): Env {
  const url = values.SUPABASE_URL;
  const databaseUrl = values.SUPABASE_DB_URL;
  const storageSecret = values.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !databaseUrl || !storageSecret || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url))
    throw new Error('Missing Supabase server configuration');
  const { db } = postgresDatabase(databaseUrl);
  const env = {
    ...publicConfiguration.variables,
    ...values,
    JWT_SECRET: values.JWT_SECRET,
    PASSWORD_PEPPER: values.PASSWORD_PEPPER,
    IP_HASH_SECRET: values.IP_HASH_SECRET,
    DB: db,
    FILES: new SupabaseObjectStore(url, storageSecret, db),
    API_RATE_LIMITER: new PostgresRateLimiter(db, 'api', 120),
    AUTH_RATE_LIMITER: new PostgresRateLimiter(db, 'auth', 10),
  } as Env;
  getConfig(env);
  return env;
}

function unavailable() {
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({ event: 'runtime_unavailable', requestId }));
  return Response.json(
    {
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable' },
      requestId,
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      },
    },
  );
}

export function createApiHandler(values: Record<string, string>) {
  let env: Env | undefined;
  return async (request: Request) => {
    try {
      env ??= environment(values);
    } catch {
      return unavailable();
    }
    // Supabase terminates TLS before the Deno isolate and supplies an internal
    // http URL. Reconstruct the trusted hosted origin instead of trusting a
    // client-controlled forwarding-proto header.
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.host = new URL(values.SUPABASE_URL).host;
    return app.fetch(new Request(url, request), env);
  };
}

function operatorResponse(body: Record<string, unknown>, init: ResponseInit = {}) {
  const requestId = typeof body.requestId === 'string' ? body.requestId : crypto.randomUUID();
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Request-Id': requestId,
  }))
    headers.set(name, value);
  if (init.status === 401) headers.set('WWW-Authenticate', 'Bearer');
  return Response.json({ ...body, requestId }, { ...init, headers });
}

export function createMaintenanceHandler(values: Record<string, string>) {
  let env: Env | undefined;
  return async (request: Request) => {
    const secret = values.MAINTENANCE_SECRET;
    const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(
      request.headers.get('Authorization') ?? '',
    )?.[1];
    if (!secret || secret.length < 43) return unavailable();
    // Compare using fixed-length Web Crypto HMAC verification.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const signature = token ? await hmac('maintenance', token) : '';
    const bytes = Uint8Array.from(signature.match(/../g) ?? [], (value) => parseInt(value, 16));
    if (
      !token ||
      !(await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode('maintenance')))
    )
      return operatorResponse(
        {
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Maintenance authorization required' },
          requestId: crypto.randomUUID(),
        },
        { status: 401 },
      );
    if (request.method !== 'POST')
      return operatorResponse(
        {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' },
          requestId: crypto.randomUUID(),
        },
        { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
      );
    if (request.headers.has('Origin'))
      return operatorResponse(
        {
          success: false,
          error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Maintenance is server-only' },
          requestId: crypto.randomUUID(),
        },
        { status: 403 },
      );
    if (
      request.headers.get('Content-Encoding') &&
      request.headers.get('Content-Encoding') !== 'identity'
    )
      return operatorResponse(
        {
          success: false,
          error: { code: 'UNSUPPORTED_ENCODING', message: 'Compressed bodies are not supported' },
        },
        { status: 415 },
      );
    const reader = request.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > 1024) {
            await reader.cancel();
            return operatorResponse(
              {
                success: false,
                error: {
                  code: 'PAYLOAD_TOO_LARGE',
                  message: 'Maintenance body exceeds 1024 bytes',
                },
                requestId: crypto.randomUUID(),
              },
              { status: 413 },
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    if (total) {
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get('Content-Type') ?? '',
        )
      )
        return operatorResponse(
          {
            success: false,
            error: {
              code: 'UNSUPPORTED_MEDIA_TYPE',
              message: 'Use Content-Type: application/json',
            },
          },
          { status: 415 },
        );
      try {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length)
          throw new Error('Unexpected maintenance body');
      } catch {
        return operatorResponse(
          {
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Send an empty body or {}' },
            requestId: crypto.randomUUID(),
          },
          { status: 422 },
        );
      }
    }
    try {
      env ??= environment(values);
      await maintenance(env);
    } catch {
      return unavailable();
    }
    return operatorResponse({
      success: true,
      data: { completed: true },
      requestId: crypto.randomUUID(),
    });
  };
}
