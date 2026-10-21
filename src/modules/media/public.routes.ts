import express, { Router } from 'express';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { detectMime } from '../../lib/file-signature.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { asyncHandler, validateIdParam } from '../../lib/http.js';
import { ok } from '../../lib/respond.js';
import { storage } from '../../storage/local.adapter.js';
import { getPublicTarget } from './media.service.js';

// Routes authenticated by a signed URL (or explicit PUBLIC visibility) instead of a Bearer token.
export const publicRouter = Router();

// Browser -> storage upload target (the "presigned" PUT URL). Body is the raw file.
publicRouter.put(
  '/uploads/:key',
  express.raw({ type: () => true, limit: env.MAX_UPLOAD_BYTES }),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const { expires, sig } = req.query as Record<string, string>;
    if (!expires || !sig || !storage.verifyUploadSignature(key, expires, sig)) {
      throw new ApiError(403, 'FORBIDDEN', 'Upload URL is invalid or expired');
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.mime_type, s.expected_size_bytes
         FROM media_assets a JOIN media_upload_sessions s ON s.asset_id = a.id
        WHERE a.storage_key=$1 AND a.status='PENDING_UPLOAD' AND s.status='OPEN' AND s.expires_at > now()`,
      [key],
    );
    if (!rows[0]) throw new ApiError(403, 'FORBIDDEN', 'No open upload session for this URL');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Empty upload body');
    if (String(body.length) !== rows[0].expected_size_bytes) {
      throw new ApiError(422, 'INVALID_MEDIA_CONTENT', 'Uploaded size does not match the declared size');
    }
    if (detectMime(body) !== rows[0].mime_type) {
      throw new ApiError(422, 'INVALID_MEDIA_CONTENT', 'File content does not match the declared content type');
    }
    await storage.putObject(key, body);
    ok(req, res, { uploaded: true, sizeBytes: String(body.length) });
  }),
);

// Signed download (from GET /:id/url).
publicRouter.get(
  '/files/:key',
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const { expires, sig } = req.query as Record<string, string>;
    if (!expires || !sig || !storage.verifyDownloadSignature(key, expires, sig)) {
      throw new ApiError(403, 'FORBIDDEN', 'Download URL is invalid or expired');
    }
    const { rows } = await pool.query(
      `SELECT mime_type FROM media_assets WHERE storage_key=$1 AND status='READY' AND deleted_at IS NULL
       UNION ALL
       SELECT v.mime_type FROM media_variants v JOIN media_assets a ON a.id=v.asset_id
        WHERE v.storage_key=$1 AND v.status='READY' AND a.deleted_at IS NULL`,
      [key],
    );
    if (!rows[0]) throw notFound();
    res.setHeader('Content-Type', rows[0].mime_type);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    storage.getObjectStream(key).on('error', () => res.destroy()).pipe(res);
  }),
);

// Explicitly PUBLIC + READY assets only. Private assets 404 here.
publicRouter.param('id', validateIdParam);
publicRouter.get(
  '/public/:id',
  asyncHandler(async (req, res) => {
    const variant = typeof req.query.variant === 'string' ? req.query.variant : undefined;
    const t = await getPublicTarget(String(req.params.id), variant);
    res.setHeader('Content-Type', t.mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    storage.getObjectStream(t.key).on('error', () => res.destroy()).pipe(res);
  }),
);
