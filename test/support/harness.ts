import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DbService } from '../../src/database/database.service';
import { randomUUID } from 'node:crypto';

export interface Harness {
  app: INestApplication;
  http: any;
  db: DbService['db'];
  actors: Record<string, string>;
  close: () => Promise<void>;
}

/**
 * 每个 describe 场景使用一套全新的内存库。
 * 直接落库 3 名校方引导用户（课程负责人/安全人员/门岗），
 * 机构与后续账户走 HTTP API 创建，顺带覆盖开户接口。
 */
export async function buildHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const dbService = app.get(DbService);
  const db = dbService.db;
  const now = Date.now();

  const actors: Record<string, string> = {
    lead: 'u-lead',
    security: 'u-security',
    guard: 'u-guard',
  };
  const insertUser = db.prepare(
    `INSERT INTO users (id, display_name, role, agency_id, mentor_id) VALUES (?, ?, ?, NULL, NULL)`,
  );
  insertUser.run(actors.lead, '课后课程负责人', 'program_lead');
  insertUser.run(actors.security, '校园安全人员', 'campus_security');
  insertUser.run(actors.guard, '东门门岗', 'gate_guard');
  void now;

  const http = app.getHttpServer();

  const call = (
    method: 'get' | 'post' | 'patch',
    path: string,
    actorId: string | undefined,
    body?: any,
    nowMs?: number,
  ) => {
    let r = request(http)[method](path).set('X-Actor-User-Id', actorId ?? '');
    if (nowMs !== undefined) r = r.set('X-Now-Ms', String(nowMs));
    if (body !== undefined) r = r.send(body);
    return r;
  };

  (http as any).call = call;

  return {
    app,
    http,
    db,
    actors,
    close: () => app.close(),
  };
}

export type ApiCall = (
  method: 'get' | 'post' | 'patch',
  path: string,
  actorId: string | undefined,
  body?: any,
  nowMs?: number,
) => request.Test;

export function api(h: Harness): ApiCall {
  return (h.http as any).call;
}

export function uuid(): string {
  return randomUUID();
}
