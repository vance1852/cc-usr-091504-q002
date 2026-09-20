import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessPass } from '../../entities/access-pass.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { Instructor } from '../../entities/instructor.entity';
import { Organization } from '../../entities/organization.entity';
import { GateEvent } from '../../entities/gate-event.entity';
import { PassesService } from './passes.service';
import { PassesController } from './passes.controller';
import { InstructorsModule } from '../instructors/instructors.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AccessPass, CourseSession, Course, Instructor, Organization, GateEvent]),
    InstructorsModule,
  ],
  controllers: [PassesController],
  providers: [PassesService],
  exports: [PassesService],
})
export class PassesModule {}
