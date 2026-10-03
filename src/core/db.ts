import type { User } from './types';
export interface UserRow {
  id: string; email: string; name: string; password_hash: string; role: 'member' | 'admin';
  disabled: number; created_at: string; updated_at: string;
}
export const userDto = (row: UserRow): User => ({ id: row.id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at });
