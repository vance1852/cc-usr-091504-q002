import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DbService } from '../database/database.service';
import { Actor, Role } from '../domain';
import { ROLES_KEY } from './roles.decorator';
import { ClockService } from './clock.service';

declare module 'express' {
  interface Request {
    actor?: Actor;
    now?: number;
  }
}

/**
 * 极简身份承载：调用方在 X-Actor-User-Id 头中给出用户 ID，
 * 守卫从 users 表加载其角色与机构归属，注入 request.actor。
 * （测试与内部系统场景；生产可替换为会话/JWT，权限判定逻辑不变。）
 */
@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
    private readonly clock: ClockService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.now = this.clock.now(req.headers['x-now-ms']);

    const userId = req.headers['x-actor-user-id'];
    if (typeof userId !== 'string' || !userId) {
      throw new UnauthorizedException('missing X-Actor-User-Id');
    }
    const row = this.db.db
      .prepare(`SELECT * FROM users WHERE id = ? AND active = 1`)
      .get(userId) as
      | {
          id: string;
          display_name: string;
          role: Role;
          agency_id: string | null;
          mentor_id: string | null;
        }
      | undefined;
    if (!row) throw new UnauthorizedException('unknown or inactive user');

    req.actor = {
      userId: row.id,
      role: row.role,
      agencyId: row.agency_id ?? undefined,
      displayName: row.display_name,
    } as Actor & { mentorId?: string };
    (req.actor as Record<string, unknown>).mentorId = row.mentor_id ?? undefined;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0 && !required.includes(row.role)) {
      throw new ForbiddenException(
        `role ${row.role} may not access this resource (need one of: ${required.join(', ')})`,
      );
    }
    return true;
  }
}
