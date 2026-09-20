import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { Organization } from './entities/organization.entity';
import { Instructor, InstructorStatus } from './entities/instructor.entity';
import {
  QualificationDocument,
  QualificationStatus,
  QualificationType,
} from './entities/qualification.entity';
import { TrainingRecord, TrainingType } from './entities/training.entity';
import { Clearance } from './entities/clearance.entity';
import { Course } from './entities/course.entity';
import { CourseSession, SessionStatus } from './entities/course-session.entity';
import { Student } from './entities/student.entity';
import { Enrollment } from './entities/enrollment.entity';
import { Role } from './common/auth';
import { hashPassword, newId } from './common/crypto.util';
import { Clock } from './common/clock';

/**
 * 演示数据：仅当数据库为空时写入。
 * 默认口令均为 Passw0rd!（仅本地演示，生产请通过环境变量与独立用户管理替换）。
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger('Seed');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<void> {
    const users = this.ds.getRepository(User);
    if ((await users.count()) > 0) return;

    const now = this.clock.now().toISOString();
    const mkUser = (
      username: string,
      displayName: string,
      role: Role,
      orgId: string | null = null,
      instructorId: string | null = null,
    ): User =>
      users.create({
        id: newId(),
        username,
        passwordHash: hashPassword('Passw0rd!'),
        displayName,
        role,
        orgId,
        instructorId,
        createdAt: now,
      });

    const orgs = this.ds.getRepository(Organization);
    const orgA = await orgs.save(
      orgs.create({
        id: newId(),
        name: '启航编程教育',
        contactName: '陈立',
        contactPhone: '13800000001',
        createdAt: now,
      }),
    );
    const orgB = await orgs.save(
      orgs.create({
        id: newId(),
        name: '极客少年科技',
        contactName: '赵倩',
        contactPhone: '13800000002',
        createdAt: now,
      }),
    );

    const instructors = this.ds.getRepository(Instructor);
    const mentorA = await instructors.save(
      instructors.create({
        id: newId(),
        orgId: orgA.id,
        fullName: '王工',
        idNumber: '110101199001011234',
        phone: '13900000001',
        status: InstructorStatus.VERIFIED,
        verifiedAt: now,
        verifiedBy: 'seed',
        suspendedAt: null,
        suspensionReason: null,
        createdAt: now,
      }),
    );
    // 新助教：有教学经历但身份核验与培训均未完成 —— 不得直接进班
    const newTa = await instructors.save(
      instructors.create({
        id: newId(),
        orgId: orgA.id,
        fullName: '小李',
        idNumber: '110101199505054321',
        phone: '13900000002',
        status: InstructorStatus.PENDING,
        verifiedAt: null,
        verifiedBy: null,
        suspendedAt: null,
        suspensionReason: null,
        createdAt: now,
      }),
    );

    const quals = this.ds.getRepository(QualificationDocument);
    const trainings = this.ds.getRepository(TrainingRecord);
    const clearances = this.ds.getRepository(Clearance);
    const farFuture = '2027-12-31T23:59:59.000Z';
    await quals.save(
      quals.create({
        id: newId(),
        instructorId: mentorA.id,
        type: QualificationType.TEACHING_CERT,
        docNumber: 'JSZ-2020-0001',
        issuedAt: '2020-06-01T00:00:00.000Z',
        expiresAt: farFuture,
        status: QualificationStatus.APPROVED,
        reviewedBy: 'seed',
        reviewedAt: now,
        createdAt: now,
      }),
    );
    await trainings.save(
      trainings.create({
        id: newId(),
        instructorId: mentorA.id,
        type: TrainingType.MINOR_PROTECTION,
        provider: '市教育局未保培训平台',
        completedAt: '2026-03-01T00:00:00.000Z',
        expiresAt: farFuture,
        createdAt: now,
      }),
    );
    await clearances.save(
      clearances.create({
        id: newId(),
        instructorId: mentorA.id,
        gradeLevel: 'G5',
        weekday: 0,
        windowStart: '15:00',
        windowEnd: '21:00',
        createdAt: now,
      }),
    );

    const lead = await users.save(mkUser('lead1', '课程负责人·周敏', Role.COURSE_LEAD));
    await users.save(mkUser('safety1', '安全员·郑凯', Role.SAFETY_OFFICER));
    await users.save(mkUser('guard1', '门岗·老孙', Role.GATE_GUARD));
    await users.save(mkUser('admin', '系统管理员', Role.ADMIN));
    await users.save(mkUser('orgA_admin', '启航机构管理员', Role.ORG_ADMIN, orgA.id));
    await users.save(mkUser('orgB_admin', '极客机构管理员', Role.ORG_ADMIN, orgB.id));
    await users.save(mkUser('mentorA', '导师·王工', Role.INSTRUCTOR, null, mentorA.id));

    const courses = this.ds.getRepository(Course);
    const course = await courses.save(
      courses.create({
        id: newId(),
        title: 'Scratch 创意编程',
        gradeLevel: 'G5',
        leadUserId: lead.id,
        createdAt: now,
      }),
    );
    const sessions = this.ds.getRepository(CourseSession);
    await sessions.save(
      sessions.create({
        id: newId(),
        courseId: course.id,
        date: '2026-09-20',
        startTime: '18:00',
        endTime: '19:30',
        instructorId: mentorA.id,
        status: SessionStatus.SCHEDULED,
        createdAt: now,
      }),
    );

    const students = this.ds.getRepository(Student);
    const enrollments = this.ds.getRepository(Enrollment);
    for (const [name, notes] of [
      ['张一', '花生过敏'],
      ['刘二', null],
      ['陈三', '需家长本人接送'],
    ] as const) {
      const st = await students.save(
        students.create({
          id: newId(),
          fullName: name,
          gradeLevel: 'G5',
          safetyNotes: notes,
          guardianPhone: '13700000000',
          createdAt: now,
        }),
      );
      await enrollments.save(
        enrollments.create({ id: newId(), courseId: course.id, studentId: st.id, createdAt: now }),
      );
    }

    this.logger.log(
      `演示数据已写入。机构A=${orgA.name} 机构B=${orgB.name}；导师王工(已核验) 小李(未核验:${newTa.id})；账号口令均为 Passw0rd!`,
    );
  }
}
