import request from 'supertest';
import { buildHarness, Harness, api } from './support/harness';
import { approveAndIssue, createMentorUser, createSession, day, provisionMentor } from './support/fixtures';

const DATE = '2026-09-25';

describe('权限边界与数据最小化', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  test('未携带身份头 -> 401；伪造用户 -> 401', async () => {
    await request(h.http).get('/sessions/whatever').expect(401);
    await request(h.http)
      .get('/sessions/whatever')
      .set('X-Actor-User-Id', 'u-not-exist')
      .expect(401);
  });

  test('角色越权：门岗不能建档导师，导师不能签发凭证', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const ag = (await call('post', '/agencies', h.actors.lead, { name: '机构甲' }, t)).body;
    await call('post', '/mentors', h.actors.guard, {
      fullName: 'x', idDocumentNo: 'ID-X-0001', agencyId: ag.id,
    }, t).expect(403);
  });

  test('机构管理员不能查看/操作其他机构资料，但可以访问本机构', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const a = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', createAdmin: true });
    const b = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });

    // 为机构 B 另开管理员
    const adminB = (await call('post', '/users', h.actors.lead, {
      displayName: '机构乙管理员', role: 'agency_admin', agencyId: b.agencyId,
    }, t)).body.id;

    await call('get', `/agencies/${b.agencyId}`, a.adminUserId!, undefined, t).expect(403);
    await call('get', `/mentors/${b.mentorId}`, a.adminUserId!, undefined, t).expect(403);
    await call('get', `/mentors/${a.mentorId}`, adminB, undefined, t).expect(403);

    // 本机构可读，且证件号默认掩码
    const mine = await call('get', `/mentors/${a.mentorId}`, a.adminUserId!, undefined, t).expect(200);
    expect(mine.body.agencyId).toBe(a.agencyId);
    expect(mine.body.idDocumentNo).toMatch(/^\*+/);
    expect(mine.body.idDocumentNo).not.toContain('ID-2026');
  });

  test('机构管理员只能为本机构导师申请代课', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const a = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', createAdmin: true });
    const b = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);

    await call('post', '/applications', a.adminUserId!, {
      sessionId: session.id, mentorId: b.mentorId,
    }, t).expect(403);
    await call('post', '/applications', a.adminUserId!, {
      sessionId: session.id, mentorId: a.mentorId,
    }, t).expect(201);
  });

  test('机构管理员的申请列表只含本机构', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const a = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', createAdmin: true });
    const b = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    await call('post', '/applications', h.actors.lead, { sessionId: session.id, mentorId: b.mentorId }, t);
    await call('post', '/applications', a.adminUserId!, { sessionId: session.id, mentorId: a.mentorId }, t);

    const list = await call('get', '/applications', a.adminUserId!, undefined, t).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].mentorId).toBe(a.mentorId);
  });

  test('导师只能读取当前课程所需学生最小信息，且看不到校方备注；其他课程不可读', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const mentorUser = await createMentorUser(h, m.mentorId, t);
    const s1 = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    const s2 = await createSession(h, {
      date: DATE, startTime: '18:00', endTime: '19:00', grade: 'G3', subject: 'programming',
    }, t);

    // 无 approved 申请前，花名册不可读
    await call('get', `/sessions/${s1.id}/roster`, mentorUser, undefined, t).expect(403);

    await approveAndIssue(h, s1.id, m.mentorId, {
      submit: day(DATE, '13:00'), lead: day(DATE, '13:05'),
      security: day(DATE, '13:10'), issue: day(DATE, '15:00'),
    });

    const roster = await call('get', `/sessions/${s1.id}/roster`, mentorUser, undefined, day(DATE, '15:30'))
      .expect(200);
    expect(roster.body.roster).toHaveLength(2);
    for (const r of roster.body.roster) {
      expect(Object.keys(r).sort()).toEqual(['code', 'name']);
      expect(r).not.toHaveProperty('note');
    }
    // 未授权的其他课程仍然不可读
    await call('get', `/sessions/${s2.id}/roster`, mentorUser, undefined, t).expect(403);
  });

  test('门岗与机构管理员均无权读取花名册', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const a = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', createAdmin: true });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    await call('get', `/sessions/${session.id}/roster`, h.actors.guard, undefined, t).expect(403);
    await call('get', `/sessions/${session.id}/roster`, a.adminUserId!, undefined, t).expect(403);
  });

  test('双人确认角色互斥：负责人不能执行安全确认，反之亦然', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    const app = (await call('post', '/applications', h.actors.lead, {
      sessionId: session.id, mentorId: m.mentorId,
    }, t)).body;

    await call('post', `/applications/${app.id}/security-confirmation`, h.actors.lead, { decision: 'approve' }, t)
      .expect(403);
    await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.security, { decision: 'approve' }, t)
      .expect(403);
  });

  test('门岗查询凭证只能得到状态与身份摘要，不含学生与资质细节', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    const { passId } = await approveAndIssue(h, session.id, m.mentorId, {
      submit: day(DATE, '13:00'), lead: day(DATE, '13:05'),
      security: day(DATE, '13:10'), issue: day(DATE, '15:00'),
    });

    const res = await call('get', `/passes/${passId}`, h.actors.guard, undefined, day(DATE, '15:30'))
      .expect(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('李同学');
    expect(json).not.toContain('花生过敏');
    expect(json).not.toContain('programming_teaching_cert');
    expect(res.body.summary.fullName).toBe('张编程');
    expect(res.body.summary.idDocumentNo).toMatch(/^\*+0123$/);
  });
});
