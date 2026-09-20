import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { ClockModule } from './common/clock.module';
import { JwtAuthGuard, RolesGuard } from './common/auth';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrgsModule } from './modules/orgs/orgs.module';
import { InstructorsModule } from './modules/instructors/instructors.module';
import { CoursesModule } from './modules/courses/courses.module';
import { SubstitutionsModule } from './modules/substitutions/substitutions.module';
import { PassesModule } from './modules/passes/passes.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { SeedService } from './seed';
import { User } from './entities/user.entity';
import { Organization } from './entities/organization.entity';
import { Instructor } from './entities/instructor.entity';
import { QualificationDocument } from './entities/qualification.entity';
import { TrainingRecord } from './entities/training.entity';
import { Clearance } from './entities/clearance.entity';
import { Course } from './entities/course.entity';
import { CourseSession } from './entities/course-session.entity';
import { Student } from './entities/student.entity';
import { Enrollment } from './entities/enrollment.entity';
import { SubstitutionRequest } from './entities/substitution.entity';
import { AccessPass } from './entities/access-pass.entity';
import { GateEvent } from './entities/gate-event.entity';
import { Incident } from './entities/incident.entity';
import { AuditLog } from './entities/audit-log.entity';

export const ALL_ENTITIES = [
  User,
  Organization,
  Instructor,
  QualificationDocument,
  TrainingRecord,
  Clearance,
  Course,
  CourseSession,
  Student,
  Enrollment,
  SubstitutionRequest,
  AccessPass,
  GateEvent,
  Incident,
  AuditLog,
];

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DB_PATH ?? join(process.cwd(), 'data.sqlite'),
      entities: ALL_ENTITIES,
      synchronize: true,
    }),
    ClockModule,
    AuditModule,
    AuthModule,
    OrgsModule,
    InstructorsModule,
    CoursesModule,
    SubstitutionsModule,
    PassesModule,
    IncidentsModule,
  ],
  providers: [
    SeedService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
