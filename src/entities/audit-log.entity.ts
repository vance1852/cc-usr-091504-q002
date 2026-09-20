import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 审计日志：关键动作留痕，支撑代课全程追溯 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  actorUserId: string;

  @Column('text')
  action: string;

  @Column('text')
  entityType: string;

  @Column('text')
  entityId: string;

  /** 附加上下文（JSON） */
  @Column('text', { nullable: true })
  detail: string | null;

  @Column('text')
  createdAt: string;
}
