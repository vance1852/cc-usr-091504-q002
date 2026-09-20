import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { Clock, CLOCK } from '../src/common/clock';
import { JwtAuthGuard, Role, RolesGuard } from '../src/common/auth';
import { newId } from '../src/common/crypto.util';
import { weekdayOf } from '../src/common/time.util';
import { ALL_ENTITIES } from '../src/app.module';
import { AuditModule } from '../src/modules/audit/audit.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { OrgsModule } from '../src/modules/orgs/orgs.module';
import { InstructorsModule } from '../src/modules/instructors/instructors.module';
import { CoursesModule } from '../src/modules/courses/courses.module';
import { SubstitutionsModule } from '../src/modules/substitutions/substitutions.module';
import { PassesModule } from '../src/modules/passes/passes.module';
import { IncidentsModule } from '../src/modules/incidents/incidents.module';
import { User } from '../src/entities/user.entity';
import { Organization } from '../src/entities/organization.entity';
import { Instructor, InstructorStatus } from '../src/entities/instructor.entity';
import {
  QualificationDocument,
  QualificationStatus,
  QualificationType,
} from '../src/entities/qualification.entity';
import { TrainingRecord, TrainingType } from '../src/entities/training.entity';
import { Clearance } from '../src/entities/clearance.entity';
import { Course } from '../src/entities/course.entity';
import { CourseSession, SessionStatus } from '../src/entities/course-session.entity';
import { Student } from '../src/entities/student.entity';
import { Enrollment } from '../src/entities/enrollment.entity';

/** 测试时钟：可冻结、可推进，覆盖跨午夜与重放场景 */
export class MutableClock extends Clock {
  private current = new Date('2026-09-20T12:00:00.000Z');

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: MutableClock },
    { provide: Clock, useExisting: CLOCK },
  ],
  exports: [CLOCK, Clock],
})
class TestClockModule {}

export class Fixtures {
  constructor(
    private readonly ds: DataSource,
    private readonly jwt: JwtService,
  ) {}

  private seq = 0;
  private next(): number {
    return ++this.seq;
  }

