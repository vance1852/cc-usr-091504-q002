import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createTestApp, Fixtures, MutableClock } from './helpers';
import { Role } from '../src/common/auth';

/**
 * 权限边界：
 * - 机构管理员不能查看/操作其他机构的资料；
 * - 导师只能读取本人被指派的当前课次的学生最小信息；
 * - 门岗、越权角色访问受保护接口一律拒绝；
 * - 未认证请求一律 401。
 */
describe('权限与数据隔离', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let fx: Fixtures;

  const SESSION = { date: '2026-09-20', startTime: '18:00', endTime: '19:30' };

  let orgAId: string;
  let orgBId: string;
  let orgAAdminToken: string;
  let orgBAdminToken: string;
  let instructorAId: string;
  let instructorAToken: string;
  let sessionAId: string;
  let sessionOtherId: string;
  let leadToken: string;
  let guardToken: string;

  beforeAll(async () => {
    ({ app, clock, fx } = await createTestApp());
    clock.set('2026-09-20T12:00:00.000Z');

    const orgA = await fx.org('机构A');
    const orgB = await fx.org('机构B');
    orgAId = orgA.id;
    orgBId = orgB.id;
    orgAAdminToken = (await fx.userWithToken(Role.ORG_ADMIN, { orgId: orgAId })).token;
    orgBAdminToken = (await fx.userWithToken(Role.ORG_ADMIN, { orgId: orgBId })).token;
    guardToken = (await fx.userWithToken(Role.GATE_GUARD)).token;

    const lead = await fx.userWithToken(Role.COURSE_LEAD);
    leadToken = lead.token;

    // 机构A的合格导师 + 两个不同课次
    const instA = await fx.eligibleInstructor(orgAId, SESSION);
    instructorAId = instA.id;
    instructorAToken = (await fx.userWithToken(Role.INSTRUCTOR, { instructorId: instA.id })).token;

    const course = await fx.course(lead.user.id, 'G5');
    const sessionA = await fx.session(course.id, instA.id, SESSION);
    sessionAId = sessionA.id;
    const otherInst = await fx.eligibleInstructor(orgAId, SESSION);
    const sessionOther = await fx.session(course.id, otherInst.id, {
      date: '2026-09-21',
      startTime: '18:00',
      endTime: '19:30',
    });
    sessionOtherId = sessionOther.id;

    await fx.student(course.id, '张小明');
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- 跨机构隔离 ----

  it('机构管理员不能列出其他机构的导师', async () => {
    const res = await request(app.getHttpServer())
      .get(`/orgs/${orgBId}/instructors`)
      .set(auth(orgAAdminToken));
    expect(res.status).toBe(403);
  });

  it('机构管理员不能查看其他机构的导师档案', async () => {
    const res = await request(app.getHttpServer())
      .get(`/instructors/${instructorAId}`)
      .set(auth(orgBAdminToken));
    expect(res.status).toBe(403);
  });

  it('机构管理员不能在其他机构下创建导师', async () => {
    const res = await request(app.getHttpServer())
      .post(`/orgs/${orgBId}/instructors`)
      .set(auth(orgAAdminToken))
      .send({ fullName: '越权导师', idNumber: '110101199901011234', phone: '13911112222' });
    expect(res.status).toBe(403);
  });

  it('机构管理员可以管理本机构导师，且返回的证件号已脱敏', async () => {
    const created = await request(app.getHttpServer())
      .post(`/orgs/${orgAId}/instructors`)
      .set(auth(orgAAdminToken))
      .send({ fullName: '新导师', idNumber: '110101199901011234', phone: '13911112222' });
    expect(created.status).toBe(201);
    expect(created.body.idNumberMasked).toBe('1101**********1234');
    expect(created.body.idNumber).toBeUndefined();

    const list = await request(app.getHttpServer())
      .get(`/orgs/${orgAId}/instructors`)
      .set(auth(orgAAdminToken));
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
  });

  // ---- 导师最小信息 ----

  it('导师只能读取本人被指派课次的学生最小信息（不含监护人电话等敏感字段）', async () => {
    const res = await request(app.getHttpServer())
      .get(`/sessions/${sessionAId}/roster`)
      .set(auth(instructorAToken));
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('MINIMAL');
    expect(res.body.students.length).toBe(1);
    const st = res.body.students[0];
    expect(st.displayName).toBe('张小明');
    expect(st.gradeLevel).toBe('G5');
    expect(st.safetyNotes).toBeDefined();
    // 敏感字段不得出现
    expect(st.guardianPhone).toBeUndefined();
    expect(st.fullName).toBeUndefined();
  });

  it('导师不能读取未指派给自己的课次名单', async () => {
    const res = await request(app.getHttpServer())
      .get(`/sessions/${sessionOtherId}/roster`)
      .set(auth(instructorAToken));
    expect(res.status).toBe(403);
  });

  it('课程负责人可读取完整名单（含监护人电话）', async () => {
    const res = await request(app.getHttpServer())
      .get(`/sessions/${sessionAId}/roster`)
      .set(auth(leadToken));
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('FULL');
    expect(res.body.students[0].guardianPhone).toBeDefined();
  });

  // ---- 其他角色边界 ----

  it('门岗不能读取学生名单、不能查看机构导师列表', async () => {
    const roster = await request(app.getHttpServer())
      .get(`/sessions/${sessionAId}/roster`)
      .set(auth(guardToken));
    expect(roster.status).toBe(403);

    const list = await request(app.getHttpServer())
      .get(`/orgs/${orgAId}/instructors`)
      .set(auth(guardToken));
    expect(list.status).toBe(403);
  });

  it('导师账号不能创建课程、不能签发凭证', async () => {
    const createCourse = await request(app.getHttpServer())
      .post('/courses')
      .set(auth(instructorAToken))
      .send({ title: '越权课程', gradeLevel: 'G5' });
    expect(createCourse.status).toBe(403);

    const issue = await request(app.getHttpServer())
      .post(`/sessions/${sessionAId}/pass`)
      .set(auth(instructorAToken));
    expect(issue.status).toBe(403);
  });

  it('未携带令牌的请求一律 401', async () => {
    const res = await request(app.getHttpServer()).get(`/orgs/${orgAId}/instructors`);
    expect(res.status).toBe(401);
  });
});
