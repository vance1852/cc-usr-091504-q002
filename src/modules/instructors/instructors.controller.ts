import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { InstructorsService } from './instructors.service';
import { AuthUser, CurrentUser, Role, Roles } from '../../common/auth';
import { QualificationType } from '../../entities/qualification.entity';
import { TrainingType } from '../../entities/training.entity';

class CreateInstructorDto {
  @IsString() @IsNotEmpty()
  fullName: string;

  @IsString() @IsNotEmpty()
  idNumber: string;

  @IsString() @IsNotEmpty()
  phone: string;
}

class AddQualificationDto {
  @IsIn(Object.values(QualificationType))
  type: QualificationType;

  @IsString() @IsNotEmpty()
  docNumber: string;

  @IsISO8601()
  issuedAt: string;

  @IsOptional() @IsISO8601()
  expiresAt?: string | null;
}

class ReviewQualificationDto {
  @IsBoolean()
  approve: boolean;
}

class AddTrainingDto {
  @IsIn(Object.values(TrainingType))
  type: TrainingType;

  @IsString() @IsNotEmpty()
  provider: string;

  @IsISO8601()
  completedAt: string;

  @IsOptional() @IsISO8601()
  expiresAt?: string | null;
}

class AddClearanceDto {
  @IsString() @IsNotEmpty()
  gradeLevel: string;

  @IsInt() @Min(0) @Max(6)
  weekday: number;

  @IsString() @IsNotEmpty()
  windowStart: string;

  @IsString() @IsNotEmpty()
  windowEnd: string;
}

class SuspendDto {
  @IsString() @IsNotEmpty()
  reason: string;
}

@Controller()
export class InstructorsController {
  constructor(private readonly svc: InstructorsService) {}

  // ---- 机构维度（机构管理员仅限本机构） ----

  @Get('orgs/:orgId/instructors')
  @Roles(Role.ORG_ADMIN, Role.ADMIN, Role.SAFETY_OFFICER, Role.COURSE_LEAD)
  listByOrg(@CurrentUser() actor: AuthUser, @Param('orgId') orgId: string) {
    return this.svc.listByOrg(actor, orgId);
  }

  @Post('orgs/:orgId/instructors')
  @Roles(Role.ORG_ADMIN, Role.ADMIN)
  create(
    @CurrentUser() actor: AuthUser,
    @Param('orgId') orgId: string,
    @Body() dto: CreateInstructorDto,
  ) {
    return this.svc.create(actor, orgId, dto);
  }

  // ---- 导师档案 ----

  @Get('instructors/:id')
  @Roles(Role.ORG_ADMIN, Role.ADMIN, Role.SAFETY_OFFICER, Role.COURSE_LEAD)
  getOne(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.svc.getOne(actor, id);
  }

  @Post('instructors/:id/qualifications')
  @Roles(Role.ORG_ADMIN, Role.ADMIN)
  addQualification(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddQualificationDto,
  ) {
    return this.svc.addQualification(actor, id, dto);
  }

  @Post('qualifications/:qid/review')
  @Roles(Role.SAFETY_OFFICER, Role.ADMIN)
  reviewQualification(
    @CurrentUser() actor: AuthUser,
    @Param('qid') qid: string,
    @Body() dto: ReviewQualificationDto,
  ) {
    return this.svc.reviewQualification(actor, qid, dto.approve === true);
  }

  @Post('instructors/:id/verify')
  @Roles(Role.SAFETY_OFFICER, Role.ADMIN)
  verify(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.svc.verifyIdentity(actor, id);
  }

  @Post('instructors/:id/suspend')
  @Roles(Role.SAFETY_OFFICER, Role.ADMIN)
  suspend(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: SuspendDto) {
    return this.svc.suspend(actor, id, dto.reason);
  }

  @Post('instructors/:id/reinstate')
  @Roles(Role.SAFETY_OFFICER, Role.ADMIN)
  reinstate(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.svc.reinstate(actor, id);
  }

  @Post('instructors/:id/trainings')
  @Roles(Role.ORG_ADMIN, Role.ADMIN)
  addTraining(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddTrainingDto,
  ) {
    return this.svc.addTraining(actor, id, dto);
  }

  @Post('instructors/:id/clearances')
  @Roles(Role.SAFETY_OFFICER, Role.ADMIN)
  addClearance(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddClearanceDto,
  ) {
    return this.svc.addClearance(actor, id, dto);
  }

  @Get('instructors/:id/clearances')
  @Roles(Role.ORG_ADMIN, Role.ADMIN, Role.SAFETY_OFFICER, Role.COURSE_LEAD)
  listClearances(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.svc.listClearances(actor, id);
  }

  /** 已发生授课与接触范围（复核用） */
  @Get('instructors/:id/exposure')
  @Roles(Role.SAFETY_OFFICER, Role.COURSE_LEAD, Role.ADMIN)
  exposure(@Param('id') id: string) {
    return this.svc.exposure(id);
  }
}
