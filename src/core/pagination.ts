import { z } from 'zod';
import type { AppContext } from './types';
import { parse, text } from './validation';
import { ApiError } from './errors';

export const paginationShape = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: text(100).optional(),
};
export interface PageQuery { page: number; limit: number; order: 'asc' | 'desc'; sort: string; q?: string }
export function query<T extends z.ZodType>(c: AppContext, schema: T): z.infer<T> {
  const params = new URL(c.req.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in raw) throw new ApiError(422, 'VALIDATION_ERROR', 'Duplicate query parameters are not allowed');
    raw[key] = value;
  }
  return parse(schema, raw);
}
export const pageMeta = (total: number, input: {page: number; limit: number}) => ({
  page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit),
  hasNext: input.page * input.limit < total, hasPrevious: input.page > 1,
});
export const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
