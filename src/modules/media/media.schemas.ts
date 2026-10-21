import { z } from 'zod';

export const idStr = z.string().regex(/^[0-9]{1,19}$/, 'must be a decimal string ID');
const digitsOrNumber = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((v) => String(v));

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/pdf',
  'video/mp4',
] as const;

export const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const optionalId = idStr.nullable().optional();
const text = (max: number) => z.string().trim().max(max);

export const createUploadSessionSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().toLowerCase(),
  sizeBytes: digitsOrNumber,
  websiteId: optionalId,
  folderId: optionalId,
  checksumSha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: idStr.optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED']).optional(),
  folderId: idStr.optional(),
  websiteId: idStr.optional(),
  mimeType: z.string().trim().max(100).optional(),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
});

export const patchMediaSchema = z
  .object({
    displayName: text(255).nullable().optional(),
    altText: text(1000).nullable().optional(),
    folderId: optionalId,
    visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

// PUT replaces all editable metadata: every key must be present (nullable fields may be null).
export const putMediaSchema = z.object({
  displayName: text(255).nullable(),
  altText: text(1000).nullable(),
  folderId: idStr.nullable(),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
});

const format = z.enum(['jpeg', 'png', 'webp', 'avif']).optional();
const dim = z.number().int().min(1).max(8192);

export const resizeSchema = z
  .object({
    width: dim.optional(),
    height: dim.optional(),
    fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).default('inside'),
    format,
  })
  .refine((v) => v.width !== undefined || v.height !== undefined, { message: 'width or height is required' });

export const cropSchema = z.object({
  left: z.number().int().min(0).max(65535),
  top: z.number().int().min(0).max(65535),
  width: dim,
  height: dim,
  format,
});

export const optimizeSchema = z.object({
  quality: z.number().int().min(1).max(100).default(80),
  format,
});

export const variantQuerySchema = z.object({ variant: z.string().trim().max(120).optional() });

export const deleteQuerySchema = z.object({ force: z.enum(['true', 'false']).default('false') });

export const referenceSchema = z.object({
  sourceType: z.string().trim().min(1).max(64),
  sourceId: z.string().trim().min(1).max(128),
  referenceKey: z.string().trim().max(128).default(''),
});
