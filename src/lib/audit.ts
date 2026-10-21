import type { Queryable } from '../db/pool.js';
import type { RequestContext } from '../middleware/authenticate.js';
import { nextId } from './id.js';

export async function audit(
  db: Queryable,
  ctx: RequestContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO audit_events (id, tenant_id, organization_id, actor_id, action, resource_type, resource_id, request_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [nextId(), ctx.tenantId, ctx.organizationId, ctx.userId, action, resourceType, resourceId, ctx.requestId, details],
  );
}

export async function emitEvent(
  db: Queryable,
  ctx: { tenantId: string; organizationId: string },
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
) {
  await db.query(
    `INSERT INTO outbox_events (id, tenant_id, organization_id, event_type, aggregate_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [nextId(), ctx.tenantId, ctx.organizationId, eventType, aggregateId, payload],
  );
}
