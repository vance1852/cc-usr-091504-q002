import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

/** 系统角色：课程负责人 / 校园安全人员 / 机构管理员 / 门岗 / 导师 / 系统管理员 */
export enum Role {
  ADMIN = 'ADMIN',
  COURSE_LEAD = 'COURSE_LEAD',
  SAFETY_OFFICER = 'SAFETY_OFFICER',
  ORG_ADMIN = 'ORG_ADMIN',
  GATE_GUARD = 'GATE_GUARD',
  INSTRUCTOR = 'INSTRUCTOR',
}

export interface AuthUser {
  sub: string;
  username: string;
  role: Role;
  /** ORG_ADMIN 所属机构；用于跨机构数据隔离 */
  orgId?: string | null;
  /** INSTRUCTOR 账号关联的导师档案 */
  instructorId?: string | null;
}

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('缺少访问令牌');
    try {
      req.user = await this.jwt.verifyAsync<AuthUser>(token);
    } catch {
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = ctx.switchToHttp().getRequest();
    if (!user) throw new UnauthorizedException();
    if (!required.includes(user.role)) {
      throw new ForbiddenException('当前角色无权执行此操作');
    }
    return true;
  }
}
