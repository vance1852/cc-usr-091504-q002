import { Harness, api } from './harness';

export function day(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00`);
}

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const MIN = 60 * 1000;

export interface MentorFixture {
  mentorId: string;
  agencyId: string;
  adminUserId?: string;
}

/**
 * 通过公开 HTTP 接口构建一名导师及其全部准入要素。
 * 任一要素可通过 opts 关闭/篡改，用于构造边界场景。
 */
export async function provisionMentor(
  h: Harness,
  opts: {
    at: number;
    agencyId?: string;
    grade: string;
    subject: string;
    verified?: boolean; // 默认 true（由安全人员核验）
    suspended?: boolean;
    credExpiresAt?: number; // 默认 at + 365 天
    trainingExpiresAt?: number; // 默认 at + 365 天
    withCredential?: boolean;
    withTraining?: boolean;
    withContactAuth?: boolean;
    createAdmin?: boolean;
    idDocumentNo?: string;
  },
): Promise<MentorFixture> {
  const call = api(h);
  const { lead, security } = h.actors;
  const at = opts.at;

  let agencyId = opts.agencyId;
  if (!agencyId) {
    const ag = await call('post', '/agencies', lead, { name: `机构-${Math.random().toString(36).slice(2, 8)}` }, at);
    agencyId = ag.body.id;
  }

  let adminUserId: string | undefined;
  if (opts.createAdmin) {
    // 先建档导师再开管理员账户无依赖，管理员先开：
    const au = await call('post', '/users', lead, {
      displayName: '机构管理员',
      role: 'agency_admin',
      agencyId,
    }, at);
    adminUserId = au.body.id;
  }

  const m = await call('post', '/mentors', lead, {
    fullName: '张编程',
    idDocumentNo: opts.idDocumentNo ?? 'ID-2026-000123',
    phone: '13800000000',
    agencyId,
  }, at);
  const mentorId = m.body.id;

  if (opts.withCredential !== false) {
    await call('post', `/mentors/${mentorId}/credentials`, lead, {
      type: 'programming_teaching_cert',
      fileRef: 'oss://creds/cert-1.pdf',
      issuedAt: at - 200 * DAY,
      expiresAt: opts.credExpiresAt ?? at + 365 * DAY,
    }, at);
  }

  if (opts.withTraining !== false) {
    await call('post', `/mentors/${mentorId}/trainings`, lead, {
      type: 'minor_protection',
      completedAt: at - 10 * DAY,
      expiresAt: opts.trainingExpiresAt ?? at + 365 * DAY,
      provider: '区教育局未成年人保护中心',
    }, at);
  }

  if (opts.withContactAuth !== false) {
    await call('post', `/mentors/${mentorId}/contact-authorizations`, lead, {
      grade: opts.grade,
      subject: opts.subject,
    }, at);
  }

  if (opts.verified !== false) {
    await call('patch', `/mentors/${mentorId}/verification`, security, { decision: 'verified' }, at);
  }

  if (opts.suspended) {
    await call('patch', `/mentors/${mentorId}/suspension`, lead, { suspended: true, reason: 'test' }, at);
  }

  return { mentorId, agencyId: agencyId!, adminUserId };
}

export async function createSession(
  h: Harness,
  opts: {
    date: string;
    startTime: string;
    endTime: string;
    grade: string;
    subject: string;
    location?: string;
    roster?: Array<{ code: string; name: string; note?: string }>;
  },
  at: number,
) {
  const call = api(h);
  const res = await call('post', '/sessions', h.actors.lead, {
    subject: opts.subject,
    grade: opts.grade,
    date: opts.date,
    startTime: opts.startTime,
    endTime: opts.endTime,
    location: opts.location ?? '科创楼302',
    roster: opts.roster ?? [
      { code: 'S-G3-018', name: '李同学', note: '花生过敏，仅校方可见' },
      { code: 'S-G3-021', name: '王同学' },
    ],
  }, at);
  return res.body;
}

/** 提交申请并完成双人确认 + 发证，返回申请与凭证（调用方需保证各时点资格满足） */
export async function approveAndIssue(
  h: Harness,
  sessionId: string,
  mentorId: string,
  times: { submit: number; lead: number; security: number; issue: number },
  opts: { emergency?: boolean; requesterId?: string } = {},
) {
  const call = api(h);
  const { lead, security } = h.actors;
  const requester = opts.requesterId ?? lead;
  const app = await call('post', '/applications', requester, {
    sessionId,
    mentorId,
    reason: '原导师临时发热',
    emergency: opts.emergency ?? false,
  }, times.submit);
  if (app.status >= 400) throw new Error(`submit failed: ${JSON.stringify(app.body)}`);
  const appId = app.body.id;

  const l = await call('post', `/applications/${appId}/lead-confirmation`, lead, { decision: 'approve' }, times.lead);
  if (l.status >= 400) throw new Error(`lead approve failed: ${JSON.stringify(l.body)}`);
  const s = await call('post', `/applications/${appId}/security-confirmation`, security, { decision: 'approve' }, times.security);
  if (s.status >= 400) throw new Error(`security approve failed: ${JSON.stringify(s.body)}`);
  const p = await call('post', `/applications/${appId}/pass`, lead, {}, times.issue);
  if (p.status >= 400) throw new Error(`issue pass failed: ${JSON.stringify(p.body)}`);
  return { appId, passId: p.body.id, application: app.body };
}

export async function createMentorUser(h: Harness, mentorId: string, at: number, name = '导师本人账户') {
  const u = await api(h)('post', '/users', h.actors.lead, {
    displayName: name,
    role: 'mentor',
    mentorId,
  }, at);
  return u.body.id as string;
}
