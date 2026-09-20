import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 选课关系 */
@Entity('enrollments')
export class Enrollment {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  courseId: string;

  @Column('text')
  studentId: string;

  @Column('text')
  createdAt: string;
}
