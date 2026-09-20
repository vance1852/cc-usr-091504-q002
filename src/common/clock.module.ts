import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock, CLOCK } from './clock';

/** 全局时钟模块：生产用系统时钟；测试以 MutableClock 替换 CLOCK 即可 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: Clock, useExisting: CLOCK },
  ],
  exports: [CLOCK, Clock],
})
export class ClockModule {}
