import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Instructor, InstructorStatus } from '../../entities/instructor.entity';
import {
  QualificationDocument,
  QualificationStatus,
  QualificationType,
} from '../../entities/qualification.entity';
import { TrainingRecord, TrainingType } from '../../entities/training.entity';
import { Clearance } from '../../entities/clearance.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { Enrollment } from '../../entities/enrollment.entity';
import { Student } from '../../entities/student.entity';
import { GateEvent, GateDecision, GateDirection } from '../../entities/gate-event.entity';
import { AccessPass } from '../../entities/access-pass.entity';
import { AuthUser, Role } from '../../common/auth';
import { maskIdNumber, newId } from '../../common/crypto.util';
import { assertDate, assertHm, dayInterval } from '../../common/time.util';
import { Clock } from '../../common/clock';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class InstructorsService {
  constructor(
    @InjectRepository(Instructor)
    private readonly instructors: Repository<Instructor>,
    @InjectRepository(QualificationDocument)
    private readonly qualifications: Repository<QualificationDocument>,
    @InjectRepository(TrainingRecord)
    private readonly trainings: Repository<TrainingRecord>,
    @InjectRepository(Clearance)
    private readonly clearances: Repository<Clearance>,
    @InjectRepository(CourseSession)
    private readonly sessions: Repository<CourseSession>,
    @InjectRepository(Course)
    private readonly courses: Repository<Course>,
    @InjectRepository(Enrollment)
    private readonly enrollments: Repository<Enrollment>,
    @InjectRepository(Student)
    private readonly students: Repository<Student>,
    @InjectRepository(GateEvent)
    private readonly gateEvents: Repository<GateEvent>,
    @InjectRepository(AccessPass)
    private readonly passes: Repository<AccessPass>,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** 机构管理员只能触碰本机构的导师；校务角色（安全人员/管理员）不受机构限制 */
  private assertOrgScope(actor: AuthUser, orgId: string): void {
    if (actor.role === Role.ORG_ADMIN && actor.orgId !== orgId) {
      throw new ForbiddenException('机构管理员不能访问其他机构的资料');
    }
  }

  private async mustGet(id: string): Promise<Instructor> {
    const instructor = await this.instructors.findOne({ where: { id } });
    if (!instructor) throw new NotFoundException('导师不存在');
    return instructor;
  }

  /** 对外展示时证件号一律脱敏 */
  private redact(i: Instructor) {
    return {
      id: i.id,
      orgId: i.orgId,
      fullName: i.fullName,
      idNumberMasked: maskIdNumber(i.idNumber),
      phone: i.phone,
      status: i.status,
      verifiedAt: i.verifiedAt,
      verifiedBy: i.verifiedBy,
      suspendedAt: i.suspendedAt,
      suspensionReason: i.suspensionReason,
      createdAt: i.createdAt,
    };
  }

  async listByOrg(actor: AuthUser, orgId: string) {
    this.assertOrgScope(actor, orgId);
    const list = await this.instructors.find({ where: { orgId } });
    return list.map((i) => this.redact(i));
  }

  async getOne(actor: AuthUser, id: string) {
    const instructor = await this.mustGet(id);
    this.assertOrgScope(actor, instructor.orgId);
    return this.redact(instructor);
  }

  async create(
    actor: AuthUser,
    orgId: string,
    input: { fullName: string; idNumber: string; phone: string },
  ) {
    this.assertOrgScope(actor, orgId);
    const instructor = await this.instructors.save(
      this.instructors.create({
        id: newId(),
        orgId,
        fullName: input.fullName,
        idNumber: input.idNumber,
        phone: input.phone,
        status: InstructorStatus.PENDING,
        verifiedAt: null,
        verifiedBy: null,
        suspendedAt: null,
        suspensionReason: null,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'INSTRUCTOR_CREATED', 'instructor', instructor.id, {
      orgId,
    });
    return this.redact(instructor);
  }

  async addQualification(
    actor: AuthUser,
    instructorId: string,
    input: { type: QualificationType; docNumber: string; issuedAt: string; expiresAt?: string | null },
  ) {
    const instructor = await this.mustGet(instructorId);
    this.assertOrgScope(actor, instructor.orgId);
    const qual = await this.qualifications.save(
      this.qualifications.create({
        id: newId(),
        instructorId,
        type: input.type,
        docNumber: input.docNumber,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt ?? null,
        status: QualificationStatus.SUBMITTED,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'QUALIFICATION_SUBMITTED', 'instructor', instructorId, {
      qualificationId: qual.id,
      type: qual.type,
    });
    return qual;
  }

  /** 校务侧核准/驳回资质文件 */
  async reviewQualification(
    actor: AuthUser,
    qualificationId: string,
    approve: boolean,
  ): Promise<QualificationDocument> {
    const qual = await this.qualifications.findOne({ where: { id: qualificationId } });
    if (!qual) throw new NotFoundException('资质文件不存在');
    qual.status = approve ? QualificationStatus.APPROVED : QualificationStatus.REJECTED;
    qual.reviewedBy = actor.sub;
    qual.reviewedAt = this.clock.now().toISOString();
    await this.qualifications.save(qual);
    await this.audit.record(
      actor.sub,
      approve ? 'QUALIFICATION_APPROVED' : 'QUALIFICATION_REJECTED',
      'instructor',
      qual.instructorId,
      { qualificationId },
    );
    return qual;
  }

  /** 完成身份核验（学校安全人员线下核验后登记） */
  async verifyIdentity(actor: AuthUser, instructorId: string) {
    const instructor = await this.mustGet(instructorId);
    if (instructor.status === InstructorStatus.SUSPENDED) {
      throw new BadRequestException('该导师已被暂停，需先解除暂停');
    }
    instructor.status = InstructorStatus.VERIFIED;
    instructor.verifiedAt = this.clock.now().toISOString();
    instructor.verifiedBy = actor.sub;
    await this.instructors.save(instructor);
    await this.audit.record(actor.sub, 'IDENTITY_VERIFIED', 'instructor', instructorId);
    return this.redact(instructor);
  }

  async suspend(actor: AuthUser, instructorId: string, reason: string) {
    const instructor = await this.mustGet(instructorId);
    instructor.status = InstructorStatus.SUSPENDED;
    instructor.suspendedAt = this.clock.now().toISOString();
    instructor.suspensionReason = reason;
    await this.instructors.save(instructor);
    await this.audit.record(actor.sub, 'INSTRUCTOR_SUSPENDED', 'instructor', instructorId, {
      reason,
    });
    return this.redact(instructor);
  }

  async reinstate(actor: AuthUser, instructorId: string) {
    const instructor = await this.mustGet(instructorId);
    if (instructor.status !== InstructorStatus.SUSPENDED) {
      throw new BadRequestException('该导师当前未处于暂停状态');
    }
    instructor.status = InstructorStatus.VERIFIED;
    instructor.suspendedAt = null;
    instructor.suspensionReason = null;
    await this.instructors.save(instructor);
    await this.audit.record(actor.sub, 'INSTRUCTOR_REINSTATED', 'instructor', instructorId);
    return this.redact(instructor);
  }

  async addTraining(
    actor: AuthUser,
    instructorId: string,
    input: { type: TrainingType; provider: string; completedAt: string; expiresAt?: string | null },
  ) {
    const instructor = await this.mustGet(instructorId);
    this.assertOrgScope(actor, instructor.orgId);
    const record = await this.trainings.save(
      this.trainings.create({
        id: newId(),
        instructorId,
        type: input.type,
        provider: input.provider,
        completedAt: input.completedAt,
        expiresAt: input.expiresAt ?? null,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'TRAINING_RECORDED', 'instructor', instructorId, {
      trainingId: record.id,
      type: record.type,
    });
    return record;
  }

  /** 校务侧授予允许接触范围（年级 + 星期 + 时间窗） */
  async addClearance(
    actor: AuthUser,
    instructorId: string,
    input: { gradeLevel: string; weekday: number; windowStart: string; windowEnd: string },
  ) {
    await this.mustGet(instructorId);
    assertHm(input.windowStart, 'windowStart');
    assertHm(input.windowEnd, 'windowEnd');
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
      throw new BadRequestException('weekday 必须是 0-6 的整数');
    }
    const clearance = await this.clearances.save(
      this.clearances.create({
        id: newId(),
        instructorId,
        gradeLevel: input.gradeLevel,
        weekday: input.weekday,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'CLEARANCE_GRANTED', 'instructor', instructorId, {
      clearanceId: clearance.id,
    });
    return clearance;
  }

  async listClearances(actor: AuthUser, instructorId: string) {
    const instructor = await this.mustGet(instructorId);
    this.assertOrgScope(actor, instructor.orgId);
    return this.clearances.find({ where: { instructorId } });
  }

  /**
   * 已发生授课与接触范围：供资格异常后的复核。
   * 「已发生」= 已有入校回执，或课次结束时间已过。历史数据只读保留，不做删除。
   */
  async exposure(instructorId: string) {
    await this.mustGet(instructorId);
    const now = this.clock.now();
    const sessions = await this.sessions.find({ where: { instructorId } });
    const occurred = sessions.filter((s) => {
      const { end } = dayInterval(s.date, s.startTime, s.endTime);
      return end.getTime() <= now.getTime();
    });

    // 有入校回执的进行中课次也算已发生
    const passes = await this.passes.find({ where: { instructorId } });
    const enteredSessionIds = new Set<string>();
    for (const pass of passes) {
      const entries = await this.gateEvents.find({
        where: { passId: pass.id, direction: GateDirection.IN, decision: GateDecision.ALLOW },
      });
      if (entries.length > 0) enteredSessionIds.add(pass.sessionId);
    }

    const result = [];
    for (const s of sessions) {
      const happened = occurred.includes(s) || enteredSessionIds.has(s.id);
      if (!happened) continue;
      const course = await this.courses.findOne({ where: { id: s.courseId } });
      const enrollments = await this.enrollments.find({ where: { courseId: s.courseId } });
      const students = [];
      for (const e of enrollments) {
        const st = await this.students.findOne({ where: { id: e.studentId } });
        if (st) {
          students.push({
            studentId: st.id,
            fullName: st.fullName,
            gradeLevel: st.gradeLevel,
            safetyNotes: st.safetyNotes,
          });
        }
      }
      result.push({
        sessionId: s.id,
        courseId: s.courseId,
        courseTitle: course?.title ?? null,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        studentsExposed: students,
      });
    }
    return { instructorId, generatedAt: now.toISOString(), occurredSessions: result };
  }
}
