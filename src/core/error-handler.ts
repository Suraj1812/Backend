import type { ErrorHandler } from 'hono';
import type { AppEnv } from './types';
import { ApiError } from './errors';
import { log } from './logger';

export const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
  const requestId = c.get('requestId') || crypto.randomUUID();
  if (error instanceof ApiError) {
    for (const [key, value] of Object.entries(error.headers ?? {})) c.header(key, value);
    log('warn', { event: 'api_error', requestId, status: error.status, code: error.code });
    return c.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        requestId,
      },
      error.status,
    );
  }
  // A relation could disappear between validation and the atomic database write.
  if ((error as Error & { code?: string }).code === '23503') {
    return c.json(
      {
        success: false,
        error: {
          code: 'RELATION_CONFLICT',
          message: 'A related resource changed. Refresh and try again',
        },
        requestId,
      },
      409,
    );
  }
  const databaseCode = (error as Error & { code?: string }).code;
  log('error', {
    event: 'internal_error',
    requestId,
    errorType: error.name,
    ...(typeof databaseCode === 'string' && /^[0-9A-Z]{5}$/.test(databaseCode)
      ? { databaseCode }
      : {}),
  });
  const configFailure = !c.get('config');
  return c.json(
    {
      success: false,
      error: {
        code: configFailure ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
        message: configFailure
          ? 'The service is temporarily unavailable'
          : 'An unexpected error occurred',
      },
      requestId,
    },
    configFailure ? 503 : 500,
  );
};
