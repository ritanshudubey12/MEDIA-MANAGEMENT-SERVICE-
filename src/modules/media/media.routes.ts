import { Router } from 'express';
import { asyncHandler, validateIdParam } from '../../lib/http.js';
import { ok } from '../../lib/respond.js';
import { requirePermission } from '../../middleware/authorize.js';
import { storage } from '../../storage/local.adapter.js';
import {
  createUploadSessionSchema,
  cropSchema,
  deleteQuerySchema,
  idStr,
  listQuerySchema,
  optimizeSchema,
  patchMediaSchema,
  putMediaSchema,
  referenceSchema,
  resizeSchema,
  variantQuerySchema,
} from './media.schemas.js';
import * as svc from './media.service.js';

export const mediaRouter = Router();
mediaRouter.param('id', validateIdParam);
mediaRouter.param('referenceId', validateIdParam);

// NOTE: folder routes are mounted before this router (see app.ts) so /folders never matches /:id.

mediaRouter.get('/usage', requirePermission('media:read'), asyncHandler(async (req, res) => ok(req, res, await svc.getUsage(req))));

mediaRouter.get(
  '/',
  requirePermission('media:read'),
  asyncHandler(async (req, res) => {
    const { items, nextCursor } = await svc.listAssets(req, listQuerySchema.parse(req.query));
    ok(req, res, items, { nextCursor, limit: Number(req.query.limit ?? 25) });
  }),
);

mediaRouter.post(
  '/upload-sessions',
  requirePermission('media:upload'),
  asyncHandler(async (req, res) => ok(req, res, await svc.createUploadSession(req, createUploadSessionSchema.parse(req.body)))),
);

mediaRouter.post(
  '/:id/complete-upload',
  requirePermission('media:upload'),
  asyncHandler(async (req, res) => ok(req, res, await svc.completeUpload(req, String(req.params.id)))),
);

mediaRouter.get('/:id', requirePermission('media:read'), asyncHandler(async (req, res) => ok(req, res, await svc.getAssetDetail(req, String(req.params.id)))));

mediaRouter.patch(
  '/:id',
  requirePermission('media:update'),
  asyncHandler(async (req, res) => ok(req, res, await svc.patchAsset(req, String(req.params.id), patchMediaSchema.parse(req.body)))),
);

mediaRouter.put(
  '/:id',
  requirePermission('media:update'),
  asyncHandler(async (req, res) => ok(req, res, await svc.putAsset(req, String(req.params.id), putMediaSchema.parse(req.body)))),
);

mediaRouter.delete(
  '/:id',
  requirePermission('media:delete'),
  asyncHandler(async (req, res) => {
    const { force } = deleteQuerySchema.parse(req.query);
    ok(req, res, await svc.deleteAsset(req, String(req.params.id), force === 'true'));
  }),
);

mediaRouter.get(
  '/:id/processing-status',
  requirePermission('media:read'),
  asyncHandler(async (req, res) => ok(req, res, await svc.getProcessingStatus(req, String(req.params.id)))),
);

mediaRouter.post(
  '/:id/optimize',
  requirePermission('media:process'),
  asyncHandler(async (req, res) => ok(req, res, await svc.requestVariant(req, String(req.params.id), 'optimize', optimizeSchema.parse(req.body ?? {})))),
);
mediaRouter.post(
  '/:id/resize',
  requirePermission('media:process'),
  asyncHandler(async (req, res) => ok(req, res, await svc.requestVariant(req, String(req.params.id), 'resize', resizeSchema.parse(req.body)))),
);
mediaRouter.post(
  '/:id/crop',
  requirePermission('media:process'),
  asyncHandler(async (req, res) => ok(req, res, await svc.requestVariant(req, String(req.params.id), 'crop', cropSchema.parse(req.body)))),
);

mediaRouter.get(
  '/:id/url',
  requirePermission('media:read'),
  asyncHandler(async (req, res) => ok(req, res, await svc.getSignedUrl(req, String(req.params.id), variantQuerySchema.parse(req.query).variant))),
);

mediaRouter.get(
  '/:id/content',
  requirePermission('media:read'),
  asyncHandler(async (req, res) => {
    const t = await svc.getContentTarget(req, String(req.params.id), variantQuerySchema.parse(req.query).variant);
    res.setHeader('Content-Type', t.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    storage.getObjectStream(t.key).on('error', () => res.destroy()).pipe(res);
  }),
);

mediaRouter.get('/:id/references', requirePermission('media:read'), asyncHandler(async (req, res) => ok(req, res, await svc.listReferences(req, String(req.params.id)))));
mediaRouter.post(
  '/:id/references',
  requirePermission('media:update'),
  asyncHandler(async (req, res) => ok(req, res, await svc.addReference(req, String(req.params.id), referenceSchema.parse(req.body)))),
);
mediaRouter.delete(
  '/:id/references/:referenceId',
  requirePermission('media:update'),
  asyncHandler(async (req, res) => ok(req, res, await svc.removeReference(req, String(req.params.id), idStr.parse(req.params.referenceId)))),
);

