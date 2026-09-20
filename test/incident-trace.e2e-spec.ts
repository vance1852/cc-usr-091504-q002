import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createTestApp, Fixtures, MutableClock } from './helpers';
import { Role } from '../src/common/auth';
import { InstructorStatus } from '../src/entities/instructor.entity';
import { SubstitutionStatus } from '../src/entities/substitution.entity';
import { weekdayOf } from '../src/common/time.util';

/**
 * 课程开始后发现资格问题（完整时间线）：
 * 12:00 紧急代课双人确认 → 17:35 代课人扫码入校 → 18:30 课中发现资质过期
 * → 立即停止后续通行（今日+明日凭证吊销、课次标记待复核）
 * → 已发生授课、进出回执与接触范围保留供复核，负责人可全程追溯。
 */
describe('课中资格异常处置与全程追溯', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let fx: Fixtures;

  const TODAY = { date: '2026-09-20', startTime: '18:00', endTime: '19:30' };
  const TOMORROW = { date: '2026-09-21', startTime: '18:00', endTime: '19:30' };

  let leadToken: string;
  let safetyToken: string;
  let guardToken: string;
  let substituteId: string;
  let session1Id: string;
  let session2Id: string;
  let substitutionId: string;
  let token1: string;
  let token2: string;

  beforeAll(async () => {
    ({ app, clock, fx } = await createTestApp());

    const org = await fx.org();
    const lead = await fx.userWithToken(Role.COURSE_LEAD);
    leadToken = lead.token;
    safetyToken = (await fx.userWithToken(Role.SAFETY_OFFICER)).token;
    guardToken = (await fx.userWithToken(Role.GATE_GUARD)).token;

    const original = await fx.eligibleInstructor(org.id, TODAY);
    const substitute = await fx.eligibleInstructor(org.id, TODAY);
    substituteId = substitute.id;
    // 代课人同时持有明日（周一）同时段的接触范围，明日课次才能签发凭证
    await fx.clearance(substituteId, {
      gradeLevel: 'G5',
      weekday: weekdayOf(TOMORROW.date),
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    const course = await fx.course(lead.user.id, 'G5');
    await fx.student(course.id, '学生甲');
    await fx.student(course.id, '学生乙');

    const s1 = await fx.session(course.id, original.id, TODAY);
    session1Id = s1.id;
    const s2 = await fx.session(course.id, substituteId, TOMORROW);
    session2Id = s2.id;

    // ---- 12:00 紧急代课：负责人 + 安全员分别确认，批准响应一次性返回令牌 ----
    clock.set('2026-09-20T12:00:00.000Z');
    const created = await request(app.getHttpServer())
      .post('/substitutions')
      .set(auth(leadToken))
      .send({
        sessionId: session1Id,
        substituteInstructorId: substituteId,
        kind: 'EMERGENCY',
        reason: '原导师突发疾病',
      });
    substitutionId = created.body.id;
    await request(app.getHttpServer())
      .post(`/substitutions/${substitutionId}/confirm`)
      .set(auth(leadToken));
    const approved = await request(app.getHttpServer())
      .post(`/substitutions/${substitutionId}/confirm`)
      .set(auth(safetyToken));
    expect(approved.body.status).toBe(SubstitutionStatus.APPROVED);
    token1 = approved.body.issuedPassToken;
    expect(token1).toBeTruthy();

    // 明日课次凭证由负责人显式签发
    const issued2 = await request(app.getHttpServer())
      .post(`/sessions/${session2Id}/pass`)
      .set(auth(leadToken));
    expect(issued2.status).toBe(201);
    token2 = issued2.body.token;

    // ---- 17:35 代课人扫码入校（留下入校回执） ----
    clock.set('2026-09-20T17:35:00.000Z');
    const entry = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token: token1, direction: 'IN' });
    expect(entry.body.decision).toBe('ALLOW');

    // ---- 18:30 课中：安全员报告资格异常 ----
    clock.set('2026-09-20T18:30:00.000Z');
    const incident = await request(app.getHttpServer())
      .post('/incidents')
      .set(auth(safetyToken))
      .send({
        instructorId: substituteId,
        sessionId: session1Id,
        type: 'QUALIFICATION_EXPIRED',
        detail: '课中复核发现教师资格证已于上周到期',
      });
    expect(incident.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('异常处置立即停止后续通行：导师暂停、全部未消耗凭证吊销、课次标记待复核', async () => {
    // 导师已被暂停
    const profile = await request(app.getHttpServer())
      .get(`/instructors/${substituteId}`)
      .set(auth(safetyToken));
    expect(profile.body.status).toBe(InstructorStatus.SUSPENDED);
    expect(profile.body.suspensionReason).toContain('资格异常');

    // 今日凭证（已入校）被吊销 —— 再次扫码拒绝
    const againToday = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token: token1, direction: 'IN' });
    expect(againToday.body.decision).toBe('DENY');
    expect(againToday.body.reason).toContain('吊销');

    // 明日凭证同样被吊销 —— 即使拨到明日有效窗口内也拒绝
    clock.set('2026-09-21T17:35:00.000Z');
    const tomorrow = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token: token2, direction: 'IN' });
    expect(tomorrow.body.decision).toBe('DENY');
    expect(tomorrow.body.reason).toContain('吊销');

    // 课次已标记待复核（记录保留，未删除）
    const trace = await request(app.getHttpServer())
      .get(`/substitutions/${substitutionId}/trace`)
      .set(auth(leadToken));
    expect(trace.body.session.status).toBe('FLAGGED');
    expect(trace.body.pass.status).toBe('REVOKED');
  });

  it('已发生授课与接触范围保留供复核', async () => {
    const exposure = await request(app.getHttpServer())
      .get(`/instructors/${substituteId}/exposure`)
      .set(auth(safetyToken));
    expect(exposure.status).toBe(200);
    const occurred = exposure.body.occurredSessions;
    const ids = occurred.map((s: { sessionId: string }) => s.sessionId);
    // 今日课次已有入校回执，属于已发生；明日课次未发生不在其列
    expect(ids).toContain(session1Id);
    expect(ids).not.toContain(session2Id);
    const s1 = occurred.find((s: { sessionId: string }) => s.sessionId === session1Id);
    expect(s1.studentsExposed.length).toBe(2);
    expect(s1.studentsExposed.map((s: { fullName: string }) => s.fullName).sort()).toEqual([
      '学生乙',
      '学生甲',
    ]);
  });

  it('负责人可通过 trace 还原申请、审核、凭证、进出回执与异常处置全链路', async () => {
    const trace = await request(app.getHttpServer())
      .get(`/substitutions/${substitutionId}/trace`)
      .set(auth(leadToken));
    expect(trace.status).toBe(200);

    // 申请与双方确认
    expect(trace.body.request.status).toBe(SubstitutionStatus.APPROVED);
    expect(trace.body.request.kind).toBe('EMERGENCY');
    expect(trace.body.request.leadConfirmedAt).toBeTruthy();
    expect(trace.body.request.safetyConfirmedAt).toBeTruthy();
    expect(trace.body.request.leadConfirmedBy).not.toBe(trace.body.request.safetyConfirmedBy);

    // 进出回执：17:35 放行入校 + 事发后两次拒绝，全部留痕
    const decisions = trace.body.gateEvents.map((e: { decision: string }) => e.decision);
    expect(decisions).toContain('ALLOW');
    expect(decisions.filter((d: string) => d === 'DENY').length).toBeGreaterThanOrEqual(1);
    // 追溯响应不包含凭证明文令牌
    expect(JSON.stringify(trace.body)).not.toContain(token1);

    // 异常处置记录
    expect(trace.body.incidents.length).toBe(1);
    expect(trace.body.incidents[0].type).toBe('QUALIFICATION_EXPIRED');
    expect(trace.body.incidents[0].passesRevoked).toBe(2);
    expect(trace.body.incidents[0].sessionsFlagged).toBe(2);

    // 审计链覆盖关键动作
    const actions = trace.body.auditTrail.map((a: { action: string }) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'SUBSTITUTION_REQUESTED',
        'SUBSTITUTION_PARTIALLY_CONFIRMED',
        'SUBSTITUTION_APPROVED',
        'PASS_ISSUED',
        'PASS_REVOKED',
      ]),
    );
  });

  it('门岗无权上报异常，机构管理员无权查看追溯', async () => {
    const byGuard = await request(app.getHttpServer())
      .post('/incidents')
      .set(auth(guardToken))
      .send({ instructorId: substituteId, type: 'MANUAL_SUSPENSION', detail: '越权测试' });
    expect(byGuard.status).toBe(403);

    const orgAdmin = await fx.userWithToken(Role.ORG_ADMIN);
    const trace = await request(app.getHttpServer())
      .get(`/substitutions/${substitutionId}/trace`)
      .set(auth(orgAdmin.token));
    expect(trace.status).toBe(403);
  });
});
