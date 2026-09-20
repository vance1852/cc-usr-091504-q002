import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from '../database/database.service';
import {
  BUFFER_BEFORE_MIN,
  BUFFER_AFTER_MIN,
  composeSlotStart,
  composeSlotEnd,
  todayLocal,
} from '../domain';

/**
 * 仅当 SEED_ON_BOOT=1 时写入一套可演示/冒烟的数据：
 * - 三名校方用户（固定 ID，便于用 X-Actor-User-Id 直接扮演）
 * - 服务机构 + 机构管理员
 * - M1：资质/培训/核验/接触范围齐全的导师，已完成双人确认并签发当日凭证
 * - M2：开课前临时更换的新助教，有教学经历但身份核验与未保培训均未完成，
 *   存在一条 emergency=1 的待审批申请（批准会被 fail-closed 拦截）
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(private readonly db: DbService) {}

  onApplicationBootstrap(): void {
    if (process.env.SEED_ON_BOOT !== '1') return;
    const existing = this.db.db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
    if (existing.c > 0) return;

    const now = Date.now();
    const db = this.db.db;
    const DAY = 24 * 60 * 60 * 1000;

    const user = db.prepare(
      `INSERT INTO users (id, display_name, role, agency_id, mentor_id) VALUES (?, ?, ?, ?, ?)`,
    );
    user.run('u-lead', '课后课程负责人', 'program_lead', null, null);
    user.run('u-security', '校园安全人员', 'campus_security', null, null);
    user.run('u-guard', '东门门岗', 'gate_guard', null, null);

    db.prepare(`INSERT INTO agencies (id, name, status, created_at) VALUES (?, ?, 'active', ?)`)
      .run('ag-demo', '启点编程教育服务机构', now);
    user.run('u-admin', '机构管理员-启点', 'agency_admin', 'ag-demo', null);

    db.prepare(
      `INSERT INTO mentors (id, agency_id, full_name, id_document_no, phone, status,
         verification_status, verified_at, verified_by, created_at)
       VALUES (?, 'ag-demo', ?, ?, ?, 'active', 'verified', ?, 'u-security', ?)`,
    ).run('m-qualified', '陈资深（合格导师）', 'ID-DEMO-888888', '13900001111', now, now);

    db.prepare(
      `INSERT INTO mentors (id, agency_id, full_name, id_document_no, phone, status,
         verification_status, created_at)
       VALUES (?, 'ag-demo', ?, ?, ?, 'active', 'unverified', ?)`,
    ).run('m-newta', '林临时（新助教·未核验）', 'ID-DEMO-000001', '13900002222', now);

    user.run('u-mentor', '陈资深账户', 'mentor', 'ag-demo', 'm-qualified');

    const cred = db.prepare(
      `INSERT INTO credentials (id, mentor_id, type, file_ref, issued_at, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    );
    cred.run(randomBytes(8).toString('hex'), 'm-qualified', 'programming_teaching_cert',
      'oss://demo/cert-chen.pdf', now - 200 * DAY, now + 365 * DAY, now);
    cred.run(randomBytes(8).toString('hex'), 'm-newta', 'teaching_experience_statement',
      'oss://demo/exp-lin.pdf', now - 30 * DAY, now + 365 * DAY, now);

    db.prepare(
      `INSERT INTO trainings (id, mentor_id, type, completed_at, expires_at, provider)
       VALUES (?, ?, 'minor_protection', ?, ?, ?)`,
    ).run(randomBytes(8).toString('hex'), 'm-qualified', now - 10 * DAY, now + 365 * DAY,
      '区教育局未成年人保护中心');

    db.prepare(
      `INSERT INTO contact_authorizations (id, mentor_id, grade, subject, granted_at)
       VALUES (?, ?, 'G3', 'programming', ?)`,
    ).run(randomBytes(8).toString('hex'), 'm-qualified', now);

    // 课程安排在当前时间约 20 分钟后开始，持续 90 分钟。
    // 领域层约定：date + HH:MM 按同一时间帧组合为 epoch（与 composeSlotStart 一致），
    // date 仅作校园本地归属日标签；因此 HH:MM 组件直接取 epoch 的 UTC 字段。
    const pad = (n: number) => String(n).padStart(2, '0');
    const slotStart = Math.floor((now + 20 * 60_000) / 60_000) * 60_000;
    const slotEnd = slotStart + 90 * 60_000;
    const s0 = new Date(slotStart);
    const e0 = new Date(slotEnd);
    const date = todayLocal(slotStart);
    const startTime = `${pad(s0.getUTCHours())}:${pad(s0.getUTCMinutes())}`;
    const endTime = `${pad(e0.getUTCHours())}:${pad(e0.getUTCMinutes())}`;

    db.prepare(
      `INSERT INTO course_sessions (id, subject, grade, date, start_time, end_time, location,
         roster_json, default_mentor_id, created_by, created_at)
       VALUES ('s-demo', 'programming', 'G3', ?, ?, ?, '科创楼302', ?, 'm-qualified', 'u-lead', ?)`,
    ).run(date, startTime, endTime, JSON.stringify([
      { code: 'S-G3-018', name: '李同学', note: '花生过敏（仅校方可见）' },
      { code: 'S-G3-021', name: '王同学' },
    ]), now);

    const startMs = composeSlotStart(date, startTime);
    const endMs = composeSlotEnd(date, startTime, endTime);

    // M1：双人确认完成的申请 + ACTIVE 当日凭证
    db.prepare(
      `INSERT INTO substitute_applications
         (id, session_id, mentor_id, reason, status, requested_by, requested_at,
          lead_confirm_by, lead_confirm_at, security_confirm_by, security_confirm_at,
          decided_at, emergency)
       VALUES ('a-demo', 's-demo', 'm-qualified', '例行排课', 'approved', 'u-lead', ?,
          'u-lead', ?, 'u-security', ?, ?, 0)`,
    ).run(now - 30 * 60_000, now - 25 * 60_000, now - 20 * 60_000, now - 20 * 60_000);

    db.prepare(
      `INSERT INTO passes (id, application_id, mentor_id, session_id, scope_date,
         valid_from, valid_to, location, grades_json, subject, status, issued_at)
       VALUES ('p-demo', 'a-demo', 'm-qualified', 's-demo', ?, ?, ?, '科创楼302',
         '["G3"]', 'programming', 'ACTIVE', ?)`,
    ).run(date, startMs - BUFFER_BEFORE_MIN * 60_000, endMs + BUFFER_AFTER_MIN * 60_000, now - 15 * 60_000);

    // M2：开课前紧急换人的待审批申请（资格不全）
    db.prepare(
      `INSERT INTO substitute_applications
         (id, session_id, mentor_id, reason, status, requested_by, requested_at, emergency)
       VALUES ('a-demo-emergency', 's-demo', 'm-newta',
         '原导师路上突发状况，校外机构临时更换新助教', 'pending', 'u-admin', ?, 1)`,
    ).run(now - 5 * 60_000);

    // eslint-disable-next-line no-console
    console.log('[seed] 演示数据已写入。固定账户: u-lead / u-security / u-guard / u-admin / u-mentor');
    // eslint-disable-next-line no-console
    console.log(`[seed] 今日课程 ${date} ${startTime}-${endTime}（跨午夜: ${endTime <= startTime}）；合格导师凭证: p-demo`);
    // eslint-disable-next-line no-console
    console.log('[seed] 新助教紧急换人申请: a-demo-emergency（审批应被资格门槛拦截）');
  }
}
