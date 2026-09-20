import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { ClockService } from './clock.service';

@Global()
@Module({
  providers: [AuditService, ClockService],
  exports: [AuditService, ClockService],
})
export class CommonModule {}
