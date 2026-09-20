import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';
import { newId } from '../../common/crypto.util';
import { Clock } from '../../common/clock';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>,
    private readonly clock: Clock,
  ) {}

  async record(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.repo.save(
      this.repo.create({
        id: newId(),
        actorUserId,
        action,
        entityType,
        entityId,
        detail: detail ? JSON.stringify(detail) : null,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  /** 某实体相关的全部审计记录（按时间升序） */
  async trailFor(entityType: string, entityId: string): Promise<AuditLog[]> {
    const logs = await this.repo.find({ where: { entityType, entityId } });
    return logs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
