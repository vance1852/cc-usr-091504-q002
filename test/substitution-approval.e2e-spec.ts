import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createTestApp, Fixtures, MutableClock } from './helpers';
import { Role } from '../src/common/auth';
import { SubstitutionStatus } from '../src/entities/substitution.entity';

/**
 * 紧急换人：必须由课程负责人与校园安全人员「分别」确认（两个不同账号）；
 * 普通代课只需课程负责人确认。批准前会重新评估资格。
 */
describe('代课确认流程（紧急换人双人分别确认）', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let fx: Fixtures;

  const SESSION = { date: '2026-09-20', startTime: '18:00', endTime: '19:30' };

  let leadToken: string;
  let leadId: string;
  let safetyToken: string;
  let guardToken: string;
  let orgAdminToken: string;
  let orgId: string;
  let courseId: string;
  let substituteId: string;

  beforeAll(async () => {
    ({ app, clock, fx } = await createTestApp());
    clock.set('2026-09-20T12:00:00.000Z');

    const org = await fx.org();
    orgId = org.id;
    const lead = await fx.userWithToken(Role.COURSE_LEAD);
    const safety = await fx.userWithToken(Role.SAFETY_OFFICER);
    const guard = await fx.userWithToken(Role.GATE_GUARD);
    const orgAdmin = await fx.userWithToken(Role.ORG_ADMIN, { orgId });
    leadToken = lead.token;
    leadId = lead.user.id;
    safetyToken = safety.token;
    guardToken = guard.token;
    orgAdminToken = orgAdmin.token;

    const course = await fx.course(leadId, 'G5');
    courseId = course.id;
    const substitute = await fx.eligibleInstructor(orgId, SESSION);
    substituteId = substitute.id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** 每个用例使用独立课次，避免改派后互相影响 */
  const newSession = async () => {
    const original = await fx.eligibleInstructor(orgId, SESSION);
    const session = await fx.session(courseId, original.id, SESSION);
    return session.id;
  };

  const createSub = (sessionId: string, kind: 'NORMAL' | 'EMERGENCY') =>
    request(app.getHttpServer())
      .post('/substitutions')
      .set(auth(leadToken))
      .send({ sessionId, substituteInstructorId: substituteId, kind, reason: '测试' });

  it('紧急代课：仅课程负责人确认不生效，需安全人员再确认', async () => {
    const sessionId = await newSession();
    const created = await createSub(sessionId, 'EMERGENCY');
    expect(created.body.status).toBe(SubstitutionStatus.PENDING);
    const id = created.body.id;

    const afterLead = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(leadToken));
    expect(afterLead.body.status).toBe(SubstitutionStatus.PENDING);
    expect(afterLead.body.leadConfirmedBy).toBeTruthy();
    expect(afterLead.body.safetyConfirmedBy).toBeNull();

    const afterSafety = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(safetyToken));
    expect(afterSafety.body.status).toBe(SubstitutionStatus.APPROVED);
    expect(afterSafety.body.safetyConfirmedBy).toBeTruthy();
    expect(afterSafety.body.leadConfirmedBy).not.toBe(afterSafety.body.safetyConfirmedBy);
  });

  it('紧急代课：安全人员先确认、负责人后确认同样生效', async () => {
    const sessionId = await newSession();
    const created = await createSub(sessionId, 'EMERGENCY');
    const id = created.body.id;

    await request(app.getHttpServer()).post(`/substitutions/${id}/confirm`).set(auth(safetyToken));
    const res = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(leadToken));
    expect(res.body.status).toBe(SubstitutionStatus.APPROVED);
  });

  it('同一角色不能重复确认', async () => {
    const sessionId = await newSession();
    const created = await createSub(sessionId, 'EMERGENCY');
    const id = created.body.id;

    await request(app.getHttpServer()).post(`/substitutions/${id}/confirm`).set(auth(leadToken));
    const dup = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(leadToken));
    expect(dup.status).toBe(400);
  });

  it('门岗与机构管理员无权确认代课', async () => {
    const sessionId = await newSession();
    const created = await createSub(sessionId, 'EMERGENCY');
    const id = created.body.id;

    const byGuard = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(guardToken));
    expect(byGuard.status).toBe(403);

    const byOrgAdmin = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(orgAdminToken));
    expect(byOrgAdmin.status).toBe(403);
  });

  it('普通代课：课程负责人单方确认即生效', async () => {
    const sessionId = await newSession();
    const created = await createSub(sessionId, 'NORMAL');
    const id = created.body.id;

    const res = await request(app.getHttpServer())
      .post(`/substitutions/${id}/confirm`)
      .set(auth(leadToken));
    expect(res.body.status).toBe(SubstitutionStatus.APPROVED);
  });

  it('申请后导师被暂停的，批准时重新评估并判为不合格', async () => {
    const sessionId = await newSession();
    const created = await createSub(sessionId, 'NORMAL');
    expect(created.body.status).toBe(SubstitutionStatus.PENDING);

    // 申请后、确认前：代课人被安全员暂停
    await request(app.getHttpServer())
      .post(`/instructors/${substituteId}/suspend`)
      .set(auth(safetyToken))
      .send({ reason: '批准前发现异常' });

    const confirm = await request(app.getHttpServer())
      .post(`/substitutions/${created.body.id}/confirm`)
      .set(auth(leadToken));
    expect(confirm.body.status).toBe(SubstitutionStatus.ELIGIBILITY_FAILED);
  });
});
