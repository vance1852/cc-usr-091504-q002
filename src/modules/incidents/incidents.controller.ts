import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IncidentsService } from './incidents.service';
import { AuthUser, CurrentUser, Role, Roles } from '../../common/auth';
import { IncidentType } from '../../entities/incident.entity';

class ReportIncidentDto {
  @IsString() @IsNotEmpty()
  instructorId: string;

  @IsOptional() @IsString()
  sessionId?: string;

  @IsIn(Object.values(IncidentType))
  type: IncidentType;

  @IsString() @IsNotEmpty()
  detail: string;
}

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly svc: IncidentsService) {}

  @Post()
  @Roles(Role.SAFETY_OFFICER, Role.ADMIN)
  report(@CurrentUser() actor: AuthUser, @Body() dto: ReportIncidentDto) {
    return this.svc.report(actor, dto);
  }

  @Get('instructor/:instructorId')
  @Roles(Role.SAFETY_OFFICER, Role.COURSE_LEAD, Role.ADMIN)
  listByInstructor(@Param('instructorId') instructorId: string) {
    return this.svc.listByInstructor(instructorId);
  }
}
