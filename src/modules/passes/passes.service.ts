import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessPass, PassStatus } from '../../entities/access-pass.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { Instructor } from '../../entities/instructor.entity';
import { Organization } from '../../entities/organization.entity';
import { GateDecision, GateDirection, GateEvent } from '../../entities/gate-event.entity';
import { AuthUser } from '../../common/auth';
import { maskIdNumber, newId, newPassToken, sha256 } from '../../common/crypto.util';
import { dayInterval, passWindow } from '../../common/time.util';
import { Clock } from '../../common/clock';
import { AuditService } from '../audit/audit.service';
import { EligibilityService } from '../instructors/eligibility.service';

export interface GateVerifyResult {
  decision: GateDecision;
  reason: string | null;
  /** 门岗仅得到放行结论与必要身份摘要 */
  instructor?: {
    fullName: string;
    orgName: string | null;
    idNumberMasked: string;
  };
  pass?: {
    id: string;
    duties: string;
    validFrom: string;
    validTo: string;
  };
}

@Injectable()
export class PassesService {
  constructor(
    @InjectRepository(AccessPass) private readonly passes: Repository<AccessPass>,
    @InjectRepository(CourseSession) private readonly sessions: Repository<CourseSession>,
    @InjectRepository(Course) private readonly courses: Repository<Course>,
    @InjectRepository(Instructor) private readonly instructors: Repository<Instructor>,
    @InjectRepository(Organization) private readonly orgs: Repository<Organization>,
    @InjectRepository(GateEvent) private readonly gateEvents: Repository<GateEvent>,
    private readonly eligibility: EligibilityService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * 为课次的当前指派导师签发当日通行凭证。
   * 签发前做资格评估；窗口 = 课次区间向前后各扩 30 分钟（跨午夜安全）。
   * 明文令牌只在本响应中出现一次，库中仅存 SHA-256 摘要。
   */
  async issueForSession(
    actor: AuthUser,
    sessionId: string,
    substitutionId: string | null = null,
  ): Promise<{ pass: AccessPass; token: string }> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('课次不存在');
    const course = await this.courses.findOne({ where: { id: session.courseId } });
    if (!course) throw new NotFoundException('课程不存在');

    const existing = await this.passes.findOne({
      where: { sessionId, instructorId: session.instructorId },
    });
    if (existing && existing.status !== PassStatus.REVOKED) {
      throw new ConflictException('该课次已存在有效凭证，不可重复签发');
    }

    const evalResult = await this.eligibility.evaluate(session.instructorId, session, course);
    if (!evalResult.eligible) {
      throw new BadRequestException(
        `导师不具备授课资格，无法签发凭证：${evalResult.reasons.join('；')}`,
      );
    }

    const sessionInterval = dayInterval(session.date, session.startTime, session.endTime);
    const window = passWindow(sessionInterval);
    const token = newPassToken();
    const pass = await this.passes.save(
      this.passes.create({
        id: newId(),
        tokenHash: sha256(token),
        instructorId: session.instructorId,
        sessionId: session.id,
        substitutionId,
        duties: `${course.title}（${course.gradeLevel}）${session.date} ${session.startTime}-${session.endTime} 授课及该时段学生看护`,
        validFrom: window.start.toISOString(),
        validTo: window.end.toISOString(),
        status: PassStatus.ACTIVE,
        enteredAt: null,
        exitedAt: null,
        createdAt: this.clock.now().toISOString(),
      }),
    );
    await this.audit.record(actor.sub, 'PASS_ISSUED', 'pass', pass.id, {
      sessionId,
      instructorId: session.instructorId,
      substitutionId,
      validFrom: pass.validFrom,
      validTo: pass.validTo,
    });
    return { pass, token };
  }

