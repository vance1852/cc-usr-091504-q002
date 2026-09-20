import { Injectable } from '@nestjs/common';

/**
 * 时钟服务。
 * 生产环境固定使用系统时钟；仅当 ALLOW_CLOCK_OVERRIDE=1（测试环境）时，
 * 允许请求通过 X-Now-Ms 头注入“当前时间”，用于验证跨午夜课程与凭证重放。
 */
@Injectable()
export class ClockService {
  private readonly allowOverride = process.env.ALLOW_CLOCK_OVERRIDE === '1';

  now(overrideHeader?: string | string[] | null): number {
    if (this.allowOverride && typeof overrideHeader === 'string') {
      const v = Number(overrideHeader);
      if (Number.isFinite(v) && v > 0) return Math.trunc(v);
    }
    return Date.now();
  }

  get allowsOverride(): boolean {
    return this.allowOverride;
  }
}
