import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum GateDirection {
  IN = 'IN',
  OUT = 'OUT',
}

export enum GateDecision {
  ALLOW = 'ALLOW',
  DENY = 'DENY',
}

/**
 * 门岗进出回执：每一次扫码（无论放行或拒绝）都留痕，
 * 是凭证重放与异常处置追溯的依据。
 */
@Entity('gate_events')
export class GateEvent {
  @PrimaryColumn('text')
  id: string;

  /** 无法识别令牌时为 null */
  @Column('text', { nullable: true })
  passId: string | null;

  @Column('text')
  direction: GateDirection;

  @Column('text')
  decision: GateDecision;

  @Column('text', { nullable: true })
  denyReason: string | null;

  @Column('text')
  guardUserId: string;

  @Column('text')
  createdAt: string;
}
