import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Course } from '../../entities/course.entity';
import { CourseSession, SessionStatus } from '../../entities/course-session.entity';
import { Student } from '../../entities/student.entity';
import { Enrollment } from '../../entities/enrollment.entity';
import { Instructor } from '../../entities/instructor.entity';
import { AuthUser, Role } from '../../common/auth';
import { newId } from '../../common/crypto.util';
import { assertDate, assertHm, dayInterval } from '../../common/time.util';
import { Clock } from '../../common/clock';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(Course) private readonly courses: Repository<Course>,
    @InjectRepository(CourseSession) private readonly sessions: Repository<CourseSession>,
    @InjectRepository(Student) private readonly students: Repository<Student>,
    @InjectRepository(Enrollment) private readonly enrollments: Repository<Enrollment>,
    @InjectRepository(Instructor) private readonly instructors: Repository<Instructor>,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async createCourse(actor: AuthUser, input: { title: string; gradeLevel: string }) {
    const course = await this.courses.save(
      this.courses.create({
        id: newId(),
        title: input.title,
        gradeLevel: input.gradeLevel,
        leadUserId: actor.sub,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'COURSE_CREATED', 'course', course.id);
    return course;
  }

  async createSession(
    actor: AuthUser,
    courseId: string,
    input: { date: string; startTime: string; endTime: string; instructorId: string },
  ) {
    const course = await this.mustGetCourse(courseId);
    this.assertLead(actor, course);
    assertDate(input.date, 'date');
    assertHm(input.startTime, 'startTime');
    assertHm(input.endTime, 'endTime');
    dayInterval(input.date, input.startTime, input.endTime); // 校验区间可解析
    const instructor = await this.instructors.findOne({ where: { id: input.instructorId } });
    if (!instructor) throw new NotFoundException('指派的导师不存在');
    const session = await this.sessions.save(
      this.sessions.create({
        id: newId(),
        courseId,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        instructorId: input.instructorId,
        status: SessionStatus.SCHEDULED,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'SESSION_CREATED', 'session', session.id, {
      courseId,
      instructorId: input.instructorId,
    });
    return session;
  }

  async addStudent(input: {
    fullName: string;
    gradeLevel: string;
    safetyNotes?: string | null;
    guardianPhone: string;
  }) {
    return this.students.save(
      this.students.create({
        id: newId(),
        fullName: input.fullName,
        gradeLevel: input.gradeLevel,
        safetyNotes: input.safetyNotes ?? null,
        guardianPhone: input.guardianPhone,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  async enroll(actor: AuthUser, courseId: string, studentId: string) {
    const course = await this.mustGetCourse(courseId);
    this.assertLead(actor, course);
    const student = await this.students.findOne({ where: { id: studentId } });
    if (!student) throw new NotFoundException('学生不存在');
    const existing = await this.enrollments.findOne({ where: { courseId, studentId } });
    if (existing) return existing;
    return this.enrollments.save(
      this.enrollments.create({
        id: newId(),
        courseId,
        studentId,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  /**
   * 课次学生名单。
   * - 导师：仅限本人被指派的课次，且只返回最小必要字段（显示名/年级/安全备注）。
   * - 课程负责人/安全人员/管理员：完整字段（含监护人电话）。
   */
  async roster(actor: AuthUser, sessionId: string) {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('课次不存在');
    const course = await this.mustGetCourse(session.courseId);

    const enrollments = await this.enrollments.find({ where: { courseId: course.id } });
    const students: Student[] = [];
    for (const e of enrollments) {
      const st = await this.students.findOne({ where: { id: e.studentId } });
      if (st) students.push(st);
    }

    if (actor.role === Role.INSTRUCTOR) {
      if (!actor.instructorId || session.instructorId !== actor.instructorId) {
        throw new ForbiddenException('导师只能查看本人被指派的课次名单');
      }
      return {
        sessionId,
        view: 'MINIMAL',
        students: students.map((s) => ({
          studentId: s.id,
          displayName: s.fullName,
          gradeLevel: s.gradeLevel,
          safetyNotes: s.safetyNotes,
        })),
      };
    }

    if (actor.role === Role.COURSE_LEAD && course.leadUserId !== actor.sub) {
      throw new ForbiddenException('只能查看本人负责课程的名单');
    }

    return {
      sessionId,
      view: 'FULL',
      students: students.map((s) => ({
        studentId: s.id,
        fullName: s.fullName,
        gradeLevel: s.gradeLevel,
        safetyNotes: s.safetyNotes,
        guardianPhone: s.guardianPhone,
      })),
    };
  }

  async getSession(id: string): Promise<CourseSession | null> {
    return this.sessions.findOne({ where: { id } });
  }

  async getCourse(id: string): Promise<Course | null> {
    return this.courses.findOne({ where: { id } });
  }

  private async mustGetCourse(id: string): Promise<Course> {
    const course = await this.courses.findOne({ where: { id } });
    if (!course) throw new NotFoundException('课程不存在');
    return course;
  }

  private assertLead(actor: AuthUser, course: Course): void {
    if (actor.role === Role.ADMIN) return;
    if (actor.role !== Role.COURSE_LEAD || course.leadUserId !== actor.sub) {
      throw new ForbiddenException('只有本课程的负责人可以执行此操作');
    }
  }
}
