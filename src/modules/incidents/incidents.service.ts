import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Incident, IncidentStatus, IncidentType } from '../../entities/incident.entity';
import { Instructor, InstructorStatus } from '../../entities/instructor.entity';
import { CourseSession, SessionStatus } from '../../entities/course-session.entity';
import { AuthUser } from '../../common/auth';
import { newId } from '../../common/crypto.util';
import { dayInterval } from '../../common/time.util';
import { Clock } from '../../common/clock';
import { AuditService } from '../audit/audit.service';
import { PassesService } from '../passes/passes.service';

@Injectable()
export class IncidentsService {
  constructor(
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(Instructor) private readonly instructors: Repository<Instructor>,
    @InjectRepository(CourseSession) private readonly sessions: Repository<CourseSession>,
    private readonly passesService: PassesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * 登记资格异常（如：课程开始后发现资质过期/核验失效/需暂停）。
   * 处置动作：
   *  1. 导师置为 SUSPENDED；
   *  2. 吊销其全部尚未消耗的通行凭证（含进行中的课次）——立即停止后续通行；
   *  3. 未结束/未开始的课次标记 FLAGGED 待复核；
   *  4. 已发生的授课记录、门岗回执、接触名单一律保留，供追溯复核。
   */
  async report(
    actor: AuthUser,
    input: { instructorId: string; sessionId?: string; type: IncidentType; detail: string },
  ): Promise<Incident> {
    const instructor = await this.instructors.findOne({ where: { id: input.instructorId } });
    if (!instructor) throw new NotFoundException('导师不存在');

    const now = this.clock.now();
    const nowIso = now.toISOString();

    // 1. 暂停导师
    instructor.status = InstructorStatus.SUSPENDED;
    instructor.suspendedAt = nowIso;
    instructor.suspensionReason = `资格异常处置：${input.detail}`;
    await this.instructors.save(instructor);

    // 2. 吊销该导师所有未消耗凭证（ACTIVE 与已入校 USED 都吊销，阻断再次入校）
    const passesRevoked = await this.passesService.revokeWhere(
      (p) => p.instructorId === input.instructorId,
      actor.sub,
      `incident:${input.type}`,
    );

    // 3. 标记未结束课次为 FLAGGED（历史已完成课次保持原状，记录保留）
    const instructorSessions = await this.sessions.find({
      where: { instructorId: input.instructorId },
    });
    let sessionsFlagged = 0;
    for (const s of instructorSessions) {
      if (s.status !== SessionStatus.SCHEDULED) continue;
      const { end } = dayInterval(s.date, s.startTime, s.endTime);
      if (end.getTime() >= now.getTime()) {
        s.status = SessionStatus.FLAGGED;
        await this.sessions.save(s);
        sessionsFlagged += 1;
      }
    }

    const incident = await this.incidents.save(
      this.incidents.create({
        id: newId(),
        instructorId: input.instructorId,
        sessionId: input.sessionId ?? null,
        type: input.type,
        detail: input.detail,
        status: IncidentStatus.OPEN,
        passesRevoked,
        sessionsFlagged,
        reportedBy: actor.sub,
        createdAt: nowIso,
      }),
    );
    await this.audit.record(actor.sub, 'INCIDENT_REPORTED', 'incident', incident.id, {
      instructorId: input.instructorId,
      type: input.type,
      passesRevoked,
      sessionsFlagged,
    });
    return incident;
  }

  async listByInstructor(instructorId: string): Promise<Incident[]> {
    return this.incidents.find({ where: { instructorId } });
  }
}
