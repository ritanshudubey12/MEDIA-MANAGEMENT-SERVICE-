import sharp, { type FitEnum, type Metadata, type Sharp } from 'sharp';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { nextId } from '../lib/id.js';
import { detectMime } from '../lib/file-signature.js';
import { storage } from '../storage/local.adapter.js';

const MAX_ATTEMPTS = 3;
const MAX_PIXELS = 50_000_000; // decompression-bomb guard
const STUCK_AFTER_MINUTES = 5;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

class ContentError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const EXT: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

function encode(img: Sharp, format: string, quality?: number) {
  switch (format) {
    case 'jpeg':
      return img.jpeg({ quality: quality ?? 80 });
    case 'png':
      return img.png();
    case 'avif':
      return img.avif({ quality: quality ?? 60 });
    default:
      return img.webp({ quality: quality ?? 80 });
  }
}

async function processAsset(): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE media_assets SET status='PROCESSING', processing_attempts = processing_attempts + 1, updated_at = now()
      WHERE id = (SELECT id FROM media_assets WHERE status='UPLOADED' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  const asset = rows[0];
  if (!asset) return false;
  try {
    const buf = await storage.getObject(asset.storage_key);
    const detected = detectMime(buf);
    if (!detected || detected !== asset.mime_type) throw new ContentError('FILE_SIGNATURE_MISMATCH');

    let width: number | null = null;
    let height: number | null = null;
    if (IMAGE_TYPES.has(asset.mime_type)) {
      let meta: Metadata;
      try {
        meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
      } catch {
        throw new ContentError('INVALID_MEDIA_CONTENT');
      }
      width = meta.width ?? null;
      height = meta.height ?? null;
      if (!width || !height) throw new ContentError('INVALID_MEDIA_CONTENT');
      const thumbKey = `${asset.tenant_id}/${asset.organization_id}/${asset.id}/variants/thumb_320`;
      let thumb: Buffer;
      try {
        thumb = await sharp(buf, { limitInputPixels: MAX_PIXELS })
          .rotate()
          .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75 })
          .toBuffer({ resolveWithObject: false });
      } catch {
        throw new ContentError('INVALID_MEDIA_CONTENT');
      }
      await storage.putObject(thumbKey, thumb);
      const tm = await sharp(thumb).metadata();
      await pool.query(
        `INSERT INTO media_variants (id, asset_id, variant_key, operation, params, storage_key, mime_type, width, height, size_bytes, status)
         VALUES ($1,$2,'thumb_320','thumbnail','{"width":320}',$3,'image/webp',$4,$5,$6,'READY')
         ON CONFLICT (asset_id, variant_key) DO NOTHING`,
        [nextId(), asset.id, thumbKey, tm.width ?? null, tm.height ?? null, String(thumb.length)],
      );
    }
    await pool.query(
      `UPDATE media_assets SET status='READY', width=$2, height=$3, failure_code=NULL, updated_at=now() WHERE id=$1`,
      [asset.id, width, height],
    );
    await pool.query(
      `INSERT INTO outbox_events (id, tenant_id, organization_id, event_type, aggregate_id, payload)
       VALUES ($1,$2,$3,'media.asset.ready',$4,$5)`,
      [nextId(), asset.tenant_id, asset.organization_id, asset.id, { mimeType: asset.mime_type, width, height }],
    );
  } catch (err) {
    const permanent = err instanceof ContentError;
    const code = permanent ? err.code : 'PROCESSING_ERROR';
    const giveUp = permanent || asset.processing_attempts >= MAX_ATTEMPTS;
    if (!permanent) console.error(JSON.stringify({ level: 'error', worker: 'processing', assetId: asset.id, err: String(err) }));
    await pool.query(
      `UPDATE media_assets SET status=$2, failure_code=$3, updated_at=now() WHERE id=$1`,
      [asset.id, giveUp ? 'FAILED' : 'UPLOADED', code],
    );
  }
  return true;
}

