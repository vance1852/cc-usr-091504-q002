import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CoursesService } from './courses.service';
import { AuthUser, CurrentUser, Role, Roles } from '../../common/auth';

class CreateCourseDto {
  @IsString() @IsNotEmpty()
  title: string;

  @IsString() @IsNotEmpty()
  gradeLevel: string;
}

class CreateSessionDto {
  @IsString() @IsNotEmpty()
  date: string;

  @IsString() @IsNotEmpty()
  startTime: string;

  @IsString() @IsNotEmpty()
  endTime: string;

  @IsString() @IsNotEmpty()
  instructorId: string;
}

class CreateStudentDto {
  @IsString() @IsNotEmpty()
  fullName: string;

  @IsString() @IsNotEmpty()
  gradeLevel: string;

  @IsOptional() @IsString()
  safetyNotes?: string | null;

  @IsString() @IsNotEmpty()
  guardianPhone: string;
}

class EnrollDto {
  @IsString() @IsNotEmpty()
  studentId: string;
}

@Controller()
export class CoursesController {
  constructor(private readonly svc: CoursesService) {}

  @Post('courses')
  @Roles(Role.COURSE_LEAD, Role.ADMIN)
  createCourse(@CurrentUser() actor: AuthUser, @Body() dto: CreateCourseDto) {
    return this.svc.createCourse(actor, dto);
  }

  @Post('courses/:id/sessions')
  @Roles(Role.COURSE_LEAD, Role.ADMIN)
  createSession(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateSessionDto,
  ) {
    return this.svc.createSession(actor, id, dto);
  }

  @Post('students')
  @Roles(Role.ADMIN, Role.COURSE_LEAD)
  addStudent(@Body() dto: CreateStudentDto) {
    return this.svc.addStudent(dto);
  }

  @Post('courses/:id/enrollments')
  @Roles(Role.COURSE_LEAD, Role.ADMIN)
  enroll(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: EnrollDto) {
    return this.svc.enroll(actor, id, dto.studentId);
  }

  @Get('sessions/:id/roster')
  @Roles(Role.INSTRUCTOR, Role.COURSE_LEAD, Role.SAFETY_OFFICER, Role.ADMIN)
  roster(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.svc.roster(actor, id);
  }
}
