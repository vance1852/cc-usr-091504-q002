import { buildHarness, Harness, api } from './support/harness';
import { approveAndIssue, createSession, day, DAY, provisionMentor } from './support/fixtures';

const DATE = '2026-09-25';

describe('资格门槛：未核验 / 资质过期 / 培训缺失 / 越范围 / 被暂停', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  async function baseSession() {
    const t = day(DATE, '12:00');
    return createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
  }

  test('未完成身份核验：负责人确认即被拦截（紧急换人同样拦截）', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await baseSession();
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', verified: false });

    for (const emergency of [false, true]) {
      const app = (await call('post', '/applications', h.actors.lead, {
        sessionId: session.id, mentorId: m.mentorId, emergency,
      }, t)).body;
      const res = await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.lead, { decision: 'approve' }, t);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('NOT_VERIFIED');
      // 终结本次申请，避免与下一轮构造重复申请
      await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.lead, { decision: 'reject' }, t);
    }
  });

  test('缺少未成年人保护培训：审批被拦截', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await baseSession();
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', withTraining: false });
    const app = (await call('post', '/applications', h.actors.lead, {
      sessionId: session.id, mentorId: m.mentorId,
    }, t)).body;
    const res = await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.lead, { decision: 'approve' }, t);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('NO_MINOR_PROTECTION_TRAINING');
  });

  test('资质在审批后、发证前过期：发证时 fail-closed 拦截', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await baseSession();
    // 资质在 14:00 过期
    const m = await provisionMentor(h, {
      at: t, grade: 'G3', subject: 'programming', credExpiresAt: day(DATE, '14:00'),
    });
    const app = (await call('post', '/applications', h.actors.lead, {
      sessionId: session.id, mentorId: m.mentorId,
    }, day(DATE, '13:00'))).body;
    await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.lead, { decision: 'approve' }, day(DATE, '13:05'))
      .expect(201);
    await call('post', `/applications/${app.id}/security-confirmation`, h.actors.security, { decision: 'approve' }, day(DATE, '13:10'))
      .expect(201);
    const issue = await call('post', `/applications/${app.id}/pass`, h.actors.lead, {}, day(DATE, '15:00'));
    expect(issue.status).toBe(409);
    expect(JSON.stringify(issue.body)).toContain('CREDENTIAL_EXPIRED');
  });

  test('课程进行中资质到期：后续入校/核验被实时拒绝', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await baseSession();
    // 培训 16:30 到期（课程 16:00-17:30 进行中）
    const m = await provisionMentor(h, {
      at: t, grade: 'G3', subject: 'programming',
      trainingExpiresAt: day(DATE, '16:30'),
    });
    const { passId } = await approveAndIssue(h, session.id, m.mentorId, {
      submit: day(DATE, '13:00'), lead: day(DATE, '13:05'),
      security: day(DATE, '13:10'), issue: day(DATE, '15:40'),
    });
    await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:45'))
      .expect(200);
    // 导师出校取物料，16:35 试图再次入校：培训已过期 → 拒绝
    const res = await call('post', `/gate/passes/${passId}/verify`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '16:35'))
      .expect(200);
    expect(res.body.decision).toBe('deny');
    expect(res.body.reasons).toContain('ELIGIBILITY:TRAINING_EXPIRED');
    // 且门岗响应不含任何资质细节以外的学生信息
    expect(JSON.stringify(res.body)).not.toContain('李同学');
  });

  test('接触范围外（年级/课程不匹配）不得批准', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G5', subject: 'robotics',
    }, t);
    // 导师仅获授权 G3 programming
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const check = await call('get', `/mentors/${m.mentorId}/eligibility-check?grade=G5&subject=robotics`, h.actors.lead, undefined, t)
      .expect(200);
    expect(check.body.eligible).toBe(false);
    const codes = check.body.issues.map((i: any) => i.code);
    expect(codes).toContain('OUT_OF_SCOPE_GRADE');

    const app = (await call('post', '/applications', h.actors.lead, {
      sessionId: session.id, mentorId: m.mentorId,
    }, t)).body;
    const res = await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.lead, { decision: 'approve' }, t);
    expect(res.status).toBe(409);
  });

  test('被暂停导师：审批被拦截；暂停即时吊销在用凭证', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await baseSession();

    // 1) 暂停状态不可批准
    const m1 = await provisionMentor(h, {
      at: t, grade: 'G3', subject: 'programming', suspended: true,
    });
    const app1 = (await call('post', '/applications', h.actors.lead, {
      sessionId: session.id, mentorId: m1.mentorId,
    }, t)).body;
    const blocked = await call('post', `/applications/${app1.id}/lead-confirmation`, h.actors.lead, { decision: 'approve' }, t);
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('MENTOR_SUSPENDED');

    // 2) 已入校导师被暂停：凭证立即吊销，门岗随即拒绝
    const m2 = await provisionMentor(h, {
      at: t, grade: 'G3', subject: 'programming', idDocumentNo: 'ID-2026-000777',
    });
    const { passId } = await approveAndIssue(h, session.id, m2.mentorId, {
      submit: day(DATE, '13:00'), lead: day(DATE, '13:05'),
      security: day(DATE, '13:10'), issue: day(DATE, '15:40'),
    });
    await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:45'))
      .expect(200);
    const susp = await call('patch', `/mentors/${m2.mentorId}/suspension`, h.actors.security, {
      suspended: true, reason: '接到投诉需立即停课',
    }, day(DATE, '16:20')).expect(200);
    expect(susp.body.revokedPasses).toEqual([passId]);

    const verify = await call('post', `/gate/passes/${passId}/verify`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '16:21'))
      .expect(200);
    expect(verify.body.decision).toBe('deny');
    expect(verify.body.reasons).toContain('PASS_REVOKED');
    expect(verify.body.reasons).toContain('ELIGIBILITY:MENTOR_SUSPENDED');

    // 被吊销人员仍可登记离校（不能滞留校内），凭证不复活
    const exit = await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '16:30'))
      .expect(200);
    expect(exit.body.decision).toBe('allow');
    expect(exit.body.passStatus).toBe('REVOKED');
  });

  test('安全顺序：必须先负责人确认，安全确认不能抢先；驳回即终结', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const session = await baseSession();
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const app = (await call('post', '/applications', h.actors.lead, {
      sessionId: session.id, mentorId: m.mentorId,
    }, t)).body;

    await call('post', `/applications/${app.id}/security-confirmation`, h.actors.security, { decision: 'approve' }, t)
      .expect(409);

    await call('post', `/applications/${app.id}/lead-confirmation`, h.actors.lead, {
      decision: 'reject', reason: '课程已取消',
    }, t).expect(201);
    // 已驳回不可再确认
    await call('post', `/applications/${app.id}/security-confirmation`, h.actors.security, { decision: 'approve' }, t)
      .expect(409);
    // 驳回不可发证
    await call('post', `/applications/${app.id}/pass`, h.actors.lead, {}, t).expect(409);
  });

  test('机构被暂停：导师资格同步失效', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const check1 = await call('get', `/mentors/${m.mentorId}/eligibility-check?grade=G3&subject=programming`, h.actors.lead, undefined, t)
      .expect(200);
    expect(check1.body.eligible).toBe(true);
    await call('patch', `/agencies/${m.agencyId}/suspension`, h.actors.lead, { suspended: true, reason: '年检未过' }, t)
      .expect(200);
    const check2 = await call('get', `/mentors/${m.mentorId}/eligibility-check?grade=G3&subject=programming`, h.actors.lead, undefined, t)
      .expect(200);
    expect(check2.body.eligible).toBe(false);
    expect(check2.body.issues.map((i: any) => i.code)).toContain('AGENCY_SUSPENDED');
    void DAY;
  });
});
