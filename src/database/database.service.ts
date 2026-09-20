import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DB_TOKEN = 'DB_INSTANCE';

/**
 * 全量表结构。所有业务表均使用 epoch 毫秒（INTEGER）存时间，
 * 审计表 append-only，应用层不提供 UPDATE/DELETE 审计记录的方法。
 */
const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 平台用户（按角色登录，测试中由调用方直接携带身份头）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agency_admin','program_lead','campus_security','gate_guard','mentor')),
  agency_id TEXT REFERENCES agencies(id),
  mentor_id TEXT REFERENCES mentors(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mentors (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  full_name TEXT NOT NULL,
  id_document_no TEXT NOT NULL,          -- 证件号（仅门岗/安全人员可取摘要）
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','rejected')),
  verified_at INTEGER,
  verified_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (agency_id, id_document_no)
);
CREATE INDEX IF NOT EXISTS idx_mentors_agency ON mentors(agency_id);

-- 资质文件（如编程教学能力证明、无犯罪记录承诺等）
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  mentor_id TEXT NOT NULL REFERENCES mentors(id),
  type TEXT NOT NULL,
  file_ref TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,           -- 长期有效也需给一个明确到期日
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_mentor ON credentials(mentor_id);

-- 培训记录（未成年人保护培训为强制项）
CREATE TABLE IF NOT EXISTS trainings (
  id TEXT PRIMARY KEY,
  mentor_id TEXT NOT NULL REFERENCES mentors(id),
  type TEXT NOT NULL CHECK (type IN ('minor_protection','campus_safety')),
  completed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  provider TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trainings_mentor ON trainings(mentor_id);

-- 允许接触范围：年级 × 课程类别（机构管理员维护，安全人员核验）
CREATE TABLE IF NOT EXISTS contact_authorizations (
  id TEXT PRIMARY KEY,
  mentor_id TEXT NOT NULL REFERENCES mentors(id),
  grade TEXT NOT NULL,                   -- 如 'G3','G4'
  subject TEXT NOT NULL,                 -- 如 'programming'
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (mentor_id, grade, subject)
);

-- 课程时段（一次具体排课，可能跨午夜）
CREATE TABLE IF NOT EXISTS course_sessions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  grade TEXT NOT NULL,
  date TEXT NOT NULL,                   -- 开课当地日期 YYYY-MM-DD（归属日）
  start_time TEXT NOT NULL,             -- HH:MM
  end_time TEXT NOT NULL,               -- HH:MM；<= start_time 表示跨午夜
  location TEXT NOT NULL,
  roster_json TEXT NOT NULL DEFAULT '[]', -- 学生花名册（最小信息：姓名/代号+年级）
  default_mentor_id TEXT REFERENCES mentors(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON course_sessions(date);

-- 代课/入校申请
CREATE TABLE IF NOT EXISTS substitute_applications (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES course_sessions(id),
  mentor_id TEXT NOT NULL REFERENCES mentors(id),
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','lead_approved','approved','rejected','cancelled')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  lead_confirm_by TEXT REFERENCES users(id),
  lead_confirm_at INTEGER,
  security_confirm_by TEXT REFERENCES users(id),
  security_confirm_at INTEGER,
  decided_at INTEGER,
  reject_step TEXT CHECK (reject_step IS NULL OR reject_step IN ('lead','security')),
  reject_reason TEXT,
  emergency INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_apps_session ON substitute_applications(session_id);
CREATE INDEX IF NOT EXISTS idx_apps_mentor ON substitute_applications(mentor_id);

-- 当日通行凭证
CREATE TABLE IF NOT EXISTS passes (
  id TEXT PRIMARY KEY,                  -- 对外凭证编码（不可枚举：随机 32 字节 hex）
  application_id TEXT NOT NULL UNIQUE REFERENCES substitute_applications(id),
  mentor_id TEXT NOT NULL REFERENCES mentors(id),
  session_id TEXT NOT NULL REFERENCES course_sessions(id),
  scope_date TEXT NOT NULL,             -- 仅当日职责
  valid_from INTEGER NOT NULL,
  valid_to INTEGER NOT NULL,
  location TEXT NOT NULL,
  grades_json TEXT NOT NULL,            -- 接触年级快照
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','EXITED','REVOKED')),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_passes_mentor ON passes(mentor_id);
CREATE INDEX IF NOT EXISTS idx_passes_session ON passes(session_id);

-- 进出回执（门岗扫码产生；entry/exit 各一条）
CREATE TABLE IF NOT EXISTS access_receipts (
  id TEXT PRIMARY KEY,
  pass_id TEXT NOT NULL REFERENCES passes(id),
  kind TEXT NOT NULL CHECK (kind IN ('entry','exit')),
  gate_id TEXT NOT NULL,
  guard_user_id TEXT NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  deny_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_pass ON access_receipts(pass_id);

-- 异常处置记录（授课中发现资格问题等）
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  pass_id TEXT REFERENCES passes(id),
  application_id TEXT REFERENCES substitute_applications(id),
  mentor_id TEXT NOT NULL REFERENCES mentors(id),
  type TEXT NOT NULL,                   -- credential_expired / verification_revoked / mentor_suspended / out_of_scope / other
  detail TEXT,
  reported_by TEXT NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT 'pass_revoked' CHECK (action IN ('pass_revoked','none')),
  -- 事件发生时已发生的授课/接触范围快照（供复核，不被后续吊销抹掉）
  contact_snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_mentor ON incidents(mentor_id);

-- append-only 审计
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_application
  ON audit_log(entity_type, entity_id);
`;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly db: DatabaseSync;

  constructor(@Inject('SQLITE_FILE') file: string) {
    if (file !== ':memory:') {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  onModuleDestroy(): void {
    try {
      this.db.close();
    } catch {
      // 关闭时忽略
    }
  }
}
