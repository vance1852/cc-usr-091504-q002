import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Incident } from '../../entities/incident.entity';
import { Instructor } from '../../entities/instructor.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { IncidentsService } from './incidents.service';
import { IncidentsController } from './incidents.controller';
import { PassesModule } from '../passes/passes.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Incident, Instructor, CourseSession]),
    PassesModule,
  ],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
