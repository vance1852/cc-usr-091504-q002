import { Injectable } from '@nestjs/common';
import { DbService } from '../database/database.service';

export interface EligibilityIssue {
  code:
    | 'MENTOR_SUSPENDED'
    | 'NOT_VERIFIED'
    | 'VERIFICATION_REJECTED'
    | 'NO_ACTIVE_CREDENTIAL'
    | 'CREDENTIAL_EXPIRED'
    | 'NO_MINOR_PROTECTION_TRAINING'
    | 'TRAINING_EXPIRED'
    | 'OUT_OF_SCOPE_GRADE'
    | 'OUT_OF_SCOPE_SUBJECT'
    | 'AGENCY_SUSPENDED';
  message: string;
}

export interface EligibilityResult {
  eligible: boolean;
  issues: EligibilityIssue[];
}

interface MentorRow {
  id: string;
  agency_id: string;
  full_name: string;
  status: 'active' | 'suspended';
  verification_status: 'unverified' | 'verified' | 'rejected';
}

/**
 * 资格判定引擎。所有“能不能代课 / 凭证是否仍有效”的问题都收敛到这里，
 * 保证发证、门岗放行、授课中复查三处使用同一套规则。
 *
 * 判定时点 atMs 显式传入，使跨午夜课程与凭证重放测试可精确控制。
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly db: DbService) {}

  mentor(mentorId: string, atMs: number): { mentor: MentorRow; agencyStatus: string } | null {
    const m = this.db.db
      .prepare(`SELECT * FROM mentors WHERE id = ?`)
      .get(mentorId) as MentorRow | undefined;
    if (!m) return null;
    const a = this.db.db
      .prepare(`SELECT status FROM agencies WHERE id = ?`)
      .get(m.agency_id) as { status: string } | undefined;
    return { mentor: m, agencyStatus: a?.status ?? 'missing' };
  }

  evaluate(mentorId: string, grade: string, subject: string, atMs: number): EligibilityResult {
    const issues: EligibilityIssue[] = [];
    const loaded = this.mentor(mentorId, atMs);
    if (!loaded) {
      return {
        eligible: false,
        issues: [{ code: 'NOT_VERIFIED', message: '导师不存在' }],
      };
    }
    const { mentor: m, agencyStatus } = loaded;

    if (agencyStatus === 'suspended') {
      issues.push({ code: 'AGENCY_SUSPENDED', message: '所属服务机构已被暂停' });
    }
    if (m.status === 'suspended') {
      issues.push({ code: 'MENTOR_SUSPENDED', message: '导师本人已被暂停授课' });
    }
    if (m.verification_status === 'unverified') {
      issues.push({ code: 'NOT_VERIFIED', message: '身份核验尚未完成' });
    } else if (m.verification_status === 'rejected') {
      issues.push({ code: 'VERIFICATION_REJECTED', message: '身份核验未通过' });
    }

    // 资质文件：至少一份 active 且在判定时点未过期
    const creds = this.db.db
      .prepare(
        `SELECT expires_at FROM credentials
         WHERE mentor_id = ? AND status = 'active'`,
      )
      .all(mentorId) as Array<{ expires_at: number }>;
    if (creds.length === 0) {
      issues.push({ code: 'NO_ACTIVE_CREDENTIAL', message: '缺少有效资质文件' });
    } else if (!creds.some((c) => c.expires_at > atMs)) {
      issues.push({ code: 'CREDENTIAL_EXPIRED', message: '全部资质文件均已过期' });
    }

    // 未成年人保护培训：强制且需在有效期内
    const mp = this.db.db
      .prepare(
        `SELECT expires_at FROM trainings
         WHERE mentor_id = ? AND type = 'minor_protection'
         ORDER BY expires_at DESC LIMIT 1`,
      )
      .get(mentorId) as { expires_at: number } | undefined;
    if (!mp) {
      issues.push({
        code: 'NO_MINOR_PROTECTION_TRAINING',
        message: '未完成未成年人保护培训',
      });
    } else if (mp.expires_at <= atMs) {
      issues.push({ code: 'TRAINING_EXPIRED', message: '未成年人保护培训已过期' });
    }

    // 接触范围：年级与课程类别均须在授权表中且未撤销
    const auth = this.db.db
      .prepare(
        `SELECT 1 FROM contact_authorizations
         WHERE mentor_id = ? AND grade = ? AND subject = ?
           AND granted_at <= ? AND (revoked_at IS NULL OR revoked_at > ?)
         LIMIT 1`,
      )
      .get(mentorId, grade, subject, atMs, atMs);
    if (!auth) {
      // 细分两类越界，便于门岗与负责人定位
      const gradeOk = this.db.db
        .prepare(
          `SELECT 1 FROM contact_authorizations
           WHERE mentor_id = ? AND grade = ? AND granted_at <= ?
             AND (revoked_at IS NULL OR revoked_at > ?) LIMIT 1`,
        )
        .get(mentorId, grade, atMs, atMs);
      issues.push(
        gradeOk
          ? { code: 'OUT_OF_SCOPE_SUBJECT', message: `未被授权教授课程类别 ${subject}` }
          : { code: 'OUT_OF_SCOPE_GRADE', message: `未被授权接触年级 ${grade}` },
      );
    }

    return { eligible: issues.length === 0, issues };
  }
}
