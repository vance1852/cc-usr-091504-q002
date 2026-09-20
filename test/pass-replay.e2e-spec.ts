import { buildHarness, Harness, api } from './support/harness';
import { approveAndIssue, createSession, day, DAY, MIN, provisionMentor } from './support/fixtures';

const DATE = '2026-09-25';

describe('凭证重放、时间窗与门岗状态机', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  async function setupPass() {
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
    return { passId, session, mentor: m };
  }

  test('凭证不可枚举：随机/伪造编码直接 deny，且不泄露存在性', async () => {
    const { passId } = await setupPass();
    expect(passId).toHaveLength(64);
    const res = await api(h)('post', '/gate/passes/deadbeefdeadbeef/verify', h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:40'))
      .expect(200);
    expect(res.body.decision).toBe('deny');
    expect(res.body.reasons).toEqual(['PASS_NOT_FOUND']);
    expect(res.body.summary).toBeUndefined();
  });

  test('窗外不可入校（开课前 30 分钟之前）', async () => {
    const { passId } = await setupPass();
    const res = await api(h)('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:20'))
      .expect(200);
    expect(res.body.decision).toBe('deny');
    expect(res.body.reasons).toContain('NOT_WITHIN_WINDOW');
  });

  test('正常入校 -> 再次出示同一凭证入校被拒（防重放）', async () => {
    const call = api(h);
    const { passId } = await setupPass();
    const first = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:40'))
      .expect(200);
    expect(first.body.decision).toBe('allow');
    expect(first.body.passStatus).toBe('USED');

    const replay = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '16:30'))
      .expect(200);
    expect(replay.body.decision).toBe('deny');
    expect(replay.body.reasons).toContain('ALREADY_ENTERED');
  });

  test('未入校直接离校 -> deny；正常离校后凭证终结', async () => {
    const call = api(h);
    const { passId } = await setupPass();
    const ghost = await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:45'))
      .expect(200);
    expect(ghost.body.decision).toBe('deny');
    expect(ghost.body.reasons).toContain('NO_ENTRY_RECORD');

    await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:45'));
    const out = await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '17:40'))
      .expect(200);
    expect(out.body.decision).toBe('allow');
    expect(out.body.passStatus).toBe('EXITED');

    const after = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '17:45'))
      .expect(200);
    expect(after.body.decision).toBe('deny');
    expect(after.body.reasons).toContain('ALREADY_EXITED');

    const again = await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '17:50'))
      .expect(200);
    expect(again.body.decision).toBe('deny');
    expect(again.body.reasons).toContain('ALREADY_EXITED');
  });

  test('凭证仅覆盖当日职责：时间窗 = 开课前30分 ~ 结课后30分', async () => {
    const { passId, session } = await setupPass();
    const res = await api(h)('get', `/applications?sessionId=${session.id}`, h.actors.lead, undefined, day(DATE, '15:00'))
      .expect(200);
    const detail = await api(h)('get', `/passes/${passId}`, h.actors.lead, undefined, day(DATE, '15:00'))
      .expect(200);
    expect(detail.body.validFrom).toBe(new Date(day(DATE, '15:30')).toISOString());
    expect(detail.body.validTo).toBe(new Date(day(DATE, '18:00')).toISOString());
    expect(detail.body.scopeDate).toBe(DATE);
    expect(res.body[0].status).toBe('approved');
  });

  test('凭证过期（次日重放昨日凭证）：窗口关闭拒绝入校', async () => {
    const call = api(h);
    const { passId } = await setupPass();
    await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:40'));
    await call('post', `/gate/passes/${passId}/exit`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '17:40'));
    const nextDay = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'EAST' }, day(DATE, '15:40') + 24 * 60 * MIN)
      .expect(200);
    expect(nextDay.body.decision).toBe('deny');
    expect(nextDay.body.reasons).toContain('ALREADY_EXITED');
    expect(nextDay.body.reasons).toContain('PASS_WINDOW_CLOSED');
  });

  test('跨午夜课程：23:00-00:30 的课在次日凌晨仍在窗内，且归属开课当日', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G4', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '23:00', endTime: '00:30', grade: 'G4', subject: 'programming',
    }, t);
    expect(session.crossesMidnight).toBe(true);

    const { passId } = await approveAndIssue(h, session.id, m.mentorId, {
      submit: day(DATE, '20:00'), lead: day(DATE, '20:05'),
      security: day(DATE, '20:10'), issue: day(DATE, '22:00'),
    });
    const detail = await call('get', `/passes/${passId}`, h.actors.lead, undefined, day(DATE, '22:00'))
      .expect(200);
    // 窗：22:30 起，次日 01:00 止；scopeDate 仍是开课当日 2026-09-25
    expect(detail.body.validFrom).toBe(new Date(day(DATE, '22:30')).toISOString());
    expect(detail.body.validTo).toBe(new Date(day(DATE, '00:30') + DAY + 30 * MIN).toISOString());
    expect(detail.body.scopeDate).toBe(DATE);

    // 次日凌晨 00:10 入校（跨午夜后）放行
    const entry = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'WEST' }, day(DATE, '00:10') + DAY)
      .expect(200);
    expect(entry.body.decision).toBe('allow');
    expect(entry.body.passStatus).toBe('USED');

    // 同一凭证跨午夜不得用于第二晚
    const nextNight = await call('post', `/gate/passes/${passId}/verify`, h.actors.guard, { gateId: 'WEST' }, day(DATE, '00:10') + 2 * DAY)
      .expect(200);
    expect(nextNight.body.decision).toBe('deny');
    expect(nextNight.body.reasons).toContain('PASS_WINDOW_CLOSED');
  });

  test('跨午夜课程在次日凌晨 01:30 已超窗，拒绝入校', async () => {
    const call = api(h);
    const t = day(DATE, '12:00');
    const m = await provisionMentor(h, { at: t, grade: 'G4', subject: 'programming' });
    const session = await createSession(h, {
      date: DATE, startTime: '23:00', endTime: '00:30', grade: 'G4', subject: 'programming',
    }, t);
    const { passId } = await approveAndIssue(h, session.id, m.mentorId, {
      submit: day(DATE, '20:00'), lead: day(DATE, '20:05'),
      security: day(DATE, '20:10'), issue: day(DATE, '22:00'),
    });
    const res = await call('post', `/gate/passes/${passId}/entry`, h.actors.guard, { gateId: 'WEST' }, day(DATE, '01:30') + DAY)
      .expect(200);
    expect(res.body.decision).toBe('deny');
    expect(res.body.reasons).toContain('PASS_WINDOW_CLOSED');
  });
});
