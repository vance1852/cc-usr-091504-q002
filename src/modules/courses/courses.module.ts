import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Course } from '../../entities/course.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Student } from '../../entities/student.entity';
import { Enrollment } from '../../entities/enrollment.entity';
import { Instructor } from '../../entities/instructor.entity';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Course, CourseSession, Student, Enrollment, Instructor])],
  controllers: [CoursesController],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
