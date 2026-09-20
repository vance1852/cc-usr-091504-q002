import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum SessionStatus {
  SCHEDULED = 'SCHEDULED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  /** 授课后发现资格问题，已标记待复核（历史记录保留） */
  FLAGGED = 'FLAGGED',
}

/**
 * 课次：某课程在某日的一次授课。
 * endTime <= startTime 表示跨午夜（结束于次日）。
 */
@Entity('course_sessions')
export class CourseSession {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  courseId: string;

  /** 上课日期 YYYY-MM-DD（UTC） */
  @Column('text')
  date: string;

  @Column('text')
  startTime: string;

  @Column('text')
  endTime: string;

  /** 当前指派的授课导师（可能因代课审批通过而变更） */
  @Column('text')
  instructorId: string;

  @Column('text')
  status: SessionStatus;

  @Column('text')
  createdAt: string;
}
