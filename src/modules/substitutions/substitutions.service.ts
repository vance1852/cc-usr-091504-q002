import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SubstitutionKind,
  SubstitutionRequest,
  SubstitutionStatus,
} from '../../entities/substitution.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { AccessPass } from '../../entities/access-pass.entity';
import { GateEvent } from '../../entities/gate-event.entity';
import { Incident } from '../../entities/incident.entity';
import { AuthUser, Role } from '../../common/auth';
import { newId } from '../../common/crypto.util';
import { Clock } from '../../common/clock';
import { AuditService } from '../audit/audit.service';
import { EligibilityService } from '../instructors/eligibility.service';
import { PassesService } from '../passes/passes.service';

@Injectable()
export class SubstitutionsService {
  constructor(
    @InjectRepository(SubstitutionRequest)
    private readonly requests: Repository<SubstitutionRequest>,
    @InjectRepository(CourseSession)
    private readonly sessions: Repository<CourseSession>,
    @InjectRepository(Course)
    private readonly courses: Repository<Course>,
    @InjectRepository(AccessPass)
    private readonly passes: Repository<AccessPass>,
    @InjectRepository(GateEvent)
    private readonly gateEvents: Repository<GateEvent>,
    @InjectRepository(Incident)
    private readonly incidents: Repository<Incident>,
    private readonly eligibility: EligibilityService,
    private readonly passesService: PassesService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * 发起代课申请。创建时即做资格预审：
   * 资质过期、核验未完成、已暂停或超出允许接触范围的人员直接判定 ELIGIBILITY_FAILED，不得代课。
   */
  async create(
    actor: AuthUser,
    input: {
      sessionId: string;
      substituteInstructorId: string;
      kind: SubstitutionKind;
      reason: string;
    },
  ): Promise<SubstitutionRequest> {
    const session = await this.sessions.findOne({ where: { id: input.sessionId } });
    if (!session) throw new NotFoundException('课次不存在');
    const course = await this.courses.findOne({ where: { id: session.courseId } });
    if (!course) throw new NotFoundException('课程不存在');
    if (actor.role === Role.COURSE_LEAD && course.leadUserId !== actor.sub) {
      throw new ForbiddenException('只能为本负责人名下的课程发起代课');
    }
    if (session.instructorId === input.substituteInstructorId) {
      throw new BadRequestException('代课人与原授课导师相同');
    }

    const evalResult = await this.eligibility.evaluate(input.substituteInstructorId, session, course);
    const now = this.clock.now().toISOString();
    const request = await this.requests.save(
      this.requests.create({
        id: newId(),
        sessionId: session.id,
        originalInstructorId: session.instructorId,
        substituteInstructorId: input.substituteInstructorId,
        kind: input.kind,
        reason: input.reason,
        status: evalResult.eligible
          ? SubstitutionStatus.PENDING
          : SubstitutionStatus.ELIGIBILITY_FAILED,
        eligibilityReasons: evalResult.eligible ? null : evalResult.reasons,
        requestedBy: actor.sub,
        leadConfirmedBy: null,
        leadConfirmedAt: null,
        safetyConfirmedBy: null,
        safetyConfirmedAt: null,
        decidedAt: null,
        createdAt: now,
      }),
    );
    await this.audit.record(actor.sub, 'SUBSTITUTION_REQUESTED', 'substitution', request.id, {
      sessionId: session.id,
      substituteInstructorId: input.substituteInstructorId,
      kind: input.kind,
      eligible: evalResult.eligible,
      reasons: evalResult.reasons,
    });
    return request;
  }

  /**
   * 确认代课。
   * - 普通代课：课程负责人确认即可。
   * - 紧急代课：必须由课程负责人与校园安全人员「分别」确认（两个不同账号、两个角色）。
   * 确认前重新评估资格（防止申请后状态变化），全部通过后自动签发当日通行凭证。
   */
  async confirm(
    actor: AuthUser,
    id: string,
  ): Promise<SubstitutionRequest & { issuedPassToken?: string }> {
    const request = await this.mustGet(id);
    if (request.status === SubstitutionStatus.ELIGIBILITY_FAILED) {
      throw new BadRequestException('该申请资格预审未通过，不可确认');
    }
    if (request.status !== SubstitutionStatus.PENDING) {
      throw new BadRequestException(`申请已处于 ${request.status} 状态，不可重复确认`);
    }

    const now = this.clock.now().toISOString();
    if (actor.role === Role.COURSE_LEAD) {
      if (request.leadConfirmedBy) throw new BadRequestException('课程负责人已确认过');
      request.leadConfirmedBy = actor.sub;
      request.leadConfirmedAt = now;
    } else if (actor.role === Role.SAFETY_OFFICER) {
      if (request.safetyConfirmedBy) throw new BadRequestException('安全人员已确认过');
      request.safetyConfirmedBy = actor.sub;
      request.safetyConfirmedAt = now;
    } else {
      throw new ForbiddenException('只有课程负责人或校园安全人员可以确认代课');
    }

    // 分别确认：两个角色不得是同一账号
    if (
      request.leadConfirmedBy &&
      request.safetyConfirmedBy &&
      request.leadConfirmedBy === request.safetyConfirmedBy
    ) {
      throw new BadRequestException('课程负责人与安全人员必须由不同人员分别确认');
    }

    const fullyConfirmed =
      request.kind === SubstitutionKind.EMERGENCY
        ? Boolean(request.leadConfirmedBy && request.safetyConfirmedBy)
        : Boolean(request.leadConfirmedBy);

    if (fullyConfirmed) {
      const session = await this.sessions.findOne({ where: { id: request.sessionId } });
      const course = await this.courses.findOne({ where: { id: session!.courseId } });
      // 批准前再次评估资格
      const reeval = await this.eligibility.evaluate(
        request.substituteInstructorId,
        session!,
        course!,
      );
      if (!reeval.eligible) {
        request.status = SubstitutionStatus.ELIGIBILITY_FAILED;
        request.eligibilityReasons = reeval.reasons;
        request.decidedAt = now;
        await this.requests.save(request);
        await this.audit.record(actor.sub, 'SUBSTITUTION_ELIGIBILITY_FAILED', 'substitution', id, {
          reasons: reeval.reasons,
        });
        return request;
      }
      request.status = SubstitutionStatus.APPROVED;
      request.decidedAt = now;
      await this.requests.save(request);

      // 换人生效：课次改派；原导师该课次凭证立即作废；为代课人签发仅覆盖当日当次课的凭证
      session!.instructorId = request.substituteInstructorId;
      await this.sessions.save(session!);
      await this.passesService.revokeWhere(
        (p) => p.sessionId === session!.id,
        actor.sub,
        `substitution:${request.id} 代课生效，原凭证作废`,
      );
      const { token } = await this.passesService.issueForSession(actor, session!.id, request.id);

      await this.audit.record(actor.sub, 'SUBSTITUTION_APPROVED', 'substitution', id, {
        kind: request.kind,
        leadConfirmedBy: request.leadConfirmedBy,
        safetyConfirmedBy: request.safetyConfirmedBy,
      });
      // 明文令牌随批准响应一次性返回，由负责人转交代课人；追溯接口永不包含令牌
      return { ...request, issuedPassToken: token };
    }

    await this.requests.save(request);
    await this.audit.record(actor.sub, 'SUBSTITUTION_PARTIALLY_CONFIRMED', 'substitution', id, {
      role: actor.role,
    });
    return request;
  }

  async reject(actor: AuthUser, id: string, reason: string): Promise<SubstitutionRequest> {
    const request = await this.mustGet(id);
    if (request.status !== SubstitutionStatus.PENDING) {
      throw new BadRequestException(`申请已处于 ${request.status} 状态`);
    }
    request.status = SubstitutionStatus.REJECTED;
    request.decidedAt = this.clock.now().toISOString();
    await this.requests.save(request);
    await this.audit.record(actor.sub, 'SUBSTITUTION_REJECTED', 'substitution', id, { reason });
    return request;
  }

  async get(id: string): Promise<SubstitutionRequest> {
    return this.mustGet(id);
  }

  /**
   * 代课全程追溯：申请 → 双方确认 → 凭证签发 → 门岗进出回执 → 异常处置。
   * 供课程负责人/安全人员复核某次代课的完整链路。
   */
  async trace(id: string) {
    const request = await this.mustGet(id);
    const session = await this.sessions.findOne({ where: { id: request.sessionId } });
    const course = session
      ? await this.courses.findOne({ where: { id: session.courseId } })
      : null;
    const pass = await this.passes.findOne({ where: { substitutionId: id } });
    const gateEvents = pass
      ? await this.gateEvents.find({ where: { passId: pass.id } })
      : [];
    const incidents = await this.incidents.find({
      where: { instructorId: request.substituteInstructorId },
    });
    const auditTrail = await this.audit.trailFor('substitution', id);
    const passAudit = pass ? await this.audit.trailFor('pass', pass.id) : [];

    return {
      request,
      session,
      course,
      pass: pass ?? null,
      gateEvents: gateEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      incidents,
      auditTrail: [...auditTrail, ...passAudit].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    };
  }

  private async mustGet(id: string): Promise<SubstitutionRequest> {
    const request = await this.requests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('代课申请不存在');
    return request;
  }
}
