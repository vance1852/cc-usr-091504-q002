import { SetMetadata } from '@nestjs/common';
import { Role } from '../domain';

export const ROLES_KEY = 'allowed_roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