  tokenFor(user: User): string {
    return this.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      orgId: user.orgId,
      instructorId: user.instructorId,
    });
  }

  async user(role: Role, extra: Partial<User> = {}): Promise<User> {
    const n = this.next();
    const repo = this.ds.getRepository(User);
    const user = await repo.save(
      repo.create({
        id: newId(),
        username: `u${n}_${role.toLowerCase()}`,
        passwordHash: 'x',
        displayName: `用户${n}`,
        role,
        orgId: extra.orgId ?? null,
        instructorId: extra.instructorId ?? null,
        createdAt: new Date().toISOString(),
      }),
    );
    return user;
  }

  async userWithToken(
    role: Role,
    extra: Partial<User> = {},
  ): Promise<{ user: User; token: string }> {
    const user = await this.user(role, extra);
    return { user, token: this.tokenFor(user) };
  }

  async org(name?: string): Promise<Organization> {
    const repo = this.ds.getRepository(Organization);
    return repo.save(
      repo.create({
        id: newId(),
        name: name ?? `机构${this.next()}`,
        contactName: '联系人',
        contactPhone: '13800000000',
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async instructor(
    orgId: string,
    opts: { status?: InstructorStatus; fullName?: string } = {},
  ): Promise<Instructor> {
    const repo = this.ds.getRepository(Instructor);
    return repo.save(
      repo.create({
        id: newId(),
        orgId,
        fullName: opts.fullName ?? `导师${this.next()}`,
        idNumber: `1101011990${String(this.next()).padStart(8, '0')}`,
        phone: '13900000000',
        status: opts.status ?? InstructorStatus.VERIFIED,
        verifiedAt: opts.status === InstructorStatus.PENDING ? null : new Date().toISOString(),
        verifiedBy: opts.status === InstructorStatus.PENDING ? null : 'test',
        suspendedAt: opts.status === InstructorStatus.SUSPENDED ? new Date().toISOString() : null,
        suspensionReason: opts.status === InstructorStatus.SUSPENDED ? '测试暂停' : null,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async qualification(instructorId: string, expiresAt: string | null): Promise<void> {
    const repo = this.ds.getRepository(QualificationDocument);
    await repo.save(
      repo.create({
        id: newId(),
        instructorId,
        type: QualificationType.TEACHING_CERT,
        docNumber: `DOC-${this.next()}`,
        issuedAt: '2024-01-01T00:00:00.000Z',
        expiresAt,
        status: QualificationStatus.APPROVED,
        reviewedBy: 'test',
        reviewedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async minorProtectionTraining(instructorId: string, expiresAt: string | null): Promise<void> {
    const repo = this.ds.getRepository(TrainingRecord);
    await repo.save(
      repo.create({
        id: newId(),
        instructorId,
        type: TrainingType.MINOR_PROTECTION,
        provider: '未保培训平台',
        completedAt: '2026-01-01T00:00:00.000Z',
        expiresAt,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async clearance(
    instructorId: string,
    opts: { gradeLevel: string; weekday: number; windowStart: string; windowEnd: string },
  ): Promise<void> {
    const repo = this.ds.getRepository(Clearance);
    await repo.save(
      repo.create({
        id: newId(),
        instructorId,
        gradeLevel: opts.gradeLevel,
        weekday: opts.weekday,
        windowStart: opts.windowStart,
        windowEnd: opts.windowEnd,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async course(leadUserId: string, gradeLevel = 'G5'): Promise<Course> {
    const repo = this.ds.getRepository(Course);
    return repo.save(
      repo.create({
        id: newId(),
        title: `编程课${this.next()}`,
        gradeLevel,
        leadUserId,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async session(
    courseId: string,
    instructorId: string,
    opts: { date: string; startTime: string; endTime: string },
  ): Promise<CourseSession> {
    const repo = this.ds.getRepository(CourseSession);
    return repo.save(
      repo.create({
        id: newId(),
        courseId,
        date: opts.date,
        startTime: opts.startTime,
        endTime: opts.endTime,
        instructorId,
        status: SessionStatus.SCHEDULED,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async student(courseId: string, fullName?: string): Promise<Student> {
    const students = this.ds.getRepository(Student);
    const enrollments = this.ds.getRepository(Enrollment);
    const st = await students.save(
      students.create({
        id: newId(),
        fullName: fullName ?? `学生${this.next()}`,
        gradeLevel: 'G5',
        safetyNotes: '过敏测试备注',
        guardianPhone: '13711112222',
        createdAt: new Date().toISOString(),
      }),
    );
    await enrollments.save(
      enrollments.create({
        id: newId(),
        courseId,
        studentId: st.id,
        createdAt: new Date().toISOString(),
      }),
    );
    return st;
  }

  /**
   * 一名「完全合格」的导师：已核验 + 有效资质 + 有效未保培训 + 覆盖课次的接触范围。
   * 课次参数用于推导 clearance 的星期与时间窗。
   */
  async eligibleInstructor(
    orgId: string,
    session: { date: string; startTime: string; endTime: string },
    gradeLevel = 'G5',
    window: { start: string; end: string } = { start: '00:00', end: '23:59' },
  ): Promise<Instructor> {
    const inst = await this.instructor(orgId, { status: InstructorStatus.VERIFIED });
    await this.qualification(inst.id, '2027-12-31T23:59:59.000Z');
    await this.minorProtectionTraining(inst.id, '2027-12-31T23:59:59.000Z');
    await this.clearance(inst.id, {
      gradeLevel,
      weekday: weekdayOf(session.date),
      windowStart: window.start,
      windowEnd: window.end,
    });
    return inst;
  }
}

export async function createTestApp(): Promise<{
  app: INestApplication;
  clock: MutableClock;
  ds: DataSource;
  fx: Fixtures;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ALL_ENTITIES,
        synchronize: true,
      }),
      AuditModule,
      AuthModule,
      OrgsModule,
      InstructorsModule,
      CoursesModule,
      SubstitutionsModule,
      PassesModule,
      IncidentsModule,
      TestClockModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const clock = app.get<MutableClock>(CLOCK);
  const ds = app.get(DataSource);
  const fx = new Fixtures(ds, app.get(JwtService));
  return { app, clock, ds, fx };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
