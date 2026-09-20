import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum IncidentType {
  QUALIFICATION_EXPIRED = 'QUALIFICATION_EXPIRED',
  TRAINING_EXPIRED = 'TRAINING_EXPIRED',
  VERIFICATION_REVOKED = 'VERIFICATION_REVOKED',
  MANUAL_SUSPENSION = 'MANUAL_SUSPENSION',
}

export enum IncidentStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

/**
 * 资格异常事件：课程开始后发现资格问题时登记，
 * 触发立即停止后续通行（吊销未消耗凭证），历史授课与接触范围保留供复核。
 */
@Entity('incidents')
export class Incident {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  instructorId: string;

  @Column('text', { nullable: true })
  sessionId: string | null;

  @Column('text')
  type: IncidentType;

  @Column('text')
  detail: string;

  @Column('text')
  status: IncidentStatus;

  /** 本次处置吊销的凭证数量 */
  @Column('integer')
  passesRevoked: number;

  /** 本次处置标记待复核的课次数量 */
  @Column('integer')
  sessionsFlagged: number;

  @Column('text')
  reportedBy: string;

  @Column('text')
  createdAt: string;
}
