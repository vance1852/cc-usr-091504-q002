import { Injectable } from '@nestjs/common';
import { DbService } from '../database/database.service';
import { Actor } from '../domain';

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  record(
    actor: Actor | undefined,
    action: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {},
    at = Date.now(),
  ): void {
    this.db.db
      .prepare(
        `INSERT INTO audit_log (at, actor_user_id, actor_role, action, entity_type, entity_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        actor?.userId ?? null,
        actor?.role ?? null,
        action,
        entityType,
        entityId,
        JSON.stringify(detail),
      );
  }

  forEntities(entities: Array<{ type: string; id: string }>) {
    const marks = entities.map(() => '(?, ?)').join(',');
    const params: unknown[] = [];
    for (const e of entities) params.push(e.type, e.id);
    return this.db.db
      .prepare(
        `SELECT * FROM audit_log WHERE (entity_type, entity_id) IN (${marks}) ORDER BY at ASC, id ASC`,
      )
      .all(...(params as any[]));
  }
}
