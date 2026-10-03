import { z } from 'zod';
import { text } from '../../core/validation';
import { paginationShape } from '../../core/pagination';

const fields = {
  name: text(120),
  description: z.union([text(2000), z.literal('')]),
  status: z.enum(['active', 'archived']),
};
export const createProjectSchema = z
  .object({
    ...fields,
    description: fields.description.default(''),
    status: fields.status.default('active'),
  })
  .strict();
export const updateProjectSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export const listProjectSchema = z
  .object({
    ...paginationShape,
    sort: z.enum(['createdAt', 'updatedAt', 'name']).default('createdAt'),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();