  /**
   * 门岗核验：只返回放行结论与必要身份摘要。
   * 每次扫码（含拒绝）都写回执；同一令牌的重复入校判定为重放并拒绝。
   * 放行前按当前时刻重新评估导师资格——课程开始后发现资格问题可立即拦截后续入校。
   */
  async verifyAtGate(
    guard: AuthUser,
    token: string,
    direction: GateDirection,
  ): Promise<GateVerifyResult> {
    const now = this.clock.now();
    const pass = await this.passes.findOne({ where: { tokenHash: sha256(token) } });

    const deny = async (
      reason: string,
      passId: string | null,
      extra?: Partial<GateVerifyResult>,
    ): Promise<GateVerifyResult> => {
      await this.recordEvent(guard, passId, direction, GateDecision.DENY, reason);
      return { decision: GateDecision.DENY, reason, ...extra };
    };

    if (!pass) {
      return deny('凭证不存在或已作废', null);
    }

    const instructor = await this.instructors.findOne({ where: { id: pass.instructorId } });
    const org = instructor
      ? await this.orgs.findOne({ where: { id: instructor.orgId } })
      : null;
    const summary = {
      instructor: {
        fullName: instructor?.fullName ?? '未知',
        orgName: org?.name ?? null,
        idNumberMasked: instructor ? maskIdNumber(instructor.idNumber) : '****',
      },
      pass: {
        id: pass.id,
        duties: pass.duties,
        validFrom: pass.validFrom,
        validTo: pass.validTo,
      },
    };

    if (direction === GateDirection.OUT) {
      // 出校不做资格拦截（安全优先），但要求已入校且未出校，否则记为异常拒绝
      if (pass.status !== PassStatus.USED || pass.exitedAt) {
        return deny('凭证状态异常（未入校或已出校）', pass.id, summary);
      }
      pass.exitedAt = now.toISOString();
      await this.passes.save(pass);
      await this.recordEvent(guard, pass.id, direction, GateDecision.ALLOW, null);
      return { decision: GateDecision.ALLOW, reason: null, ...summary };
    }

    // ---- 入校方向：完整校验链 ----
    if (pass.status === PassStatus.REVOKED) {
      return deny('凭证已被吊销', pass.id, summary);
    }
    if (pass.status === PassStatus.USED) {
      return deny('凭证重放：该凭证已完成入校，不可重复使用', pass.id, summary);
    }
    if (now.toISOString() < pass.validFrom) {
      return deny('尚未到可入校时间', pass.id, summary);
    }
    if (now.toISOString() > pass.validTo) {
      return deny('凭证已过期（超出当日职责时段）', pass.id, summary);
    }

    const session = await this.sessions.findOne({ where: { id: pass.sessionId } });
    const course = session
      ? await this.courses.findOne({ where: { id: session.courseId } })
      : null;
    if (!session || !course) {
      return deny('关联课次不存在', pass.id, summary);
    }
    const evalResult = await this.eligibility.evaluate(pass.instructorId, session, course);
    if (!evalResult.eligible) {
      return deny(`资格复核未通过：${evalResult.reasons.join('；')}`, pass.id, summary);
    }

    pass.status = PassStatus.USED;
    pass.enteredAt = now.toISOString();
    await this.passes.save(pass);
    await this.recordEvent(guard, pass.id, direction, GateDecision.ALLOW, null);
    return { decision: GateDecision.ALLOW, reason: null, ...summary };
  }

  /** 吊销凭证（异常处置用）；返回吊销数量 */
  async revokeWhere(
    predicate: (p: AccessPass) => boolean,
    actorUserId: string,
    reason: string,
  ): Promise<number> {
    const all = await this.passes.find();
    const targets = all.filter(
      (p) => p.status !== PassStatus.REVOKED && predicate(p),
    );
    for (const p of targets) {
      p.status = PassStatus.REVOKED;
      await this.passes.save(p);
      await this.audit.record(actorUserId, 'PASS_REVOKED', 'pass', p.id, { reason });
    }
    return targets.length;
  }

  private async recordEvent(
    guard: AuthUser,
    passId: string | null,
    direction: GateDirection,
    decision: GateDecision,
    denyReason: string | null,
  ): Promise<void> {
    await this.gateEvents.save(
      this.gateEvents.create({
        id: newId(),
        passId,
        direction,
        decision,
        denyReason,
        guardUserId: guard.sub,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }
}
