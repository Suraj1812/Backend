import type { AppContext } from '../../core/types';
import { success } from '../../core/response';
import { json, resourceId } from '../../core/validation';
import { createApiKeySchema } from './validation';
import * as service from './service';

export const list = async (c: AppContext) => success(c, await service.list(c));
export const create = async (c: AppContext) =>
  success(c, await service.create(c, json(c, createApiKeySchema)), 201);
export const revoke = async (c: AppContext) => success(c, await service.revoke(c, resourceId(c)));
