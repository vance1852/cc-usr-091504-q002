import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum TrainingType {
  /** 未成年人保护培训（强制） */
  MINOR_PROTECTION = 'MINOR_PROTECTION',
  CAMPUS_SAFETY = 'CAMPUS_SAFETY',
  FIRST_AID = 'FIRST_AID',
}

/** 培训记录 */
@Entity('training_records')
export class TrainingRecord {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  instructorId: string;

  @Column('text')
  type: TrainingType;

  @Column('text')
  provider: string;

  @Column('text')
  completedAt: string;

  /** 有效期至（ISO）；null 表示长期有效 */
  @Column('text', { nullable: true })
  expiresAt: string | null;

  @Column('text')
  createdAt: string;
}
