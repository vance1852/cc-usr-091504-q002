import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { PassesService } from './passes.service';

@Module({
  controllers: [ApplicationsController],
  providers: [PassesService],
})
export class ApplicationsModule {}
