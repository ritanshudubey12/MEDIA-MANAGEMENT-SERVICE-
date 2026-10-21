import crypto from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { pool, withTransaction, type Queryable } from '../../db/pool.js';
import { audit, emitEvent } from '../../lib/audit.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { nextId } from '../../lib/id.js';
import type { RequestContext } from '../../middleware/authenticate.js';
import { assertWebsiteAccess } from '../../middleware/authorize.js';
import { storage } from '../../storage/local.adapter.js';
import { kickWorker } from '../../workers/media-processing.worker.js';
import { ALLOWED_MIME_TYPES, IMAGE_MIME_TYPES } from './media.schemas.js';

export interface AssetRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  website_id: string | null;
  folder_id: string | null;
  created_by: string;
  original_filename: string;
  display_name: string | null;
  storage_key: string;
  mime_type: string;
  size_bytes: string;
  checksum_sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: string | null;
  alt_text: string | null;
  status: string;
  visibility: string;
  failure_code: string | null;
  processing_attempts: number;
  created_at: Date;
  updated_at: Date;
}

export const toAssetDto = (r: AssetRow) => ({
  id: r.id,
  tenantId: r.tenant_id,
  organizationId: r.organization_id,
  websiteId: r.website_id,
  folderId: r.folder_id,
  createdBy: r.created_by,
  originalFilename: r.original_filename,
  displayName: r.display_name,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  checksumSha256: r.checksum_sha256,
  width: r.width,
  height: r.height,
  durationMs: r.duration_ms,
  altText: r.alt_text,
  status: r.status,
  visibility: r.visibility,
  failureCode: r.failure_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const websiteFilter = (ctx: RequestContext) => (ctx.websiteIds ? [...ctx.websiteIds] : null);

// Scope every lookup by tenant + organization (+ website restriction from the token) in SQL.
export async function getAssetOrThrow(db: Queryable, ctx: RequestContext, id: string, lock = false): Promise<AssetRow> {
  const { rows } = await db.query<AssetRow>(
    `SELECT * FROM media_assets
      WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND deleted_at IS NULL
        AND ($4::bigint[] IS NULL OR website_id = ANY($4::bigint[]))
      ${lock ? 'FOR UPDATE' : ''}`,
    [id, ctx.tenantId, ctx.organizationId, websiteFilter(ctx)],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function assertFolderInScope(db: Queryable, ctx: RequestContext, folderId: string | null | undefined, websiteId: string | null) {
  if (!folderId) return;
  const { rows } = await db.query<{ website_id: string | null }>(
    `SELECT website_id FROM media_folders WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND deleted_at IS NULL`,
    [folderId, ctx.tenantId, ctx.organizationId],
  );
  if (!rows[0]) throw notFound('Folder not found', 'FOLDER_NOT_FOUND');
  if (rows[0].website_id && websiteId && rows[0].website_id !== websiteId) {
    throw badRequest('Folder belongs to a different website');
  }
}

async function ensureUsageRow(db: Queryable, ctx: RequestContext) {
  await db.query(
    `INSERT INTO tenant_media_usage (tenant_id, organization_id, quota_bytes) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, organization_id) DO NOTHING`,
    [ctx.tenantId, ctx.organizationId, env.DEFAULT_TENANT_QUOTA_BYTES],
  );
}

const cleanFileName = (name: string) => name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255);

// ---------------------------------------------------------------- upload sessions

export async function createUploadSession(
  req: Request,
  input: {
    fileName: string;
    contentType: string;
    sizeBytes: string;
    websiteId?: string | null;
    folderId?: string | null;
    checksumSha256?: string;
  },
) {
  const ctx = req.ctx;
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(input.contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content type ${input.contentType} is not supported`);
  }
  const size = BigInt(input.sizeBytes);
  if (size <= 0n) throw badRequest('sizeBytes must be greater than zero');
  if (size > BigInt(env.MAX_UPLOAD_BYTES)) {
    throw new ApiError(413, 'FILE_TOO_LARGE', `File exceeds the maximum of ${env.MAX_UPLOAD_BYTES} bytes`);
  }
  const websiteId = input.websiteId ?? null;
  assertWebsiteAccess(req, websiteId);
  const idemKey = req.header('idempotency-key')?.slice(0, 128) || null;
  const fileName = cleanFileName(input.fileName);

  return withTransaction(async (db) => {
    if (idemKey) {
      const existing = await db.query(
        `SELECT s.id AS session_id, s.status AS session_status, a.id AS asset_id, a.original_filename, a.size_bytes, a.status
           FROM media_upload_sessions s JOIN media_assets a ON a.id = s.asset_id
          WHERE s.tenant_id=$1 AND s.organization_id=$2 AND s.actor_id=$3 AND s.idempotency_key=$4`,
        [ctx.tenantId, ctx.organizationId, ctx.userId, idemKey],
      );
      const e = existing.rows[0];
      if (e) {
        if (e.original_filename !== fileName || e.size_bytes !== input.sizeBytes) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
        }
        const { rows } = await db.query<{ storage_key: string }>('SELECT storage_key FROM media_assets WHERE id=$1', [e.asset_id]);
        const signed = storage.createUploadUrl(rows[0]!.storage_key, { ttlSeconds: env.PRESIGNED_URL_TTL_SECONDS });
        return {
          assetId: e.asset_id as string,
          uploadSessionId: e.session_id as string,
          status: e.status as string,
          uploadUrl: signed.url,
          expiresAt: signed.expiresAt,
          idempotentReplay: true,
        };
      }
    }

    await assertFolderInScope(db, ctx, input.folderId, websiteId);
    await ensureUsageRow(db, ctx);
    const usage = await db.query<{ stored_bytes: string; quota_bytes: string }>(
      `SELECT stored_bytes, quota_bytes FROM tenant_media_usage WHERE tenant_id=$1 AND organization_id=$2 FOR UPDATE`,
      [ctx.tenantId, ctx.organizationId],
    );
    const pending = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(s.expected_size_bytes),0) AS total FROM media_upload_sessions s
        WHERE s.tenant_id=$1 AND s.organization_id=$2 AND s.status='OPEN' AND s.expires_at > now()`,
      [ctx.tenantId, ctx.organizationId],
    );
    if (BigInt(usage.rows[0]!.stored_bytes) + BigInt(pending.rows[0]!.total) + size > BigInt(usage.rows[0]!.quota_bytes)) {
      throw new ApiError(429, 'QUOTA_EXCEEDED', 'Storage quota exceeded');
    }

    const assetId = nextId();
    const sessionId = nextId();
    const storageKey = `${ctx.tenantId}/${ctx.organizationId}/${assetId}/original`;
    const signed = storage.createUploadUrl(storageKey, { ttlSeconds: env.PRESIGNED_URL_TTL_SECONDS });

    await db.query(
      `INSERT INTO media_assets (id, tenant_id, organization_id, website_id, folder_id, created_by, original_filename,
         storage_key, mime_type, size_bytes, status, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_UPLOAD','PRIVATE')`,
      [assetId, ctx.tenantId, ctx.organizationId, websiteId, input.folderId ?? null, ctx.userId, fileName, storageKey, input.contentType, input.sizeBytes],
    );
    await db.query(
      `INSERT INTO media_upload_sessions (id, asset_id, tenant_id, organization_id, actor_id, expected_size_bytes, expires_at, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8)`,
      [sessionId, assetId, ctx.tenantId, ctx.organizationId, ctx.userId, input.sizeBytes, signed.expiresAt, idemKey],
    );
    // Remember the client-declared checksum (verified at completion) in the audit trail.
    await audit(db, ctx, 'media.upload_session.created', 'media_asset', assetId, {
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      checksumSha256: input.checksumSha256 ?? null,
    });
    return {
      assetId,
      uploadSessionId: sessionId,
      status: 'PENDING_UPLOAD',
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt,
      idempotentReplay: false,
    };
  });
}

export async function completeUpload(req: Request, id: string) {
  const ctx = req.ctx;
  const declaredChecksum = typeof req.body?.checksumSha256 === 'string' ? req.body.checksumSha256.toLowerCase() : null;
  if (declaredChecksum && !/^[a-f0-9]{64}$/.test(declaredChecksum)) throw badRequest('checksumSha256 must be a 64-char hex string');

  const result = await withTransaction(async (db) => {
    const asset = await getAssetOrThrow(db, ctx, id, true);
    if (asset.status !== 'PENDING_UPLOAD') return { asset, replay: true }; // idempotent: already completed

    const session = await db.query<{ id: string; expires_at: Date; expected_size_bytes: string }>(
      `SELECT id, expires_at, expected_size_bytes FROM media_upload_sessions WHERE asset_id=$1 AND status='OPEN'`,
      [asset.id],
    );
    const s = session.rows[0];
    if (!s) throw conflict('INVALID_STATE_TRANSITION', 'No open upload session for this asset');

    const stat = await storage.statObject(asset.storage_key);
    if (!stat) throw conflict('INVALID_STATE_TRANSITION', 'The file has not been uploaded yet');
    if (String(stat.sizeBytes) !== s.expected_size_bytes) {
      await storage.deleteObject(asset.storage_key);
      await db.query(`UPDATE media_assets SET status='FAILED', failure_code='SIZE_MISMATCH', updated_at=now() WHERE id=$1`, [asset.id]);
      await db.query(`UPDATE media_upload_sessions SET status='COMPLETED' WHERE id=$1`, [s.id]);
      return { asset: null, sizeMismatch: true };
    }
    const checksum = crypto.createHash('sha256').update(await storage.getObject(asset.storage_key)).digest('hex');
    if (declaredChecksum && declaredChecksum !== checksum) {
      await storage.deleteObject(asset.storage_key);
      await db.query(`UPDATE media_assets SET status='FAILED', failure_code='CHECKSUM_MISMATCH', updated_at=now() WHERE id=$1`, [asset.id]);
      await db.query(`UPDATE media_upload_sessions SET status='COMPLETED' WHERE id=$1`, [s.id]);
      return { asset: null, checksumMismatch: true };
    }

    const { rows } = await db.query<AssetRow>(
      `UPDATE media_assets SET status='UPLOADED', size_bytes=$2, checksum_sha256=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [asset.id, String(stat.sizeBytes), checksum],
    );
    await db.query(`UPDATE media_upload_sessions SET status='COMPLETED' WHERE id=$1`, [s.id]);
    await ensureUsageRow(db, ctx);
    await db.query(
      `UPDATE tenant_media_usage SET stored_bytes = stored_bytes + $3, asset_count = asset_count + 1, updated_at = now()
        WHERE tenant_id=$1 AND organization_id=$2`,
      [ctx.tenantId, ctx.organizationId, String(stat.sizeBytes)],
    );
    await audit(db, ctx, 'media.upload.completed', 'media_asset', asset.id, { sizeBytes: String(stat.sizeBytes) });
    return { asset: rows[0]!, replay: false };
  });

  if ('sizeMismatch' in result) throw new ApiError(422, 'INVALID_MEDIA_CONTENT', 'Uploaded size does not match the declared size');
  if ('checksumMismatch' in result) throw new ApiError(422, 'INVALID_MEDIA_CONTENT', 'Checksum does not match the uploaded file');
  if (!result.replay) kickWorker();
  return { ...toAssetDto(result.asset!), idempotentReplay: result.replay };
}

// ---------------------------------------------------------------- read / list

export async function listAssets(req: Request, q: Record<string, unknown>) {
  const ctx = req.ctx;
  const params: unknown[] = [ctx.tenantId, ctx.organizationId, websiteFilter(ctx)];
  const where = [
    'tenant_id = $1',
    'organization_id = $2',
    'deleted_at IS NULL',
    `status NOT IN ('DELETE_PENDING','DELETED')`,
    '($3::bigint[] IS NULL OR website_id = ANY($3::bigint[]))',
  ];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.cursor) add('id < ?', q.cursor);
  if (q.status) add('status = ?', q.status);
  if (q.folderId) add('folder_id = ?', q.folderId);
  if (q.websiteId) add('website_id = ?', q.websiteId);
  if (q.visibility) add('visibility = ?', q.visibility);
  if (q.mimeType) add(`mime_type LIKE ? ESCAPE '\\'`, `${String(q.mimeType).replace(/[\\%_]/g, '\\$&')}%`);
  if (q.q) {
    const like = `%${String(q.q).replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like);
    where.push(`(original_filename ILIKE $${params.length} ESCAPE '\\' OR display_name ILIKE $${params.length} ESCAPE '\\' OR alt_text ILIKE $${params.length} ESCAPE '\\')`);
  }
  const limit = Number(q.limit);
  params.push(limit + 1);
  const { rows } = await pool.query<AssetRow>(
    `SELECT * FROM media_assets WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  return { items: page.map(toAssetDto), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

interface VariantRow {
  id: string;
  variant_key: string;
  operation: string;
  params: unknown;
  storage_key: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  size_bytes: string | null;
  status: string;
  failure_code: string | null;
  created_at: Date;
}

export async function getAssetDetail(req: Request, id: string) {
  const asset = await getAssetOrThrow(pool, req.ctx, id);
  const { rows } = await pool.query<VariantRow>(`SELECT * FROM media_variants WHERE asset_id=$1 ORDER BY id`, [asset.id]);
  return {
    ...toAssetDto(asset),
    variants: rows.map((v) => ({
      id: v.id,
      variantKey: v.variant_key,
      operation: v.operation,
      params: v.params,
      mimeType: v.mime_type,
      width: v.width,
      height: v.height,
      sizeBytes: v.size_bytes,
      status: v.status,
      failureCode: v.failure_code,
      createdAt: v.created_at,
    })),
  };
}

export async function getProcessingStatus(req: Request, id: string) {
  const asset = await getAssetOrThrow(pool, req.ctx, id);
  const { rows } = await pool.query<VariantRow>(`SELECT * FROM media_variants WHERE asset_id=$1 ORDER BY id`, [asset.id]);
  return {
    assetId: asset.id,
    status: asset.status,
    failureCode: asset.failure_code,
    attempts: asset.processing_attempts,
    variants: rows.map((v) => ({ variantKey: v.variant_key, status: v.status, failureCode: v.failure_code })),
  };
}

async function resolveStorageKey(db: Queryable, asset: AssetRow, variantKey?: string) {
  if (!variantKey) return { key: asset.storage_key, mime: asset.mime_type };
  const { rows } = await db.query<{ storage_key: string; mime_type: string }>(
    `SELECT storage_key, mime_type FROM media_variants WHERE asset_id=$1 AND variant_key=$2 AND status='READY'`,
    [asset.id, variantKey],
  );
  if (!rows[0]) throw notFound('Variant not found or not ready', 'VARIANT_NOT_FOUND');
  return { key: rows[0].storage_key, mime: rows[0].mime_type };
}

export async function getContentTarget(req: Request, id: string, variantKey?: string) {
  const asset = await getAssetOrThrow(pool, req.ctx, id);
  if (asset.status !== 'READY') throw conflict('INVALID_STATE_TRANSITION', `Asset is ${asset.status}, not READY`);
  return resolveStorageKey(pool, asset, variantKey);
}

export async function getSignedUrl(req: Request, id: string, variantKey?: string) {
  const t = await getContentTarget(req, id, variantKey);
  const ttl = env.PRESIGNED_URL_TTL_SECONDS;
  return { url: storage.createDownloadUrl(t.key, ttl), expiresAt: new Date(Date.now() + ttl * 1000), mimeType: t.mime };
}

export async function getPublicTarget(id: string, variantKey?: string) {
  const { rows } = await pool.query<AssetRow>(
    `SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL AND status='READY' AND visibility='PUBLIC'`,
    [id],
  );
  if (!rows[0]) throw notFound();
  return resolveStorageKey(pool, rows[0], variantKey);
}

// ---------------------------------------------------------------- update / delete

async function updateMetadata(req: Request, id: string, input: Record<string, unknown>, action: string) {
  const ctx = req.ctx;
  if (input.visibility !== undefined && !ctx.permissions.has('media:manage')) {
    throw forbidden('Changing visibility requires media:manage', 'INSUFFICIENT_PERMISSION');
  }
  return withTransaction(async (db) => {
    const asset = await getAssetOrThrow(db, ctx, id, true);
    if (input.visibility === 'PUBLIC' && asset.status !== 'READY') {
      throw conflict('INVALID_STATE_TRANSITION', 'Only READY assets can be made PUBLIC');
    }
    if (input.folderId !== undefined) await assertFolderInScope(db, ctx, input.folderId as string | null, asset.website_id);
    const columns: Record<string, string> = {
      displayName: 'display_name',
      altText: 'alt_text',
      folderId: 'folder_id',
      visibility: 'visibility',
    };
    const sets: string[] = [];
    const values: unknown[] = [asset.id];
    for (const [key, col] of Object.entries(columns)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      sets.push(`${col} = $${values.length}`);
    }
    const { rows } = await db.query<AssetRow>(
      `UPDATE media_assets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      values,
    );
    await audit(db, ctx, action, 'media_asset', asset.id, { fields: Object.keys(input) });
    if (input.visibility !== undefined && input.visibility !== asset.visibility) {
      await emitEvent(db, ctx, 'media.asset.visibility_changed', asset.id, { visibility: input.visibility });
    }
    return toAssetDto(rows[0]!);
  });
}

export const patchAsset = (req: Request, id: string, input: Record<string, unknown>) => updateMetadata(req, id, input, 'media.asset.updated');
export const putAsset = (req: Request, id: string, input: Record<string, unknown>) => updateMetadata(req, id, input, 'media.asset.replaced');

export async function deleteAsset(req: Request, id: string, force: boolean) {
  const ctx = req.ctx;
  if (force && !ctx.permissions.has('media:manage')) {
    throw forbidden('Force delete requires media:manage', 'INSUFFICIENT_PERMISSION');
  }
  return withTransaction(async (db) => {
    const asset = await getAssetOrThrow(db, ctx, id, true);
    const refs = await db.query<{ n: string }>(`SELECT count(*) AS n FROM media_asset_references WHERE asset_id=$1`, [asset.id]);
    if (Number(refs.rows[0]!.n) > 0 && !force) {
      throw conflict('ASSET_IN_USE', `Asset is referenced ${refs.rows[0]!.n} time(s); remove references or use force=true`);
    }
    await db.query(`DELETE FROM media_asset_references WHERE asset_id=$1`, [asset.id]);
    await db.query(
      `UPDATE media_assets SET status='DELETE_PENDING', deleted_at=now(), updated_at=now() WHERE id=$1`,
      [asset.id],
    );
    await audit(db, ctx, 'media.asset.deleted', 'media_asset', asset.id, { force });
    await emitEvent(db, ctx, 'media.asset.deleted', asset.id, {});
    return { id: asset.id, status: 'DELETE_PENDING' };
  }).then((r) => {
    kickWorker();
    return r;
  });
}

// ---------------------------------------------------------------- variants

export async function requestVariant(
  req: Request,
  id: string,
  operation: 'resize' | 'crop' | 'optimize',
  params: Record<string, unknown>,
) {
  const ctx = req.ctx;
  const result = await withTransaction(async (db: PoolClient) => {
    const asset = await getAssetOrThrow(db, ctx, id, true);
    if (!IMAGE_MIME_TYPES.has(asset.mime_type)) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Transformations are only supported for images');
    }
    if (asset.status !== 'READY') throw conflict('INVALID_STATE_TRANSITION', `Asset is ${asset.status}, not READY`);
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const key = `${operation}_${Object.keys(clean).sort().map((k) => `${clean[k]}`).join('_')}`.replace(/[^\w.-]/g, '').slice(0, 120);
    const inserted = await db.query(
      `INSERT INTO media_variants (id, asset_id, variant_key, operation, params, status) VALUES ($1,$2,$3,$4,$5,'PENDING')
       ON CONFLICT (asset_id, variant_key) DO NOTHING RETURNING id`,
      [nextId(), asset.id, key, operation, clean],
    );
    const { rows } = await db.query<VariantRow>(`SELECT * FROM media_variants WHERE asset_id=$1 AND variant_key=$2`, [asset.id, key]);
    if (inserted.rowCount) await audit(db, ctx, `media.variant.${operation}`, 'media_asset', asset.id, { variantKey: key });
    return { assetId: asset.id, variantId: rows[0]!.id, variantKey: key, status: rows[0]!.status, alreadyExisted: !inserted.rowCount };
  });
  kickWorker();
  return result;
}

