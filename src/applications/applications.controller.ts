import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DbService } from '../database/database.service';
import { AuditService } from '../common/audit.service';
import { Roles } from '../common/roles.decorator';
import { Actor, iso } from '../domain';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  ConfirmationDto,
  CreateApplicationDto,
  GateScanDto,
  IncidentDto,
} from './dto';
import { PassesService } from './passes.service';

interface ApplicationRow {
  id: string;
  session_id: string;
  mentor_id: string;
  reason: string | null;
  status: string;
  requested_by: string;
  requested_at: number;
  lead_confirm_by: string | null;
  lead_confirm_at: number | null;
  security_confirm_by: string | null;
  security_confirm_at: number | null;
  decided_at: number | null;
  reject_step: string | null;
  reject_reason: string | null;
  emergency: number;
}

@Controller()
export class ApplicationsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly eligibility: EligibilityService,
    private readonly passes: PassesService,
  ) {}

  private loadApp(id: string): ApplicationRow {
    const a = this.db.db
      .prepare(`SELECT * FROM substitute_applications WHERE id = ?`)
      .get(id) as ApplicationRow | undefined;
    if (!a) throw new NotFoundException('application not found');
    return a;
  }

  private assertSchoolRole(actor: Actor) {
    if (actor.role !== 'program_lead' && actor.role !== 'campus_security') {
      throw new ForbiddenException('仅校方可追溯代课全流程');
    }
  }

  // ---------------- 申请 ----------------

  @Post('applications')
  @Roles('program_lead', 'agency_admin')
  create(@Req() req: any, @Body() dto: CreateApplicationDto) {
    const actor = req.actor as Actor;
    const session = this.db.db
      .prepare(`SELECT * FROM course_sessions WHERE id = ?`)
      .get(dto.sessionId) as any;
    if (!session) throw new BadRequestException('sessionId 不存在');
    const mentor = this.db.db
      .prepare(`SELECT * FROM mentors WHERE id = ?`)
      .get(dto.mentorId) as any;
    if (!mentor) throw new BadRequestException('mentorId 不存在');

    if (actor.role === 'agency_admin' && actor.agencyId !== mentor.agency_id) {
      throw new ForbiddenException('机构管理员只能为本机构导师申请代课');
    }

    // 同一课程时段不允许存在未终结的重复申请
    const dup = this.db.db
      .prepare(
        `SELECT id FROM substitute_applications
         WHERE session_id = ? AND mentor_id = ? AND status IN ('pending','lead_approved','approved')`,
      )
      .get(dto.sessionId, dto.mentorId);
    if (dup) throw new ConflictException('该导师本次课程已有进行中的代课申请');

    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO substitute_applications
           (id, session_id, mentor_id, reason, status, requested_by, requested_at, emergency)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, dto.sessionId, dto.mentorId, dto.reason ?? null, actor.userId, req.now, dto.emergency ? 1 : 0);

    // 提交即做一次资格预检并留痕；不阻断申请（正式批准与发证时 fail-closed）
    const pre = this.eligibility.evaluate(dto.mentorId, session.grade, session.subject, req.now);
    this.audit.record(actor, 'application.create', 'application', id, {
      sessionId: dto.sessionId,
      mentorId: dto.mentorId,
      emergency: !!dto.emergency,
      precheckEligible: pre.eligible,
      precheckIssues: pre.issues.map((i) => i.code),
    }, req.now);
    return { id, status: 'pending', precheck: pre };
  }

  @Get('applications')
  @Roles('program_lead', 'campus_security', 'agency_admin')
  list(@Req() req: any) {
    const actor = req.actor as Actor;
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
    const rows = this.db.db
      .prepare(
        `SELECT a.* FROM substitute_applications a
         JOIN mentors m ON m.id = a.mentor_id
         WHERE (?1 IS NULL OR a.session_id = ?1)
           AND (?2 != 'agency_admin' OR m.agency_id = ?3)
         ORDER BY a.requested_at DESC`,
      )
      .all(sessionId, actor.role, actor.agencyId ?? null) as unknown as ApplicationRow[];
    return rows.map((a) => this.serializeApp(a));
  }

  // ---------------- 双人确认 ----------------

  /**
   * 课程负责人确认教学必要性。结构上角色互斥 + 显式校验，
   * 保证两位确认人不可能是同一人。
   */
  @Post('applications/:id/lead-confirmation')
  @Roles('program_lead')
  leadConfirm(@Req() req: any, @Param('id') id: string, @Body() dto: ConfirmationDto) {
    const a = this.loadApp(id);
    if (a.status !== 'pending') {
      throw new ConflictException(`申请当前状态 ${a.status}，不可再由负责人确认`);
    }
    return this.applyConfirmation(req, a, 'lead', dto);
  }

  @Post('applications/:id/security-confirmation')
  @Roles('campus_security')
  securityConfirm(@Req() req: any, @Param('id') id: string, @Body() dto: ConfirmationDto) {
    const a = this.loadApp(id);
    if (a.status !== 'lead_approved') {
      throw new ConflictException(`申请当前状态 ${a.status}，须先经课程负责人确认`);
    }
    if (a.lead_confirm_by === req.actor.userId) {
      // 双角色账户体系下不可达，保留作纵深防御
      throw new ForbiddenException('课程负责人与安全人员须为不同人员分别确认');
    }
    return this.applyConfirmation(req, a, 'security', dto);
  }

  private applyConfirmation(req: any, a: ApplicationRow, step: 'lead' | 'security', dto: ConfirmationDto) {
    const session = this.db.db
      .prepare(`SELECT * FROM course_sessions WHERE id = ?`)
      .get(a.session_id) as any;
    const now = req.now as number;

    if (dto.decision === 'reject') {
      this.db.db
        .prepare(
          `UPDATE substitute_applications
             SET status = 'rejected', decided_at = ?, reject_step = ?, reject_reason = ?
           WHERE id = ?`,
        )
        .run(now, step, dto.reason ?? null, a.id);
      this.audit.record(req.actor, 'application.reject', 'application', a.id, {
        step,
        reason: dto.reason ?? null,
      }, now);
      return this.serializeApp(this.loadApp(a.id));
    }

    // approve：fail-closed。紧急换人也不豁免任何资格门槛。
    const result = this.eligibility.evaluate(a.mentor_id, session.grade, session.subject, now);
    if (!result.eligible) {
      this.audit.record(req.actor, 'application.confirm_blocked', 'application', a.id, {
        step,
        issues: result.issues.map((i) => i.code),
      }, now);
      throw new ConflictException({
        message: '资格门槛未满足，不能确认通过；可明确驳回或待资质补齐后再确认',
        eligibility: result,
      });
    }

    if (step === 'lead') {
      this.db.db
        .prepare(
          `UPDATE substitute_applications SET lead_confirm_by = ?, lead_confirm_at = ?, status = 'lead_approved'
           WHERE id = ?`,
        )
        .run(req.actor.userId, now, a.id);
      this.audit.record(req.actor, 'application.lead_approve', 'application', a.id, {}, now);
    } else {
      this.db.db
        .prepare(
          `UPDATE substitute_applications
             SET security_confirm_by = ?, security_confirm_at = ?, status = 'approved', decided_at = ?
           WHERE id = ?`,
        )
        .run(req.actor.userId, now, now, a.id);
      this.audit.record(req.actor, 'application.security_approve', 'application', a.id, {}, now);
    }
    return this.serializeApp(this.loadApp(a.id));
  }

  // ---------------- 当日凭证签发 ----------------

  @Post('applications/:id/pass')
  @Roles('program_lead')
  issuePass(@Req() req: any, @Param('id') id: string) {
    const actor = req.actor as Actor;
    const a = this.loadApp(id);
    if (a.status !== 'approved') {
      throw new ConflictException(`申请状态 ${a.status}，须双人确认完成后发证`);
    }
    const existing = this.db.db
      .prepare(`SELECT id FROM passes WHERE application_id = ?`)
      .get(a.id);
    if (existing) throw new ConflictException('该申请已签发凭证（一申请一凭证）');

    const session = this.db.db
      .prepare(`SELECT * FROM course_sessions WHERE id = ?`)
      .get(a.session_id) as any;
    const now = req.now as number;
    const win = this.passes.validityWindow(session);

    if (now >= win.slotEnd) throw new ConflictException('课程时段已结束，不再签发凭证');

    // 发证瞬间再次全量判定：确认后到发证前资质过期/被暂停同样拦截
    const result = this.eligibility.evaluate(a.mentor_id, session.grade, session.subject, now);
    if (!result.eligible) {
      this.audit.record(actor, 'pass.issue_blocked', 'application', a.id, {
        issues: result.issues.map((i) => i.code),
      }, now);
      throw new ConflictException({ message: '发证时资格复核未通过', eligibility: result });
    }

    const code = randomBytes(32).toString('hex'); // 不可枚举
    this.db.db
      .prepare(
        `INSERT INTO passes (id, application_id, mentor_id, session_id, scope_date,
           valid_from, valid_to, location, grades_json, subject, status, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      )
      .run(
        code,
        a.id,
        a.mentor_id,
        session.id,
        session.date,
        win.validFrom,
        win.validTo,
        session.location,
        JSON.stringify([session.grade]),
        session.subject,
        now,
      );
    this.audit.record(actor, 'pass.issue', 'pass', code, {
      applicationId: a.id,
      scopeDate: session.date,
      validFrom: iso(win.validFrom),
      validTo: iso(win.validTo),
      location: session.location,
      grades: [session.grade],
    }, now);
    return this.serializePass(this.db.db.prepare(`SELECT * FROM passes WHERE id = ?`).get(code));
  }

  // ---------------- 门岗：核验 / 进出 ----------------

  /**
   * 只返回放行结论与必要身份摘要。门岗拿不到花名册、机构资料或资质细节，
   * reasons 仅给出机器可读的拒绝码。
   */
  @Post('gate/passes/:code/verify')
  @Roles('gate_guard')
  @HttpCode(200)
  gateVerify(@Req() req: any, @Param('code') code: string, @Body() dto: GateScanDto) {
    return this.gateDecision(req, code, dto.gateId, false);
  }

  @Post('gate/passes/:code/entry')
  @Roles('gate_guard')
  @HttpCode(200)
  gateEntry(@Req() req: any, @Param('code') code: string, @Body() dto: GateScanDto) {
    return this.gateDecision(req, code, dto.gateId, 'entry');
  }

  @Post('gate/passes/:code/exit')
  @Roles('gate_guard')
  @HttpCode(200)
  gateExit(@Req() req: any, @Param('code') code: string, @Body() dto: GateScanDto) {
    return this.gateDecision(req, code, dto.gateId, 'exit');
  }

  private gateDecision(req: any, code: string, gateId: string, action: false | 'entry' | 'exit') {
    const actor = req.actor as Actor;
    const now = req.now as number;
    const pass = this.passes.loadPassByCode(code);
    if (!pass) {
      return { decision: 'deny' as const, gateId, at: iso(now), reasons: ['PASS_NOT_FOUND'] };
    }
    const mentor = this.db.db.prepare(`SELECT * FROM mentors WHERE id = ?`).get(pass.mentor_id) as any;
    const session = this.db.db.prepare(`SELECT * FROM course_sessions WHERE id = ?`).get(pass.session_id) as any;

    const reasons: string[] = [];

    const entryAllowedReceipt = this.db.db
      .prepare(
        `SELECT at FROM access_receipts
         WHERE pass_id = ? AND kind = 'entry' AND decision = 'allow' ORDER BY at ASC LIMIT 1`,
      )
      .get(pass.id) as { at: number } | undefined;
    const exitAllowedReceipt = this.db.db
      .prepare(
        `SELECT at FROM access_receipts
         WHERE pass_id = ? AND kind = 'exit' AND decision = 'allow' ORDER BY at DESC LIMIT 1`,
      )
      .get(pass.id) as { at: number } | undefined;

    if (action === 'entry') {
      // 重放防护：状态机只允许 ACTIVE 凭证入校
      if (pass.status === 'USED') reasons.push('ALREADY_ENTERED');
      if (pass.status === 'EXITED') reasons.push('ALREADY_EXITED');
      if (pass.status === 'REVOKED') reasons.push('PASS_REVOKED');
      if (now < pass.valid_from) reasons.push('NOT_WITHIN_WINDOW');
      if (now > pass.valid_to) reasons.push('PASS_WINDOW_CLOSED');
      // 入校瞬间实时复核资格：资质过期/核验撤销/暂停立即生效
      const eligibility = this.eligibility.evaluate(
        pass.mentor_id,
        session.grade,
        session.subject,
        now,
      );
      if (!eligibility.eligible) reasons.push(...eligibility.issues.map((i) => `ELIGIBILITY:${i.code}`));
    } else if (action === 'exit') {
      // 离校只看“是否确有入校记录/是否已离校”；
      // 被异常吊销的人员必须允许离校，但凭证不会因此恢复有效。
      if (!entryAllowedReceipt) reasons.push('NO_ENTRY_RECORD');
      if (exitAllowedReceipt) reasons.push('ALREADY_EXITED');
    } else {
      // 纯核验（不落回执）：返回当前完整判定结论
      if (pass.status === 'REVOKED') reasons.push('PASS_REVOKED');
      if (pass.status === 'EXITED') reasons.push('ALREADY_EXITED');
      if (now < pass.valid_from) reasons.push('NOT_WITHIN_WINDOW');
      if (now > pass.valid_to) reasons.push('PASS_WINDOW_CLOSED');
      const eligibility = this.eligibility.evaluate(
        pass.mentor_id,
        session.grade,
        session.subject,
        now,
      );
      if (!eligibility.eligible) reasons.push(...eligibility.issues.map((i) => `ELIGIBILITY:${i.code}`));
    }

    const decision: 'allow' | 'deny' = reasons.length === 0 ? 'allow' : 'deny';
    let late = false;

    if (action) {
      const receiptId = randomUUID();
      this.db.db
        .prepare(
          `INSERT INTO access_receipts (id, pass_id, kind, gate_id, guard_user_id, at, decision, deny_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receiptId,
          pass.id,
          action,
          gateId,
          actor.userId,
          now,
          decision,
          decision === 'deny' ? JSON.stringify(reasons) : null,
        );
      this.audit.record(actor, `gate.${action}`, 'pass', pass.id, {
        gateId,
        decision,
        reasons,
      }, now);

      if (decision === 'allow' && action === 'entry') {
        this.db.db.prepare(`UPDATE passes SET status = 'USED' WHERE id = ?`).run(pass.id);
      } else if (decision === 'allow' && action === 'exit') {
        late = now > pass.valid_to;
        if (pass.status === 'USED') {
          this.db.db.prepare(`UPDATE passes SET status = 'EXITED' WHERE id = ?`).run(pass.id);
        }
        // pass.status === 'ACTIVE'（理论上无入校记录，已被 NO_ENTRY_RECORD 拦截）
        // pass.status === 'REVOKED' 时保持 REVOKED，只登记离校回执
      }
    }

    const currentStatus = this.db.db
      .prepare(`SELECT status FROM passes WHERE id = ?`)
      .get(pass.id)?.status as string;

    return {
      decision,
      gateId,
      at: iso(now),
      passStatus: currentStatus,
      ...(reasons.length ? { reasons } : {}),
      // 无论放行与否，仅给出门岗必要身份摘要
      summary: this.passes.gateSummary(pass, mentor, session),
      ...(late ? { late: true } : {}),
    };
  }

  // ---------------- 异常处置 ----------------

  @Post('incidents')
  @Roles('program_lead', 'campus_security')
  reportIncident(@Req() req: any, @Body() dto: IncidentDto & { passId?: string }) {
    const actor = req.actor as Actor;
    if (!dto.passId) throw new BadRequestException('passId 必填');
    const pass = this.db.db.prepare(`SELECT * FROM passes WHERE id = ?`).get(dto.passId) as any;
    if (!pass) throw new NotFoundException('pass not found');

    const now = req.now as number;
    // 立即停止后续通行：只要凭证尚未完成离校，一律吊销
    const live = pass.status === 'ACTIVE' || pass.status === 'USED';
    if (live) {
      this.db.db
        .prepare(
          `UPDATE passes SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE id = ?`,
        )
        .run(now, `incident:${dto.type}`, pass.id);
    }

    // 冻结已发生授课与接触范围（快照不随后续任何操作改变）
    const snapshot = this.passes.contactSnapshot(pass, now);
    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO incidents (id, pass_id, application_id, mentor_id, type, detail, reported_by, at, action, contact_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        pass.id,
        pass.application_id,
        pass.mentor_id,
        dto.type,
        dto.detail ?? null,
        actor.userId,
        now,
        live ? 'pass_revoked' : 'none',
        JSON.stringify(snapshot),
      );
    this.audit.record(actor, 'incident.report', 'incident', id, {
      passId: pass.id,
      type: dto.type,
      action: live ? 'pass_revoked' : 'none',
      teachingOccurred: snapshot.teachingOccurred,
      contactedCount: snapshot.contactedStudents.length,
    }, now);
    if (live) {
      this.audit.record(actor, 'pass.revoke', 'pass', pass.id, {
        reason: `incident:${dto.type}`,
        incidentId: id,
      }, now);
    }
    return {
      id,
      passId: pass.id,
      type: dto.type,
      action: live ? 'pass_revoked' : 'none',
      passStatus: 'REVOKED',
      contactSnapshot: snapshot,
    };
  }

  @Post('passes/:id/revoke')
  @Roles('program_lead', 'campus_security')
  revokePass(@Req() req: any, @Param('id') id: string, @Body() body: { reason?: string }) {
    const pass = this.db.db.prepare(`SELECT * FROM passes WHERE id = ?`).get(id) as any;
    if (!pass) throw new NotFoundException('pass not found');
    if (pass.status === 'REVOKED') throw new ConflictException('凭证已吊销');
    this.db.db
      .prepare(`UPDATE passes SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE id = ?`)
      .run(req.now, body.reason ?? 'manual revoke', id);
    this.audit.record(req.actor, 'pass.revoke', 'pass', id, { reason: body.reason ?? null }, req.now);
    return { id, status: 'REVOKED' };
  }

  // ---------------- 追溯时间线 ----------------

  @Get('applications/:id/timeline')
  @Roles('program_lead', 'campus_security')
  timeline(@Req() req: any, @Param('id') id: string) {
    this.assertSchoolRole(req.actor);
    const a = this.loadApp(id);
    const pass = this.db.db
      .prepare(`SELECT * FROM passes WHERE application_id = ?`)
      .get(a.id) as any;
    const receipts = pass
      ? (this.db.db
          .prepare(`SELECT * FROM access_receipts WHERE pass_id = ? ORDER BY at ASC, id ASC`)
          .all(pass.id) as any[])
      : [];
    const incidents = pass
      ? (this.db.db
          .prepare(`SELECT * FROM incidents WHERE pass_id = ? ORDER BY at ASC, id ASC`)
          .all(pass.id) as any[])
      : [];

    const entityRefs = [{ type: 'application', id: a.id }];
    if (pass) entityRefs.push({ type: 'pass', id: pass.id });
    for (const inc of incidents) entityRefs.push({ type: 'incident', id: inc.id });
    const audit = this.audit.forEntities(entityRefs);

    return {
      application: this.serializeApp(a),
      pass: pass ? this.serializePass(pass) : null,
      receipts: receipts.map((r) => ({
        id: r.id,
        kind: r.kind,
        gateId: r.gate_id,
        guardUserId: r.guard_user_id,
        at: iso(r.at),
        decision: r.decision,
        denyReason: r.deny_reason ? JSON.parse(r.deny_reason) : null,
      })),
      incidents: incidents.map((i) => ({
        id: i.id,
        type: i.type,
        detail: i.detail,
        reportedBy: i.reported_by,
        at: iso(i.at),
        action: i.action,
        contactSnapshot: JSON.parse(i.contact_snapshot_json),
      })),
      auditTrail: audit.map((x: any) => ({
        seq: x.id,
        at: iso(x.at),
        actorUserId: x.actor_user_id,
        actorRole: x.actor_role,
        action: x.action,
        entityType: x.entity_type,
        entityId: x.entity_id,
        detail: JSON.parse(x.detail_json),
      })),
    };
  }

  @Get('passes/:id')
  @Roles('program_lead', 'campus_security', 'gate_guard')
  getPass(@Req() req: any, @Param('id') id: string) {
    const pass = this.db.db.prepare(`SELECT * FROM passes WHERE id = ?`).get(id) as any;
    if (!pass) throw new NotFoundException('pass not found');
    if (req.actor.role === 'gate_guard') {
      const mentor = this.db.db.prepare(`SELECT * FROM mentors WHERE id = ?`).get(pass.mentor_id) as any;
      const session = { location: pass.location } as any;
      return {
        id: pass.id,
        status: pass.status,
        summary: this.passes.gateSummary(pass, mentor, session),
      };
    }
    return this.serializePass(pass);
  }

  // ---------------- 序列化 ----------------

  private serializeApp(a: ApplicationRow) {
    return {
      id: a.id,
      sessionId: a.session_id,
      mentorId: a.mentor_id,
      reason: a.reason,
      status: a.status,
      emergency: !!a.emergency,
      requestedBy: a.requested_by,
      requestedAt: iso(a.requested_at),
      leadConfirmation:
        a.lead_confirm_by != null
          ? { by: a.lead_confirm_by, at: iso(a.lead_confirm_at) }
          : null,
      securityConfirmation:
        a.security_confirm_by != null
          ? { by: a.security_confirm_by, at: iso(a.security_confirm_at) }
          : null,
      decidedAt: iso(a.decided_at),
      rejectStep: a.reject_step,
      rejectReason: a.reject_reason,
    };
  }

  private serializePass(p: any) {
    return {
      id: p.id,
      applicationId: p.application_id,
      mentorId: p.mentor_id,
      sessionId: p.session_id,
      scopeDate: p.scope_date,
      validFrom: iso(p.valid_from),
      validTo: iso(p.valid_to),
      location: p.location,
      gradeScope: JSON.parse(p.grades_json),
      subject: p.subject,
      status: p.status,
      issuedAt: iso(p.issued_at),
      revokedAt: iso(p.revoked_at),
      revokeReason: p.revoke_reason,
    };
  }
}
