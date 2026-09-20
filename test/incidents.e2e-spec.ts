import { buildHarness, Harness, api } from './support/harness';
import { approveAndIssue, createSession, day, provisionMentor } from './support/fixtures';

const DATE = '2026-09-25';

describe('异常处置与代课全流程追溯', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  async function issuedPass() {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    const { appId, passId } = await approveAndIssue(h, session.id, m.mentorId, {
      submit: day(DATE, '13:00'), lead: day(DATE, '13:05'),
      security: day(DATE, '13:10'), issue: day(DATE, '15:00'),
    });
    return { appId, passId, session, mentor: m };
  }

  test('课程中发现资格问题：立即停止后续通行，已发生授课与接触范围冻结留存', async () => {
    const call = api(h);
    const { appId, passId } = await issuedPass();

    await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:45'))
      .expect(200);

    // 16:20 负责人发现导师资质异常，上报
    const inc = await call('post', '/incidents', h.actors.lead, {
      passId,
      type: 'credential_expired',
      detail: '巡检发现资质已于今晨过期，立即停止后续通行',
    }, day(DATE, '16:20')).expect(201);

    expect(inc.body.action).toBe('pass_revoked');
    expect(inc.body.passStatus).toBe('REVOKED');

    const snap = inc.body.contactSnapshot;
    expect(snap.teachingOccurred).toBe(true);
    expect(snap.enteredAt).toBe(new Date(day(DATE, '15:45')).toISOString());
    expect(snap.exitedAt).toBeNull();
    expect(snap.contactedStudents).toHaveLength(2);
    // 快照仅含最小学生信息，无校方备注
    expect(JSON.stringify(snap)).not.toContain('花生过敏');
    expect(snap.contactScope).toEqual({
      grades: ['G3'],
      subject: 'programming',
      location: '科创楼302',
    });

    // 后续通行立即停止：再次入校被拒
    const retry = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '16:25'))
      .expect(200);
    expect(retry.body.decision).toBe('deny');
    expect(retry.body.reasons).toContain('PASS_REVOKED');

    // 允许登记离校
    const exit = await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '16:40'))
      .expect(200);
    expect(exit.body.decision).toBe('allow');

    // 时间线包含申请、双确认、发证、进出回执、异常处置全链路
    const tl = await call('get', `/applications/${appId}/timeline`, h.actors.lead, undefined, day(DATE, '17:00'))
      .expect(200);
    expect(tl.body.application.status).toBe('approved');
    expect(tl.body.pass.status).toBe('REVOKED');

    const receipts = tl.body.receipts.map((r: any) => `${r.kind}:${r.decision}`);
    expect(receipts).toEqual(['entry:allow', 'entry:deny', 'exit:allow']);

    expect(tl.body.incidents).toHaveLength(1);
    expect(tl.body.incidents[0].type).toBe('credential_expired');
    // 事件快照在时间线中同样可复核
    expect(tl.body.incidents[0].contactSnapshot.contactedStudents).toHaveLength(2);

    const actions = tl.body.auditTrail.map((x: any) => x.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'application.create',
        'application.lead_approve',
        'application.security_approve',
        'pass.issue',
        'gate.entry',
        'incident.report',
        'pass.revoke',
      ]),
    );
    // 双人确认人分别留痕且不为同一人
    const leadBy = tl.body.application.leadConfirmation.by;
    const secBy = tl.body.application.securityConfirmation.by;
    expect(leadBy).not.toBe(secBy);
    expect(leadBy).toBe(h.actors.lead);
    expect(secBy).toBe(h.actors.security);
  });

  test('尚未入校即发现问题：吊销凭证，快照显示无实际接触', async () => {
    const call = api(h);
    const { passId } = await issuedPass();
    const inc = await call('post', '/incidents', h.actors.security, {
      passId, type: 'verification_revoked', detail: '核验复核未通过',
    }, day(DATE, '15:20')).expect(201);
    expect(inc.body.action).toBe('pass_revoked');
    expect(inc.body.contactSnapshot.teachingOccurred).toBe(false);
    expect(inc.body.contactSnapshot.contactedStudents).toEqual([]);

    const entry = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:45'))
      .expect(200);
    expect(entry.body.decision).toBe('deny');
    expect(entry.body.reasons).toContain('PASS_REVOKED');
  });

  test('机构管理员无权查看追溯时间线', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G3', subject: 'programming', createAdmin: true });
    const session = await createSession(h, {
      date: DATE, startTime: '16:00', endTime: '17:30', grade: 'G3', subject: 'programming',
    }, t);
    const { appId } = await approveAndIssue(h, session.id, m.mentorId, {
      submit: day(DATE, '13:00'), lead: day(DATE, '13:05'),
      security: day(DATE, '13:10'), issue: day(DATE, '15:00'),
    }, { requesterId: m.adminUserId });
    await call('get', `/applications/${appId}/timeline`, m.adminUserId!, undefined, t).expect(403);
  });

  test('正常完成的代课：时间线显示完整申请-审核-发证-入校-离校闭环', async () => {
    const call = api(h);
    const { appId, passId } = await issuedPass();
    await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:40'));
    await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '18:05')); // 迟离
    const tl = await call('get', `/applications/${appId}/timeline`, h.actors.security, undefined, day(DATE, '19:00'))
      .expect(200);
    expect(tl.body.pass.status).toBe('EXITED');
    const exit = tl.body.receipts.find((r: any) => r.kind === 'exit');
    expect(exit.decision).toBe('allow');

    // 驳回/撤销路径留痕：另起一例
    const t2 = day(DATE, '12:00');
    const m2 = await provisionMentor(h, { at: t2, grade: 'G3', subject: 'programming' });
    const s2 = await createSession(h, {
      date: DATE, startTime: '19:00', endTime: '20:00', grade: 'G3', subject: 'programming',
    }, t2);
    const app2 = (await call('post', '/applications', h.actors.lead, { sessionId: s2.id, mentorId: m2.mentorId }, t2)).body;
    await call('post', `/applications/${app2.id}/security-confirmation`, h.actors.security, { decision: 'reject', reason: '排队顺序错误' }, t2)
      .expect(409); // 未到安全步骤
    await call('post', `/applications/${app2.id}/lead-confirmation`, h.actors.lead, { decision: 'reject', reason: '不再需要' }, t2)
      .expect(201);
    const tl2 = await call('get', `/applications/${app2.id}/timeline`, h.actors.lead, undefined, t2).expect(200);
    expect(tl2.body.application.status).toBe('rejected');
    expect(tl2.body.application.rejectStep).toBe('lead');
    expect(tl2.body.pass).toBeNull();
  });
});