async function processVariant(): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE media_variants SET status='PROCESSING', updated_at=now()
      WHERE id = (SELECT id FROM media_variants WHERE status='PENDING' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  const v = rows[0];
  if (!v) return false;
  try {
    const a = (await pool.query('SELECT * FROM media_assets WHERE id=$1', [v.asset_id])).rows[0];
    if (!a || a.status !== 'READY') throw new ContentError('ASSET_NOT_READY');
    const p = v.params as Record<string, number | string | undefined>;
    const format = (p.format as string) ?? (a.mime_type === 'image/jpeg' ? 'jpeg' : a.mime_type === 'image/png' ? 'png' : a.mime_type === 'image/avif' ? 'avif' : 'webp');
    let img = sharp(await storage.getObject(a.storage_key), { limitInputPixels: MAX_PIXELS }).rotate();
    if (v.operation === 'resize') {
      img = img.resize({
        width: p.width as number | undefined,
        height: p.height as number | undefined,
        fit: ((p.fit as string) ?? 'inside') as keyof FitEnum,
        withoutEnlargement: true,
      });
    } else if (v.operation === 'crop') {
      const meta = await img.clone().toBuffer().then((b) => sharp(b).metadata());
      const left = p.left as number;
      const top = p.top as number;
      const width = p.width as number;
      const height = p.height as number;
      if (left + width > (meta.width ?? 0) || top + height > (meta.height ?? 0)) throw new ContentError('CROP_OUT_OF_BOUNDS');
      img = img.extract({ left, top, width, height });
    }
    const out = await encode(img, format, v.operation === 'optimize' ? (p.quality as number) : undefined).toBuffer();
    const meta = await sharp(out).metadata();
    const key = `${a.tenant_id}/${a.organization_id}/${a.id}/variants/${v.variant_key}`;
    await storage.putObject(key, out);
    await pool.query(
      `UPDATE media_variants SET status='READY', storage_key=$2, mime_type=$3, width=$4, height=$5, size_bytes=$6, failure_code=NULL, updated_at=now() WHERE id=$1`,
      [v.id, key, EXT[format] ?? 'image/webp', meta.width ?? null, meta.height ?? null, String(out.length)],
    );
  } catch (err) {
    const code = err instanceof ContentError ? err.code : 'PROCESSING_ERROR';
    if (!(err instanceof ContentError)) console.error(JSON.stringify({ level: 'error', worker: 'variant', variantId: v.id, err: String(err) }));
    await pool.query(`UPDATE media_variants SET status='FAILED', failure_code=$2, updated_at=now() WHERE id=$1`, [v.id, code]);
  }
  return true;
}

// Cleanup: physically remove binaries of deleted assets, expire abandoned sessions, reconcile stuck jobs.
async function cleanup(): Promise<boolean> {
  let didWork = false;

  const expired = await pool.query(
    `UPDATE media_upload_sessions SET status='EXPIRED' WHERE status='OPEN' AND expires_at < now() RETURNING asset_id`,
  );
  if (expired.rowCount) {
    didWork = true;
    await pool.query(
      `UPDATE media_assets SET status='DELETE_PENDING', deleted_at=now(), failure_code='UPLOAD_EXPIRED', updated_at=now()
        WHERE id = ANY($1::bigint[]) AND status='PENDING_UPLOAD'`,
      [expired.rows.map((r) => r.asset_id)],
    );
  }

  const stuck = await pool.query(
    `UPDATE media_assets SET status='UPLOADED', updated_at=now()
      WHERE status='PROCESSING' AND updated_at < now() - ($1 || ' minutes')::interval RETURNING id`,
    [String(STUCK_AFTER_MINUTES)],
  );
  if (stuck.rowCount) didWork = true;
  await pool.query(
    `UPDATE media_variants SET status='PENDING', updated_at=now()
      WHERE status='PROCESSING' AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(STUCK_AFTER_MINUTES)],
  );

  const { rows } = await pool.query(
    `SELECT * FROM media_assets WHERE status='DELETE_PENDING' ORDER BY id LIMIT 20`,
  );
  for (const a of rows) {
    didWork = true;
    const variants = await pool.query('SELECT storage_key FROM media_variants WHERE asset_id=$1 AND storage_key IS NOT NULL', [a.id]);
    for (const v of variants.rows) await storage.deleteObject(v.storage_key);
    await storage.deleteObject(a.storage_key);
    await pool.query('DELETE FROM media_variants WHERE asset_id=$1', [a.id]);
    await pool.query(`UPDATE media_assets SET status='DELETED', updated_at=now() WHERE id=$1`, [a.id]);
    if (a.checksum_sha256) {
      // Bytes were counted at completion; release them.
      await pool.query(
        `UPDATE tenant_media_usage SET stored_bytes = GREATEST(stored_bytes - $3::bigint, 0), asset_count = GREATEST(asset_count - 1, 0), updated_at = now()
          WHERE tenant_id=$1 AND organization_id=$2`,
        [a.tenant_id, a.organization_id, a.size_bytes],
      );
    }
  }
  return didWork;
}

let running = false;
let rerun = false;

export async function tick() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      while (await processAsset()) { /* drain */ }
      while (await processVariant()) { /* drain */ }
      await cleanup();
    } while (rerun);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', worker: 'tick', err: String(err) }));
  } finally {
    running = false;
  }
}

export const kickWorker = () => {
  setImmediate(() => void tick());
};

let timer: NodeJS.Timeout | undefined;

export function startWorker() {
  timer = setInterval(() => void tick(), env.WORKER_POLL_MS);
  timer.unref();
  kickWorker();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
}
