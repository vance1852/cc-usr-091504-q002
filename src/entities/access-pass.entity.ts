import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum PassStatus {
  ACTIVE = 'ACTIVE',
  /** 已扫码入校（再次入校扫描判定为重放） */
  USED = 'USED',
  REVOKED = 'REVOKED',
}

/**
 * 通行凭证：一次入校一张，仅覆盖当日当次课职责。
 * 库中只保存令牌摘要（tokenHash），明文令牌签发时返回一次。
 */
@Entity('access_passes')
export class AccessPass {
  @PrimaryColumn('text')
  id: string;

  @Column('text', { unique: true })
  tokenHash: string;

  @Column('text')
  instructorId: string;

  @Column('text')
  sessionId: string;

  /** 由代课审批触发时关联的申请 */
  @Column('text', { nullable: true })
  substitutionId: string | null;

  /** 当日职责描述（门岗与追溯可见） */
  @Column('text')
  duties: string;

  @Column('text')
  validFrom: string;

  @Column('text')
  validTo: string;

  @Column('text')
  status: PassStatus;

  @Column('text', { nullable: true })
  enteredAt: string | null;

  @Column('text', { nullable: true })
  exitedAt: string | null;

  @Column('text')
  createdAt: string;
}
