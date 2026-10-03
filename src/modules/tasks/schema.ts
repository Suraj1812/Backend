import { z } from 'zod';
import { text, idSchema } from '../../core/validation';
import { paginationShape } from '../../core/pagination';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, 'Use a valid calendar date');
const fields = {
  title: text(200),
  description: z.union([text(4000), z.literal('')]),
  status: z.enum(['todo', 'in_progress', 'done']),
  priority: z.enum(['low', 'medium', 'high']),
  projectId: idSchema.nullable(),
  dueDate: date.nullable(),
};
export const createTaskSchema = z
  .object({
    ...fields,
    description: fields.description.default(''),
    status: fields.status.default('todo'),
    priority: fields.priority.default('medium'),
    projectId: fields.projectId.default(null),
    dueDate: fields.dueDate.default(null),
  })
  .strict();
export const updateTaskSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export const listTaskSchema = z
  .object({
    ...paginationShape,
    sort: z.enum(['createdAt', 'updatedAt', 'title', 'dueDate']).default('createdAt'),
    status: z.enum(['todo', 'in_progress', 'done']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    projectId: idSchema.optional(),
  })
  .strict();
