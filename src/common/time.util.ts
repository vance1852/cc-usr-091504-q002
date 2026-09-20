/**
 * 时间工具：全部按 UTC 解释，避免服务器本地时区影响跨午夜计算。
 * 时间戳在数据库中一律以 ISO-8601 文本存储。
 */

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** 进出场缓冲：开课前 30 分钟可入校，结束后 30 分钟内可离校。 */
export const ENTRY_BUFFER_MIN = 30;
export const EXIT_BUFFER_MIN = 30;

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertHm(hm: string, field: string): void {
  if (!HM_RE.test(hm)) {
    throw new Error(`${field} 必须是 HH:mm 格式，收到: ${hm}`);
  }
}

export function assertDate(date: string, field: string): void {
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    throw new Error(`${field} 必须是 YYYY-MM-DD 格式，收到: ${date}`);
  }
}

export function iso(d: Date): string {
  return d.toISOString();
}

export function parseIso(s: string): Date {
  return new Date(s);
}

export interface Interval {
  start: Date;
  end: Date;
}

/**
 * 由「日期 + 起止时刻」计算绝对时间区间。
 * 结束时刻 <= 起始时刻时视为跨午夜，结束时间顺延到次日。
 * 例：2026-09-20 22:30 - 01:30 => [2026-09-20T22:30Z, 2026-09-21T01:30Z]
 */
export function dayInterval(date: string, startHm: string, endHm: string): Interval {
  assertDate(date, 'date');
  assertHm(startHm, 'startTime');
  assertHm(endHm, 'endTime');
  const start = new Date(`${date}T${startHm}:00.000Z`);
  let end = new Date(`${date}T${endHm}:00.000Z`);
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + DAY_MS);
  }
  return { start, end };
}

/** 课程时段对应的通行凭证有效窗口（含进出缓冲）。 */
export function passWindow(session: Interval): Interval {
  return {
    start: new Date(session.start.getTime() - ENTRY_BUFFER_MIN * MINUTE_MS),
    end: new Date(session.end.getTime() + EXIT_BUFFER_MIN * MINUTE_MS),
  };
}

/** 判断 inner 区间是否完全落在 outer 区间内（两者均按 dayInterval 规则展开）。 */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime();
}

/** 日期对应的星期（UTC，0=周日）。 */
export function weekdayOf(date: string): number {
  assertDate(date, 'date');
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}
