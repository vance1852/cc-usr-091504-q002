/**
 * 领域常量与共享类型。
 *
 * 设计要点：
 * - 凭证只承载当日单次代课职责，有效期严格落在课程时间窗外加少量入校缓冲。
 * - 凭证状态机：ACTIVE -> USED（已入校）-> EXITED；任意时点可 REVOKED。
 * - 代课申请需要课程负责人与校园安全人员“分别确认”（双人双角色，不可同一人代办）。
 */

export const BUFFER_BEFORE_MIN = 30; // 开课前 30 分钟起可入校
export const BUFFER_AFTER_MIN = 30; // 结课后 30 分钟内须离校

export type Role =
  | 'agency_admin' // 机构管理员（仅限本机构资料）
  | 'program_lead' // 学校课后课程负责人
  | 'campus_security' // 校园安全人员
  | 'gate_guard' // 门岗
  | 'mentor'; // 校外导师本人

export type VerificationStatus = 'unverified' | 'verified' | 'rejected';
export type MentorStatus = 'active' | 'suspended';
export type TrainingType = 'minor_protection' | 'campus_safety';

export type ApplicationStatus =
  | 'pending' // 已提交，等待双确认
  | 'lead_approved' // 仅课程负责人确认
  | 'approved' // 双人确认完成（但未必已发证）
  | 'rejected' // 任一确认人驳回
  | 'cancelled'; // 发起人撤销

export type PassStatus = 'ACTIVE' | 'USED' | 'EXITED' | 'REVOKED';

export interface Actor {
  userId: string;
  role: Role;
  agencyId?: string; // 仅机构管理员/导师需要
  displayName: string;
}

/** 把本地日期 (YYYY-MM-DD) 与 HH:MM 组合成 epoch 毫秒；end 为 true 时允许跨午夜（+1 天） */
export function composeSlotStart(date: string, startTime: string): number {
  return Date.parse(`${date}T${startTime}:00`);
}

export function composeSlotEnd(date: string, startTime: string, endTime: string): number {
  const start = composeSlotStart(date, startTime);
  let end = composeSlotStart(date, endTime);
  if (end <= start) {
    // 跨午夜课程：结束时间落在次日
    end += 24 * 60 * 60 * 1000;
  }
  return end;
}

export function iso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

export function todayLocal(now: number): string {
  // 以 UTC+8 校园本地时区生成 YYYY-MM-DD，保证跨午夜课程归属“开课当日”
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
