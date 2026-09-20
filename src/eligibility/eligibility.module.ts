import { Global, Module } from '@nestjs/common';
import { EligibilityService } from './eligibility.service';

@Global()
@Module({
  providers: [EligibilityService],
  exports: [EligibilityService],
})
export class EligibilityModule {}
