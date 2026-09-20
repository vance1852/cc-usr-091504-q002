import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Instructor } from '../../entities/instructor.entity';
import { QualificationDocument } from '../../entities/qualification.entity';
import { TrainingRecord } from '../../entities/training.entity';
import { Clearance } from '../../entities/clearance.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { Enrollment } from '../../entities/enrollment.entity';
import { Student } from '../../entities/student.entity';
import { GateEvent } from '../../entities/gate-event.entity';
import { AccessPass } from '../../entities/access-pass.entity';
import { InstructorsService } from './instructors.service';
import { InstructorsController } from './instructors.controller';
import { EligibilityService } from './eligibility.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Instructor,
      QualificationDocument,
      TrainingRecord,
      Clearance,
      CourseSession,
      Course,
      Enrollment,
      Student,
      GateEvent,
      AccessPass,
    ]),
  ],
  controllers: [InstructorsController],
  providers: [InstructorsService, EligibilityService],
  exports: [InstructorsService, EligibilityService],
})
export class InstructorsModule {}
