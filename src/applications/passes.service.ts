import { Injectable } from '@nestjs/common';
import { DbService } from '../database/database.service';
import { BUFFER_BEFORE_MIN, BUFFER_AFTER_MIN, composeSlotStart, composeSlotEnd } from '../domain';

@Injectable()
export class PassesService {
  constructor(private readonly db: DbService) {}

  /** 计算凭证时间窗：开课前 30 分钟 ~ 结课后 30 分钟（跨午夜自动顺延） */
  validityWindow(session: { date: string; start_time: string; end_time: string }) {
    const start = composeSlotStart(session.date, session.start_time);
    const end = composeSlotEnd(session.date, session.start_time, session.end_time);
    return {
      validFrom: start - BUFFER_BEFORE_MIN * 60_000,
      validTo: end + BUFFER_AFTER_MIN * 60_000,
      slotStart: start,
      slotEnd: end,
    };
  }

  loadPassByCode(code: string) {
    return this.db.db.prepare(`SELECT * FROM passes WHERE id = ?`).get(code) as
      | any
      | undefined;
  }

  /** 门岗可见的身份摘要：姓名 + 掩码证件号，不含任何学生信息或机构内部资料 */
  gateSummary(pass: any, mentor: any, session: any) {
    const doc = mentor.id_document_no as string;
    return {
      fullName: mentor.full_name,
      idDocumentNo: doc.length <= 4 ? '****' : `****${doc.slice(-4)}`,
      subject: pass.subject,
      gradeScope: JSON.parse(pass.grades_json),
      location: pass.location,
      scopeDate: pass.scope_date,
      validTo: new Date(pass.valid_to).toISOString(),
    };
  }

  /**
   * 已发生授课/接触范围快照。课程开始后发现资格问题时，
   * 用它冻结现场事实，后续吊销不会抹掉快照。
   */
  contactSnapshot(pass: any, at: number) {
    const session = this.db.db
      .prepare(`SELECT * FROM course_sessions WHERE id = ?`)
      .get(pass.session_id) as any;
    const entry = this.db.db
      .prepare(
        `SELECT at FROM access_receipts WHERE pass_id = ? AND kind = 'entry' AND decision = 'allow'
         ORDER BY at ASC LIMIT 1`,
      )
      .get(pass.id) as { at: number } | undefined;
    const exit = this.db.db
      .prepare(
        `SELECT at FROM access_receipts WHERE pass_id = ? AND kind = 'exit' AND decision = 'allow'
         ORDER BY at DESC LIMIT 1`,
      )
      .get(pass.id) as { at: number } | undefined;

    const roster = JSON.parse(session.roster_json) as Array<{
      code: string;
      name: string;
      note?: string;
    }>;
    const startedTeaching = !!entry;
    return {
      frozenAt: new Date(at).toISOString(),
      sessionId: session.id,
      subject: session.subject,
      grade: session.grade,
      scopeDate: session.date,
      location: session.location,
      slot: {
        start: new Date(composeSlotStart(session.date, session.start_time)).toISOString(),
        end: new Date(composeSlotEnd(session.date, session.start_time, session.end_time)).toISOString(),
        crossesMidnight: session.end_time <= session.start_time,
      },
      enteredAt: entry ? new Date(entry.at).toISOString() : null,
      exitedAt: exit ? new Date(exit.at).toISOString() : null,
      // 只有实际入校后才认定“已发生接触”，且仅保留最小学生信息（无校方备注）
      teachingOccurred: startedTeaching,
      contactedStudents: startedTeaching
        ? roster.map((r) => ({ code: r.code, name: r.name }))
        : [],
      contactScope: {
        grades: JSON.parse(pass.grades_json),
        subject: pass.subject,
        location: pass.location,
      },
    };
  }
}
