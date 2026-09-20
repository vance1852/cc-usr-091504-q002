import { Injectable } from '@nestjs/common';

/**
 * 可注入时钟。生产环境使用系统时间；测试用 MutableClock 冻结/推进时间，
 * 以覆盖跨午夜课程、凭证重放等时间敏感场景。
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export const CLOCK = 'CLOCK';
