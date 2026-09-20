import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum InstructorStatus {
  /** 已登记但身份核验未完成，不得授课 */
  PENDING = 'PENDING_VERIFICATION',
  /** 核验通过 */
  VERIFIED = 'VERIFIED',
  /** 被暂停，立即停止一切入校与授课 */
  SUSPENDED = 'SUSPENDED',
}

/** 校外导师身份档案 */
@Entity('instructors')
export class Instructor {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  orgId: string;

  @Column('text')
  fullName: string;

  /** 证件号码（敏感，仅签发/核验环节可见，对外一律脱敏） */
  @Column('text')
  idNumber: string;

  @Column('text')
  phone: string;

  @Column('text')
  status: InstructorStatus;

  @Column('text', { nullable: true })
  verifiedAt: string | null;

  @Column('text', { nullable: true })
  verifiedBy: string | null;

  @Column('text', { nullable: true })
  suspendedAt: string | null;

  @Column('text', { nullable: true })
  suspensionReason: string | null;

  @Column('text')
  createdAt: string;
}
