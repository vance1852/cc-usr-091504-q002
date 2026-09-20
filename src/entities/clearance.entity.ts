import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 允许接触范围：某导师在某星期几的某时间窗内，可接触某年级的学生。
 * 时间窗支持跨午夜（endTime <= startTime 表示到次日）。
 */
@Entity('clearances')
export class Clearance {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  instructorId: string;

  /** 年级，如 G1..G9 */
  @Column('text')
  gradeLevel: string;

  /** 星期（UTC，0=周日 … 6=周六） */
  @Column('integer')
  weekday: number;

  @Column('text')
  windowStart: string;

  @Column('text')
  windowEnd: string;

  @Column('text')
  createdAt: string;
}
