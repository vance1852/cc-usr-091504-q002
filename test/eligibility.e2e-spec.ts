import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  auth,
  createTestApp,
  Fixtures,
  MutableClock,
} from './helpers';
import { Role } from '../src/common/auth';
import { InstructorStatus } from '../src/entities/instructor.entity';
import { SubstitutionStatus } from '../src/entities/substitution.entity';
import { weekdayOf } from '../src/common/time.util';

/**
 * 资格边界：资质过期、核验未完成、被暂停、培训缺失、超出允许接触范围的人员
 * 一律不得代课（申请即判 ELIGIBILITY_FAILED，且无法确认）。
 */
describe('代课资格预审（不合格人员不得代课）', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let fx: Fixtures;

  const SESSION = { date: '2026-09-20', startTime: '18:00', endTime: '19:30' };

  let leadToken: string;
  let leadId: string;
  let orgId: string;
  let originalInstructorId: string;
  let sessionId: string;

  beforeAll(async () => {
    ({ app, clock, fx } = await createTestApp());
    clock.set('2026-09-20T12:00:00.000Z');

    const org = await fx.org('启航编程');
    orgId = org.id;
    const lead = await fx.userWithToken(Role.COURSE_LEAD);
    leadToken = lead.token;
    leadId = lead.user.id;

    const original = await fx.eligibleInstructor(orgId, SESSION);
    originalInstructorId = original.id;

    const course = await fx.course(leadId, 'G5');
    const session = await fx.session(course.id, originalInstructorId, SESSION);
    sessionId = session.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const requestSub = (substituteInstructorId: string) =>
    request(app.getHttpServer())
      .post('/substitutions')
      .set(auth(leadToken))
      .send({
        sessionId,
        substituteInstructorId,
        kind: 'NORMAL',
        reason: '原导师临时有事',
      });

  it('身份核验未完成的导师不得代课', async () => {
    const pending = await fx.instructor(orgId, { status: InstructorStatus.PENDING });
    await fx.qualification(pending.id, '2027-12-31T23:59:59.000Z');
    await fx.minorProtectionTraining(pending.id, '2027-12-31T23:59:59.000Z');
    await fx.clearance(pending.id, {
      gradeLevel: 'G5',
      weekday: weekdayOf(SESSION.date),
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    const res = await requestSub(pending.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
    expect(res.body.eligibilityReasons).toContain('身份核验未完成');

    // 资格预审未通过的申请不可确认
    const confirm = await request(app.getHttpServer())
      .post(`/substitutions/${res.body.id}/confirm`)
      .set(auth(leadToken));
    expect(confirm.status).toBe(400);
  });

  it('资质文件已过期的导师不得代课', async () => {
    const expired = await fx.instructor(orgId, { status: InstructorStatus.VERIFIED });
    // 资质在课次结束前已过期
    await fx.qualification(expired.id, '2026-09-01T00:00:00.000Z');
    await fx.minorProtectionTraining(expired.id, '2027-12-31T23:59:59.000Z');
    await fx.clearance(expired.id, {
      gradeLevel: 'G5',
      weekday: weekdayOf(SESSION.date),
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    const res = await requestSub(expired.id);
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
    expect(res.body.eligibilityReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('资质')]),
    );
  });

  it('资质在课次进行中途到期的导师同样不得代课', async () => {
    const midExpire = await fx.instructor(orgId, { status: InstructorStatus.VERIFIED });
    // 课次 18:00-19:30，资质 19:00 到期 —— 未覆盖全程
    await fx.qualification(midExpire.id, '2026-09-20T19:00:00.000Z');
    await fx.minorProtectionTraining(midExpire.id, '2027-12-31T23:59:59.000Z');
    await fx.clearance(midExpire.id, {
      gradeLevel: 'G5',
      weekday: weekdayOf(SESSION.date),
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    const res = await requestSub(midExpire.id);
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
  });

  it('缺少未成年人保护培训的导师不得代课', async () => {
    const noTraining = await fx.instructor(orgId, { status: InstructorStatus.VERIFIED });
    await fx.qualification(noTraining.id, '2027-12-31T23:59:59.000Z');
    await fx.clearance(noTraining.id, {
      gradeLevel: 'G5',
      weekday: weekdayOf(SESSION.date),
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    const res = await requestSub(noTraining.id);
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
    expect(res.body.eligibilityReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('未成年人保护培训')]),
    );
  });

  it('被暂停的导师不得代课', async () => {
    const suspended = await fx.eligibleInstructor(orgId, SESSION);
    await request(app.getHttpServer())
      .post(`/instructors/${suspended.id}/suspend`)
      .set(auth((await fx.userWithToken(Role.SAFETY_OFFICER)).token))
      .send({ reason: '收到投诉，暂停调查' });

    const res = await requestSub(suspended.id);
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
    expect(res.body.eligibilityReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('暂停')]),
    );
  });

  it('超出允许接触范围（年级/时段不匹配）的导师不得代课', async () => {
    const outOfScope = await fx.instructor(orgId, { status: InstructorStatus.VERIFIED });
    await fx.qualification(outOfScope.id, '2027-12-31T23:59:59.000Z');
    await fx.minorProtectionTraining(outOfScope.id, '2027-12-31T23:59:59.000Z');
    // 只允许 G2 年级，课次是 G5
    await fx.clearance(outOfScope.id, {
      gradeLevel: 'G2',
      weekday: weekdayOf(SESSION.date),
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    const res = await requestSub(outOfScope.id);
    expect(res.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
    expect(res.body.eligibilityReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('允许的接触范围')]),
    );
  });

  it('全部条件满足的导师可以进入待确认，并在确认后完成改派与凭证签发', async () => {
    const ok = await fx.eligibleInstructor(orgId, SESSION);
    const res = await requestSub(ok.id);
    expect(res.body.status).toBe(SubstitutionStatus.PENDING);

    const confirm = await request(app.getHttpServer())
      .post(`/substitutions/${res.body.id}/confirm`)
      .set(auth(leadToken));
    expect(confirm.status).toBe(201);
    expect(confirm.body.status).toBe(SubstitutionStatus.APPROVED);

    // 课次已改派给代课人
    const trace = await request(app.getHttpServer())
      .get(`/substitutions/${res.body.id}/trace`)
      .set(auth(leadToken));
    expect(trace.body.session.instructorId).toBe(ok.id);
    expect(trace.body.pass).toBeTruthy();
    expect(trace.body.pass.instructorId).toBe(ok.id);
    // 凭证仅覆盖当日当次课职责
    expect(trace.body.pass.validFrom).toBe('2026-09-20T17:30:00.000Z');
    expect(trace.body.pass.validTo).toBe('2026-09-20T20:00:00.000Z');
  });
});
