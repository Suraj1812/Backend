import { derive } from '../../core/argon2';
import { createPasswordHelpers } from './password-core';

export { PASSWORD_FORMAT } from './password-core';
export const { hashPassword, verifyPassword } = createPasswordHelpers(derive);
