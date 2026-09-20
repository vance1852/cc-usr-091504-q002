import { Module } from '@nestjs/common';
import { MentorsController } from './mentors.controller';

@Module({ controllers: [MentorsController] })
export class MentorsModule {}
