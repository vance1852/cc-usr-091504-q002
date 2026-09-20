import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum SubstitutionStatus {
  /** 待确认（紧急代课需课程负责人与安全人员分别确认） */
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  /** 资格预审不通过：资质过期 / 核验未完成 / 已暂停 / 超出允许范围 */
  ELIGIBILITY_FAILED = 'ELIGIBILITY_FAILED',
}

export enum SubstitutionKind {
  NORMAL = 'NORMAL',
  EMERGENCY = 'EMERGENCY',
}

/** 代课申请 */
@Entity('substitution_requests')
export class SubstitutionRequest {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  sessionId: string;

  @Column('text')
  originalInstructorId: string;

  @Column('text')
  substituteInstructorId: string;

  @Column('text')
  kind: SubstitutionKind;

  @Column('text')
  reason: string;

  @Column('text')
  status: SubstitutionStatus;

  /** 资格预审结论（不通过时的原因列表） */
  @Column('simple-json', { nullable: true })
  eligibilityReasons: string[] | null;

  @Column('text')
  requestedBy: string;

  @Column('text', { nullable: true })
  leadConfirmedBy: string | null;

  @Column('text', { nullable: true })
  leadConfirmedAt: string | null;

  @Column('text', { nullable: true })
  safetyConfirmedBy: string | null;

  @Column('text', { nullable: true })
  safetyConfirmedAt: string | null;

  @Column('text', { nullable: true })
  decidedAt: string | null;

  @Column('text')
  createdAt: string;
}
