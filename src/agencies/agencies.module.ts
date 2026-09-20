import { Module } from '@nestjs/common';
import { AgenciesController } from './agencies.controller';

@Module({ controllers: [AgenciesController] })
export class AgenciesModule {}
