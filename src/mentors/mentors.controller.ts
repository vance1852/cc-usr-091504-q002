import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../database/database.service';
import { AuditService } from '../common/audit.service';
import { Roles } from '../common/roles.decorator';
import { Actor, iso } from '../domain';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  ContactAuthDto,
  CreateCredentialDto,
  CreateMentorDto,
  CreateTrainingDto,
  VerificationDecisionDto,
} from './dto';

interface MentorRow {
  id: string;
  agency_id: string;
  full_name: string;
  id_document_no: string;
  phone: string | null;
  status: string;
  verification_status: string;
  verified_at: number | null;
  verified_by: string | null;
  created_at: number;
}

@Controller()
export class MentorsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly eligibility: EligibilityService,
  ) {}

  private load(id: string): MentorRow {
    const m = this.db.db.prepare(`SELECT * FROM mentors WHERE id = ?`).get(id) as
      | MentorRow
      | undefined;
    if (!m) throw new NotFoundException('mentor not found');
    return m;
  }

  /** 机构管理员只能操作本机构导师；否则 403 */
  private assertSameAgency(actor: Actor, mentor: MentorRow): void {
    if (actor.role === 'agency_admin' && actor.agencyId !== mentor.agency_id) {
      throw new ForbiddenException('机构管理员不得查看或操作其他机构资料');
    }
  }

  private maskDocNo(doc: string): string {
    return doc.length <= 4 ? '****' : `****${doc.slice(-4)}`;
  }

  private serialize(
    m: MentorRow,
    actor: Actor,
    now: number,
    opts: { includeSensitive?: boolean } = {},
  ) {
    const includeSensitive =
      opts.includeSensitive ??
      (actor.role === 'program_lead' || actor.role === 'campus_security');
    return {
      id: m.id,
      agencyId: m.agency_id,
      fullName: m.full_name,
      phone: m.phone,
      status: m.status,
      verificationStatus: m.verification_status,
      verifiedAt: iso(m.verified_at),
      verifiedBy: m.verified_by,
      idDocumentNo: includeSensitive ? m.id_document_no : this.maskDocNo(m.id_document_no),
      credentials: this.db.db
        .prepare(`SELECT * FROM credentials WHERE mentor_id = ? ORDER BY issued_at DESC`)
        .all(m.id)
        .map((c: any) => ({
          id: c.id,
          type: c.type,
          fileRef: c.file_ref,
          issuedAt: iso(c.issued_at),
          expiresAt: iso(c.expires_at),
          status: c.status,
          expired: c.expires_at <= now,
        })),
      trainings: this.db.db
        .prepare(`SELECT * FROM trainings WHERE mentor_id = ? ORDER BY completed_at DESC`)
        .all(m.id)
        .map((t: any) => ({
          id: t.id,
          type: t.type,
          completedAt: iso(t.completed_at),
          expiresAt: iso(t.expires_at),
          provider: t.provider,
          expired: t.expires_at <= now,
        })),
      contactAuthorizations: this.db.db
        .prepare(
          `SELECT id, grade, subject, granted_at, revoked_at FROM contact_authorizations
           WHERE mentor_id = ? ORDER BY grade, subject`,
        )
        .all(m.id)
        .map((a: any) => ({
          id: a.id,
          grade: a.grade,
          subject: a.subject,
          grantedAt: iso(a.granted_at),
          revokedAt: iso(a.revoked_at),
        })),
    };
  }

  @Post('mentors')
  @Roles('program_lead', 'agency_admin')
  create(@Req() req: any, @Body() dto: CreateMentorDto) {
    const actor = req.actor as Actor;
    if (actor.role === 'agency_admin' && actor.agencyId !== dto.agencyId) {
      throw new ForbiddenException('机构管理员只能为本机构建档导师');
    }
    const agency = this.db.db.prepare(`SELECT id FROM agencies WHERE id = ?`).get(dto.agencyId);
    if (!agency) throw new BadRequestException('agencyId 不存在');

    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO mentors (id, agency_id, full_name, id_document_no, phone, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(id, dto.agencyId, dto.fullName, dto.idDocumentNo, dto.phone ?? null, req.now);
    this.audit.record(actor, 'mentor.create', 'mentor', id, {
      agencyId: dto.agencyId,
      fullName: dto.fullName,
    }, req.now);
    return this.serialize(this.load(id), actor, req.now);
  }

  @Get('mentors/:id')
  @Roles('program_lead', 'campus_security', 'agency_admin', 'mentor')
  get(@Req() req: any, @Param('id') id: string) {
    const actor = req.actor as Actor;
    const m = this.load(id);
    if (actor.role === 'mentor' && (actor as any).mentorId !== m.id) {
      throw new ForbiddenException('导师只能读取本人档案');
    }
    this.assertSameAgency(actor, m);
    return this.serialize(m, actor, req.now);
  }

  @Get('mentors/:id/eligibility-check')
  @Roles('program_lead', 'campus_security', 'agency_admin')
  checkEligibility(
    @Req() req: any,
    @Param('id') id: string,
  ) {
    const actor = req.actor as Actor;
    const m = this.load(id);
    this.assertSameAgency(actor, m);
    const grade = String(req.query.grade ?? '');
    const subject = String(req.query.subject ?? '');
    if (!grade || !subject) throw new BadRequestException('grade 与 subject 必填');
    const result = this.eligibility.evaluate(id, grade, subject, req.now);
    return { mentorId: id, at: iso(req.now), grade, subject, ...result };
  }

  // ---- 资质文件 ----

  @Post('mentors/:id/credentials')
  @Roles('program_lead', 'agency_admin')
  addCredential(@Req() req: any, @Param('id') id: string, @Body() dto: CreateCredentialDto) {
    const actor = req.actor as Actor;
    const m = this.load(id);
    this.assertSameAgency(actor, m);
    if (dto.expiresAt <= dto.issuedAt) {
      throw new BadRequestException('expiresAt 必须晚于 issuedAt');
    }
    const cid = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO credentials (id, mentor_id, type, file_ref, issued_at, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(cid, id, dto.type, dto.fileRef, dto.issuedAt, dto.expiresAt, req.now);
    this.audit.record(actor, 'credential.add', 'mentor', id, {
      credentialId: cid,
      type: dto.type,
      expiresAt: iso(dto.expiresAt),
    }, req.now);
    return { id: cid };
  }

  @Patch('credentials/:credentialId/revoke')
  @Roles('program_lead', 'campus_security')
  revokeCredential(@Req() req: any, @Param('credentialId') credentialId: string) {
    const c = this.db.db.prepare(`SELECT * FROM credentials WHERE id = ?`).get(credentialId) as
      | { mentor_id: string; status: string }
      | undefined;
    if (!c) throw new NotFoundException('credential not found');
    this.db.db.prepare(`UPDATE credentials SET status = 'revoked' WHERE id = ?`).run(credentialId);
    this.audit.record(req.actor, 'credential.revoke', 'mentor', c.mentor_id, {
      credentialId,
    }, req.now);
    return { id: credentialId, status: 'revoked' };
  }

  // ---- 培训记录 ----

  @Post('mentors/:id/trainings')
  @Roles('program_lead', 'agency_admin')
  addTraining(@Req() req: any, @Param('id') id: string, @Body() dto: CreateTrainingDto) {
    const actor = req.actor as Actor;
    const m = this.load(id);
    this.assertSameAgency(actor, m);
    if (dto.expiresAt <= dto.completedAt) {
      throw new BadRequestException('expiresAt 必须晚于 completedAt');
    }
    const tid = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO trainings (id, mentor_id, type, completed_at, expires_at, provider)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tid, id, dto.type, dto.completedAt, dto.expiresAt, dto.provider);
    this.audit.record(actor, 'training.add', 'mentor', id, {
      trainingId: tid,
      type: dto.type,
      expiresAt: iso(dto.expiresAt),
    }, req.now);
    return { id: tid };
  }

  // ---- 接触授权 ----

  @Post('mentors/:id/contact-authorizations')
  @Roles('program_lead', 'campus_security')
  grantContact(@Req() req: any, @Param('id') id: string, @Body() dto: ContactAuthDto) {
    const m = this.load(id);
    const existing = this.db.db
      .prepare(
        `SELECT * FROM contact_authorizations WHERE mentor_id = ? AND grade = ? AND subject = ?`,
      )
      .get(id, dto.grade, dto.subject) as
      | { id: string; revoked_at: number | null }
      | undefined;

    let authId: string;
    if (existing) {
      if (existing.revoked_at === null) {
        throw new BadRequestException('该接触范围授权已存在且有效');
      }
      this.db.db
        .prepare(`UPDATE contact_authorizations SET granted_at = ?, revoked_at = NULL WHERE id = ?`)
        .run(req.now, existing.id);
      authId = existing.id;
    } else {
      authId = randomUUID();
      this.db.db
        .prepare(
          `INSERT INTO contact_authorizations (id, mentor_id, grade, subject, granted_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(authId, id, dto.grade, dto.subject, req.now);
    }
    this.audit.record(req.actor, 'contact.grant', 'mentor', id, {
      grade: dto.grade,
      subject: dto.subject,
    }, req.now);
    return { id: authId, grade: dto.grade, subject: dto.subject };
  }

  @Patch('contact-authorizations/:authId/revoke')
  @Roles('program_lead', 'campus_security')
  revokeContact(@Req() req: any, @Param('authId') authId: string) {
    const a = this.db.db
      .prepare(`SELECT * FROM contact_authorizations WHERE id = ?`)
      .get(authId) as { mentor_id: string; revoked_at: number | null } | undefined;
    if (!a) throw new NotFoundException('authorization not found');
    if (a.revoked_at !== null) throw new BadRequestException('授权已被撤销');
    this.db.db
      .prepare(`UPDATE contact_authorizations SET revoked_at = ? WHERE id = ?`)
      .run(req.now, authId);
    this.audit.record(req.actor, 'contact.revoke', 'mentor', a.mentor_id, {
      authorizationId: authId,
    }, req.now);
    return { id: authId, revokedAt: iso(req.now) };
  }

  // ---- 身份核验（仅校园安全人员）----

  @Patch('mentors/:id/verification')
  @Roles('campus_security')
  verify(@Req() req: any, @Param('id') id: string, @Body() dto: VerificationDecisionDto) {
    const m = this.load(id);
    this.db.db
      .prepare(
        `UPDATE mentors SET verification_status = ?, verified_at = ?, verified_by = ? WHERE id = ?`,
      )
      .run(dto.decision, req.now, req.actor.userId, id);
    this.audit.record(req.actor, 'mentor.verify', 'mentor', id, {
      decision: dto.decision,
      note: dto.note ?? null,
    }, req.now);
    return { id, verificationStatus: dto.decision, verifiedAt: iso(req.now) };
  }

  // ---- 暂停 / 恢复导师 ----

  @Patch('mentors/:id/suspension')
  @Roles('program_lead', 'campus_security')
  suspend(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { suspended: boolean; reason?: string },
  ) {
    const m = this.load(id);
    const status = body.suspended ? 'suspended' : 'active';
    this.db.db.prepare(`UPDATE mentors SET status = ? WHERE id = ?`).run(status, id);
    this.audit.record(req.actor, 'mentor.suspend', 'mentor', id, {
      status,
      reason: body.reason ?? null,
    }, req.now);

    // 暂停即时生效：吊销该导师所有未结束的当日凭证
    let live: Array<{ id: string }> = [];
    if (body.suspended) {
      live = this.db.db
        .prepare(
          `SELECT id FROM passes WHERE mentor_id = ? AND status IN ('ACTIVE','USED')`,
        )
        .all(id) as unknown as Array<{ id: string }>;
      const revoke = this.db.db
        .prepare(`UPDATE passes SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE id = ?`);
      for (const p of live) {
        revoke.run(req.now, 'mentor suspended', p.id);
        this.audit.record(req.actor, 'pass.auto_revoke', 'pass', p.id, {
          reason: 'mentor suspended',
        }, req.now);
      }
    }
    return { id, status, revokedPasses: body.suspended ? live.map((p) => p.id) : [] };
  }
}
