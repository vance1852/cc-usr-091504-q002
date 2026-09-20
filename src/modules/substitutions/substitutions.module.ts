import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubstitutionRequest } from '../../entities/substitution.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { AccessPass } from '../../entities/access-pass.entity';
import { GateEvent } from '../../entities/gate-event.entity';
import { Incident } from '../../entities/incident.entity';
import { SubstitutionsService } from './substitutions.service';
import { SubstitutionsController } from './substitutions.controller';
import { InstructorsModule } from '../instructors/instructors.module';
import { PassesModule } from '../passes/passes.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubstitutionRequest,
      CourseSession,
      Course,
      AccessPass,
      GateEvent,
      Incident,
    ]),
    InstructorsModule,
    PassesModule,
  ],
  controllers: [SubstitutionsController],
  providers: [SubstitutionsService],
  exports: [SubstitutionsService],
})
export class SubstitutionsModule {}
