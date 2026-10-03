import { z } from 'zod';
import { text } from '../../core/validation';

const email = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());
const password = z
  .string()
  .min(15)
  .max(128)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 256,
    'Password must use at most 256 UTF-8 bytes',
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'Password must not contain control characters',
  );
export const registerSchema = z.strictObject({ email, password, name: text(80) });
export const loginSchema = z.strictObject({ email, password });
export const refreshSchema = z.strictObject({
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid refresh token format'),
});
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
