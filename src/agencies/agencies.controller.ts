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
import { CreateAgencyDto, CreateUserDto } from './dto';

@Controller()
export class AgenciesController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ---- 机构 ----

  @Post('agencies')
  @Roles('program_lead')
  createAgency(@Req() req: any, @Body() dto: CreateAgencyDto) {
    const id = randomUUID();
    const now = req.now as number;
    this.db.db
      .prepare(`INSERT INTO agencies (id, name, status, created_at) VALUES (?, ?, 'active', ?)`)
      .run(id, dto.name, now);
    this.audit.record(req.actor as Actor, 'agency.create', 'agency', id, { name: dto.name }, now);
    return { id, name: dto.name, status: 'active', createdAt: iso(now) };
  }

  @Get('agencies/:id')
  getAgency(@Req() req: any, @Param('id') id: string) {
    const a = this.db.db.prepare(`SELECT * FROM agencies WHERE id = ?`).get(id) as
      | { id: string; name: string; status: string; created_at: number }
      | undefined;
    if (!a) throw new NotFoundException('agency not found');

    // 机构管理员只能查看本机构；负责人/安全人员可查看任意机构
    const actor = req.actor as Actor;
    if (actor.role === 'agency_admin' && actor.agencyId !== a.id) {
      throw new ForbiddenException('机构管理员不得查看其他机构资料');
    }
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      createdAt: iso(a.created_at),
    };
  }

  @Patch('agencies/:id/suspension')
  @Roles('program_lead', 'campus_security')
  suspendAgency(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { suspended: boolean; reason?: string },
  ) {
    const a = this.db.db.prepare(`SELECT id FROM agencies WHERE id = ?`).get(id);
    if (!a) throw new NotFoundException('agency not found');
    const status = body.suspended ? 'suspended' : 'active';
    this.db.db.prepare(`UPDATE agencies SET status = ? WHERE id = ?`).run(status, id);
    this.audit.record(req.actor, 'agency.suspension', 'agency', id, {
      status,
      reason: body.reason ?? null,
    }, req.now);
    return { id, status };
  }

  // ---- 用户账户（由课程负责人开立）----

  @Post('users')
  @Roles('program_lead')
  createUser(@Req() req: any, @Body() dto: CreateUserDto) {
    if (dto.role === 'agency_admin') {
      if (!dto.agencyId) throw new BadRequestException('agency_admin 必须指定 agencyId');
      const a = this.db.db.prepare(`SELECT id FROM agencies WHERE id = ?`).get(dto.agencyId);
      if (!a) throw new BadRequestException('agencyId 不存在');
    }
    if (dto.role === 'mentor') {
      if (!dto.mentorId) throw new BadRequestException('mentor 账户必须指定 mentorId');
      const m = this.db.db.prepare(`SELECT id FROM mentors WHERE id = ?`).get(dto.mentorId);
      if (!m) throw new BadRequestException('mentorId 不存在');
    }
    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO users (id, display_name, role, agency_id, mentor_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, dto.displayName, dto.role, dto.agencyId ?? null, dto.mentorId ?? null);
    this.audit.record(req.actor, 'user.create', 'user', id, {
      role: dto.role,
      agencyId: dto.agencyId ?? null,
      mentorId: dto.mentorId ?? null,
    }, req.now);
    return { id, displayName: dto.displayName, role: dto.role };
  }
}
