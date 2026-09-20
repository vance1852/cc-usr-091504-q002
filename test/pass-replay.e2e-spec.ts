import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { auth, createTestApp, Fixtures, MutableClock } from './helpers';
import { Role } from '../src/common/auth';
import { GateEvent } from '../src/entities/gate-event.entity';

/**
 * 通行凭证边界：一次性入校、时间窗、重放拦截、吊销拦截、未知令牌、
 * 门岗响应只含放行结论与必要身份摘要，且每次扫码均留回执。
 */
describe('通行凭证与门岗核验（重放防护）', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let fx: Fixtures;
  let ds: DataSource;

  const SESSION = { date: '2026-09-20', startTime: '18:00', endTime: '19:30' };
  // 窗口：17:30 - 20:00（前后各 30 分钟缓冲）

  let leadToken: string;
  let guardToken: string;
  let safetyToken: string;
  let orgId: string;
  let courseId: string;

  beforeAll(async () => {
    ({ app, clock, fx, ds } = await createTestApp());
    const org = await fx.org();
    orgId = org.id;
    const lead = await fx.userWithToken(Role.COURSE_LEAD);
    leadToken = lead.token;
    guardToken = (await fx.userWithToken(Role.GATE_GUARD)).token;
    safetyToken = (await fx.userWithToken(Role.SAFETY_OFFICER)).token;
    const course = await fx.course(lead.user.id, 'G5');
    courseId = course.id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** 独立课次 + 合格导师 + 已签发凭证 */
  const setupPass = async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION);
    const session = await fx.session(courseId, inst.id, SESSION);
    const res = await request(app.getHttpServer())
      .post(`/sessions/${session.id}/pass`)
      .set(auth(leadToken));
    expect(res.status).toBe(201);
    return { token: res.body.token as string, passId: res.body.pass.id as string, inst };
  };

  const gateIn = (token: string) =>
    request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });

  const gateOut = (token: string) =>
    request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'OUT' });

  it('有效窗口内首次入校放行，且门岗只得到结论与必要身份摘要', async () => {
    const { token } = await setupPass();
    clock.set('2026-09-20T17:35:00.000Z');
    const res = await gateIn(token);
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe('ALLOW');
    // 必要身份摘要：姓名、机构、脱敏证件号、当日职责与窗口
    expect(res.body.instructor.fullName).toBeTruthy();
    expect(res.body.instructor.orgName).toBeTruthy();
    expect(res.body.instructor.idNumberMasked).toMatch(/^1101\*+.{4}$/);
    expect(res.body.pass.duties).toContain('2026-09-20');
    // 门岗响应结构最小化：只有结论、身份摘要、凭证窗口三类信息
    expect(Object.keys(res.body).sort()).toEqual(['decision', 'instructor', 'pass', 'reason']);
    expect(Object.keys(res.body.instructor).sort()).toEqual([
      'fullName',
      'idNumberMasked',
      'orgName',
    ]);
    expect(Object.keys(res.body.pass).sort()).toEqual(['duties', 'id', 'validFrom', 'validTo']);
    // 不得包含任何学生信息或未脱敏敏感字段
    expect(JSON.stringify(res.body)).not.toContain('guardianPhone');
    expect(res.body.instructor.idNumber).toBeUndefined();
    expect(res.body.instructor.phone).toBeUndefined();
  });

  it('同一令牌重复入校判定为重放并拒绝，且两次扫码都留回执', async () => {
    const { token, passId } = await setupPass();
    clock.set('2026-09-20T17:35:00.000Z');
    const first = await gateIn(token);
    expect(first.body.decision).toBe('ALLOW');

    clock.set('2026-09-20T17:36:00.000Z');
    const second = await gateIn(token);
    expect(second.body.decision).toBe('DENY');
    expect(second.body.reason).toContain('重放');

    const events = await ds
      .getRepository(GateEvent)
      .find({ where: { passId } });
    expect(events.length).toBe(2);
    expect(events.map((e) => e.decision).sort()).toEqual(['ALLOW', 'DENY']);
  });

  it('未到可入校时间拒绝', async () => {
    const { token } = await setupPass();
    clock.set('2026-09-20T17:00:00.000Z'); // 窗口 17:30 开始
    const res = await gateIn(token);
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('尚未到');
  });

  it('超出当日职责时段（含缓冲）拒绝', async () => {
    const { token } = await setupPass();
    clock.set('2026-09-20T20:00:01.000Z'); // 窗口 20:00 结束
    const res = await gateIn(token);
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('过期');
  });

  it('未知令牌拒绝且留痕（passId 为空）', async () => {
    clock.set('2026-09-20T17:35:00.000Z');
    const res = await gateIn('not-a-real-token');
    expect(res.body.decision).toBe('DENY');
    const events = await ds.getRepository(GateEvent).find();
    expect(events.some((e) => e.passId === null && e.decision === 'DENY')).toBe(true);
  });

  it('被吊销的凭证拒绝入校', async () => {
    const { token, inst } = await setupPass();
    // 安全员报告异常 → 凭证吊销
    await request(app.getHttpServer())
      .post('/incidents')
      .set(auth(safetyToken))
      .send({ instructorId: inst.id, type: 'MANUAL_SUSPENSION', detail: '测试吊销' });

    clock.set('2026-09-20T17:35:00.000Z');
    const res = await gateIn(token);
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('吊销');
  });

  it('出校流程：入校后可出校，重复出校或未入校出校均被拒并留痕', async () => {
    const { token, passId } = await setupPass();
    clock.set('2026-09-20T17:35:00.000Z');
    await gateIn(token);

    clock.set('2026-09-20T19:45:00.000Z');
    const out = await gateOut(token);
    expect(out.body.decision).toBe('ALLOW');

    const outAgain = await gateOut(token);
    expect(outAgain.body.decision).toBe('DENY');

    const events = await ds.getRepository(GateEvent).find({ where: { passId } });
    expect(events.length).toBe(3);
  });

  it('未入校直接出校视为异常并拒绝', async () => {
    const { token } = await setupPass();
    clock.set('2026-09-20T17:35:00.000Z');
    const res = await gateOut(token);
    expect(res.body.decision).toBe('DENY');
  });

  it('非门岗角色不能使用门岗核验接口', async () => {
    const { token } = await setupPass();
    const res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(leadToken))
      .send({ token, direction: 'IN' });
    expect(res.status).toBe(403);
  });
});
