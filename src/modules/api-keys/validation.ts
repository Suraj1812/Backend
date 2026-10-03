import { z } from 'zod';
import { text } from '../../core/validation';

export const scopeSchema = z.enum([
  'resources:read',
  'resources:write',
  'files:read',
  'files:write',
]);
export const createApiKeySchema = z.strictObject({
  name: text(80),
  scopes: z
    .array(scopeSchema)
    .min(1)
    .max(4)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'Scopes must be unique'),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
