import { z } from 'zod';
import type { AppContext } from './types';
import { ApiError } from './errors';

export const idSchema = z.string().uuid();
// Plain text is stored as plain text. Reject markup and control characters; encode in the consuming UI.
export const text = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Use plain text without markup or control characters');

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Some fields are invalid', result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

export function json<T extends z.ZodType>(c: AppContext, schema: T): z.infer<T> {
  const bytes = c.get('bodyBytes');
  if (!bytes?.length) throw new ApiError(400, 'INVALID_JSON', 'A JSON body is required');
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'The request body must contain valid UTF-8 JSON'); }
  return parse(schema, body);
}

export function resourceId(c: AppContext, name = 'id'): string {
  return parse(idSchema, c.req.param(name));
}
