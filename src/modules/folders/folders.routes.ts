import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction, type Queryable } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { ApiError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { asyncHandler, validateIdParam } from '../../lib/http.js';
import { nextId } from '../../lib/id.js';
import { ok } from '../../lib/respond.js';
import type { RequestContext } from '../../middleware/authenticate.js';
import { assertWebsiteAccess, requirePermission } from '../../middleware/authorize.js';
import { idStr } from '../media/media.schemas.js';

interface FolderRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  website_id: string | null;
  parent_folder_id: string | null;
  name: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const dto = (f: FolderRow) => ({
  id: f.id,
  websiteId: f.website_id,
  parentFolderId: f.parent_folder_id,
  name: f.name,
  createdBy: f.created_by,
  createdAt: f.created_at,
  updatedAt: f.updated_at,
});

const name = z.string().trim().min(1).max(120).refine((n) => !/[\\/]/.test(n), 'name must not contain slashes');
const createSchema = z.object({ name, websiteId: idStr.nullable().optional(), parentFolderId: idStr.nullable().optional() });
const patchSchema = z
  .object({ name: name.optional(), parentFolderId: idStr.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
const putSchema = z.object({ name, parentFolderId: idStr.nullable() });
const listSchema = z.object({
  websiteId: idStr.optional(),
  parentFolderId: z.union([idStr, z.literal('root')]).optional(),
});
const deleteSchema = z.object({ moveContentsToParent: z.enum(['true', 'false']).default('false') });

const allowedSites = (ctx: RequestContext) => (ctx.websiteIds ? [...ctx.websiteIds] : null);

async function getFolder(db: Queryable, ctx: RequestContext, id: string, lock = false): Promise<FolderRow> {
  const { rows } = await db.query<FolderRow>(
    `SELECT * FROM media_folders WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND deleted_at IS NULL
        AND ($4::bigint[] IS NULL OR website_id = ANY($4::bigint[])) ${lock ? 'FOR UPDATE' : ''}`,
    [id, ctx.tenantId, ctx.organizationId, allowedSites(ctx)],
  );
  if (!rows[0]) throw notFound('Folder not found', 'FOLDER_NOT_FOUND');
  return rows[0];
}

function mapUnique(err: unknown): never {
  if ((err as { code?: string }).code === '23505') {
    throw new ApiError(409, 'FOLDER_NAME_EXISTS', 'A folder with this name already exists in the same location');
  }
  throw err;
}

export const foldersRouter = Router();
foldersRouter.param('id', validateIdParam);

foldersRouter.get(
  '/',
  requirePermission('media:read'),
  asyncHandler(async (req, res) => {
    const q = listSchema.parse(req.query);
    const ctx = req.ctx;
    const params: unknown[] = [ctx.tenantId, ctx.organizationId, allowedSites(ctx)];
    let sql = `SELECT * FROM media_folders WHERE tenant_id=$1 AND organization_id=$2 AND deleted_at IS NULL
                 AND ($3::bigint[] IS NULL OR website_id = ANY($3::bigint[]))`;
    if (q.websiteId) {
      params.push(q.websiteId);
      sql += ` AND website_id = $${params.length}`;
    }
    if (q.parentFolderId === 'root') sql += ' AND parent_folder_id IS NULL';
    else if (q.parentFolderId) {
      params.push(q.parentFolderId);
      sql += ` AND parent_folder_id = $${params.length}`;
    }
    const { rows } = await pool.query<FolderRow>(`${sql} ORDER BY lower(name), id`, params);
    ok(req, res, rows.map(dto));
  }),
);

foldersRouter.post(
  '/',
  requirePermission('media:manage'),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const ctx = req.ctx;
    assertWebsiteAccess(req, body.websiteId ?? null);
    const folder = await withTransaction(async (db) => {
      let websiteId = body.websiteId ?? null;
      if (body.parentFolderId) {
        const parent = await getFolder(db, ctx, body.parentFolderId);
        if (websiteId && parent.website_id && parent.website_id !== websiteId) throw badRequest('Parent folder belongs to a different website');
        websiteId = websiteId ?? parent.website_id; // auto-inherit website from parent
      }
      try {
        const { rows } = await db.query<FolderRow>(
          `INSERT INTO media_folders (id, tenant_id, organization_id, website_id, parent_folder_id, name, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [nextId(), ctx.tenantId, ctx.organizationId, websiteId, body.parentFolderId ?? null, body.name, ctx.userId],
        );
        await audit(db, ctx, 'media.folder.created', 'media_folder', rows[0]!.id, { name: body.name });
        return rows[0]!;
      } catch (e) {
        return mapUnique(e);
      }
    });
    ok(req, res, dto(folder));
  }),
);

foldersRouter.get(
  '/:id',
  requirePermission('media:read'),
  asyncHandler(async (req, res) => ok(req, res, dto(await getFolder(pool, req.ctx, String(req.params.id))))),
);

async function updateFolder(req: import('express').Request, input: { name?: string; parentFolderId?: string | null }) {
  const ctx = req.ctx;
  const id = String(req.params.id);
  return withTransaction(async (db) => {
    const folder = await getFolder(db, ctx, id, true);
    if (input.parentFolderId !== undefined && input.parentFolderId !== null) {
      if (input.parentFolderId === id) throw badRequest('A folder cannot be its own parent');
      const parent = await getFolder(db, ctx, input.parentFolderId);
      if (folder.website_id && parent.website_id && folder.website_id !== parent.website_id) {
        throw badRequest('Parent folder belongs to a different website');
      }
      const cycle = await db.query(
        `WITH RECURSIVE d AS (
           SELECT id FROM media_folders WHERE parent_folder_id = $1 AND deleted_at IS NULL
           UNION SELECT f.id FROM media_folders f JOIN d ON f.parent_folder_id = d.id WHERE f.deleted_at IS NULL)
         SELECT 1 FROM d WHERE id = $2`,
        [id, input.parentFolderId],
      );
      if (cycle.rowCount) throw badRequest('Cannot move a folder into its own descendant');
    }
    try {
      const { rows } = await db.query<FolderRow>(
        `UPDATE media_folders SET name = COALESCE($2, name),
                parent_folder_id = CASE WHEN $3::boolean THEN $4::bigint ELSE parent_folder_id END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, input.name ?? null, input.parentFolderId !== undefined, input.parentFolderId ?? null],
      );
      await audit(db, ctx, 'media.folder.updated', 'media_folder', id, input);
      return rows[0]!;
    } catch (e) {
      return mapUnique(e);
    }
  });
}

foldersRouter.patch(
  '/:id',
  requirePermission('media:manage'),
  asyncHandler(async (req, res) => ok(req, res, dto(await updateFolder(req, patchSchema.parse(req.body))))),
);
foldersRouter.put(
  '/:id',
  requirePermission('media:manage'),
  asyncHandler(async (req, res) => ok(req, res, dto(await updateFolder(req, putSchema.parse(req.body))))),
);

foldersRouter.delete(
  '/:id',
  requirePermission('media:manage'),
  asyncHandler(async (req, res) => {
    const { moveContentsToParent } = deleteSchema.parse(req.query);
    const ctx = req.ctx;
    const id = String(req.params.id);
    const result = await withTransaction(async (db) => {
      const folder = await getFolder(db, ctx, id, true);
      const children = await db.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM media_folders WHERE parent_folder_id=$1 AND deleted_at IS NULL)
              + (SELECT count(*) FROM media_assets WHERE folder_id=$1 AND deleted_at IS NULL) AS n`,
        [id],
      );
      if (Number(children.rows[0]!.n) > 0) {
        if (moveContentsToParent !== 'true') {
          throw conflict('FOLDER_NOT_EMPTY', 'Folder is not empty; pass moveContentsToParent=true to move its contents to the parent');
        }
        try {
          await db.query(`UPDATE media_folders SET parent_folder_id=$2, updated_at=now() WHERE parent_folder_id=$1 AND deleted_at IS NULL`, [id, folder.parent_folder_id]);
        } catch (e) {
          mapUnique(e);
        }
        await db.query(`UPDATE media_assets SET folder_id=$2, updated_at=now() WHERE folder_id=$1 AND deleted_at IS NULL`, [id, folder.parent_folder_id]);
      }
      await db.query(`UPDATE media_folders SET deleted_at=now(), updated_at=now() WHERE id=$1`, [id]);
      await audit(db, ctx, 'media.folder.deleted', 'media_folder', id, { moveContentsToParent });
      return { id, deleted: true };
    });
    ok(req, res, result);
  }),
);
