import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { SubstitutionsService } from './substitutions.service';
import { AuthUser, CurrentUser, Role, Roles } from '../../common/auth';
import { SubstitutionKind } from '../../entities/substitution.entity';

class CreateSubstitutionDto {
  @IsString() @IsNotEmpty()
  sessionId: string;

  @IsString() @IsNotEmpty()
  substituteInstructorId: string;

  @IsIn([SubstitutionKind.NORMAL, SubstitutionKind.EMERGENCY])
  kind: SubstitutionKind;

  @IsString() @IsNotEmpty()
  reason: string;
}

class RejectDto {
  @IsString() @IsNotEmpty()
  reason: string;
}

@Controller('substitutions')
export class SubstitutionsController {
  constructor(private readonly svc: SubstitutionsService) {}

  @Post()
  @Roles(Role.COURSE_LEAD, Role.ADMIN)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSubstitutionDto) {
    return this.svc.create(actor, dto);
  }

  @Post(':id/confirm')
  @Roles(Role.COURSE_LEAD, Role.SAFETY_OFFICER, Role.ADMIN)
  confirm(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.svc.confirm(actor, id);
  }

  @Post(':id/reject')
  @Roles(Role.COURSE_LEAD, Role.SAFETY_OFFICER, Role.ADMIN)
  reject(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.svc.reject(actor, id, dto.reason);
  }

  @Get(':id')
  @Roles(Role.COURSE_LEAD, Role.SAFETY_OFFICER, Role.ADMIN)
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  /** 代课全程追溯：申请 → 审核 → 凭证 → 进出回执 → 异常处置 */
  @Get(':id/trace')
  @Roles(Role.COURSE_LEAD, Role.SAFETY_OFFICER, Role.ADMIN)
  trace(@Param('id') id: string) {
    return this.svc.trace(id);
  }
}
