import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createTestApp, Fixtures, MutableClock } from './helpers';
import { Role } from '../src/common/auth';
import { InstructorStatus } from '../src/entities/instructor.entity';
import { SubstitutionStatus } from '../src/entities/substitution.entity';
import { weekdayOf } from '../src/common/time.util';

/**
 * 跨午夜课程：22:30 开始、次日 01:30 结束的课次。
 * 凭证窗口与允许接触范围都必须正确跨越零点，且只在当夜有效。
 */
describe('跨午夜课程（22:30 - 次日 01:30）', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let fx: Fixtures;

  const SESSION = { date: '2026-09-20', startTime: '22:30', endTime: '01:30' };
  // 凭证窗口应为 2026-09-20T22:00Z - 2026-09-21T02:00Z

  let leadToken: string;
  let guardToken: string;
  let orgId: string;
  let courseId: string;

  beforeAll(async () => {
    ({ app, clock, fx } = await createTestApp());
    const org = await fx.org();
    orgId = org.id;
    const lead = await fx.userWithToken(Role.COURSE_LEAD);
    leadToken = lead.token;
    guardToken = (await fx.userWithToken(Role.GATE_GUARD)).token;
    const course = await fx.course(lead.user.id, 'G5');
    courseId = course.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const newSession = async (instructorId: string) => {
    const session = await fx.session(courseId, instructorId, SESSION);
    return session.id;
  };

  it('接触范围跨午夜（22:00-02:00）时资格评估通过', async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const original = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const sessionId = await newSession(original.id);

    const res = await request(app.getHttpServer())
      .post('/substitutions')
      .set(auth(leadToken))
      .send({ sessionId, substituteInstructorId: inst.id, kind: 'NORMAL', reason: '跨午夜测试' });
    expect(res.body.status).toBe(SubstitutionStatus.PENDING);
  });

  it('接触范围在午夜前结束（22:00-01:00）不能覆盖到 01:30 的课次', async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '01:00',
    });
    const original = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const sessionId = await newSession(original.id);

    const res = await request(app.getHttpServer())
      .post('/substitutions')
      .set(auth(leadToken))
      .send({ sessionId, substituteInstructorId: inst.id, kind: 'NORMAL', reason: '跨午夜测试' });
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
  });

  it('仅当天 00:00-23:59 的范围同样覆盖不了跨零点时段', async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '00:00',
      end: '23:59',
    });
    const original = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const sessionId = await newSession(original.id);

    const res = await request(app.getHttpServer())
      .post('/substitutions')
      .set(auth(leadToken))
      .send({ sessionId, substituteInstructorId: inst.id, kind: 'NORMAL', reason: '跨午夜测试' });
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
  });

  it('凭证窗口正确跨越零点：22:00 前拒绝，22:00 后放行，零点后仍有效，次夜 02:00 后失效', async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const sessionId = await newSession(inst.id);
    const issued = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/pass`)
      .set(auth(leadToken));
    expect(issued.status).toBe(201);
    expect(issued.body.pass.validFrom).toBe('2026-09-20T22:00:00.000Z');
    expect(issued.body.pass.validTo).toBe('2026-09-21T02:00:00.000Z');
    const token = issued.body.token;

    // 21:59 尚未到可入校时间
    clock.set('2026-09-20T21:59:00.000Z');
    let res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('尚未到');

    // 22:05 放行
    clock.set('2026-09-20T22:05:00.000Z');
    res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });
    expect(res.body.decision).toBe('ALLOW');

    // 重放拦截
    clock.set('2026-09-20T22:06:00.000Z');
    res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('重放');
  });

  it('零点之后（次日 00:30）凭证依然有效', async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const sessionId = await newSession(inst.id);
    const issued = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/pass`)
      .set(auth(leadToken));
    const token = issued.body.token;

    clock.set('2026-09-21T00:30:00.000Z'); // 已跨零点
    const res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });
    expect(res.body.decision).toBe('ALLOW');
  });

  it('次日 02:00 缓冲结束后凭证失效；第二天同一时刻也不可再用', async () => {
    const inst = await fx.eligibleInstructor(orgId, SESSION, 'G5', {
      start: '22:00',
      end: '02:00',
    });
    const sessionId = await newSession(inst.id);
    const issued = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/pass`)
      .set(auth(leadToken));
    const token = issued.body.token;

    clock.set('2026-09-21T02:00:01.000Z');
    let res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });
    expect(res.body.decision).toBe('DENY');
    expect(res.body.reason).toContain('过期');

    clock.set('2026-09-21T22:30:00.000Z'); // 第二天同一时间
    res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token, direction: 'IN' });
    expect(res.body.decision).toBe('DENY');
  });

  it('跨午夜接触范围的星期按课次日期判定（次日凌晨不需要次日权限）', async () => {
    // 只授予课次日期当天（weekdayOf(2026-09-20)）的跨午夜窗口
    const inst = await fx.instructor(orgId, { status: InstructorStatus.VERIFIED });
    await fx.qualification(inst.id, '2027-12-31T23:59:59.000Z');
    await fx.minorProtectionTraining(inst.id, '2027-12-31T23:59:59.000Z');
    await fx.clearance(inst.id, {
      gradeLevel: 'G5',
      weekday: weekdayOf('2026-09-20'),
      windowStart: '22:00',
      windowEnd: '02:00',
    });
    const sessionId = await newSession(inst.id);

    clock.set('2026-09-21T00:15:00.000Z'); // 已是次日（星期已变）
    const issued = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/pass`)
      .set(auth(leadToken));
    expect(issued.status).toBe(201);
    const res = await request(app.getHttpServer())
      .post('/gate/verify')
      .set(auth(guardToken))
      .send({ token: issued.body.token, direction: 'IN' });
    expect(res.body.decision).toBe('ALLOW');
  });
});
