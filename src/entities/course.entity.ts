import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 课后课程 */
@Entity('courses')
export class Course {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  title: string;

  /** 面向年级，如 G4 */
  @Column('text')
  gradeLevel: string;

  /** 课程负责人（用户 id） */
  @Column('text')
  leadUserId: string;

  @Column('text')
  createdAt: string;
}
