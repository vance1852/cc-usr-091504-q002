import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from './users.service';
import { verifyPassword } from '../../common/crypto.util';
import { AuthUser } from '../../common/auth';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<{ accessToken: string }> {
    const user = await this.users.findByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const payload: AuthUser = {
      sub: user.id,
      username: user.username,
      role: user.role,
      orgId: user.orgId,
      instructorId: user.instructorId,
    };
    return { accessToken: await this.jwt.signAsync(payload) };
  }
}
