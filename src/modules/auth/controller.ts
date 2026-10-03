import type { AppContext } from '../../core/types';
import { success } from '../../core/response';
import { json, resourceId } from '../../core/validation';
import { loginSchema, refreshSchema, registerSchema } from './validation';
import * as service from './service';

export const register = async (c: AppContext) =>
  success(c, await service.register(c, json(c, registerSchema)), 201);
export const login = async (c: AppContext) =>
  success(c, await service.login(c, json(c, loginSchema)));
export const refresh = async (c: AppContext) =>
  success(c, await service.refresh(c, json(c, refreshSchema).refreshToken));
export const logout = async (c: AppContext) => success(c, await service.logout(c));
export const me = (c: AppContext) => success(c, { user: c.get('principal').user });
export const listSessions = async (c: AppContext) => success(c, await service.sessions(c));
export const revokeSession = async (c: AppContext) =>
  success(c, await service.revokeOwnedSession(c, resourceId(c)));
