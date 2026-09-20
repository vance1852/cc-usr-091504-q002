import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { PassesService } from './passes.service';
import { AuthUser, CurrentUser, Role, Roles } from '../../common/auth';
import { GateDirection } from '../../entities/gate-event.entity';

class GateVerifyDto {
  @IsString() @IsNotEmpty()
  token: string;

  @IsIn([GateDirection.IN, GateDirection.OUT])
  direction: GateDirection;
}

@Controller()
export class PassesController {
  constructor(private readonly svc: PassesService) {}

  /** 课程负责人为课次当前指派导师签发当日通行凭证（明文令牌仅本次返回） */
  @Post('sessions/:id/pass')
  @Roles(Role.COURSE_LEAD, Role.ADMIN)
  issue(@CurrentUser() actor: AuthUser, @Param('id') sessionId: string) {
    return this.svc.issueForSession(actor, sessionId);
  }

  /** 门岗核验：仅返回放行结论与必要身份摘要 */
  @Post('gate/verify')
  @Roles(Role.GATE_GUARD)
  verify(@CurrentUser() guard: AuthUser, @Body() dto: GateVerifyDto) {
    return this.svc.verifyAtGate(guard, dto.token, dto.direction);
  }
}
