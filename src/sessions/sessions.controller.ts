import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../database/database.service';
import { AuditService } from '../common/audit.service';
import { Roles } from '../common/roles.decorator';
import { Actor, composeSlotEnd, composeSlotStart, iso } from '../domain';
import { CreateSessionDto } from './dto';

interface SessionRow {
  id: string;
  subject: string;
  grade: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string;
  roster_json: string;
  default_mentor_id: string | null;
  created_by: string;
  created_at: number;
}

@Controller()
export class SessionsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private load(id: string): SessionRow {
    const s = this.db.db.prepare(`SELECT * FROM course_sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    if (!s) throw new NotFoundException('session not found');
    return s;
  }

  @Post('sessions')
  @Roles('program_lead')
  create(@Req() req: any, @Body() dto: CreateSessionDto) {
    if (dto.defaultMentorId) {
      const m = this.db.db
        .prepare(`SELECT id FROM mentors WHERE id = ?`)
        .get(dto.defaultMentorId);
      if (!m) throw new NotFoundException('defaultMentorId 不存在');
    }
    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO course_sessions
           (id, subject, grade, date, start_time, end_time, location, roster_json,
            default_mentor_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        dto.subject,
        dto.grade,
        dto.date,
        dto.startTime,
        dto.endTime,
        dto.location,
        JSON.stringify(dto.roster),
        dto.defaultMentorId ?? null,
        req.actor.userId,
        req.now,
      );
    this.audit.record(req.actor, 'session.create', 'session', id, {
      date: dto.date,
      grade: dto.grade,
      subject: dto.subject,
      rosterCount: dto.roster.length,
    }, req.now);
    return this.serialize(this.load(id), false);
  }

  private serialize(s: SessionRow, includeRoster: boolean) {
    const roster = JSON.parse(s.roster_json) as Array<{
      code: string;
      name: string;
      note?: string;
    }>;
    const startMs = composeSlotStart(s.date, s.start_time);
    const endMs = composeSlotEnd(s.date, s.start_time, s.end_time);
    return {
      id: s.id,
      subject: s.subject,
      grade: s.grade,
      date: s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      crossesMidnight: endMs - startMs > 0 && s.end_time <= s.start_time,
      startAt: iso(startMs),
      endAt: iso(endMs),
      location: s.location,
      defaultMentorId: s.default_mentor_id,
      rosterCount: roster.length,
      ...(includeRoster ? { roster } : {}),
    };
  }

  /** 课程元数据：任何已认证角色可见（不含花名册） */
  @Get('sessions/:id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.serialize(this.load(id), false);
  }

  /**
   * 学生最小信息读取：
   * - 课程负责人/安全人员：完整花名册（含校方备注）。
   * - 导师：仅当其对本节课程存在 approved 申请或有效凭证时，返回 code+name（不含备注），
   *   且只返回该节课程自己的花名册。
   * - 机构管理员/门岗：无权读取任何学生信息。
   */
  @Get('sessions/:id/roster')
  @Roles('program_lead', 'campus_security', 'mentor')
  roster(@Req() req: any, @Param('id') id: string) {
    const actor = req.actor as Actor;
    const s = this.load(id);
    const full = JSON.parse(s.roster_json) as Array<{ code: string; name: string; note?: string }>;

    if (actor.role === 'mentor') {
      const link = this.db.db
        .prepare(
          `SELECT a.status AS app_status, p.id AS pass_id, p.status AS pass_status
           FROM substitute_applications a
           LEFT JOIN passes p ON p.application_id = a.id
           WHERE a.session_id = ? AND a.mentor_id = ?
           ORDER BY a.requested_at DESC LIMIT 1`,
        )
        .get(id, (actor as any).mentorId) as
        | { app_status: string; pass_id: string | null; pass_status: string | null }
        | undefined;

      const approved =
        link?.app_status === 'approved' ||
        (link?.pass_status && ['ACTIVE', 'USED', 'EXITED'].includes(link.pass_status));
      if (!approved) {
        throw new ForbiddenException('导师只能读取本人当前课程所需的学生最小信息');
      }
      return {
        sessionId: id,
        roster: full.map((r) => ({ code: r.code, name: r.name })),
      };
    }

    // 校方角色：完整信息
    this.audit.record(actor, 'roster.read', 'session', id, { count: full.length }, req.now);
    return { sessionId: id, roster: full };
  }
}
