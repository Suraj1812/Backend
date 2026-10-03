import { auditStatement } from '../../core/audit';
import { userDto, type UserRow } from '../../core/db';
import { likePattern, type PageQuery } from '../../core/pagination';
import type { AppContext } from '../../core/types';
import { ApiError } from '../../core/errors';

export async function updateProfile(c: AppContext, name: string) {
  const id = c.get('principal').user.id;
  const [result] = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET name = ?, updated_at = ? WHERE id = ? AND disabled = 0 RETURNING *',
    ).bind(name, new Date().toISOString(), id),
    auditStatement(c, 'users.profile_updated', 'users', id),
  ]);
  if (!result.results[0])
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'This account is no longer active');
  return userDto(result.results[0] as unknown as UserRow);
}

export async function listUsers(c: AppContext, input: PageQuery & { role?: 'member' | 'admin' }) {
  const filters = ['1 = 1'];
  const values: (string | number)[] = [];
  if (input.role) {
    filters.push('role = ?');
    values.push(input.role);
  }
  if (input.q) {
    filters.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    values.push(likePattern(input.q), likePattern(input.q));
  }
  const sort = { createdAt: 'created_at', name: 'name', email: 'email' }[input.sort];
  if (!sort) throw new Error('Unconfigured user sort field');
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE ${filters.join(' AND ')}`).bind(
      ...values,
    ),
    c.env.DB.prepare(
      `SELECT * FROM users WHERE ${filters.join(' AND ')} ORDER BY ${sort} ${input.order === 'asc' ? 'ASC' : 'DESC'}, id ASC LIMIT ? OFFSET ?`,
    ).bind(...values, input.limit, (input.page - 1) * input.limit),
    auditStatement(c, 'users.list', 'users'),
  ]);
  return {
    data: (rows.results as unknown as UserRow[]).map(userDto),
    total: Number((count.results[0] as { total: number }).total),
  };
}