// ---------------------------------------------------------------- references

export async function listReferences(req: Request, id: string) {
  const asset = await getAssetOrThrow(pool, req.ctx, id);
  const { rows } = await pool.query(
    `SELECT id, source_type, source_id, reference_key, created_at FROM media_asset_references WHERE asset_id=$1 ORDER BY id`,
    [asset.id],
  );
  return {
    assetId: asset.id,
    inUse: rows.length > 0,
    references: rows.map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id, referenceKey: r.reference_key, createdAt: r.created_at })),
  };
}

export async function addReference(req: Request, id: string, input: { sourceType: string; sourceId: string; referenceKey: string }) {
  const ctx = req.ctx;
  return withTransaction(async (db) => {
    const asset = await getAssetOrThrow(db, ctx, id, true);
    const refId = nextId();
    const { rows } = await db.query(
      `INSERT INTO media_asset_references (id, asset_id, tenant_id, organization_id, source_type, source_id, reference_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (asset_id, source_type, source_id, reference_key) DO UPDATE SET source_type = EXCLUDED.source_type
       RETURNING id, created_at`,
      [refId, asset.id, ctx.tenantId, ctx.organizationId, input.sourceType, input.sourceId, input.referenceKey],
    );
    await audit(db, ctx, 'media.reference.added', 'media_asset', asset.id, input);
    return { id: rows[0].id as string, assetId: asset.id, ...input, createdAt: rows[0].created_at as Date };
  });
}

export async function removeReference(req: Request, id: string, referenceId: string) {
  const ctx = req.ctx;
  return withTransaction(async (db) => {
    const asset = await getAssetOrThrow(db, ctx, id, true);
    const { rowCount } = await db.query(`DELETE FROM media_asset_references WHERE id=$1 AND asset_id=$2`, [referenceId, asset.id]);
    if (!rowCount) throw notFound('Reference not found', 'REFERENCE_NOT_FOUND');
    await audit(db, ctx, 'media.reference.removed', 'media_asset', asset.id, { referenceId });
    return { id: referenceId, assetId: asset.id, removed: true };
  });
}

// ---------------------------------------------------------------- usage

export async function getUsage(req: Request) {
  const ctx = req.ctx;
  await ensureUsageRow(pool, ctx);
  const { rows } = await pool.query(
    `SELECT stored_bytes, asset_count, quota_bytes, updated_at FROM tenant_media_usage WHERE tenant_id=$1 AND organization_id=$2`,
    [ctx.tenantId, ctx.organizationId],
  );
  const r = rows[0];
  return { storedBytes: r.stored_bytes, assetCount: r.asset_count, quotaBytes: r.quota_bytes, updatedAt: r.updated_at };
}
